import type { LogEvent, LogReceipt } from "./log-types.ts";
import type { VaultSpec, VmemConfig } from "./config.ts";
export type WriteOp =
  | { op: "check"; path: string; text: string }
  | { op: "create"; path: string; frontmatter: Record<string, unknown>; body?: string }
  | { op: "patch"; path: string; oldString: string; newString: string; expectedSha?: string }
  | { op: "append"; path: string; section: string; markdown: string; expectedSha?: string }
  | { op: "frontmatter"; path: string; set: Record<string, unknown>; unset?: string[]; expectedSha?: string }
  | { op: "link"; from: string; to: string; relation: "supports" | "contradicts" | "extends" | "applies-to" | "context-for"; context?: string; bidirectional?: boolean }
  | { op: "supersede"; old: string; next: string }
  | { op: "move"; from: string; to: string }
  | { op: "delete"; path: string }
  | { op: "tidy" }
  /** Whole-note replacement used by `tidy` rules; the text is validated like any other write. */
  | { op: "sanitize"; path: string; text: string }
  | { op: "report"; path: string; text: string };
export interface WriteRequest {
  vault: string;
  operation: WriteOp;
  channel?: "cli" | "mcp";
  dryRun?: boolean;
  confirm?: boolean;
  fingerprint?: string;
  expectedShas?: Record<string, string>;
  log?: LogEvent | false;
}
export interface WriteIssue { code: string; severity: "error" | "warning"; path?: string; message: string }
export interface PlannedChange { path: string; before: string | null; after: string | null }
export interface ValidationContext {
  vault: VaultSpec;
  config: VmemConfig;
  /** Original flat notes snapshot, paths prefixed with notes/. */
  notes: Map<string, string>;
  operation: WriteOp;
}
export interface ChangeReceipt { path: string; beforeSha: string | null; sha256: string | null; bytes: number }
export interface WriteReceipt {
  ok: boolean;
  applied: boolean;
  /** A link request whose requested sides already have body references made no changes. */
  unchanged?: boolean;
  issues: WriteIssue[];
  changes: ChangeReceipt[];
  fingerprint?: string;
  preview?: boolean;
  possibleDuplicates?: string[];
  indexUpdated: boolean;
  logged?: boolean;
  log?: LogReceipt;
}
