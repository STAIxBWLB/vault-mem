import { resolve } from "node:path";
import { MAX_AUX_BYTES, analysisReadWithSize } from "./analysis-input.ts";
import { localDate } from "./local-date.ts";
import { LOG_TYPES } from "./log-format.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { loadRegistry } from "./registry.ts";
import { sourceReferences, sourceWorkspaceRoot, type SourceReference } from "./source.ts";
import { VaultIndex, type NoteSize, type SourcedNote } from "./vault-index.ts";
import { readLog } from "./vault-log.ts";
import type { WriteIssue } from "./write-types.ts";
import type { VaultSpec } from "./config.ts";

export const STATS_DEFAULT_DAYS = 30;
export const STATS_MAX_DAYS = 3650;
/** Source files the ratio pass reads per call, and how many source bytes it counts in total. */
export const MAX_RATIO_SOURCES = 10000;
export const MAX_RATIO_SOURCE_BYTES = 64 * 1024 * 1024;
/** The caps one ratio call works within; the defaults are the two bounds above, and a test lowers them. */
export interface RatioLimits { sources: number; bytes: number }
export const RATIO_LIMITS: RatioLimits = { sources: MAX_RATIO_SOURCES, bytes: MAX_RATIO_SOURCE_BYTES };
/** One bounded source read; `noteSourceRatio` takes one so a test can count the reads a pass really makes. */
export type SourceFileRead = (file: string, maximum: number) => { bytes: number } | null;
/** Notes listed as the largest, and the ratio above which a note is larger than the sources it cites. */
export const RATIO_LARGEST_SHOWN = 5;
export const RATIO_OVER_ONE = 1;
export interface VaultRatio {
  /** Notes whose sources could be read and total more than zero bytes. */
  notes: number;
  /** Source files read within the per-call bounds; a zero-byte file is read and counted but leaves its note out of the ratio. */
  sources: number;
  /** Source references left out of the ratio; `skippedNonFile` of them are not workspace files at all. */
  skipped: number;
  skippedNonFile: number;
  /**
   * Notes left out because their readable sources total zero bytes. Such a note has no ratio, and counting it here
   * keeps `skipped` a count of source references: its sources were read and are already in `sources`.
   */
  emptySourceNotes: number;
  /**
   * Sourced notes the index kept out of the pass (`MAX_RATIO_NOTES`), counted rather than dropped silently. The
   * index stops collecting at the cap, so the median, p90 and the rest describe the notes it returned, not all of them.
   */
  truncatedNotes: number;
  /** Median and nearest-rank p90 of the per-note ratio: note bytes over the bytes of its readable sources. */
  median: number | null;
  p90: number | null;
  /** Notes whose ratio is above `RATIO_OVER_ONE`, so the note is larger than its sources. */
  overOne: number;
  largest: { path: string; ratio: number }[];
}
export interface VaultStats {
  vault: string;
  /** Local calendar date the windows end on (today included). */
  asOf: string;
  /** Note text size in bytes and words, by type and domain; "(none)" groups an empty type or domain. */
  size: { total: NoteSize; byType: Record<string, NoteSize>; byDomain: Record<string, NoteSize> };
  /** How large the notes are next to the workspace files they cite. */
  ratio: VaultRatio;
  notes: { total: number; byType: Record<string, number>; byDomain: Record<string, number>; byStatus: Record<string, number> };
  /** Notes whose indexed mtime falls within the last 7 and 30 local calendar days, today included. */
  modified: { last7Days: number; last30Days: number };
  /** Log events dated on or after `since` (local date), by type; types outside the known set count as "(other)". */
  log: { days: number; since: string; total: number | null; byType: Record<string, number> | null; warnings: string[]; issues: WriteIssue[] };
}
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const middle = (sorted: readonly number[]) => {
  const half = sorted.length >> 1;
  return sorted.length % 2 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
};
/** Nearest rank: the smallest sorted value that at least `p` percent of the values do not exceed. */
const percentile = (sorted: readonly number[], p: number) => sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1]!;
/**
 * Note-to-source byte ratio over notes that declare a frontmatter `source`. Each entry is one note: its own byte size
 * over the summed size of the sources that could be read. The reader is `analysisReadWithSize`, so every file keeps its
 * bound, no link is followed, and the bytes counted are the file's own on-disk size rather than the size of its decoded
 * text, which overstates a file that is not UTF-8. The caps bound the I/O, not just the counted total: a read asks only
 * for the bytes the budget has left, the reader refuses a larger file from its fstat size without reading it, and once
 * the budget is spent no further file is opened. Every read attempt, successful or not, counts against the file cap, so
 * a run of failures or over-budget files cannot outrun it. A memory id, a URL, a denied, missing or oversized path and
 * anything the caps leave out is a skipped source reference, which keeps the pass read-only and bounded; a note whose
 * readable sources total zero bytes has no ratio and is counted in `emptySourceNotes` instead, so `skipped` stays a
 * count of references and never repeats a file that was read. The per-note truncation count belongs to the index, so
 * `vaultStats` adds it to this pass's result.
 */
export function noteSourceRatio(rows: readonly SourcedNote[], root: string | undefined, denyPaths: string[], limits: RatioLimits = RATIO_LIMITS, readFile: SourceFileRead = analysisReadWithSize): Omit<VaultRatio, "truncatedNotes"> {
  const ratios: { path: string; ratio: number }[] = [];
  let sources = 0, skipped = 0, skippedNonFile = 0, emptySourceNotes = 0, bytesRead = 0, attempts = 0;
  for (const row of rows) {
    let refs: SourceReference[];
    try { refs = sourceReferences(row.source); } catch { skipped++; continue; }
    let size = 0, used = 0;
    for (const ref of refs) {
      if (ref.kind !== "path") { skipped++; skippedNonFile++; continue; }
      const remaining = limits.bytes - bytesRead;
      // Stop before opening anything once a cap is used up, so an exhausted call does no further I/O.
      if (!root || attempts >= limits.sources || remaining <= 0) { skipped++; continue; }
      // Counted before the read, so a failed or over-budget attempt cannot slip past the file cap.
      attempts++;
      const file = resolve(root, ref.value);
      let read: { bytes: number } | null;
      // Ask for no more than the budget has left: the reader refuses a larger file from its fstat size, unread.
      try { read = isDenied(canonicalPath(file), denyPaths) ? null : readFile(file, Math.min(MAX_AUX_BYTES, remaining)); } catch { read = null; }
      // A denied, missing or over-budget file is a skip, and one that would pass the cap is left out whole.
      if (read === null || read.bytes > remaining) { skipped++; continue; }
      size += read.bytes; bytesRead += read.bytes; sources++; used++;
    }
    // A note whose sources are all empty has no ratio: count the note, not a reference, so `skipped` stays reference-only.
    if (!used) continue;
    if (size === 0) { emptySourceNotes++; continue; }
    ratios.push({ path: row.path, ratio: row.bytes / size });
  }
  const values = ratios.map(entry => entry.ratio).sort((a, b) => a - b);
  const largest = [...ratios].sort((a, b) => b.ratio - a.ratio || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, RATIO_LARGEST_SHOWN);
  return {
    notes: ratios.length, sources, skipped, skippedNonFile, emptySourceNotes,
    median: values.length ? round3(middle(values)) : null, p90: values.length ? round3(percentile(values, 90)) : null,
    overOne: ratios.filter(entry => entry.ratio > RATIO_OVER_ONE).length,
    largest: largest.map(entry => ({ path: entry.path, ratio: round3(entry.ratio) })),
  };
}
/**
 * Read-only vault statistics over the derived index (refreshed like every read tool) and the log streamed by `readLog`:
 * no vault file or log is written and no vault or log lock is taken. Note sizes come from the same index pass, and the
 * ratio reads only workspace files a note cites, through `analysisReadWithSize` and its bounds.
 */
export function vaultStats(home: string, id: string, options: { days?: number; now?: Date; expectedVault?: VaultSpec; limits?: RatioLimits } = {}): VaultStats {
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
  const size = notes.size, pass = noteSourceRatio(notes.sourced, sourceWorkspaceRoot(vault), registry.denyPaths ?? [], options.limits);
  const ratio: VaultRatio = { ...pass, truncatedNotes: notes.truncatedSourced };
  const since = localDate(start(days)), byType: Record<string, number> = Object.fromEntries(LOG_TYPES.map(type => [type, 0]));
  let total = 0;
  const log = readLog(home, { vault: vault.id, limit: 1, visit: line => {
    const match = /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}\s+(\S+)/.exec(line);
    if (!match || match[1]! < since) return;
    const type = (LOG_TYPES as readonly string[]).includes(match[2]!) ? match[2]! : "(other)";
    total++; byType[type] = (byType[type] ?? 0) + 1;
  } });
  const { modified: [last7Days = 0, last30Days = 0] } = notes;
  return {
    vault: vault.id, asOf: localDate(now), size, ratio,
    notes: { total: notes.total, byType: notes.byType, byDomain: notes.byDomain, byStatus: notes.byStatus },
    modified: { last7Days, last30Days },
    log: { days, since, total: log.ok ? total : null, byType: log.ok ? byType : null, warnings: log.warnings, issues: log.issues },
  };
}
