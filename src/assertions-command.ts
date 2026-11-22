/** CLI surface for the shared assertion read provider. */
import { Report } from "@staix/cli-output";
import { readAssertions } from "./assertion-read.ts";
import { assertionCoverageWarnings } from "./assertion-coverage.ts";
import { scanAssertionExposure, writeReplaceFile, type ExposureReceipt } from "./assertion-exposure.ts";
import { purgeAssertions, type PurgeReceipt } from "./assertions.ts";
import { plural, shellWord, PLAIN, UsageError, type TextOptions } from "./text-output.ts";
import { confirmCommand } from "./write-output.ts";

export function runAssertionsCommand(args: string[], home: string, env: NodeJS.ProcessEnv, text: TextOptions): { text: string; code: number } {
  if (args[0] === "purge") return runPurgeCommand(args.slice(1), home, env, text);
  if (args[0] === "exposure") return runExposureCommand(args.slice(1), home, env, text);
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
  const out = new Report(text.columns, text.ascii).header("vmem", "assertions");
  const coverage = assertionCoverageWarnings(result.coverage);
  if (coverage.length) {
    out.section("Coverage");
    for (const warning of coverage) out.bullet(warning.tone === "err" ? "fail" : warning.tone === "warn" ? "warn" : "unknown", warning.message.replaceAll("`", "").replace("vmem assertions <vault>", `vmem assertions ${shellWord(result.vault)}`).replace("vmem sync to", `vmem sync ${shellWord(result.vault)} to`));
  }
  out.section("Assertions").kv([["Vault", result.vault], ["Shown", result.items.length]]);
  for (const item of result.items) out.bullet("absent", `${item.subject}: ${item.relation}, ${item.answer ?? "-"}, ${typeof item.value === "string" ? item.value : item.value ? "withheld" : "-"}, ${item.id}`);
  if (result.truncated && result.continuation) {
    const args = ["vmem", "assertions", result.vault, ...values.filter(flag => flag !== "--cursor" && typeof flags[flag] === "string").flatMap(flag => [flag, String(flags[flag])]), ...(flags["--history"] === true ? ["--history"] : []), "--cursor", result.continuation];
    out.next(args.map(shellWord).join(" "));
  }
  return { text: out.render(text.color).join("\n"), code: 0 };
}

/** What a purge receipt means in words; `argv` is the command without `vmem`, so the confirm line is pasteable. */
export function purgeText(r: PurgeReceipt, o: TextOptions, c: { argv: string[]; vault: string }): string {
  const entries = plural(r.entries.length, "entry", "entries"), segments = plural(r.segments.length, "segment"), out = new Report(o.columns, o.ascii).header("vmem", "assertions purge");
  if (r.issues.length) { out.section("Problems"); for (const issue of r.issues) out.bullet(issue.severity === "error" ? "fail" : "warn", `${issue.code}${issue.path ? ` ${issue.path}` : ""}: ${issue.message}`); }
  const verdict = r.preview ? r.ok ? `purge preview for ${r.assertion} in ${c.vault}: ${entries} in ${segments} would keep their hashes and lose their payloads; nothing written` : `purge refused for ${c.vault}; nothing written` : r.applied ? r.ok ? `purged ${r.assertion} in ${c.vault} at ${r.at}: ${entries} rewritten in ${segments}; payloads removed, chain unchanged` : `${r.assertion} was rewritten in ${c.vault} but a later step failed; request a fresh preview and confirm again` : `purge refused for ${c.vault}; nothing written`;
  out.section("Result").bullet(r.ok ? r.preview ? "pending" : "ok" : "fail", verdict);
  if (r.entries.length) out.section("Entries").table(["Segment", "Seq", "Op", "Hash"], r.entries.map(e => [e.segment, String(e.seq), e.op, e.hash.slice(0, 12)]));
  if (r.alreadyPurged) out.note(`${plural(r.alreadyPurged, "entry", "entries")} already carried a purge marker and were left as they are.`);
  if (r.omitted) out.note(`${r.omitted} more ${r.omitted === 1 ? "entry is" : "entries are"} affected but not listed; confirm rewrites all of them.`);
  if (r.recovery.length) { out.section("Recovery"); for (const note of r.recovery) out.bullet("warn", note); }
  if (r.applied) out.section("Scope").note("bytes in Git history, other clones or remotes are unchanged; erasing them needs a history rewrite outside vmem");
  if (r.preview && r.ok) out.next(confirmCommand(["assertions", ...c.argv], r.fingerprint));
  return out.render(o.color).join("\n");
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

/** What an exposure receipt means in words; the scan prints position and hash, never payload text. */
export function exposureText(r: ExposureReceipt, o: TextOptions): string {
  const out = new Report(o.columns, o.ascii).header("vmem", "assertions exposure");
  if (r.issues.length || r.truncated) { out.section("Problems"); for (const issue of r.issues) out.bullet("warn", issue); if (r.truncated) out.bullet("warn", `partial scan: stopped at the ${r.truncated}; a partial scan is never reported clean`); }
  out.section("Scan").kv([["Vault", r.vault], ["Commits", r.scanned.commits], ["Blobs", r.scanned.blobs], ["Bytes", r.scanned.bytes], ["Clean", r.clean === null ? "unknown" : r.clean]]);
  if (r.exposed.length) { out.section("Exposed"); for (const row of r.exposed) out.bullet("fail", `${row.assertion} ${row.segment}:${row.seq}: ${row.commits.count} commits, ${row.refs.length} refs, hash ${row.hash.slice(0, 12)}`); }
  if (r.refsOmitted) out.note("refs are omitted from this reply to stay inside the 48 KiB bound");
  else { const held = r.exposed.filter(row => row.refs.length); if (held.length) { out.section("Held by"); for (const row of held) out.bullet("warn", `${row.assertion} ${row.segment}:${row.seq}: ${row.refs.join(", ")}`); } }
  if (r.omitted) out.note(`${r.omitted} more ${r.omitted === 1 ? "entry is" : "entries are"} omitted from this reply to stay inside the 48 KiB bound`);
  const manual = r.exposed.filter(row => row.manual !== undefined);
  if (manual.length) { out.section("Manual step"); for (const row of manual) out.bullet("warn", `${row.assertion} ${row.segment}:${row.seq}: ${row.manual}`); }
  if (r.replaceFile) out.section("Replace file").bullet("warn", `${r.replaceFile.path}: ${plural(r.replaceFile.lines, "expression")}, ${r.replaceFile.unreplaceable} unreplaceable. ${r.replaceFile.delete}`);
  if (r.clean === false) out.section("Scope").note("vmem never runs the rewrite: git-filter-repo, the force push, reflog expire and gc stay with you; see docs/reference/writes.md");
  out.summary({ failed: r.exposed.length, warnings: !r.exposed.length && r.clean === false ? 1 : 0, unknown: r.clean === null ? 1 : 0, ok: r.clean === true ? 1 : 0 });
  return out.render(o.color).join("\n");
}

/** `vmem assertions exposure <vault> [<assertion-id>] [--replace-file PATH] [--json]`. */
export function runExposureCommand(args: string[], home: string, env: NodeJS.ProcessEnv = process.env, text: TextOptions = PLAIN): { text: string; code: number } {
  const positional: string[] = [], flags: Record<string, string | boolean> = {};
  const values = ["--replace-file"];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (!word.startsWith("-")) { positional.push(word); continue; }
    if (Object.hasOwn(flags, word) || ![...values, "--json"].includes(word)) throw new UsageError(`assertions exposure: unknown or repeated option: ${word}`);
    if (!values.includes(word)) { flags[word] = true; continue; }
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${word}: value required`);
    flags[word] = value;
  }
  if (positional.length < 1 || positional.length > 2) throw new UsageError("assertions exposure: requires a vault id and at most one assertion id; run vmem help assertions exposure");
  const scan = scanAssertionExposure(home, { vault: positional[0]!, ...(positional[1] !== undefined ? { assertion: positional[1]! } : {}) }, { env });
  if (typeof flags["--replace-file"] === "string") scan.receipt.replaceFile = writeReplaceFile(scan, flags["--replace-file"]);
  return { text: flags["--json"] ? JSON.stringify(scan.receipt) : exposureText(scan.receipt, text), code: scan.receipt.clean === true ? 0 : 1 };
}
