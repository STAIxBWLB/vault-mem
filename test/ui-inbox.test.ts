import { expect, test } from "bun:test";
import type { InboxItem } from "@staix/agent-console/contract";
import { boundInbox, createInboxSnapshot, runInboxSource, type InboxRows } from "../src/ui/inbox.ts";

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
    expect(snapshot).toMatchObject({ items: [], more: 0, refreshing: true });
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
