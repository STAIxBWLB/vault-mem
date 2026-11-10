import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { VaultSpec } from "../config.ts";
import { CONFIG_FILE } from "../config.ts";
import type { listPromotionCandidates } from "../promote.ts";

type Candidates = Awaited<ReturnType<typeof listPromotionCandidates>>;
type Candidate = Candidates["projects"][number]["candidates"][number];
const PAGE_BYTES = 32 * 1024;
let sequence = Date.now();
export const nextSnapshotCursor = () => ++sequence;

/** Receipt metadata can share a timestamp across writes on coarse filesystems. Include a bounded
 * log tail (or the entire size-limited registry) so same-size rewrites still invalidate. */
function revisionStamp(file: string, budget: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const s = fstatSync(fd, { bigint: true });
    const metadata = `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    if (!s.isFile()) return metadata;
    const size = Number(s.size);
    if (!Number.isSafeInteger(size)) throw new Error("revision source is too large");
    if (budget > 256 && size > budget) throw new Error("registry exceeds its revision read budget");
    const bytes = Buffer.alloc(Math.min(budget, size));
    const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return `${metadata}:${createHash("sha256").update(bytes.subarray(0, count)).digest("hex")}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    // A broken source must not prevent healthy vaults or unrelated panels from opening.
    // Recovery changes this stamp back to file evidence and invalidates the cache.
    return `error:${(error as NodeJS.ErrnoException).code ?? "UNREADABLE"}`;
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** A vmem write appends a receipt to its vault log. Check bounded receipt evidence, never scan notes or open Git/SQLite.
 * Configuration changes also invalidate policy-screened candidates. An explicit invalidation covers an
 * applied console write whose follow-up log failed, including link-only agent-mem promotions. */
export function createSnapshotRevision(home: string, vaults: VaultSpec[]) {
  const files = [{ file: join(home, CONFIG_FILE), budget: 64 * 1024 }, ...vaults.map(vault => ({ file: join(vault.path, "log"), budget: 256 }))];
  let previous = "", cursor = nextSnapshotCursor();
  return {
    current(): number {
      const stamp = files.map(({ file, budget }) => revisionStamp(file, budget)).join("|");
      if (stamp !== previous) { previous = stamp; cursor = nextSnapshotCursor(); }
      return cursor;
    },
    invalidate() { cursor = nextSnapshotCursor(); },
  };
}

/** Retain only the brief candidate metadata, and prepare byte-bounded pages once per revision.
 * `cursor` identifies the page (including selection), `nextPage` is navigation, and `after` is conditional polling. */
export function createPromoteSnapshot(revision: () => number, load: () => Promise<Candidates>, now: () => number = Date.now) {
  let cached: { revision: number; generation: number; digest: string; at: number; pages: Candidate[][] } | undefined;
  let flight: Promise<void> | undefined;
  const cursors = new Map<string, number>();
  function response(rows: Candidate[], selected: string | null, cursor: number, page: string, nextPage?: string) {
    const projects: Candidates["projects"] = [];
    for (const row of rows) {
      let project = projects.find(p => p.project === row.project);
      if (!project) { project = { project: row.project, candidates: [] }; projects.push(project); }
      project.candidates.push(row);
    }
    return { projects, selected, cursor, page, ...(nextPage ? { nextPage } : {}) };
  }
  return {
    async snapshot(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      // A concurrent write may move the revision while the scan runs. Never label that scan as the new revision.
      let attempts = 0;
      while (!cached || cached.revision !== revision() || now() - cached.at >= 60_000) {
        if (++attempts > 2) throw new Error("vault changed during promotion collection; retry the snapshot");
        if (!flight) {
          const started = revision();
          flight = (async () => {
            const result = await load();
            const pages: Candidate[][] = [[]];
            for (const project of result.projects) for (const item of project.candidates) {
              const candidate = { ...item, title: item.title === null ? null : [...item.title].slice(0, 160).join("") };
              const rows = pages.at(-1)!;
              // Reserve enough envelope space for cursors, page tokens, and selection/reset metadata.
              if (Buffer.byteLength(JSON.stringify(response([...rows, candidate], candidate.id, Number.MAX_SAFE_INTEGER, "x".repeat(80), "x".repeat(80)))) > PAGE_BYTES - 256) {
                if (rows.length === 0) throw new Error("promotion candidate exceeds the 32 KiB page budget");
                pages.push([]);
                if (Buffer.byteLength(JSON.stringify(response([candidate], candidate.id, Number.MAX_SAFE_INTEGER, "x".repeat(80), "x".repeat(80)))) > PAGE_BYTES - 256) throw new Error("promotion candidate exceeds the 32 KiB page budget");
              }
              pages.at(-1)!.push(candidate);
            }
            const digest = createHash("sha256").update(JSON.stringify(pages)).digest("hex");
            const identical = cached?.digest === digest;
            cached = { revision: started, generation: identical ? cached!.generation : nextSnapshotCursor(), digest, at: now(), pages };
            if (!identical) cursors.clear();
          })().finally(() => { flight = undefined; });
        }
        await flight;
      }
      const { pages, generation: rev } = cached;
      const selected = typeof args.id === "string" && args.id.length <= 64 ? args.id : null;
      const token = typeof args.page === "string" ? /^(\d+):(\d+)$/.exec(args.page) : null;
      const validPage = token !== null && Number(token[1]) === rev && Number.isSafeInteger(Number(token[2])) && Number(token[2]) < pages.length;
      const reset = args.page !== undefined && !validPage;
      let index = validPage ? Number(token[2]) : 0;
      if (!validPage && selected) index = Math.max(0, pages.findIndex(rows => rows.some(row => row.id === selected)));
      const key = `${index}:${selected ?? ""}`;
      let cursor = cursors.get(key);
      if (cursor === undefined) {
        // A bounded set of view cursors avoids growing with arbitrary selection inputs.
        if (cursors.size >= 256) cursors.delete(cursors.keys().next().value!);
        cursor = nextSnapshotCursor(); cursors.set(key, cursor);
      }
      if (args.after === cursor) return { changed: false, cursor };
      return { ...response(pages[index]!, selected, cursor, `${rev}:${index}`, index + 1 < pages.length ? `${rev}:${index + 1}` : undefined), ...(reset ? { reset: true } : {}) };
    },
  };
}
