/** `vmem assert <vault> --batch FILE|- [--dry-run] [--log JSON] [--json]`: one implementation shared with `vmem_assert`. */
import { appendAssertions, type AssertReceipt } from "./assertions.ts";
import { argumentError } from "./mcp.ts";
import { LOG_EVENT_SCHEMA } from "./log-format.ts";
import type { LogEvent } from "./log-types.ts";
import { input } from "./write-commands.ts";
import { blocks, clean, issueTable, paint, plural, status, table, PLAIN, UsageError, type TextOptions } from "./text-output.ts";

export function assertText(r: AssertReceipt, o: TextOptions, c: { vault: string }): string {
  const ops = plural(r.entries.length, "operation");
  const head = !r.ok ? status("fail", `assert: refused, nothing appended to ${clean(c.vault)}`, o)
    : r.dryRun ? status("ok", `dry run: ${ops} valid for ${clean(c.vault)}; nothing appended`, o)
    : status("ok", `appended ${ops} to ${clean(c.vault)} segment ${r.segment} at ${r.recordedAt}`, o);
  const rows = r.ok ? table(["SEQ", "OP", "ID", "REV", "HASH"], r.entries.map(e => [e.seq ?? "-", e.op, e.id, e.rev ?? "-", e.hash ? e.hash.slice(0, 12) : "-"]), o) : undefined;
  const recovery = r.recovery.length ? ["recovery:", ...r.recovery.map(note => `  - ${clean(note)}`)].join("\n") : undefined;
  const log = r.log ? (r.log.ok ? status("ok", "log: appended", o) : blocks(status("fail", "log: not appended", o), issueTable(r.log.issues, o))) : undefined;
  return blocks(head, rows, recovery && paint(recovery, "hint", o), issueTable(r.issues, o), log);
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
