/**
 * Snapshot shapes of the console panels added in vault-mem#266 increment 1b. Each panel answers with the result of the
 * existing reader (proposal provider, assertion reader, Git snapshot history) unchanged, plus the selection it was asked
 * for; a refusal arrives as `error`, naming its cause and next step.
 */
import type { ProposalPage, ProposalView } from "../proposal-provider.ts";
import type { AssertionsReadResult } from "../assertion-read.ts";
import type { ChangesResult, HistoryResult } from "../vault-history.ts";

export type ProposalState = "pending" | "applied" | "rejected" | "apply_unknown";

export { assertionCoverageWarnings } from "../assertion-coverage.ts";
export type { CoverageWarning } from "../assertion-coverage.ts";
import type { CoverageWarning } from "../assertion-coverage.ts";

/** `proposals` panel: params `vault`, `state` (default pending), `after` page cursor, `id` to show one proposal. */
export interface ProposalsSnapshot {
  vault: string | null;
  state: ProposalState;
  page: ProposalPage | null;
  selected: ProposalView | null;
  error?: string;
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

export interface GraphNodeColumns {
  id: string[]; label: string[]; type: (string | null)[]; domain: (string | null)[];
  source_file: (string | null)[]; community: (number | null)[]; degree: number[];
  updated: (string | null)[]; date: (string | null)[]; placeholder: boolean[];
  description: (string | null)[]; confidence: (string | null)[]; topics: (string | null)[];
}
export interface GraphEdgeColumns {
  source: number[]; target: number[]; relations: string[]; relation: number[];
  field: (string | null)[]; rel: (string | null)[];
  confidence_tag: string | string[]; confidence: number | number[];
}
export interface GraphSnapshotPage {
  schema: 1; vault: string; revision: string;
  graph: { directed: boolean; multigraph: boolean; partitioner: string; resolution: number; modularity: number; iterations: number; max_iterations: number };
  totals: { nodes: number; edges: number; placeholders: number; placeholdersOmitted: number };
  kind: "nodes" | "edges"; offset: number; count: number;
  columns: GraphNodeColumns | GraphEdgeColumns; next: string | null;
}
/** The provider attaches a numeric cursor for console conditional polling. */
export type GraphPanelPage = GraphSnapshotPage & { cursor: number };
