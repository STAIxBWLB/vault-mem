import type { VaultSpec, VmemConfig } from "./config.ts";
import type { WriteIssue } from "./write-types.ts";
export interface LogEvent { type: string; project: string; source: string; dest?: string; note: string }
export interface LogRequest { vault: string; event: LogEvent; channel?: "cli" | "mcp" }
export interface LogContext { vault: VaultSpec; config: VmemConfig; channel?: "cli" | "mcp"; env?: NodeJS.ProcessEnv; now?: Date; projectIds?: ReadonlySet<string> }
export interface LogReceipt { ok: boolean; appended: boolean | null; synced: boolean; bytesWritten: number | null; issues: WriteIssue[]; rolledBack?: boolean }
export interface LogReadOptions { vault: string; limit?: number; grep?: string; type?: string }
export interface LogReadResult { ok: boolean; lines: string[]; dataLines: number | null; warnings: string[]; issues: WriteIssue[] }

export interface LogBinding { vault: VaultSpec; denyPaths: string[]; piiPatterns: string[]; dev: number; ino: number }
