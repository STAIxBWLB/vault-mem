import { nextSnapshotCursor } from "./snapshot-cache.ts";
import { Worker } from "node:worker_threads";
import type { InboxItem } from "@staix/agent-console/contract";
import type { VaultSpec } from "../config.ts";
import type { InboxSource } from "./inbox-source.ts";

const CACHE_MS = 60_000;
// Revision-triggered refreshes keep this gap from the start of the last collection, so steady vault writes cannot
// rerun every source on each poll. An applied console write invalidates the inbox directly and bypasses the gap.
const REVISION_MS = 10_000;
const FIRST_WAIT_MS = 700;
const SOURCE_MS = 30_000;
// agent-mem has no total-count API; a saturated candidate source can only report a lower bound.
export type InboxRows = { items: InboxItem[]; more: number; moreIsLowerBound?: boolean };

function readInboxRows(value: unknown): InboxRows {
  if (!value || typeof value !== "object" || !("items" in value) || !Array.isArray(value.items)
    || !("more" in value) || typeof value.more !== "number" || !Number.isSafeInteger(value.more) || value.more < 0) {
    throw new Error("inbox source returned no valid result; inspect System and restart the console provider");
  }
  return value as InboxRows;
}

/** An explicit error is a failure even when its message is empty. */
export function readInboxWorkerMessage(message: unknown): InboxRows {
  if (message && typeof message === "object" && "error" in message) {
    throw new Error(typeof message.error === "string" && message.error ? message.error
      : "inbox source failed without an error message; inspect System and retry");
  }
  return readInboxRows(message && typeof message === "object" && "result" in message ? message.result : undefined);
}

/** Urgent rows precede candidates; newest candidates first. Never ship full lint reports or memory bodies. */
export function boundInbox(items: InboxItem[], more = 0, moreIsLowerBound = false): InboxRows {
  const rank = (i: InboxItem) => {
    if (i.chip?.tone === "err") return 0;
    if (i.group === "alert") return 1;
    return 2;
  };
  const clip = (value: string, limit: number) => {
    let out = "", count = 0;
    for (const point of value) { if (count++ === limit) break; out += point; }
    return out;
  };
  const sorted = [...items].sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  return { items: sorted.slice(0, 50).map(i => ({ ...i, title: clip(i.title, 160), ...(i.detail ? { detail: clip(i.detail, 240) } : {}) })),
    more: more + Math.max(0, items.length - 50), ...(moreIsLowerBound ? { moreIsLowerBound: true } : {}) };
}

/** Workers isolate synchronous lint, SQLite and Git from requests. The deadline initiates termination;
 * shutdown can still wait for a blocking native call, so the queue waits before starting another worker. */
export function runInboxSource(home: string, source: InboxSource): { result: Promise<InboxRows>; cancel: () => void } {
  const panel = { candidates: "Promote", lint: "Lint", sync: "Overview" }[source.kind];
  const worker = new Worker(new URL("./inbox-worker.ts", import.meta.url), { workerData: { home, source }, env: { ...process.env } });
  let cancel = () => {};
  const result = new Promise<InboxRows>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, rows?: InboxRows) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      void worker.terminate().then(() => {
        if (error) reject(error); else resolve(rows!);
      }, failure => reject(failure));
    };
    const timer = setTimeout(() => finish(new Error(`inbox ${source.kind} timed out after 30 s; inspect ${panel} and System, then retry`)), SOURCE_MS);
    cancel = () => finish(new Error("inbox closed"));
    worker.once("message", (message: unknown) => {
      try { finish(undefined, readInboxWorkerMessage(message)); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    worker.once("error", error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once("exit", code => finish(new Error(`inbox worker exited (${code}); inspect System and restart the console provider`)));
  });
  return { result, cancel: () => cancel() };
}

type Runner = typeof runInboxSource;
/** `now` is looked up per call, so a test that spies on `Date.now` after opening the provider still moves this clock. */
export function createInboxSnapshot(home: string, vaults: VaultSpec[], log: (message: string) => void, run: Runner = runInboxSource, getRevision?: () => number, now: () => number = () => Date.now()) {
  const sources: InboxSource[] = [...vaults.filter(v => v.kind === "org").map(vault => ({ kind: "sync" as const, vault })),
    ...vaults.filter(v => v.kind === "personal").map(vault => ({ kind: "lint" as const, vault })), { kind: "candidates" }];
  const rows = new Map<number, InboxRows>(), firstSeen = new Map<string, string>();
  let cached: InboxRows | undefined, flight: Promise<void> | undefined, at = -Infinity, revision = 0, closed = false;
  // `stale` is a revision change not yet collected; `due` is the earliest start of the next revision-triggered run.
  let stale = false, due = -Infinity;
  let cancel: (() => void) | undefined;
  let sourceRevision = getRevision?.(), cursor = nextSnapshotCursor(), waited = false;
  const statusAt = new Date().toISOString();
  const status = (unavailable: boolean): InboxRows => ({ items: [{
    id: unavailable ? "inbox:unavailable" : "inbox:refresh", group: "alert", kind: "status",
    title: unavailable ? "Vault inbox is unavailable" : "Vault inbox is refreshing",
    detail: unavailable ? "Inspect System, then retry." : "The first collection is running; check again shortly.",
    at: statusAt, verbs: [], link: { panel: "overview" },
  }], more: 0 });
  function refresh() {
    if (closed || flight || now() - at < CACHE_MS) return;
    cursor = nextSnapshotCursor();
    const started = revision;
    // This run collects everything up to `started`; the next revision-triggered run waits for the gap.
    stale = false; due = now() + REVISION_MS;
    flight = (async () => {
      // One worker at a time, including failed sources. A source's deadline covers its entire expensive step.
      for (const [index, source] of sources.entries()) {
        if (closed) return;
        try {
          const job = run(home, source); cancel = job.cancel;
          rows.set(index, readInboxRows(await job.result));
        } catch (error) {
          if (!closed) log(`vmem: ${source.kind === "sync" ? "sync pending" : source.kind}${"vault" in source ? ` ${source.vault.id}` : ""} failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally { cancel = undefined; }
      }
      if (closed) return;
      const all = [...rows.values()].flatMap(r => r.items);
      for (const item of all) if (item.group === "alert") {
        item.at = firstSeen.get(item.id) ?? item.at; firstSeen.set(item.id, item.at);
      }
      const ids = new Set(all.map(i => i.id));
      for (const id of firstSeen.keys()) if (!ids.has(id)) firstSeen.delete(id);
      cached = rows.size === 0 ? status(true) : boundInbox(all, [...rows.values()].reduce((n, r) => n + r.more, 0), [...rows.values()].some(r => r.moreIsLowerBound));
      // An action during collection leaves these rows one revision behind: refresh again once the gap passes.
      at = now(); if (started !== revision) stale = true;
    })().catch(error => {
      // Warm snapshots do not await this promise. Never let a refresh failure escape to the console.
      if (!closed) {
        cached ??= status(true);
        at = now(); if (started !== revision) stale = true;
        try { log(`vmem: inbox refresh failed: ${error instanceof Error ? error.message : String(error)}; inspect System and retry`); }
        catch { /* A failed log sink must not create another unhandled rejection. */ }
      }
    }).finally(() => { flight = undefined; cursor = nextSnapshotCursor(); });
  }
  return {
    async snapshot(): Promise<InboxRows & { cursor: number; refreshing?: boolean }> {
      const current = getRevision?.();
      if (current !== sourceRevision) { sourceRevision = current; revision++; stale = true; }
      // A revision change refreshes at most once per gap; a console write clears the gate in `invalidate`.
      if (stale && now() >= due) { stale = false; at = -Infinity; }
      refresh();
      if (!cached && flight && !waited) {
        waited = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([flight, new Promise<void>(resolve => { timer = setTimeout(resolve, FIRST_WAIT_MS); })]);
        clearTimeout(timer);
      }
      return { ...(cached ?? status(false)), cursor, ...(flight ? { refreshing: true } : {}) };
    },
    // An applied console write is immediate: it bypasses the revision gap for the next poll, including any log
    // append the same write made, then the gap starts again from that collection.
    invalidate() { revision++; at = -Infinity; due = -Infinity; cursor = nextSnapshotCursor(); },
    async close() { closed = true; cancel?.(); await flight; },
  };
}
