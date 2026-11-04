import { localDate } from "./local-date.ts";
import { LOG_TYPES } from "./log-format.ts";
import { loadRegistry } from "./registry.ts";
import { VaultIndex } from "./vault-index.ts";
import { readLog } from "./vault-log.ts";
import type { WriteIssue } from "./write-types.ts";
import type { VaultSpec } from "./config.ts";

export const STATS_DEFAULT_DAYS = 30;
export const STATS_MAX_DAYS = 3650;
export interface VaultStats {
  vault: string;
  /** Local calendar date the windows end on (today included). */
  asOf: string;
  notes: { total: number; byType: Record<string, number>; byDomain: Record<string, number>; byStatus: Record<string, number> };
  /** Notes whose indexed mtime falls within the last 7 and 30 local calendar days, today included. */
  modified: { last7Days: number; last30Days: number };
  /** Log events dated on or after `since` (local date), by type; types outside the known set count as "(other)". */
  log: { days: number; since: string; total: number | null; byType: Record<string, number> | null; warnings: string[]; issues: WriteIssue[] };
}
/**
 * Read-only vault statistics over the derived index (refreshed like every read tool) and the log streamed by `readLog`:
 * no vault file or log is written and no vault or log lock is taken.
 */
export function vaultStats(home: string, id: string, options: { days?: number; now?: Date; expectedVault?: VaultSpec } = {}): VaultStats {
  const days = options.days ?? STATS_DEFAULT_DAYS, now = options.now ?? new Date();
  if (!Number.isInteger(days) || days < 1 || days > STATS_MAX_DAYS) throw new Error(`stats: days must be an integer 1..${STATS_MAX_DAYS}; omit it for the ${STATS_DEFAULT_DAYS}-day default`);
  const registry = loadRegistry(home), vault = registry.vaults.find(v => v.id === id);
  if (!vault) throw Object.assign(new Error("stats: unknown vault id; run vmem vaults list for the registered ids"), { code: "V04" });
  // An MCP server reads the vault set fixed at startup; a re-registered id would otherwise count a different vault.
  if (options.expectedVault && JSON.stringify(options.expectedVault) !== JSON.stringify(vault)) throw new Error("stats: the vault registration changed since the MCP server started; restart the MCP server");
  // Local midnight that opens a window of n calendar days ending today.
  const start = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1));
  const index = new VaultIndex(home, vault, registry.vaults.map(v => v.path));
  let notes: ReturnType<VaultIndex["noteStats"]>;
  try { index.scan(); notes = index.noteStats([start(7).getTime(), start(30).getTime()]); } finally { index.close(); }
  const since = localDate(start(days)), byType: Record<string, number> = Object.fromEntries(LOG_TYPES.map(type => [type, 0]));
  let total = 0;
  const log = readLog(home, { vault: vault.id, limit: 1, visit: line => {
    const match = /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}\s+(\S+)/.exec(line);
    if (!match || match[1]! < since) return;
    const type = (LOG_TYPES as readonly string[]).includes(match[2]!) ? match[2]! : "(other)";
    total++; byType[type] = (byType[type] ?? 0) + 1;
  } });
  const { modified: [last7Days = 0, last30Days = 0], ...counts } = notes;
  return {
    vault: vault.id, asOf: localDate(now), notes: counts, modified: { last7Days, last30Days },
    log: { days, since, total: log.ok ? total : null, byType: log.ok ? byType : null, warnings: log.warnings, issues: log.issues },
  };
}
