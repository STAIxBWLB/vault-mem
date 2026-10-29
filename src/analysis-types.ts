/** Private provider input. Never serialize a snapshot into CLI/MCP results or public evidence. */
export interface AnalysisSnapshot {
  notes: { path: string; source: string }[];
  today: string;
  logPath: string;
  log: string | null;
  registryIds: string[] | null;
  reports: Record<string, string>;
}
export type LintCode = "L01" | "L02" | "L03" | "L09" | "L10" | "L11" | "L12" | "L13";
export interface LintReport {
  findings: Record<LintCode, string[]>;
  errors: number;
  warnings: number;
  markdown: string;
  summary: string;
}
