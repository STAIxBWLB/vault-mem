import { Worker } from "node:worker_threads";
import type { InboxItem } from "@staix/agent-console/contract";
import type { VaultSpec } from "../config.ts";
import type { InboxSource } from "./inbox-source.ts";

const CACHE_MS = 60_000;
const FIRST_WAIT_MS = 700;
const SOURCE_MS = 30_000;
export type InboxRows = { items: InboxItem[]; more: number };

/** Urgent rows precede candidates; newest candidates first. Never ship full lint reports or memory bodies. */
export function boundInbox(items: InboxItem[], more = 0): InboxRows {
  const rank = (i: InboxItem) => i.chip?.tone === "err" ? 0 : i.group === "alert" ? 1 : 2;
  const sorted = [...items].sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  return { items: sorted.slice(0, 50).map(i => ({ ...i, title: i.title.slice(0, 160), ...(i.detail ? { detail: i.detail.slice(0, 240) } : {}) })),
    more: more + Math.max(0, items.length - 50) };
}

/** Separate workers make even synchronous lint, SQLite and Git interruptible without blocking the console. */
export function runInboxSource(home: string, source: InboxSource): { result: Promise<InboxRows>; cancel: () => void } {
  const worker = new Worker(new URL("./inbox-worker.ts", import.meta.url), { workerData: { home, source }, env: { ...process.env } });
  let cancel = () => {};
  const result = new Promise<InboxRows>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, rows?: InboxRows) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(rows!);
    };
    const timer = setTimeout(() => finish(new Error(`inbox ${source.kind} timed out after 30 s`)), SOURCE_MS);
    cancel = () => finish(new Error("inbox closed"));
    worker.once("message", (message: { result?: InboxRows; error?: string }) => finish(message.error ? new Error(message.error) : undefined, message.result));
    worker.once("error", error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once("exit", code => finish(new Error(`inbox worker exited (${code})`)));
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
          log(`vmem: ${source.kind === "sync" ? "sync pending" : source.kind}${"vault" in source ? ` ${source.vault.id}` : ""} failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally { cancel = undefined; }
      }
      if (closed) return;
      const all = [...rows.values()].flatMap(r => r.items);
      for (const item of all) if (item.group === "alert") {
        item.at = firstSeen.get(item.id) ?? item.at; firstSeen.set(item.id, item.at);
      }
      const ids = new Set(all.map(i => i.id));
      for (const id of firstSeen.keys()) if (!ids.has(id)) firstSeen.delete(id);
      cached = boundInbox(all, [...rows.values()].reduce((n, r) => n + r.more, 0));
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
      return { ...(cached ?? { items: [], more: 0 }), ...(flight ? { refreshing: true } : {}) };
    },
    invalidate() { revision++; at = -Infinity; },
    async close() { closed = true; cancel?.(); await flight; },
  };
}
