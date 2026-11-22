import { Report } from "@staix/cli-output";
/** `vmem assert <vault> --batch FILE|- [--dry-run] [--log JSON] [--json]`: one implementation shared with `vmem_assert`. */
import { appendAssertions, type AssertReceipt } from "./assertions.ts";
import { argumentError } from "./mcp.ts";
import { LOG_EVENT_SCHEMA } from "./log-format.ts";
import type { LogEvent } from "./log-types.ts";
import { input } from "./write-commands.ts";
import { plural, PLAIN, UsageError, type TextOptions } from "./text-output.ts";

export function assertText(r: AssertReceipt, o: TextOptions, c: { vault: string }): string {
  const ops = plural(r.entries.length, "operation"), out = new Report(o.columns, o.ascii).header("vmem", "assert");
  const issues = [...r.issues, ...(r.log?.issues ?? [])];
  if (issues.length) { out.section("Problems"); for (const issue of issues) out.bullet(issue.severity === "error" ? "fail" : "warn", `${issue.code}${issue.path ? ` ${issue.path}` : ""}: ${issue.message}`); }
  const head = r.dryRun ? r.ok ? `dry run: ${ops} valid for ${c.vault}; nothing appended` : `assert: dry run refused, nothing appended to ${c.vault}` : r.applied ? r.ok ? `appended ${ops} to ${c.vault} segment ${r.segment} at ${r.recordedAt}` : `${ops} appended to ${c.vault} segment ${r.segment}, but a later step failed; inspect the segment and the writer record before appending again` : `assert: refused, nothing appended to ${c.vault}`;
  out.section("Result").bullet(r.ok ? r.dryRun ? "pending" : "ok" : "fail", head);
  if (r.entries.length) out.section("Entries").table(["Seq", "Op", "ID", "Rev", "Hash"], r.entries.map(e => [String(e.seq ?? ""), e.op, e.id, String(e.rev ?? ""), e.hash?.slice(0, 12) ?? ""]));
  if (r.recovery.length) { out.section("Recovery"); for (const note of r.recovery) out.bullet("warn", note); }
  if (r.log) out.section("Log").bullet(r.log.ok ? "ok" : "fail", r.log.ok ? "appended" : "not appended");
  return out.render(o.color).join("\n");
}

export function runAssertCommand(args: string[], home: string, env: NodeJS.ProcessEnv = process.env, text: TextOptions = PLAIN): { text: string; code: number } {
  const positional: string[] = [], flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (!word.startsWith("--") || word === "-") { positional.push(word); continue; }
    if (Object.hasOwn(flags, word) || !["--batch", "--log", "--dry-run", "--json"].includes(word)) throw new UsageError(`assert: unknown or repeated option: ${word}`);
    if (word === "--dry-run" || word === "--json") { flags[word] = true; continue; }
    const value = args[++i];
    if (value === undefined || (value.startsWith("--") && value !== "-")) throw new UsageError(`${word}: value required`);
    flags[word] = value;
  }
  if (positional.length !== 1) throw new UsageError("assert: requires one vault id; usage: vmem assert <vault> --batch FILE|-");
  if (typeof flags["--batch"] !== "string") throw new UsageError("assert: --batch FILE|- is required; pass a JSON file {\"ops\": [...]} or - for stdin");
  let batch: unknown;
  try { batch = JSON.parse(input(flags["--batch"], home)); } catch (caught) { throw caught instanceof UsageError ? caught : new UsageError(`--batch: ${caught instanceof SyntaxError ? "invalid JSON" : (caught as Error).message}; expected {"ops": [...]}`); }
  if (!batch || typeof batch !== "object" || Array.isArray(batch) || Object.keys(batch).some(key => key !== "ops")) throw new UsageError("--batch: expected a JSON object {\"ops\": [...]} with no other keys; send one object holding the operation list");
  let log: LogEvent | undefined;
  if (typeof flags["--log"] === "string") {
    try { log = JSON.parse(flags["--log"]) as LogEvent; } catch { throw new UsageError("--log: invalid JSON; pass one JSON log event object"); }
    const problem = argumentError(log, LOG_EVENT_SCHEMA, "--log");
    if (problem) throw new UsageError(`${problem}; expected {"type", "project", "source", "note"[, "dest"]} as for log append`);
  }
  const vault = positional[0]!;
  const receipt = appendAssertions(home, { vault, ops: (batch as { ops: unknown }).ops, channel: "cli", dryRun: flags["--dry-run"] === true, ...(log ? { log } : {}) }, { env });
  return { text: flags["--json"] ? JSON.stringify(receipt) : assertText(receipt, text, { vault }), code: receipt.ok && receipt.log?.ok !== false ? 0 : 1 };
}
