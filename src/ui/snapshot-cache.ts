import { statSync } from "node:fs";
import { join } from "node:path";
import type { VaultSpec } from "../config.ts";
import { CONFIG_FILE } from "../config.ts";
import type { listPromotionCandidates } from "../promote.ts";

type Candidates = Awaited<ReturnType<typeof listPromotionCandidates>>;
type Candidate = Candidates["projects"][number]["candidates"][number];
const PAGE_BYTES = 32 * 1024;
let sequence = Date.now();
export const nextSnapshotCursor = () => ++sequence;

/** A vmem write appends a receipt to its vault log. Stat the receipts, never scan notes or open Git/SQLite.
 * Configuration changes also invalidate policy-screened candidates. An explicit invalidation covers an
 * applied console write whose follow-up log failed, including link-only agent-mem promotions. */
export function createSnapshotRevision(home: string, vaults: VaultSpec[]) {
  const files = [join(home, CONFIG_FILE), ...vaults.map(vault => join(vault.path, "log"))];
  let previous = "", cursor = nextSnapshotCursor();
  return {
    current(): number {
      const stamp = files.map(file => {
        try { const s = statSync(file, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
          // Unreadable revision evidence must not turn into a permanent cache hit.
          throw new Error("vault revision is unreadable; check vault log permissions", { cause: error });
        }
      }).join("|");
      if (stamp !== previous) { previous = stamp; cursor = nextSnapshotCursor(); }
      return cursor;
    },
    invalidate() { cursor = nextSnapshotCursor(); },
  };
}

/** Retain only the brief candidate metadata, and prepare byte-bounded pages once per revision.
 * `cursor` identifies the page (including selection), `nextPage` is navigation, and `after` is conditional polling. */
export function createPromoteSnapshot(revision: () => number, load: () => Promise<Candidates>) {
  let cached: { revision: number; generation: number; at: number; pages: Candidate[][] } | undefined;
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
      while (!cached || cached.revision !== revision() || Date.now() - cached.at >= 60_000) {
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
            cached = { revision: started, generation: nextSnapshotCursor(), at: Date.now(), pages }; cursors.clear();
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
