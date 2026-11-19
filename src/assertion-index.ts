/** Disposable, deterministic SQLite projection of a freshly verified assertion journal. */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { MAX_JOURNAL_BYTES, MAX_JOURNAL_ENTRIES, type JournalEntry, type VerifiedJournal } from "./assertions.ts";
import { canonical } from "./writer.ts";

/** The index belongs to the configured home, never to the vault or its source journal. */
export function assertionIndexPath(home: string, vaultRoot: string, protectedRoots: readonly string[] = [vaultRoot]): string {
  const root = realpathSync(vaultRoot), state = realpathSync(home);
  for (const protectedRoot of [vaultRoot, ...protectedRoots]) {
    const rel = relative(realpathSync(protectedRoot), state);
    if (!rel || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel)))
      throw new Error("assertion index: configured home is inside a vault; move VMEM_HOME outside every registered vault");
  }
  const digest = createHash("sha256").update(root).digest("hex");
  return join(state, "indexes", `assertions-${digest}-v1.sqlite`);
}

/**
 * Rebuild from verified entries in a fixed order. The caller must re-read the journal for each request and must
 * never use this projection as proof of journal integrity or as a substitute for current read policy.
 */
export function rebuildAssertionIndex(home: string, vaultRoot: string, journal: VerifiedJournal, protectedRoots: readonly string[] = [vaultRoot]): string {
  const target = assertionIndexPath(home, vaultRoot, protectedRoots), dir = join(realpathSync(home), "indexes");
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("assertion index: indexes is not a plain directory; replace the link or file with a directory in VMEM_HOME");
  try {
    const existing = lstatSync(target);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error("assertion index: existing index is linked or not a file; remove the disposable index from VMEM_HOME/indexes");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = join(dir, `.assertions-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
  try {
    const db = new Database(temporary);
    try {
      db.exec("PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF; CREATE TABLE entries (segment TEXT NOT NULL, seq INTEGER NOT NULL, entry TEXT NOT NULL, PRIMARY KEY(segment, seq)) WITHOUT ROWID;");
      const put = db.prepare("INSERT INTO entries (segment, seq, entry) VALUES (?, ?, ?)");
      db.transaction(() => {
        for (const segment of [...journal.segments].sort((a, b) => a.segment < b.segment ? -1 : a.segment > b.segment ? 1 : 0))
          for (const entry of segment.entries) put.run(segment.segment, entry.seq, canonical(entry));
      })();
    } finally { db.close(); }
    renameSync(temporary, target);
    return target;
  } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

/**
 * Read the projection only after verifying the journal. Compare every indexed entry with the verified bytes before
 * using it, so a replaced, stale or corrupt cache can never become an authority over the source journal.
 */
export function indexedJournal(file: string, verified: VerifiedJournal): VerifiedJournal {
  let db: Database | undefined;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_JOURNAL_BYTES * 4) return verified;
    db = new Database(file, { readonly: true });
    const sizes = db.query("SELECT count(*) AS count, coalesce(sum(length(cast(entry AS blob))), 0) AS bytes FROM entries").get() as { count: number; bytes: number };
    if (sizes.count !== verified.entries || sizes.count > MAX_JOURNAL_ENTRIES || sizes.bytes > MAX_JOURNAL_BYTES) return verified;
    const rows = db.query("SELECT segment, seq, entry FROM entries ORDER BY segment, seq").all() as { segment: string; seq: number; entry: string }[];
    const expected = verified.segments.flatMap(segment => segment.entries.map(entry => ({ segment: segment.segment, entry }))).sort((a, b) => a.segment < b.segment ? -1 : a.segment > b.segment ? 1 : a.entry.seq - b.entry.seq);
    if (rows.length !== expected.length) return verified;
    const entries = new Map<string, JournalEntry[]>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!, source = expected[i]!;
      if (row.segment !== source.segment || row.seq !== source.entry.seq || row.entry !== canonical(source.entry)) return verified;
      const segmentEntries = entries.get(row.segment) ?? [];
      segmentEntries.push(JSON.parse(row.entry) as JournalEntry); entries.set(row.segment, segmentEntries);
    }
    return { ...verified, segments: verified.segments.map(segment => ({ ...segment, entries: entries.get(segment.segment) ?? [] })) };
  } catch { return verified; } finally { db?.close(); }
}
