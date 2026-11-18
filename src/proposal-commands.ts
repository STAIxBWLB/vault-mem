import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { canonicalPath, isDenied } from "./platform.ts";
import { loadRegistry } from "./registry.ts";
import { applyProposal, listProposals, previewProposalApply, previewProposalReject, reconcileProposal, rejectProposal, showProposal, submitProposal, type ProposalContext } from "./proposal-provider.ts";
import { MAX_PROPOSAL_RECORD_BYTES } from "./proposals.ts";
import { blocks, fields, heading, issueTable, nextCommand, PLAIN, shellWord, status, stripTerminal, table, UsageError, type TextOptions } from "./text-output.ts";

const command = (...args: string[]) => ["vmem", "proposal", ...args].map(shellWord).join(" ");
function input(file: string, home: string): unknown {
  if (file !== "-" && isDenied(canonicalPath(file), loadRegistry(home).denyPaths)) throw new Error("proposal: input file is denied; choose an allowed file");
  const fd = file === "-" ? 0 : openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (file !== "-" && (!stat.isFile() || stat.size > MAX_PROPOSAL_RECORD_BYTES)) throw new Error("proposal: input must be a regular file no larger than 32 KiB; shorten the input");
    const buffer = Buffer.alloc(MAX_PROPOSAL_RECORD_BYTES + 1); let size = 0, n = 0;
    while (size < buffer.length && (n = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += n;
    if (size > MAX_PROPOSAL_RECORD_BYTES) throw new Error("proposal: input exceeds 32 KiB; shorten the input");
    const bytes = buffer.subarray(0, size), text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("proposal: input is not UTF-8; save the input as UTF-8");
    try { return JSON.parse(text); } catch { throw new UsageError("proposal: input is not JSON; supply a create or patch operation as JSON"); }
  } finally { if (file !== "-") closeSync(fd); }
}
const number = (value: string | boolean | undefined, name: string, minimum: number, maximum: number): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw new UsageError(`proposal: ${name} requires an integer ${minimum}..${maximum}`);
  return Number(value);
};
/** CLI parsing and rendering; all lifecycle semantics stay in the shared provider. */
export function runProposalCommand(args: string[], home: string, env: NodeJS.ProcessEnv, text: TextOptions = PLAIN): { text: string; code: number } {
  const action = args[0], valueFlags: Record<string, string[]> = { submit: ["--agent-label"], list: ["--state", "--limit", "--after"], show: ["--offset", "--max-bytes"], apply: ["--fingerprint"], reject: ["--reason", "--fingerprint"], reconcile: [] };
  if (!action || !Object.hasOwn(valueFlags, action)) throw new UsageError("proposal: use submit, list, show, apply, reject or reconcile");
  const flags: Record<string, string | boolean> = {}, positional: string[] = [];
  let literal = false;
  for (let i = 1; i < args.length; i++) {
    const word = args[i]!;
    if (word === "--" && !literal) { literal = true; continue; }
    if (literal || !word.startsWith("--")) { positional.push(word); continue; }
    if (Object.hasOwn(flags, word)) throw new UsageError(`proposal ${action}: repeated option ${word}`);
    if (word === "--json" || (word === "--confirm" && (action === "apply" || action === "reject"))) { flags[word] = true; continue; }
    if (!valueFlags[action]!.includes(word)) throw new UsageError(`proposal ${action}: unknown option ${word}`);
    const value = args[++i]; if (value === undefined || value.startsWith("--")) throw new UsageError(`proposal ${action}: ${word} requires a value`);
    flags[word] = value;
  }
  const required = action === "list" ? 1 : 2;
  if (positional.length !== required) throw new UsageError(`proposal ${action}: expected ${required === 1 ? "one vault" : "a vault and target"}`);
  const vault = positional[0]!, target = positional[1], ctx: ProposalContext = { channel: "cli", env }, json = flags["--json"] === true;
  const value = (name: string): string | undefined => typeof flags[name] === "string" ? flags[name] as string : undefined;
  if (!["submit", "list"].includes(action) && target !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(target)) throw new UsageError(`proposal ${action}: expected a proposal id from proposal list`);
  if (action === "submit") {
    const label = value("--agent-label");
    if (label !== undefined && (!label.trim() || Buffer.byteLength(label) > 256 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(label))) throw new UsageError("proposal submit: --agent-label needs nonempty text without controls, at most 256 bytes");
    const result = submitProposal(home, { vault, operation: input(target!, home), ...(label !== undefined ? { agentLabel: label } : {}) }, ctx);
    const message = result.stored ? `submitted proposal ${result.id}${result.path ? ` for ${result.path}` : "; inspect current policy"}` : `proposal ${result.id}: storage outcome unknown`;
    return { text: json ? JSON.stringify(result) : blocks(status(result.ok && !result.issues.length ? "ok" : result.stored ? "warn" : "unknown", message, text), issueTable(result.issues, text)), code: result.ok ? 0 : 1 };
  }
  if (action === "list") {
    const state = value("--state");
    if (state !== undefined && !["pending", "applied", "rejected", "apply_unknown"].includes(state)) throw new UsageError("proposal list: invalid --state");
    const after = value("--after");
    if (after !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(after)) throw new UsageError("proposal list: --after needs a returned cursor");
    const result = listProposals(home, { vault, ...(state ? { state: state as "pending" | "applied" | "rejected" | "apply_unknown" } : {}), limit: number(flags["--limit"], "--limit", 1, 100), after }, ctx);
    const rows = result.items.length ? table(["STATE", "PATH", "CREATED", "ID"], result.items.map(item => [item.state, item.path, item.createdAt, item.id]), text) : "no proposals found";
    const next = result.nextCursor ? nextCommand("next", command("list", vault, ...(state ? ["--state", state] : []), ...(flags["--limit"] ? ["--limit", String(flags["--limit"])] : []), "--after", result.nextCursor), text) : undefined;
    return { text: json ? JSON.stringify(result) : blocks(rows, issueTable(result.issues, text), next), code: 0 };
  }
  if (action === "show") {
    const result = showProposal(home, { vault, id: target!, offset: number(flags["--offset"], "--offset", 0, MAX_PROPOSAL_RECORD_BYTES), maxBytes: number(flags["--max-bytes"], "--max-bytes", 1, 16384) }, ctx);
    const next = result.nextOffset !== null && nextCommand("next", command("show", vault, target!, "--offset", String(result.nextOffset), ...(flags["--max-bytes"] ? ["--max-bytes", String(flags["--max-bytes"])] : [])), text);
    return { text: json ? JSON.stringify(result) : blocks(heading(`proposal ${result.id}: ${result.state}`, text), fields([["vault", result.vault], ["path", result.path], ["agent label (unverified)", result.agentLabelUnverified], ["reason", result.decisionReason]], text), issueTable(result.issues, text), stripTerminal(result.content), next), code: 0 };
  }
  if (action === "reconcile") {
    const result = reconcileProposal(home, { vault, id: target! }, ctx);
    return { text: json ? JSON.stringify(result) : blocks(status("unknown", `proposal ${result.id}: apply outcome unknown`, text), fields([["before", result.beforeSha ?? "-"], ["after", result.afterSha ?? "-"], ["observed", result.observedSha ?? "-"], ["receipt evidence", result.receiptEvidence]], text), issueTable(result.issues, text), result.explanation), code: 0 };
  }
  const confirm = flags["--confirm"] === true, fingerprint = value("--fingerprint"), reason = value("--reason");
  if ((confirm && !fingerprint) || (!confirm && fingerprint)) throw new UsageError(`proposal ${action}: --confirm and --fingerprint must be supplied together`);
  if (fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(fingerprint)) throw new UsageError(`proposal ${action}: --fingerprint needs the SHA from a fresh preview`);
  if (action === "apply") {
    if (!confirm) {
      const result = previewProposalApply(home, { vault, id: target! }, ctx);
      return { text: json ? JSON.stringify(result) : blocks(heading(`proposal ${result.id}: apply preview`, text), table(["PATH", "BEFORE", "AFTER", "BYTES"], result.changes.map(change => [change.path, change.beforeSha ?? "-", change.sha256 ?? "-", change.bytes]), text), issueTable(result.issues, text), nextCommand("confirm", command("apply", vault, target!, "--confirm", "--fingerprint", result.fingerprint), text)), code: 0 };
    }
    const result = applyProposal(home, { vault, id: target!, fingerprint: fingerprint! }, ctx);
    return { text: json ? JSON.stringify(result) : blocks(status(result.state === "apply_unknown" ? "unknown" : result.applied ? result.ok && !result.issues.length ? "ok" : "warn" : "fail", `proposal ${target}: ${result.state}${result.logged === false ? "; log not recorded" : ""}`, text), issueTable(result.issues, text)), code: result.ok ? 0 : 1 };
  }
  if (!reason?.trim() || Buffer.byteLength(reason, "utf8") > 4096) throw new UsageError("proposal reject: --reason must be nonempty and at most 4096 bytes");
  if (!confirm) {
    const result = previewProposalReject(home, { vault, id: target!, reason }, ctx);
    return { text: json ? JSON.stringify(result) : blocks(heading(`proposal ${result.id}: rejection preview`, text), fields([["reason", result.reason]], text), issueTable(result.issues, text), nextCommand("confirm", command("reject", vault, target!, "--reason", reason, "--confirm", "--fingerprint", result.fingerprint), text)), code: 0 };
  }
  const result = rejectProposal(home, { vault, id: target!, reason, fingerprint: fingerprint! }, ctx);
  return { text: json ? JSON.stringify(result) : blocks(status(result.rejected ? result.ok && !result.issues.length ? "ok" : "warn" : "fail", `proposal ${target}: ${result.rejected ? "rejected" : "not rejected"}`, text), issueTable(result.issues, text)), code: result.ok ? 0 : 1 };
}
