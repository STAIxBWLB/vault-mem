import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { VaultSpec } from "./config.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { normalizeTarget, resolveLinks, type LinkNote, type ResolvedLink } from "./links.ts";

export const MAX_NOTE_BYTES = 2 * 1024 * 1024;
export const MAX_RESULTS = 500;
export const MAX_READ_BYTES = 64 * 1024;
export interface IndexedNote extends LinkNote { hash: string; description: string; type: string; domain: string }
export interface SearchOptions { limit?: number; type?: string; domain?: string }
export interface SearchResult { path: string; title: string; description: string; type: string; domain: string; score: number; snippet: string }
interface StoredNote extends IndexedNote { metadata: string; source: string }
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel));
}
function canonicalLocation(location: string): string {
  try { return realpathSync(location); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(location);
    if (parent === location) throw error;
    return join(canonicalLocation(parent), relative(parent, location));
  }
}
export function resultLimit(value = 50): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_RESULTS) throw new Error(`limit: expected integer 1..${MAX_RESULTS}`);
  return value;
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function aliases(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [];
}
function metadata(stat: NonNullable<ReturnType<typeof lstatSync>>): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
function boundedText(value: string, bytes: number): { content: string; truncated: boolean } {
  const buffer = Buffer.from(value);
  if (buffer.length <= bytes) return { content: value, truncated: false };
  let end = bytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return { content: buffer.subarray(0, end).toString("utf8"), truncated: true };
}
/** Derived cache only. No vault or application configuration files are written. */
export class VaultIndex {
  private readonly db: Database;
  readonly file: string;
  private readonly root: string;
  constructor(home: string, readonly vault: VaultSpec, vaultRoots: string[] = [vault.path]) {
    this.root = realpathSync(vault.path);
    if (this.root !== vault.path) throw new Error(`vault ${vault.id}: registered path changed`);
    const notes = join(this.root, "notes");
    if (realpathSync(notes) !== notes || !lstatSync(notes).isDirectory()) throw new Error(`vault ${vault.id}: notes must be a plain directory`);
    const cache = resolve(home, "indexes");
    const canonical = canonicalLocation(cache);
    for (const root of vaultRoots) {
      if (within(canonicalLocation(resolve(root)), canonical)) throw new Error("index: VMEM_HOME cache must be outside every vault");
    }
    // Canonical home resolution is allowed, but a linked cache directory/file is not.
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    if (lstatSync(cache).isSymbolicLink() || !lstatSync(cache).isDirectory()) throw new Error("index: expected plain cache directory");
    this.file = join(cache, `${digest(this.root)}.sqlite`);
    try {
      const fd = openSync(this.file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      closeSync(fd);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!lstatSync(this.file).isFile() || lstatSync(this.file).isSymbolicLink()) throw new Error("index: expected plain database file");
    this.db = new Database(this.file);
    this.db.run("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE;");
    this.db.run(`CREATE TABLE IF NOT EXISTS notes (
      path TEXT PRIMARY KEY, hash TEXT NOT NULL, metadata TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL,
      type TEXT NOT NULL, domain TEXT NOT NULL, aliases TEXT NOT NULL, source TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(path UNINDEXED, title, description, body, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS links (source TEXT NOT NULL, ordinal INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source, ordinal));`);
  }
  close(): void { this.db.close(); }
  private stored(): StoredNote[] {
    return this.db.query< Omit<StoredNote, "aliases"> & { aliases: string }, []>("SELECT * FROM notes ORDER BY path").all().map(row => ({ ...row, aliases: JSON.parse(row.aliases) as string[] }));
  }
  /** Scan metadata each call; hash only new or metadata-changed files. Atomic cache update. */
  scan(rebuild = false, options: { skipInvalidFrontmatter?: boolean } = {}): { notes: number; changed: number; removed: number; skipped?: string[] } {
    return this.db.transaction(() => {
      const notesDir = join(this.root, "notes");
      if (realpathSync(this.root) !== this.root || realpathSync(notesDir) !== notesDir || !lstatSync(notesDir).isDirectory()) throw new Error(`vault ${this.vault.id}: path or notes directory changed`);
      const previous = new Map(this.db.query<{ path: string; hash: string; metadata: string }, []>("SELECT path,hash,metadata FROM notes").all().map(note => [note.path, note]));
      if (rebuild) this.db.run("DELETE FROM fts");
      const live = new Set<string>();
      let changed = 0;
      const skipped: string[] = [];
      for (const entry of readdirSync(notesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.name.endsWith(".md") || !entry.isFile()) continue;
        const path = entry.name, file = join(notesDir, path), before = lstatSync(file);
        if (!before.isFile() || before.isSymbolicLink()) throw new Error(`vault ${this.vault.id}: note path changed`);
        if (before.size > MAX_NOTE_BYTES) throw new Error(`vault ${this.vault.id}, ${path}: note exceeds ${MAX_NOTE_BYTES} bytes`);
        live.add(path);
        const old = previous.get(path), stamp = metadata(before);
        if (!rebuild && old?.metadata === stamp) continue;
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let buffer: Buffer;
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size > MAX_NOTE_BYTES || metadata(stat) !== stamp) throw new Error(`vault ${this.vault.id}, ${path}: note changed during scan`);
          // Fixed bound even if a concurrent writer grows the file.
          buffer = Buffer.alloc(MAX_NOTE_BYTES + 1);
          let size = 0;
          for (;;) {
            const count = readSync(fd, buffer, size, buffer.length - size, null);
            size += count;
            if (!count || size === buffer.length) break;
          }
          buffer = buffer.subarray(0, size);
          if (size > MAX_NOTE_BYTES || metadata(fstatSync(fd)) !== stamp) throw new Error(`vault ${this.vault.id}, ${path}: note changed during scan`);
        } finally { closeSync(fd); }
        const hash = digest(buffer);
        if (!rebuild && old?.hash === hash) { this.db.query("UPDATE notes SET metadata=? WHERE path=?").run(stamp, path); continue; }
        let document: ReturnType<typeof parseFrontmatter>;
        try { document = parseFrontmatter(buffer.toString("utf8")); }
        catch {
          if (!options.skipInvalidFrontmatter) throw new Error(`vault ${this.vault.id}, ${path}: invalid frontmatter`);
          live.delete(path); skipped.push(path); continue;
        }
        const { data, body } = document;
        this.db.query("INSERT OR REPLACE INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(path, hash, stamp,
          text(data.title) || path.slice(0, -3), text(data.description), body, text(data.type), text(data.domain), JSON.stringify(aliases(data.aliases ?? data.alias)), buffer.toString("utf8"));
        this.db.query("DELETE FROM fts WHERE path=?").run(path);
        this.db.query("INSERT INTO fts(path,title,description,body) SELECT path,title,description,body FROM notes WHERE path=?").run(path);
        changed++;
      }
      let removed = 0;
      for (const path of previous.keys()) if (!live.has(path)) { this.db.query("DELETE FROM notes WHERE path=?").run(path); this.db.query("DELETE FROM fts WHERE path=?").run(path); removed++; }
      if (changed || removed || rebuild) {
        this.db.run("DELETE FROM links");
        const insert = this.db.query("INSERT INTO links VALUES (?, ?, ?)");
        for (const [ordinal, link] of resolveLinks(this.stored()).entries()) insert.run(link.source, ordinal, JSON.stringify(link));
      }
      return { notes: live.size, changed, removed, ...(skipped.length ? { skipped } : {}) };
    }).immediate();
  }
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const limit = resultLimit(options.limit);
    if (!query.trim() || Buffer.byteLength(query) > 1024) throw new Error("search: query must contain 1..1024 bytes");
    // Literal AND terms: users cannot inject FTS operators, columns or SQL.
    const terms = query.trim().split(/\s+/).map(term => `"${term.replaceAll('"', '""')}"`).join(" AND ");
    return this.db.query<SearchResult, [string, string | null, string | null, string | null, string | null, number]>(`SELECT n.path, n.title, substr(n.description,1,512) AS description, n.type, n.domain,
      bm25(fts,0,5,2,1) AS score, snippet(fts,3,'','',' ... ',32) AS snippet FROM fts JOIN notes n ON n.path=fts.path
      WHERE fts MATCH ? AND (? IS NULL OR n.type=?) AND (? IS NULL OR n.domain=?) ORDER BY score,n.path LIMIT ?`).all(terms, options.type ?? null, options.type ?? null, options.domain ?? null, options.domain ?? null, limit)
      .map(row => ({ ...row, title: boundedText(row.title, 512).content, snippet: boundedText(row.snippet, 1024).content, type: boundedText(row.type, 256).content, domain: boundedText(row.domain, 256).content }));
  }
  private find(target: string): string {
    if (!target || Buffer.byteLength(target) > 1024) throw new Error("note: expected target <=1024 bytes");
    const key = normalizeTarget(target.replace(/^notes\//i, "").replace(/\.md$/i, ""));
    // Stream only lookup metadata, never source/body; retain at most two candidates.
    // SQLite's lower() does not implement NFC/Unicode case folding, so match in JS.
    const notes: { path: string }[] = [];
    const lookup = this.db.prepare<{ path: string; aliases: string }, []>("SELECT path,aliases FROM notes");
    try {
      for (const note of lookup.iterate()) {
        if (normalizeTarget(note.path.slice(0, -3)) === key || (JSON.parse(note.aliases) as string[]).some(alias => normalizeTarget(alias) === key)) notes.push({ path: note.path });
        if (notes.length === 2) break;
      }
    } finally { lookup.finalize(); }
    if (notes.length !== 1) throw new Error(notes.length ? "note: ambiguous target" : "note: unknown target");
    return notes[0]!.path;
  }
  show(target: string, maxBytes = 16384): { path: string; hash: string; content: string; truncated: boolean } {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) throw new Error(`max-bytes: expected integer 1..${MAX_READ_BYTES}`);
    const path = this.find(target);
    const note = this.db.query<{ hash: string; prefix: Uint8Array; bytes: number }, [number, string]>(
      "SELECT hash,substr(CAST(source AS BLOB),1,?) AS prefix,length(CAST(source AS BLOB)) AS bytes FROM notes WHERE path=?"
    ).get(maxBytes + 4, path)!;
    const bounded = boundedText(Buffer.from(note.prefix).toString("utf8"), maxBytes);
    return { path, hash: note.hash, content: bounded.content, truncated: note.bytes > maxBytes };
  }
  /** Indexed notes (paths relative to notes/) ordered by path, optionally filtered by a literal stem prefix. */
  list(prefix = "", limit = 50): { path: string; title: string; type: string; domain: string; description: string }[] {
    if (Buffer.byteLength(prefix) > 1024) throw new Error("prefix: expected <=1024 bytes");
    const key = prefix.replace(/^notes\//i, "");
    return this.db.query<{ path: string; title: string; type: string; domain: string; description: string }, [number, string, number]>(
      "SELECT path,title,type,domain,substr(description,1,512) AS description FROM notes WHERE substr(path,1,?)=? ORDER BY path LIMIT ?"
    ).all(key.length, key, resultLimit(limit)).map(row => ({ ...row, title: boundedText(row.title, 512).content, type: boundedText(row.type, 256).content, domain: boundedText(row.domain, 256).content, description: boundedText(row.description, 512).content }));
  }
  /** Links that resolve to the target note, ordered by source. */
  backlinks(target: string, limit = 50): ResolvedLink[] {
    const path = this.find(target), max = resultLimit(limit), out: ResolvedLink[] = [];
    const rows = this.db.prepare<{ data: string }, []>("SELECT data FROM links ORDER BY source,ordinal");
    try {
      for (const row of rows.iterate()) {
        const link = JSON.parse(row.data) as ResolvedLink;
        if (link.resolved !== path) continue;
        out.push({ ...link, target: boundedText(link.target, 1024).content, label: link.label === null ? null : boundedText(link.label, 1024).content, heading: null, block: null });
        if (out.length >= max) break;
      }
    } finally { rows.finalize(); }
    return out;
  }
  /** MOC notes with the number of resolved links pointing at each. */
  mocs(limit = 200): { path: string; title: string; description: string; count: number }[] {
    const mocs = this.db.query<{ path: string; title: string; description: string }, [number]>("SELECT path,title,substr(description,1,512) AS description FROM notes WHERE type='moc' ORDER BY path LIMIT ?").all(resultLimit(limit));
    const counts = new Map(mocs.map(moc => [moc.path, 0]));
    const rows = this.db.prepare<{ data: string }, []>("SELECT data FROM links");
    try {
      for (const row of rows.iterate()) {
        const resolved = (JSON.parse(row.data) as ResolvedLink).resolved;
        if (resolved && counts.has(resolved)) counts.set(resolved, counts.get(resolved)! + 1);
      }
    } finally { rows.finalize(); }
    return mocs.map(moc => ({ path: moc.path, title: boundedText(moc.title, 512).content, description: boundedText(moc.description, 512).content, count: counts.get(moc.path) ?? 0 }));
  }
  /** Notes whose frontmatter `promoted_from` equals the value exactly (at most 20). */
  promotedFrom(value: string): string[] {
    if (!/^mem:[a-f0-9]{32}$/.test(value)) throw new Error("promoted_from: expected mem:<32 hex>");
    const out: string[] = [];
    const rows = this.db.prepare<{ path: string; source: string }, [string]>("SELECT path,source FROM notes WHERE instr(source, ?) > 0 ORDER BY path");
    try {
      for (const row of rows.iterate(value)) {
        try { if (parseFrontmatter(row.source).data.promoted_from === value) out.push(row.path); } catch { /* unrelated malformed YAML */ }
        if (out.length >= 20) break;
      }
    } finally { rows.finalize(); }
    return out;
  }
  links(target: string, limit = 50): ResolvedLink[] {
    const path = this.find(target);
    return this.db.query<{ data: string }, [string, number]>("SELECT data FROM links WHERE source=? ORDER BY ordinal LIMIT ?").all(path, resultLimit(limit)).map(row => JSON.parse(row.data) as ResolvedLink).map(link => ({ ...link, target: boundedText(link.target, 1024).content, label: link.label === null ? null : boundedText(link.label, 1024).content, heading: link.heading === null ? null : boundedText(link.heading, 1024).content, block: link.block === null ? null : boundedText(link.block, 1024).content }));
  }
}
