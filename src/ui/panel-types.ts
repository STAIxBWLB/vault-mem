/**
 * Snapshot shapes of the console panels added in vault-mem#266 increment 1b. Each panel answers with the result of the
 * existing reader (proposal provider, assertion reader, Git snapshot history) unchanged, plus the selection it was asked
 * for; a refusal arrives as `error`, naming its cause and next step.
 */
import type { ProposalPage, ProposalView } from "../proposal-provider.ts";
import type { AssertionsReadResult } from "../assertion-read.ts";
import type { ChangesResult, HistoryResult } from "../vault-history.ts";

export type ProposalState = "pending" | "applied" | "rejected" | "apply_unknown";

/** A coverage notice for the panel: `err` when entries are left out as untrusted, `warn` for other gaps, `neutral` for information. */
export interface CoverageWarning { tone: "err" | "warn" | "neutral"; message: string }

/** `proposals` panel: params `vault`, `state` (default pending), `after` page cursor, `id` to show one proposal. */
export interface ProposalsSnapshot {
  vault: string | null;
  state: ProposalState;
  page: ProposalPage | null;
  selected: ProposalView | null;
  error?: string;
}

/** Coverage notices for an assertion read: anything short of a fully verified, synced and indexed journal is named with its next step. */
export function assertionCoverageWarnings(coverage: AssertionsReadResult["coverage"] | undefined): CoverageWarning[] {
  if (!coverage) return [];
  const out: CoverageWarning[] = [];
  if (coverage.untrusted.length) out.push({ tone: "err", message: `${coverage.untrusted.length} journal ${coverage.untrusted.length === 1 ? "entry is" : "entries are"} untrusted and left out (${coverage.untrusted.slice(0, 3).map(u => `${u.segment}#${u.seq}: ${u.reason}`).join("; ")}); run \`vmem assertions <vault> --history --json\` and inspect the journal segments` });
  if (coverage.unsupported.length) out.push({ tone: "warn", message: `${coverage.unsupported.length} journal ${coverage.unsupported.length === 1 ? "entry uses" : "entries use"} an unsupported schema and ${coverage.unsupported.length === 1 ? "is" : "are"} left out; upgrade vmem to read them` });
  if (coverage.tornTail.length) out.push({ tone: "warn", message: `torn journal tail in ${coverage.tornTail.join(", ")}: the incomplete last entry is ignored; the next append repairs it` });
  if (coverage.partialBatch.length) out.push({ tone: "warn", message: `${coverage.partialBatch.length} ${coverage.partialBatch.length === 1 ? "entry belongs" : "entries belong"} to an incomplete batch and ${coverage.partialBatch.length === 1 ? "is" : "are"} left out; resubmit the batch` });
  if (coverage.purged) out.push({ tone: "neutral", message: `${coverage.purged} purged ${coverage.purged === 1 ? "payload is" : "payloads are"} not shown` });
  if (coverage.unsynced) out.push({ tone: "warn", message: `${coverage.unsynced} assertion ${coverage.unsynced === 1 ? "file is" : "files are"} not committed; run \`vmem sync\` to share them` });
  if (coverage.unsynced === null) out.push({ tone: "neutral", message: "journal sync state is unknown (no Git repository or Git unavailable)" });
  if (coverage.indexIssue) out.push({ tone: "warn", message: coverage.indexIssue });
  return out;
}

/** `assertions` panel: params `vault`, `subject`, `relation`, `at`, `asOf`, `history`, `cursor`, as `vmem_assertions`. */
export interface AssertionsSnapshot {
  vault: string | null;
  result: AssertionsReadResult | null;
  /** Every gap in the reported coverage (untrusted, unsupported, torn, partial, purged, unsynced, index), empty when complete. */
  warnings: CoverageWarning[];
  error?: string;
}

/** `history` panel: params `vault`, `path`, `cursor`, and `from` with `to` (full commit ids) for the changes between them. */
export interface HistorySnapshot {
  vault: string | null;
  path: string | null;
  history: HistoryResult | null;
  changes: ChangesResult | null;
  error?: string;
}
