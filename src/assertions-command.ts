/** CLI surface for the shared assertion read provider. */
import { readAssertions } from "./assertion-read.ts";
import { purgeAssertions, type PurgeReceipt } from "./assertions.ts";
import { blocks, clean, heading, issueTable, nextCommand, paragraph, plural, status, table, PLAIN, UsageError, type TextOptions } from "./text-output.ts";
import { confirmCommand } from "./write-output.ts";

export function runAssertionsCommand(args: string[], home: string, env: NodeJS.ProcessEnv, text: TextOptions): { text: string; code: number } {
  if (args[0] === "purge") return runPurgeCommand(args.slice(1), home, env, text);
  const positional: string[] = [], flags: Record<string, string | boolean> = {};
  const values = ["--subject", "--relation", "--at", "--as-of", "--limit", "--cursor"];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (!word.startsWith("-")) { positional.push(word); continue; }
    if (Object.hasOwn(flags, word) || ![...values, "--history", "--json"].includes(word)) throw new UsageError(`assertions: unknown or repeated option: ${word}`);
    if (!values.includes(word)) { flags[word] = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new UsageError(`${word}: value required`);
    flags[word] = value;
  }
  if (positional.length !== 1) throw new UsageError("assertions: requires one vault id; run vmem help assertions");
  const limit = flags["--limit"];
  if (typeof limit === "string" && !/^[1-9][0-9]*$/.test(limit)) throw new UsageError("--limit: expected an integer from 1 to 100");
  const result = readAssertions(home, { vault: positional[0]!,
    ...(typeof flags["--subject"] === "string" ? { subject: flags["--subject"] } : {}),
    ...(typeof flags["--relation"] === "string" ? { relation: flags["--relation"] } : {}),
    ...(typeof flags["--at"] === "string" ? { at: flags["--at"] } : {}),
    ...(typeof flags["--as-of"] === "string" ? { asOf: flags["--as-of"] } : {}),
    ...(typeof limit === "string" ? { limit: Number(limit) } : {}),
    ...(typeof flags["--cursor"] === "string" ? { cursor: flags["--cursor"] } : {}),
    ...(flags["--history"] === true ? { history: true } : {}) }, { env });
  if (flags["--json"]) return { text: JSON.stringify(result), code: 0 };
  const rows = result.items.map(item => [clean(item.subject), clean(item.relation), item.answer ?? "-", typeof item.value === "string" ? clean(item.value) : item.value ? "withheld" : "-", item.id]);
  return { text: blocks(heading(`Assertions in ${clean(result.vault)}`, text), table(["SUBJECT", "RELATION", "ANSWER", "VALUE", "ID"], rows, text),
    result.truncated ? status("pending", `more results: rerun with --cursor ${result.continuation}`, text) : status("ok", `${result.items.length} assertion(s) shown`, text),
    result.coverage.untrusted.length ? status("warn", `${result.coverage.untrusted.length} untrusted journal segment(s); inspect assertions/`, text) : undefined,
    result.coverage.indexIssue ? status("warn", result.coverage.indexIssue, text) : undefined), code: 0 };
}

/** What a purge receipt means in words; `argv` is the command without `vmem`, so the confirm line is pasteable. */
export function purgeText(r: PurgeReceipt, o: TextOptions, c: { argv: string[]; vault: string }): string {
  const entries = plural(r.entries.length, "entry", "entries"), segments = plural(r.segments.length, "segment");
  const verdict = r.preview
    ? (r.ok ? status("ok", `purge preview for ${clean(r.assertion)} in ${clean(c.vault)}: ${entries} in ${segments} would keep their hashes and lose their payloads; nothing written`, o)
      : status("fail", `purge refused for ${clean(c.vault)}; nothing written`, o))
    : r.applied
      ? (r.ok ? status("ok", `purged ${clean(r.assertion)} in ${clean(c.vault)} at ${r.at}: ${entries} rewritten in ${segments}; payloads removed, chain unchanged`, o)
        : status("fail", `${clean(r.assertion)} was rewritten in ${clean(c.vault)} but a later step failed; request a fresh preview and confirm again`, o))
      : status("fail", `purge refused for ${clean(c.vault)}; nothing written`, o);
  const rows = r.entries.length ? table(["SEGMENT", "SEQ", "OP", "HASH"], r.entries.map(e => [e.segment, e.seq, e.op, e.hash.slice(0, 12)]), o) : undefined;
  const already = r.alreadyPurged ? paragraph(`${plural(r.alreadyPurged, "entry", "entries")} already carried a purge marker and were left as they are.`, o, "muted") : undefined;
  const omitted = r.omitted ? paragraph(`${r.omitted} more ${r.omitted === 1 ? "entry is" : "entries are"} affected but not listed; confirm rewrites all of them.`, o, "muted") : undefined;
  const recovery = r.recovery.length ? ["recovery:", ...r.recovery.map(note => `  - ${clean(note)}`)].join("\n") : undefined;
  const confirm = r.preview && r.ok ? nextCommand("confirm", confirmCommand(["assertions", ...c.argv], r.fingerprint), o) : undefined;
  const scope = r.applied ? paragraph("bytes in Git history, other clones or remotes are unchanged; erasing them needs a history rewrite outside vmem", o, "muted") : undefined;
  return blocks(verdict, rows, already, omitted, recovery, issueTable(r.issues, o), scope, confirm);
}

/** `vmem assertions purge <vault> <id> --reason TEXT [--confirm --fingerprint SHA] [--json]`. */
export function runPurgeCommand(args: string[], home: string, env: NodeJS.ProcessEnv = process.env, text: TextOptions = PLAIN): { text: string; code: number } {
  const positional: string[] = [], flags: Record<string, string | boolean> = {};
  const values = ["--reason", "--fingerprint"];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (!word.startsWith("-")) { positional.push(word); continue; }
    if (Object.hasOwn(flags, word) || ![...values, "--confirm", "--json"].includes(word)) throw new UsageError(`assertions purge: unknown or repeated option: ${word}`);
    if (!values.includes(word)) { flags[word] = true; continue; }
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${word}: value required`);
    flags[word] = value;
  }
  if (positional.length !== 2) throw new UsageError("assertions purge: requires a vault id and an assertion id; run vmem help assertions purge");
  if (typeof flags["--reason"] !== "string") throw new UsageError("assertions purge: --reason TEXT is required; it stays in the journal, so keep it free of sensitive content");
  if (flags["--confirm"] === true && typeof flags["--fingerprint"] !== "string") throw new UsageError("assertions purge: --confirm needs --fingerprint SHA from the preview");
  if (flags["--confirm"] !== true && flags["--fingerprint"] !== undefined) throw new UsageError("assertions purge: --fingerprint applies only with --confirm; run the preview first");
  const vault = positional[0]!, id = positional[1]!;
  const receipt = purgeAssertions(home, { vault, id, reason: flags["--reason"], channel: "cli", ...(flags["--confirm"] === true ? { confirm: true } : {}), ...(typeof flags["--fingerprint"] === "string" ? { fingerprint: flags["--fingerprint"] } : {}) }, { env });
  return { text: flags["--json"] ? JSON.stringify(receipt) : purgeText(receipt, text, { argv: ["purge", ...args.filter(word => word !== "--json")], vault }), code: receipt.ok ? 0 : 1 };
}
