import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPromoteSnapshot, createSnapshotRevision } from "../src/ui/snapshot-cache.ts";
import type { listPromotionCandidates } from "../src/promote.ts";

type Candidates = Awaited<ReturnType<typeof listPromotionCandidates>>;
function fixture(): Candidates {
  return { projects: Array.from({ length: 5 }, (_, p) => ({ project: `synthetic-${p}`, candidates: Array.from({ length: 50 }, (_, n) => ({
    id: (p * 50 + n).toString(16).padStart(32, "0"), project: `synthetic-${p}`, kind: "decision", title: "한글😀".repeat(100), at: "2026-11-10T00:00:00Z",
  })) })) };
}

test("promotion pages fit 32 KiB UTF-8, preserve all candidates and answer unchanged under 100 ms", async () => {
  let revision = 1, scans = 0;
  const source = fixture(), cache = createPromoteSnapshot(() => revision, async () => { scans++; return source; });
  let page: unknown;
  const ids: string[] = [];
  do {
    const result = await cache.snapshot({ ...(page ? { page } : {}) });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32 * 1024);
    ids.push(...(result.projects as Candidates["projects"]).flatMap(p => p.candidates.map(c => c.id)));
    const start = performance.now();
    expect(await cache.snapshot({ page: result.page, after: result.cursor })).toEqual({ changed: false, cursor: result.cursor });
    expect(performance.now() - start).toBeLessThan(100);
    page = result.nextPage;
  } while (page);
  expect(ids).toEqual(source.projects.flatMap(p => p.candidates.map(c => c.id)));
  expect(scans).toBe(1);
  const old = await cache.snapshot({}); revision++;
  const fresh = await cache.snapshot({ after: old.cursor, page: old.nextPage });
  expect(fresh.changed).toBeUndefined(); expect(fresh.reset).toBe(true); expect(scans).toBe(2);
  expect(await cache.snapshot({ page: old.nextPage, after: fresh.cursor })).toEqual({ changed: false, cursor: fresh.cursor });
});

test("concurrent promotion calls coalesce, failed loads retry, selection opens its own page", async () => {
  let calls = 0;
  const source = fixture();
  const cache = createPromoteSnapshot(() => 1, async () => { calls++; await Bun.sleep(5); if (calls === 1) throw new Error("synthetic unavailable"); return source; });
  await expect(cache.snapshot({})).rejects.toThrow("synthetic unavailable");
  const results = await Promise.all(Array.from({ length: 10 }, () => cache.snapshot({})));
  expect(calls).toBe(2); expect(new Set(results.map(r => r.cursor)).size).toBe(1);
  const id = source.projects.at(-1)!.candidates.at(-1)!.id;
  const picked = await cache.snapshot({ id, after: results[0]!.cursor });
  expect(picked.changed).toBeUndefined(); expect(picked.selected).toBe(id);
  expect((picked.projects as Candidates["projects"]).flatMap(p => p.candidates).some(c => c.id === id)).toBe(true);
  expect(await cache.snapshot({ id, page: picked.page, after: picked.cursor })).toEqual({ changed: false, cursor: picked.cursor });
});

test("a write during candidate collection cannot cache stale rows at the new revision", async () => {
  let revision = 1, calls = 0;
  const cache = createPromoteSnapshot(() => revision, async () => { calls++; if (calls === 1) { await Bun.sleep(0); revision++; } return { projects: [] }; });
  await cache.snapshot({}); expect(calls).toBe(2);
});

test("log append, same-size rewrite, removal, config policy change and explicit invalidation move the revision", () => {
  const root = mkdtempSync(join(tmpdir(), "vmem-revision-"));
  try {
    const home = join(root, "home"), vault = join(root, "vault"); mkdirSync(home); mkdirSync(vault);
    const revision = createSnapshotRevision(home, [{ id: "fixture", path: vault, kind: "personal", write: "mcp" }]);
    let before = revision.current(); expect(revision.current()).toBe(before);
    for (const write of [() => appendFileSync(join(vault, "log"), "LEARN synthetic\n"), () => writeFileSync(join(vault, "log"), "LEARN different\n"),
      () => rmSync(join(vault, "log")), () => writeFileSync(join(home, "vmem.config.json"), "{}"), () => revision.invalidate()]) {
      write(); const after = revision.current(); expect(after).not.toBe(before); expect(revision.current()).toBe(after); before = after;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
