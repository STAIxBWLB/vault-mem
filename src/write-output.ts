import type { CanonRowMatch } from "./canon-tables.ts";
/**
 * Text renderers for writes, two-step previews and promotion (#114): one result line, then changes, issues, the
 * log receipt and, for a preview, the exact confirm command. Note bodies and drafts are never printed; `--json` has them.
 */
import type { ChangeReceipt, WriteIssue, WriteReceipt } from "./write-types.ts";
import type { LogReceipt } from "./log-types.ts";
import type { TidyResult } from "./tidy.ts";
import type { OrgPromoteResult } from "./org-promote.ts";
import type { SyncResult } from "./sync.ts";
import type { PromoteResult } from "./promote.ts";
import { notePath } from "./write-operations.ts";
import { blocks, clean, fields, heading, issueTable, nextCommand, paragraph, plural, shellWord, table, type TextOptions, type Tone } from "./text-output.ts";

/** The words the command was run with (`[command, ...args]`, no `--color`) and its positional arguments. */
export interface WriteContext { argv: string[]; positional: string[] }
type Candidates = { projects: { project: string; candidates: { id: string; project: string; kind: string; title: string | null; at: string }[] }[] };

const line = (text: string, o: TextOptions, t?: Tone) => paragraph(text, o, t);
const list = (label: string, items: readonly string[] | undefined) => items?.length ? [`${label}:`, ...items.map(item => `  - ${clean(item)}`)].join("\n") : undefined;
const canonList = (rows: readonly CanonRowMatch[] | undefined) => list("canonical rows", rows?.map(row => `${row.path}:${row.line} ${row.key}: ${row.row}`));
const short = (sha: string | null) => sha ? sha.slice(0, 12) : "-";
const action = (c: ChangeReceipt) => c.beforeSha === null ? "create" : c.sha256 === null ? "delete" : "update";
const errors = (issues: readonly WriteIssue[]) => issues.filter(issue => issue.severity === "error").length;
const stem = (target: string | undefined) => { try { return notePath(target ?? ""); } catch { return target ?? "?"; } };

/** The preview's own words with `--confirm --fingerprint <sha>`, quoted so it can be pasted. */
export function confirmCommand(argv: readonly string[], fingerprint: string, drop: readonly string[] = []): string {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    if (word === "--fingerprint") { i++; continue; }
    if (!["--json", "--dry-run", "--confirm", ...drop].includes(word)) kept.push(word);
  }
  return ["vmem", ...kept, "--confirm", "--fingerprint", fingerprint].map(shellWord).join(" ");
}
function logLine(log: LogReceipt | undefined, o: TextOptions, label = "log"): string | undefined {
  if (!log) return undefined;
  if (log.ok && log.appended) return line(`${label}: appended${log.bytesWritten !== null ? ` (${plural(log.bytesWritten, "byte")})` : ""}${log.synced ? "" : ", not yet synced to disk"}`, o);
  return blocks(line(`${label}: not appended${log.rolledBack ? " (rolled back)" : ""}`, o, "fail"), issueTable(log.issues, o));
}

const VERBS: Record<string, [string, string]> = {
  new: ["create", "created"], patch: ["patch", "patched"], append: ["append to", "appended to"], frontmatter: ["update the frontmatter of", "updated the frontmatter of"],
  link: ["link", "linked"], supersede: ["supersede", "superseded"], merge: ["merge", "merged"], move: ["move", "moved"], delete: ["delete", "deleted"], report: ["write", "wrote"],
};
function what(command: string, changes: ChangeReceipt[], targets: string[], past: boolean): string {
  const verb = VERBS[command]?.[past ? 1 : 0] ?? command;
  const others = (paths: string[], how: string) => paths.length ? ` and ${how} ${plural(paths.length, "note")}` : "";
  const deleted = changes.filter(c => action(c) === "delete").map(c => c.path), created = changes.filter(c => action(c) === "create").map(c => c.path);
  const updated = changes.filter(c => action(c) === "update").map(c => c.path);
  if (command === "move") return `${verb} ${deleted[0] ?? stem(targets[0])} to ${created[0] ?? stem(targets[1])}${others(updated, past ? "rewrote links in" : "rewrite links in")}`;
  if (command === "merge") return `${verb} ${stem(targets[1])} into ${stem(targets[0])}${others(updated.filter(path => path !== stem(targets[0]) && path !== stem(targets[1])), past ? "rewrote links in" : "rewrite links in")}`;
  if (command === "delete") return `${verb} ${deleted[0] ?? stem(targets[0])}${others(updated, past ? "updated" : "update")}`;
  if (command === "link") return `${verb} ${stem(targets[0])} and ${stem(targets[1])}`;
  if (command === "supersede") return `${verb} ${stem(targets[0])} with ${stem(targets[1])}`;
  return `${verb} ${changes[0]?.path ?? (command === "report" ? targets[0] : stem(targets[0]))}`;
}

/** `new`, `patch`, `append`, `frontmatter`, `link`, `supersede`, `merge`, `move`, `delete`, `report` and `check`. */
export function renderWriteReceipt(r: WriteReceipt, o: TextOptions, ctx: WriteContext): string {
  const command = ctx.argv[0]!, targets = ctx.positional.slice(1), issues = issueTable(r.issues, o);
  if (command === "check") {
    const path = r.changes[0]?.path ?? r.issues.find(issue => issue.path)?.path ?? "the note", e = errors(r.issues), w = r.issues.length - e;
    const verdict = r.ok ? `ok: ${path} passes validation${w ? ` (${plural(w, "warning")})` : ""}` : `fail: ${path} has ${plural(e, "error")}${w ? ` and ${plural(w, "warning")}` : ""}`;
    return blocks(issues, line(verdict, o, r.ok ? "ok" : "fail"));
  }
  const twoStep = command === "merge" || command === "move" || command === "delete";
  const hasState = r.changes.some(change => change.applied !== undefined);
  const appliedSummary = hasState ? r.changes.filter(change => change.applied).map(change => change.path).join(", ") : what(command, r.changes, targets, true);
  let head: string, t: Tone;
  if (!r.ok) [head, t] = r.applied ? [`failed after writing: ${appliedSummary}; see the issues`, "fail"] : ["refused: nothing written", "fail"];
  else if (r.preview) [head, t] = [`dry run: would ${what(command, r.changes, targets, false)}`, "info"];
  else if (r.unchanged) [head, t] = ["unchanged: links already present", "muted"];
  else if (!r.applied) [head, t] = ["unchanged: nothing to write", "muted"];
  else [head, t] = [what(command, r.changes, targets, true), "ok"];
  const one = r.changes.length === 1 && r.ok && !r.preview && r.changes[0]!.sha256 ? fields([["sha256", r.changes[0]!.sha256]], o) : undefined;
  const changes = r.changes.length > 1 || hasState ? table(["PATH", "ACTION", "BYTES", "SHA", ...(hasState ? ["STATE"] : [])], r.changes.map(c => [c.path, action(c), c.sha256 === null ? "-" : c.bytes, short(c.sha256), ...(hasState ? [c.applied ? "applied" : "not applied"] : [])]), o) : undefined;
  const log = r.log ? logLine(r.log, o) : r.ok && r.preview ? line(twoStep ? "log: written on confirm" : "log: none (dry run)", o, "muted") : undefined;
  const confirm = twoStep && r.ok && r.preview && r.fingerprint ? nextCommand("confirm", confirmCommand(ctx.argv, r.fingerprint), o) : undefined;
  const merge = r.merge && r.preview ? blocks(
    fields([["keep", r.merge.keep], ["absorb", r.merge.absorb]], o),
    line(`merged body: ${plural(Buffer.byteLength(r.merge.body), "byte")}; --json shows the full body`, o, "muted"),
    list("merged source", r.merge.source), list("merged topics", r.merge.topics),
    r.merge.inboundLinks.length ? heading("INBOUND LINKS", o) + "\n" + table(["PATH", "FIELD", "TARGET", "REPLACEMENT", "LINE"], r.merge.inboundLinks.map(link => [link.path, link.field, link.target + (link.block ? `#^${link.block}` : link.heading ? `#${link.heading}` : ""), link.replacement + (link.block ? `#^${link.block}` : link.heading ? `#${link.heading}` : ""), link.line ?? "-"]), o) : line("inbound links: none", o, "muted"),
  ) : undefined;
  return blocks([line(head, o, t), one].filter(Boolean).join("\n"), changes, merge, issues, list("possible duplicates", r.possibleDuplicates), list("retained backups", r.retainedBackups), log, confirm);
}

/** `tidy`: counts per rule and the notes touched, then the confirm command. */
export function renderTidy(r: TidyResult, o: TextOptions, ctx: WriteContext): string {
  const vault = ctx.positional[0] ?? "?", notes = r.notes.length, logChanges = r.counts.log ?? 0;
  const touched = [notes ? plural(notes, "note") : "", logChanges ? "the log" : ""].filter(Boolean).join(" and ");
  let head: string, t: Tone;
  if (!r.ok) [head, t] = r.applied ? [`failed after writing ${plural(r.written.length, "file")} in ${vault}; rerun to finish`, "fail"] : ["refused: nothing written", "fail"];
  else if (!touched) [head, t] = [`unchanged: nothing to tidy in ${vault}`, "muted"];
  else if (r.preview) [head, t] = [`dry run: would tidy ${touched} in ${vault}`, "info"];
  else [head, t] = [`tidied ${touched} in ${vault}`, "ok"];
  const counted = r.rules.filter(rule => (r.counts[rule] ?? 0) > 0);
  const rules = counted.length ? table(["RULE", "CHANGES"], counted.map(rule => [rule, r.counts[rule]!]), o) : undefined;
  const noteTable = notes ? table(["NOTE", "CHANGES"], r.notes.map(note => [note.path, note.changes.length]), o) : undefined;
  const reported = r.reported.length ? table(["LEFT UNCHANGED", "REASON"], r.reported.map(item => [item.path, item.message]), o) : undefined;
  const log = r.log && (r.log.redactions || r.log.formats) ? line(`log: ${plural(r.log.redactions, "redaction")} on ${plural(r.log.lines, "line")}, ${plural(r.log.formats, "format fix", "format fixes")}`, o) : undefined;
  const event = r.ok && r.applied && r.event ? line(`logged: LINT ${r.event}`, o) : undefined;
  const confirm = r.ok && r.preview && touched && r.fingerprint ? nextCommand("confirm", confirmCommand(ctx.argv, r.fingerprint), o) : undefined;
  return blocks(line(head, o, t), rules, noteTable, reported, issueTable(r.issues, o), log, event, confirm);
}

/** `promote <vault> <note> --to <org>`. */
export function renderOrgPromote(r: OrgPromoteResult, o: TextOptions, ctx: WriteContext): string {
  const source = r.source ?? ctx.positional[1] ?? "?", target = r.target ?? "the org vault";
  let head: string, t: Tone;
  if (!r.ok) [head, t] = r.applied ? [`promoted ${source} to ${target} with problems; see the issues`, "fail"] : ["refused: nothing written", "fail"];
  else if (r.preview) [head, t] = [r.recovery ? `dry run: would record on ${source} that ${target} already holds it` : `dry run: would promote ${source} to ${target}`, "info"];
  else [head, t] = [r.recovery ? `recorded on ${source} that ${target} holds it` : `promoted ${source} to ${target}`, "ok"];
  const seen = new Set<string>(), issues = [...r.issues, ...r.screen.issues, ...(r.lint?.issues ?? [])].filter(issue => !seen.has(JSON.stringify(issue)) && !!seen.add(JSON.stringify(issue)));
  const lint = r.lint ? line(`org lint: ${r.lint.passed ? "passed" : "failed"}${r.lint.summary ? ` (${r.lint.summary})` : ""}`, o, r.lint.passed ? "ok" : "fail") : undefined;
  const logs = r.logs ? [logLine(r.logs.target ?? undefined, o, "target log"), logLine(r.logs.source ?? undefined, o, "source log")].filter(Boolean).join("\n") : undefined;
  const confirm = r.ok && r.preview && r.fingerprint ? nextCommand("confirm", confirmCommand(ctx.argv, r.fingerprint), o) : undefined;
  return blocks(line(head, o, t), issueTable(issues, o), list("dropped links", r.droppedLinks), canonList(r.canonRowMatches), list("canonical table warnings", r.canonTableWarnings), list("choices", r.choices), lint, logs, confirm);
}

/** `sync <vault>`. */
export function renderSync(r: SyncResult, o: TextOptions, ctx: WriteContext): string {
  const branch = r.branch ?? "?", origin = r.remote.origin ?? r.remote.configured ?? "origin";
  const work = [r.paths.length ? `commit ${plural(r.paths.length, "path")}` : "", r.behind ? `rebase onto origin/${branch}` : "", r.paths.length || r.ahead ? `push ${branch} to ${origin}` : ""].filter(Boolean).join(", ");
  let head: string, t: Tone;
  if (!r.ok) [head, t] = r.commit ? [`committed ${short(r.commit)} in ${r.vault}; not pushed`, "fail"] : ["refused: nothing synced", "fail"];
  else if (r.preview) [head, t] = work ? [`dry run: would ${work}`, "info"] : [`unchanged: ${r.vault} has nothing to sync`, "muted"];
  else if (!r.applied) [head, t] = [`unchanged: ${r.vault} is up to date with origin/${branch}`, "muted"];
  else [head, t] = [`synced ${r.vault}: ${r.commit ? `${short(r.commit)} ` : ""}pushed to ${origin} ${branch}`, "ok"];
  const info = r.branch === null ? "" : fields([["vault", r.vault], ["branch", r.branch], ["remote", r.remote.configured], ["origin", r.remote.origin], ["ahead", r.ahead], ["behind", r.behind]], o);
  const paths = r.paths.length ? table(["PATH"], r.paths.map(path => [path]), o) : undefined;
  const confirm = r.ok && r.preview && work && r.fingerprint ? nextCommand("confirm", confirmCommand(ctx.argv, r.fingerprint), o) : undefined;
  return blocks([line(head, o, t), info].filter(Boolean).join("\n"), paths, list("not synced (outside notes/, reports/ and log)", r.ignored), issueTable(r.issues, o), confirm);
}

/** `promote-from-amem <vault>`: the candidate table per project. */
export function renderCandidates(r: Candidates, o: TextOptions, ctx: WriteContext): string {
  const vault = ctx.positional[0] ?? "?", found = r.projects.filter(p => p.candidates.length);
  if (!found.length) return line("no promotion candidates", o, "muted");
  const first = found[0]!.candidates[0]!;
  return blocks(...found.map(p => [line(`${p.project}: ${plural(p.candidates.length, "candidate")}`, o, "bold"), table(["ID", "KIND", "AT", "TITLE"], p.candidates.map(c => [c.id, c.kind, c.at, c.title ?? "-"]), o)].join("\n")),
    nextCommand("preview one", ["vmem", "promote-from-amem", vault, first.id, "--project", first.project].map(shellWord).join(" "), o));
}

/** `promote-from-amem <vault> <mem-id>`: preview or confirm one promotion; `edited` when `--edit` changed the draft. */
export function renderPromote(r: PromoteResult, o: TextOptions, ctx: WriteContext, edited = false): string {
  const mem = `mem:${r.id}`, path = r.path ?? "a new note";
  let head: string, t: Tone;
  if (!r.ok) [head, t] = r.applied ? [`created ${path} from ${mem}, but the promotion is incomplete; see the issues`, "fail"] : ["refused: nothing written", "fail"];
  else if (r.preview && r.action === "link") [head, t] = r.alreadyLinked ? [`unchanged: ${mem} already links ${path}`, "muted"] : [`dry run: would link ${mem} to ${path}`, "info"];
  else if (r.preview) [head, t] = [`dry run: would create ${path} from ${mem}`, "info"];
  else if (!r.applied) [head, t] = [`unchanged: ${mem} already links ${path}`, "muted"];
  else [head, t] = [r.action === "link" ? `linked ${mem} to ${path}` : `created ${path} from ${mem}`, "ok"];
  const draft = r.text !== undefined && r.preview ? line(`draft: ${plural(Buffer.byteLength(r.text), "byte")}; --json shows the text, --edit opens it in $EDITOR`, o, "muted") : undefined;
  const info = fields([["linked", r.linked ?? ""]], o);
  const hint = edited && r.preview ? line("edited text is only previewed: save it and confirm with --body <file> and this fingerprint", o, "warn") : undefined;
  const command = r.ok && r.preview && !r.alreadyLinked && r.fingerprint ? confirmCommand(ctx.argv, r.fingerprint, edited ? ["--edit"] : []) : undefined;
  return blocks([line(head, o, t), info].filter(Boolean).join("\n"), draft, issueTable(r.issues, o), list("possible duplicates", r.possibleDuplicates), canonList(r.canonRowMatches), list("canonical table warnings", r.canonTableWarnings), list("choices", r.choices),
    logLine(r.note?.log, o), hint, command && nextCommand("confirm", edited ? command.replace(/ --confirm /, " --body <file> --confirm ") : command, o));
}
