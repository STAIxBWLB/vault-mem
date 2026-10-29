import { screenContent } from "./write-validation.ts";
import type { LogContext, LogEvent } from "./log-types.ts";
import type { WriteIssue } from "./write-types.ts";

export const LOG_TYPES = ["INGEST", "ROUTE", "EXTRACT", "CONNECT", "DIGEST", "LEARN", "LINT", "TASK", "GRAPH", "SYNC", "RETHINK", "SOURCE"] as const;
export const AGENT_MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"] as const;
const EVENT_KEYS = new Set(["type", "project", "source", "dest", "note"]);
const CONTEXT_KEYS = new Set(["vault", "config", "channel", "env", "now", "projectIds"]);
function error(code: string, message: string): WriteIssue { return { code, severity: "error", message }; }
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function field(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) && !value.includes("|") && !value.includes("  ") && !value.includes(" — ");
}

/** Format and screen one prospective log line. This function performs no IO. */
export function formatLogEvent(event: LogEvent, context: LogContext): { line?: string; issues: WriteIssue[] } {
  if (!record(event) || Object.keys(event).some(key => !EVENT_KEYS.has(key)) ||
      !record(context) || Object.keys(context).some(key => !CONTEXT_KEYS.has(key))) {
    return { issues: [error("L09", "invalid event or context options")] };
  }
  if (!field(event.type) || !LOG_TYPES.some(type => type === event.type) ||
      !field(event.project) || (event.project !== "-" && !/^[a-z0-9][a-z0-9-]*$/.test(event.project)) ||
      !field(event.source) || !field(event.note) || (event.dest !== undefined && !field(event.dest)) ||
      event.source.includes(" → ") || (event.dest !== undefined && event.dest.includes(" → "))) {
    return { issues: [error("L09", "invalid log fields, type, project or separators")] };
  }
  if ((context.channel !== undefined && context.channel !== "cli" && context.channel !== "mcp") ||
      !record(context.vault) || !["personal", "org"].includes(context.vault.kind) ||
      (context.vault.pii !== undefined && context.vault.pii !== "allow" && context.vault.pii !== "deny") ||
      !record(context.config) || !Array.isArray(context.config.vaults) ||
      (context.config.piiPatterns !== undefined && (!Array.isArray(context.config.piiPatterns) || context.config.piiPatterns.some(value => typeof value !== "string"))) ||
      (context.now !== undefined && !(context.now instanceof Date)) ||
      (context.env !== undefined && (!context.env || typeof context.env !== "object" || Array.isArray(context.env) || Object.values(context.env).some(value => value !== undefined && typeof value !== "string"))) ||
      (context.projectIds !== undefined && !(context.projectIds instanceof Set))) {
    return { issues: [error("L09", "invalid log context")] };
  }
  if (event.project !== "-" && context.projectIds !== undefined && !context.projectIds.has(event.project)) {
    return { issues: [error("L09", "project is absent from the configured registry")] };
  }
  const now = context.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now.getFullYear() < 0 || now.getFullYear() > 9999) {
    return { issues: [error("L09", "invalid log timestamp")] };
  }
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  const timestamp = `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const env = context.env ?? process.env;
  const agent = context.channel === "mcp" || AGENT_MARKERS.some(marker => typeof env[marker] === "string" && env[marker]!.length > 0);
  const line = `${timestamp}  ${event.type}  ${event.project}  ${event.source}${event.dest === undefined ? "" : ` → ${event.dest}`}  — ${event.note}${agent ? " (vmem:agent)" : ""}\n`;
  const issues = screenContent(line, context.vault, context.config);
  if (Buffer.byteLength(line, "utf8") > 1000) issues.push(error("V09", "log line exceeds 1000 UTF-8 bytes including attribution and newline"));
  return issues.some(issue => issue.severity === "error") ? { issues } : { line, issues };
}
