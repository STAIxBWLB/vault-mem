import { Report } from "@staix/cli-output";
/**
 * Text renderers for writes, two-step previews and promotion (#114): one result line, then changes, issues, the
 * log receipt and, for a preview, the exact confirm command. Note bodies and drafts are never printed; `--json` has them.
 */
import type { ChangeReceipt, WriteIssue, WriteReceipt } from "./write-types.ts";
import type { LogReceipt } from "./log-types.ts";
import type { TidyResult } from "./tidy.ts";
import type { OrgPromoteResult } from "./org-promote.ts";
import { STAGED_DESCRIPTION, type SyncResult } from "./sync.ts";
import type { PromoteResult } from "./promote.ts";
import { notePath } from "./write-operations.ts";
import { plural, shellWord, type TextOptions } from "./text-output.ts";

/** The words the command was run with (`[command, ...args]`, no `--color`) and its positional arguments. */
export interface WriteContext { argv: string[]; positional: string[] }
type Candidates = { projects: { project: string; candidates: { id: string; project: string; kind: string; title: string | null; at: string }[] }[] };

const short = (sha: string | null) => sha ? sha.slice(0, 12) : "-";
const action = (c: ChangeReceipt) => c.beforeSha === null ? "create" : c.sha256 === null ? "delete" : "update";
const errors = (issues: readonly WriteIssue[]) => issues.filter(issue => issue.severity === "error").length;
const stem = (target: string | undefined) => { try { return notePath(target ?? ""); } catch { return target ?? "?"; } };
const report = (name: string, o: TextOptions) => new Report(o.columns, o.ascii).header("vmem", name);
const done = (out: Report, o: TextOptions) => out.render(o.color).join("\n");
function problems(out: Report, issues: readonly WriteIssue[]): void {
  if (!issues.length) return;
  out.section("Problems");
  for (const issue of [...issues].sort((a,b) => Number(b.severity === "error") - Number(a.severity === "error"))) out.bullet(issue.severity === "error" ? "fail" : "warn", `${issue.code}${issue.path ? ` ${issue.path}` : ""}: ${issue.message}`);
}
function items(out: Report, label: string, values: readonly string[] | undefined): void {
  if (!values?.length) return;
  out.section(label); for (const value of values) out.bullet("absent", value);
}
function logReport(out: Report, log: LogReceipt | undefined, label = "Log"): void {
  if (!log) return;
  out.section(label).bullet(log.ok && log.appended ? "ok" : "fail", log.ok && log.appended ? `appended${log.bytesWritten !== null ? ` (${plural(log.bytesWritten, "byte")})` : ""}${log.synced ? "" : ", not yet synced to disk"}` : `not appended${log.rolledBack ? " (rolled back)" : ""}`);
}


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
  const command = ctx.argv[0]!, targets = ctx.positional.slice(1), out = report(command, o);
  const issues = [...r.issues, ...(r.assertions?.issue ? [r.assertions.issue] : []), ...(r.log?.issues ?? [])];
  problems(out, issues);
  if (command === "check") {
    const e = errors(r.issues), w = r.issues.length - e;
    out.section("Validation").kv([["Path", r.changes[0]?.path ?? r.issues.find(issue => issue.path)?.path ?? "the note"]]);
    out.summary({ failed: e || (r.ok ? 0 : 1), warnings: w, ok: r.ok ? 1 : 0 });
    return done(out, o);
  }
  const twoStep = command === "merge" || command === "move" || command === "delete";
  const hasState = r.changes.some(change => change.applied !== undefined);
  const appliedSummary = hasState ? r.changes.filter(change => change.applied).map(change => change.path).join(", ") : what(command, r.changes, targets, true);
  const head = !r.ok ? r.applied ? `failed after writing: ${appliedSummary}; see the issues` : "refused: nothing written"
    : r.preview ? `dry run: would ${what(command, r.changes, targets, false)}` : r.unchanged ? "unchanged: links already present" : !r.applied ? "unchanged: nothing to write" : what(command, r.changes, targets, true);
  out.section("Result").bullet(!r.ok ? "fail" : r.preview ? "pending" : r.applied ? "ok" : "absent", head);
  if (r.changes.length) { out.section("Changes"); for (const change of r.changes) out.bullet(change.applied === false ? "warn" : "absent", `${change.path}: ${action(change)}, ${change.bytes} bytes, sha256 ${change.sha256 ?? "-"}${change.applied === undefined ? "" : change.applied ? ", applied" : ", not applied"}`); }
  if (r.merge && r.preview) {
    out.section("Merge").kv([["Keep", r.merge.keep], ["Absorb", r.merge.absorb], ["Merged body bytes", Buffer.byteLength(r.merge.body)]]).note("The JSON result includes the full merged body.");
    items(out, "Merged sources", r.merge.source); items(out, "Merged topics", r.merge.topics);
    if (r.merge.inboundLinks.length) { out.section("Inbound links"); for (const link of r.merge.inboundLinks) out.bullet("absent", `${link.path}:${link.line ?? "-"} ${link.field}: ${link.target}${link.block ? `#^${link.block}` : link.heading ? `#${link.heading}` : ""} to ${link.replacement}${link.block ? `#^${link.block}` : link.heading ? `#${link.heading}` : ""}`); }
    else out.section("Inbound links").note("none");
  }
  items(out, r.preview ? "Subjects to relink" : "Subjects relinked", r.assertions?.relinked);
  if (r.assertions?.omitted) out.note(`${r.assertions.omitted} relinked subject ids omitted; inspect the assertion journal`);
  items(out, "Possible duplicates", r.possibleDuplicates); items(out, "Retained backups", r.retainedBackups);
  if (r.log) logReport(out, r.log); else if (r.ok && r.preview) out.section("Log").note(twoStep ? "written on confirm" : "none (dry run)");
  if (twoStep && r.ok && r.preview && r.fingerprint) out.next(confirmCommand(ctx.argv, r.fingerprint));
  return done(out, o);
}

/** `tidy`: counts per rule and the notes touched, then the confirm command. */
export function renderTidy(r: TidyResult, o: TextOptions, ctx: WriteContext): string {
  const vault = ctx.positional[0] ?? "?", notes = r.notes.length, logChanges = r.counts.log ?? 0;
  const touched = [notes ? plural(notes, "note") : "", logChanges ? "the log" : ""].filter(Boolean).join(" and ");
  const head = !r.ok ? r.applied ? `failed after writing ${plural(r.written.length, "file")} in ${vault}; rerun to finish` : "refused: nothing written" : !touched ? `unchanged: nothing to tidy in ${vault}` : r.preview ? `dry run: would tidy ${touched} in ${vault}` : `tidied ${touched} in ${vault}`;
  const out = report("tidy", o); problems(out, r.issues);
  out.section("Result").bullet(!r.ok ? "fail" : r.preview ? "pending" : r.applied ? "ok" : "absent", head);
  const counted = r.rules.filter(rule => (r.counts[rule] ?? 0) > 0);
  if (counted.length) out.section("Rules").kv(counted.map(rule => [rule, r.counts[rule]!]));
  if (notes) { out.section("Notes"); for (const note of r.notes) out.bullet("absent", `${note.path}: ${plural(note.changes.length, "change")}`); }
  if (r.reported.length) { out.section("Left unchanged"); for (const item of r.reported) out.bullet("warn", `${item.path}: ${item.message}`); }
  if (r.log && (r.log.redactions || r.log.formats)) out.section("Log").note(`${plural(r.log.redactions, "redaction")} on ${plural(r.log.lines, "line")}, ${plural(r.log.formats, "format fix", "format fixes")}`);
  if (r.ok && r.applied && r.event) out.note(`logged LINT ${r.event}`);
  if (r.ok && r.preview && touched && r.fingerprint) out.next(confirmCommand(ctx.argv, r.fingerprint));
  return done(out, o);
}

/** `promote <vault> <note> --to <org>`. */
export function renderOrgPromote(r: OrgPromoteResult, o: TextOptions, ctx: WriteContext): string {
  const source = r.source ?? ctx.positional[1] ?? "?", target = r.target ?? "the org vault";
  const head = !r.ok ? r.applied ? `promoted ${source} to ${target} with problems; see the issues` : "refused: nothing written" : r.preview ? r.recovery ? `dry run: would record on ${source} that ${target} already holds it` : `dry run: would promote ${source} to ${target}` : r.recovery ? `recorded on ${source} that ${target} holds it` : `promoted ${source} to ${target}`;
  const out = report("promote", o), seen = new Set<string>();
  const issues = [...r.issues, ...r.screen.issues, ...(r.lint?.issues ?? []), ...(r.logs?.target?.issues ?? []), ...(r.logs?.source?.issues ?? [])].filter(issue => !seen.has(JSON.stringify(issue)) && !!seen.add(JSON.stringify(issue)));
  problems(out, issues);
  out.section("Result").bullet(!r.ok ? "fail" : r.preview ? "pending" : "ok", head);
  items(out, "Dropped links", r.droppedLinks); items(out, "Canonical rows", r.canonRowMatches?.map(row => `${row.path}:${row.line} ${row.key}: ${row.row.replace(/`/g, "").replace(/\*\*/g, "")}`));
  items(out, "Canonical table warnings", r.canonTableWarnings); items(out, "Choices", r.choices);
  if (r.lint) out.section("Org lint").bullet(r.lint.passed ? "ok" : "fail", `${r.lint.passed ? "passed" : "failed"}${r.lint.summary ? ` (${r.lint.summary})` : ""}`);
  logReport(out, r.logs?.target ?? undefined, "Target log"); logReport(out, r.logs?.source ?? undefined, "Source log");
  if (r.ok && r.preview && r.fingerprint) out.next(confirmCommand(ctx.argv, r.fingerprint));
  return done(out, o);
}

/** `sync <vault>`. */
export function renderSync(r: SyncResult, o: TextOptions, ctx: WriteContext): string {
  const branch = r.branch ?? "?", origin = r.remote.origin ?? r.remote.configured ?? "origin";
  const work = [r.paths.length ? `commit ${plural(r.paths.length, "path")}` : "", r.behind ? `rebase onto origin/${branch}` : "", r.paths.length || r.ahead ? `push ${branch} to ${origin}` : ""].filter(Boolean).join(", ");
  const head = !r.ok ? r.commit ? `committed ${short(r.commit)} in ${r.vault}; not pushed` : "refused: nothing synced" : r.preview ? work ? `dry run: would ${work}` : `unchanged: ${r.vault} has nothing to sync` : !r.applied ? `unchanged: ${r.vault} is up to date with origin/${branch}` : `synced ${r.vault}: ${r.commit ? `${short(r.commit)} ` : ""}pushed to ${origin} ${branch}`;
  const out = report("sync", o); problems(out, r.issues);
  out.section("Result").bullet(!r.ok ? "fail" : r.preview && work ? "pending" : r.applied ? "ok" : "absent", head);
  if (r.branch !== null) out.kv([["Vault", r.vault], ["Branch", r.branch], ["Remote", r.remote.configured], ["Origin", r.remote.origin], ["Ahead", r.ahead], ["Behind", r.behind]]);
  items(out, "Paths", r.paths); items(out, `Not synced (outside ${STAGED_DESCRIPTION})`, r.ignored);
  if (r.ok && r.preview && work && r.fingerprint) out.next(confirmCommand(ctx.argv, r.fingerprint));
  return done(out, o);
}

/** `promote-from-amem <vault>`: the candidate table per project. */
export function renderCandidates(r: Candidates, o: TextOptions, ctx: WriteContext): string {
  const vault = ctx.positional[0] ?? "?", found = r.projects.filter(p => p.candidates.length), out = report("promote-from-amem", o);
  if (!found.length) out.section("Candidates").note("no promotion candidates");
  for (const project of found) { out.section(project.project, plural(project.candidates.length, "candidate")); out.table(["ID", "Kind", "At", "Title"], project.candidates.map(c => [c.id, c.kind, c.at, c.title ?? ""])); }
  if (found.length) { const first = found[0]!.candidates[0]!; out.next(["vmem", "promote-from-amem", vault, first.id, "--project", first.project].map(shellWord).join(" ")); }
  return done(out, o);
}

/** `promote-from-amem <vault> <mem-id>`: preview or confirm one promotion; `edited` when `--edit` changed the draft. */
export function renderPromote(r: PromoteResult, o: TextOptions, ctx: WriteContext, edited = false): string {
  const mem = `mem:${r.id}`, path = r.path ?? "a new note";
  const head = !r.ok ? r.applied ? `created ${path} from ${mem}, but the promotion is incomplete; see the issues` : "refused: nothing written" : r.preview && r.action === "link" ? r.alreadyLinked ? `unchanged: ${mem} already links ${path}` : `dry run: would link ${mem} to ${path}` : r.preview ? `dry run: would create ${path} from ${mem}` : !r.applied ? `unchanged: ${mem} already links ${path}` : r.action === "link" ? `linked ${mem} to ${path}` : `created ${path} from ${mem}`;
  const out = report("promote-from-amem", o); problems(out, [...r.issues, ...(r.note?.log?.issues ?? [])]);
  out.section("Result").bullet(!r.ok ? "fail" : r.preview && !r.alreadyLinked ? "pending" : r.applied ? "ok" : "absent", head).kv([["Linked", r.linked ?? ""]]);
  if (r.text !== undefined && r.preview) out.note(`draft: ${plural(Buffer.byteLength(r.text), "byte")}; --json shows the text, --edit opens it in $EDITOR`);
  items(out, "Possible duplicates", r.possibleDuplicates); items(out, "Canonical rows", r.canonRowMatches?.map(row => `${row.path}:${row.line} ${row.key}: ${row.row.replace(/`/g, "").replace(/\*\*/g, "")}`));
  items(out, "Canonical table warnings", r.canonTableWarnings); items(out, "Choices", r.choices); logReport(out, r.note?.log);
  if (edited && r.preview) out.section("Edited preview").bullet("warn", "The editor temporary file was removed. Run the edited preview with --json, save its text, then preview with --body before confirming.");
  else if (r.ok && r.preview && !r.alreadyLinked && r.fingerprint) out.next(confirmCommand(ctx.argv, r.fingerprint));
  return done(out, o);
}
