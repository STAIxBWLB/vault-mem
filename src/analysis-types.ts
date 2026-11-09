import type { TitleSuggestion } from "./links.ts";
/** Private provider input. Never serialize a snapshot into CLI/MCP results or public evidence. */
export interface AnalysisSnapshot {
  /** Effective selected-vault domain set; standalone snapshots default to the built-ins. */
  domains?: string[];
  notes: { path: string; source: string }[];
  today: string;
  logPath: string;
  log: string | null;
  registryIds: string[] | null;
  reports: Record<string, string>;
  /** Bounded auxiliary source-path existence warnings captured outside the pure lint transform. */
  sourceWarnings?: Record<string,string[]>;
  /**
   * At most one title hint per dead link text, captured with an open index outside the pure lint transform.
   * Link text is arbitrary (`__proto__` included), so a producer stores it in a null-prototype record and a reader
   * takes own keys only; `lintVault` accepts snapshots other callers built as plain records.
   */
  linkHints?: Record<string, TitleSuggestion>;
  /**
   * Set only when the hint pass hit its text bound: the bound, the texts it attempted and how many it left out. A dead
   * link text outside `attempted` was never looked up, so a reader reports "not computed" and never a miss.
   */
  linkHintBound?: { cap: number; attempted: readonly string[]; skipped: number };
}
export type LintCode = "L01" | "L02" | "L03" | "L09" | "L10" | "L11" | "L12" | "L13" | "L14" | "L15";
export interface LintReport {
  findings: Record<LintCode, string[]>;
  errors: number;
  warnings: number;
  markdown: string;
  summary: string;
}
