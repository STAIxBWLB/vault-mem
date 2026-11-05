import { Worker } from "node:worker_threads";
import type { InboxItem } from "@staix/agent-console/contract";
import type { VaultSpec } from "../config.ts";
import type { InboxSource } from "./inbox-source.ts";

const CACHE_MS = 60_000;
const FIRST_WAIT_MS = 700;
const SOURCE_MS = 30_000;
// agent-mem has no total-count API; a saturated candidate source can only report a lower bound.
export type InboxRows = { items: InboxItem[]; more: number; moreIsLowerBound?: boolean };

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
    worker.once("message", (message: { result?: InboxRows; error?: string }) => finish(message.error ? new Error(message.error) : undefined, message.result));
    worker.once("error", error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once("exit", code => finish(new Error(`inbox worker exited (${code}); inspect System and restart the console provider`)));
  });
  return { result, cancel: () => cancel() };
}

type Runner = typeof runInboxSource;
export function createInboxSnapshot(home: string, vaults: VaultSpec[], log: (message: string) => void, run: Runner = runInboxSource) {
  const sources: InboxSource[] = [...vaults.filter(v => v.kind === "org").map(vault => ({ kind: "sync" as const, vault })),
    ...vaults.filter(v => v.kind === "personal").map(vault => ({ kind: "lint" as const, vault })), { kind: "candidates" }];
  const rows = new Map<number, InboxRows>(), firstSeen = new Map<string, string>();
  let cached: InboxRows | undefined, flight: Promise<void> | undefined, at = -Infinity, revision = 0, closed = false;
  let cancel: (() => void) | undefined;
  const statusAt = new Date().toISOString();
  const status = (unavailable: boolean): InboxRows => ({ items: [{
    id: unavailable ? "inbox:unavailable" : "inbox:refresh", group: "alert", kind: "status",
    title: unavailable ? "Vault inbox is unavailable" : "Vault inbox is refreshing",
    detail: unavailable ? "Inspect System, then retry." : "The first collection is running; check again shortly.",
    at: statusAt, verbs: [], link: { panel: "overview" },
  }], more: 0 });
  function refresh() {
    if (closed || flight || Date.now() - at < CACHE_MS) return;
    const started = revision;
    flight = (async () => {
      // One worker at a time, including failed sources. A source's deadline covers its entire expensive step.
      for (const [index, source] of sources.entries()) {
        if (closed) return;
        try {
          const job = run(home, source); cancel = job.cancel;
          rows.set(index, await job.result);
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
      // An action during collection makes the next poll refresh again, without erasing the last rows.
      at = started === revision ? Date.now() : -Infinity;
    })().finally(() => { flight = undefined; });
  }
  return {
    async snapshot(): Promise<InboxRows & { refreshing?: boolean }> {
      refresh();
      if (!cached && flight) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([flight, new Promise<void>(resolve => { timer = setTimeout(resolve, FIRST_WAIT_MS); })]);
        clearTimeout(timer);
      }
      return { ...(cached ?? status(false)), ...(flight ? { refreshing: true } : {}) };
    },
    invalidate() { revision++; at = -Infinity; },
    async close() { closed = true; cancel?.(); await flight; },
  };
}
