import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, migrate, ensureShardDescriptor } from "@staix/agent-mem";
import { addVault } from "../src/registry.ts";
import { collectInboxSource } from "../src/ui/inbox-source.ts";
import { analysisInput } from "../src/analysis-input.ts";
import { lintVault } from "../src/vault-lint.ts";
import type { InboxItem } from "@staix/agent-console/contract";
import { boundInbox, createInboxSnapshot, runInboxSource, readInboxWorkerMessage, type InboxRows } from "../src/ui/inbox.ts";

const row = (n: number): InboxItem => ({ id: `mem:${n}`, kind: "promotion", group: "candidate", title: "Synthetic title ".repeat(1000),
  at: new Date(1_700_000_000_000 + n).toISOString(), project: "synthetic", verbs: [], link: { panel: "promote", params: { id: String(n) } } });
const deferred = () => {
  let resolve!: (rows: InboxRows) => void;
  const result = new Promise<InboxRows>(done => { resolve = done; });
  return { result, resolve, cancel: () => resolve({ items: [], more: 0 }) };
};

test("realistic 10,000-row result is capped at 50, urgent first, newest next, with bounded text", () => {
  const rows = Array.from({ length: 10_000 }, (_, n) => row(n));
  const alert: InboxItem = { ...row(0), id: "lint:mine", group: "alert", chip: { text: "errors", tone: "err" }, detail: "Synthetic ".repeat(1000) };
  const bounded = boundInbox([...rows, alert]);
  expect(bounded.items).toHaveLength(50); expect(bounded.more).toBe(9951);
  expect(bounded.items[0]!.id).toBe("lint:mine"); expect(bounded.items[1]!.id).toBe("mem:9999");
  expect(JSON.stringify(bounded).length).toBeLessThan(25_000);
});

test("cold p95 stays below 1 s while concurrent polls share one hung collection", async () => {
  const job = deferred(); let runs = 0;
  const cache = createInboxSnapshot("fixture", [], () => {}, () => { runs++; return job; });
  const elapsed = await Promise.all(Array.from({ length: 20 }, async () => {
    const start = performance.now(), snapshot = await cache.snapshot();
    expect(snapshot).toMatchObject({ items: [{ id: "inbox:refresh", kind: "status" }], more: 0, refreshing: true });
    return performance.now() - start;
  }));
  elapsed.sort((a, b) => a - b);
  expect(elapsed[18]!).toBeLessThan(1000); expect(runs).toBe(1);
  // A second poll must keep the same in-flight computation even beyond the cache TTL.
  cache.invalidate(); await cache.snapshot(); expect(runs).toBe(1);
  job.resolve(boundInbox(Array.from({ length: 1000 }, (_, n) => row(n))));
  await cache.close();
});

test("refresh after actions serves last complete rows and preserves alert timestamps", async () => {
  let job = deferred(), runs = 0;
  const cache = createInboxSnapshot("fixture", [], () => {}, () => { runs++; return job; });
  const alert = { ...row(0), id: "lint:mine", group: "alert" as const };
  const first = cache.snapshot(); job.resolve(boundInbox([alert])); await first;
  const complete = await cache.snapshot();
  job = deferred(); cache.invalidate();
  const start = performance.now(), stale = await cache.snapshot();
  expect(performance.now() - start).toBeLessThan(50);
  expect(stale.items).toEqual(complete.items); expect(stale.refreshing).toBe(true);
  await cache.snapshot(); expect(runs).toBe(2);
  job.resolve(boundInbox([{ ...alert, title: "Updated", at: new Date().toISOString() }]));
  await Bun.sleep(0);
  const updated = await cache.snapshot();
  expect(updated.items[0]!.title).toBe("Updated"); expect(updated.items[0]!.at).toBe(alert.at);
  await cache.close();
});

test("a failed refresh keeps prior rows and backs off; close cancels active work", async () => {
  let fail = false, cancelled = false, calls = 0;
  const logs: string[] = [];
  const cache = createInboxSnapshot("fixture", [], message => logs.push(message), () => {
    calls++;
    return { result: fail ? Promise.reject(new Error("unavailable")) : Promise.resolve(boundInbox([row(1)])), cancel() { cancelled = true; } };
  });
  const first = await cache.snapshot(); fail = true; cache.invalidate(); await cache.snapshot(); await Bun.sleep(0);
  expect((await cache.snapshot()).items).toEqual(first.items); expect(calls).toBe(2); expect(logs).toHaveLength(1);
  await cache.close(); expect(cancelled).toBe(false);
  const job = deferred(), active = createInboxSnapshot("fixture", [], () => {}, () => job);
  const cold = active.snapshot(); await active.close(); await cold;
});

test("worker startup failures are handled without unhandled rejections", async () => {
  const job = runInboxSource("/nonexistent/synthetic-vmem-home", { kind: "sync", vault: { id: "synthetic", path: "/nonexistent/synthetic-vault", kind: "org", write: "none" } });
  await expect(job.result).rejects.toThrow("vault binding changed");
});

test("a cached realistic-size candidate result answers repeated snapshots below the p95 bound", async () => {
  const cache = createInboxSnapshot("fixture", [], () => {}, () => ({
    result: Promise.resolve(boundInbox(Array.from({ length: 10_000 }, (_, n) => row(n)))),
    cancel() {},
  }));
  const cold = await cache.snapshot();
  expect(cold.items).toHaveLength(50); expect(cold.more).toBe(9950);
  const durations: number[] = [];
  for (let n = 0; n < 100; n++) {
    const start = performance.now();
    const snapshot = await cache.snapshot();
    durations.push(performance.now() - start);
    expect(snapshot.items).toHaveLength(50); expect(snapshot.more).toBe(9950);
    expect(JSON.stringify(snapshot).length).toBeLessThan(25_000);
  }
  durations.sort((a, b) => a - b);
  expect(durations[94]!).toBeLessThan(1000);
  await cache.close();
});

test("display clipping preserves astral code points at both limits", () => {
  const item = { ...row(0), title: "a".repeat(159) + "😀tail", detail: "b".repeat(239) + "😀tail" };
  const result = boundInbox([item]).items[0]!;
  expect(result.title).toBe("a".repeat(159) + "😀"); expect(result.detail).toBe("b".repeat(239) + "😀");
  expect([...result.title]).toHaveLength(160); expect([...result.detail!]).toHaveLength(240);
});

test("first-flight failure is visible and distinct from loading; shutdown is silent", async () => {
  const logs: string[] = [];
  const unavailable = createInboxSnapshot("fixture", [], message => logs.push(message), () => ({
    result: Promise.reject(new Error("synthetic failure")), cancel() {},
  }));
  expect((await unavailable.snapshot()).items[0]!.id).toBe("inbox:unavailable");
  expect(logs).toHaveLength(1); await unavailable.close();
  let reject!: (error: Error) => void;
  const active = createInboxSnapshot("fixture", [], message => logs.push(message), () => ({
    result: new Promise<InboxRows>((_, fail) => { reject = fail; }), cancel() { reject(new Error("inbox closed")); },
  }));
  const cold = active.snapshot(); await active.close(); await cold;
  expect(logs).toHaveLength(1);
});

test("candidate lower bounds survive composition and do not decrease as populations grow", () => {
  const lowerBounds = [49, 50, 51, 300].map(total => {
    const fetched = Array.from({ length: Math.min(total, 51) }, (_, n) => row(n));
    const source = boundInbox(fetched, 0, fetched.length === 51);
    const merged = boundInbox(source.items, source.more, source.moreIsLowerBound);
    expect(merged.items).toHaveLength(Math.min(total, 50));
    expect(merged.moreIsLowerBound === true).toBe(total >= 51);
    return merged.more;
  });
  expect(lowerBounds).toEqual([0, 0, 1, 1]);
});


test("one real project with 300 candidates reports overflow, and row details survive collection", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-inbox-count-"))), memoryDir = join(root, "memory"), home = join(root, "state"), vault = join(root, "vault");
  const previous = process.env.AMEM_HOME;
  try {
    const store = new MemoryStore({ memoryDir, deferPromotions: true });
    try {
      for (let n = 0; n < 300; n++) store.note({ op: "note", project: "synthetic-inbox", scope: "project", tier: "long", kind: "decision", peer: "person",
        title: `Synthetic durable lesson ${n}`, text: `Synthetic storage lesson ${n} keeps immutable identity stable across rebuilds.`, about: [], source: "person" });
    } finally { store.close(); }
    await migrate({ memoryDir, mode: "apply", generation: "c".repeat(32), authorizedPerson: true, tty: true });
    // Cross-project reads discover projects from descriptors, including unsplit generation homes.
    ensureShardDescriptor(memoryDir, "synthetic-inbox");
    process.env.AMEM_HOME = memoryDir;
    const candidates = await collectInboxSource(home, { kind: "candidates" });
    expect(candidates.items).toHaveLength(50); expect(candidates.more).toBe(1); expect(candidates.moreIsLowerBound).toBe(true);
    expect(candidates.items.every(item => item.detail === "decision memory to promote into a vault note")).toBe(true);
    const cache = createInboxSnapshot(home, [], () => {});
    try {
      const result = await cache.snapshot();
      const deadline = performance.now() + 4000;
      let complete = result;
      while (complete.refreshing && performance.now() < deadline) { await Bun.sleep(10); complete = await cache.snapshot(); }
      expect(complete.refreshing).toBeUndefined(); expect(complete.more).toBe(1); expect(complete.moreIsLowerBound).toBe(true);
    } finally { await cache.close(); }
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(join(vault, "notes", "Bad.md"), "---\ntype: insight\ndescription: Synthetic invalid filename.\n---\n# Synthetic\n");
    const spec = addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp" });
    const report = lintVault(analysisInput(home, "mine", { expectedVault: spec }).snapshot);
    const lint = await collectInboxSource(home, { kind: "lint", vault: spec });
    expect(lint.items.find(item => item.id === "lint:mine")!.detail).toBe([...report.summary].slice(0, 240).join(""));
    expect(lint.items.find(item => item.id === "stale:mine")!.detail).toBe([...report.findings.L11![0]!].slice(0, 240).join(""));
  } finally {
    if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);


test("worker messages reject explicit empty errors and missing results", () => {
  for (const error of ["", undefined, null]) {
    expect(() => readInboxWorkerMessage({ error, result: boundInbox([row(0)]) })).toThrow("failed without an error message");
  }
  for (const message of [undefined, null, {}, { result: undefined }, { result: { items: [], more: -1 } }]) {
    expect(() => readInboxWorkerMessage(message)).toThrow("no valid result");
  }
  expect(() => readInboxWorkerMessage({ error: "synthetic failure" })).toThrow("synthetic failure");
  expect(readInboxWorkerMessage({ result: { items: [], more: 0 } })).toEqual({ items: [], more: 0 });
});

test("a warm refresh with undefined rows or an empty worker error cannot terminate the process", async () => {
  const moduleUrl = new URL("../src/ui/inbox.ts", import.meta.url).href;
  const code = `
    import { createInboxSnapshot, readInboxWorkerMessage } from ${JSON.stringify(moduleUrl)};
    let mode = "ok", calls = 0;
    const logs = [];
    const item = { id: "mem:fixture", group: "candidate", kind: "promotion", title: "Synthetic", at: "2026-11-05T00:00:00.000Z", verbs: [], link: { panel: "promote" } };
    const cache = createInboxSnapshot("fixture", [], message => logs.push(message), () => {
      calls++;
      const result = Promise.resolve().then(() => {
        if (mode === "undefined") return undefined;
        if (mode === "empty-error") return readInboxWorkerMessage({ error: new Error().message });
        return { items: [item], more: 0 };
      });
      return { result, cancel() {} };
    });
    const first = await cache.snapshot();
    for (const failure of ["undefined", "empty-error"]) {
      mode = failure; cache.invalidate();
      if (JSON.stringify((await cache.snapshot()).items) !== JSON.stringify(first.items)) throw new Error("warm rows disappeared");
      await Bun.sleep(10);
      if (JSON.stringify((await cache.snapshot()).items) !== JSON.stringify(first.items)) throw new Error("failed refresh poisoned rows");
    }
    mode = "ok"; cache.invalidate(); await cache.snapshot(); await Bun.sleep(10);
    const recovered = await cache.snapshot(); await cache.close();
    console.log(JSON.stringify({ ids: recovered.items.map(item => item.id), calls, errors: logs.length }));
  `;
  const child = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" });
  const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(error).toBe(""); expect(exit).toBe(0);
  expect(JSON.parse(out)).toEqual({ ids: ["mem:fixture"], calls: 4, errors: 2 });
});

test("the final refresh catch retains warm rows even if source error logging throws", async () => {
  let fail = false, logs = 0;
  const cache = createInboxSnapshot("fixture", [], () => { logs++; throw new Error("synthetic log failure"); }, () => ({
    result: fail ? Promise.reject(new Error("synthetic source failure")) : Promise.resolve(boundInbox([row(1)])), cancel() {},
  }));
  const first = await cache.snapshot(); fail = true; cache.invalidate(); await cache.snapshot(); await Bun.sleep(0);
  expect((await cache.snapshot()).items).toEqual(first.items); expect(logs).toBe(2);
  await cache.close();
});
