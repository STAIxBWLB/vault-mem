import { Report, terminalText } from "@staix/cli-output";
/**
 * Text renderers for `vmem spec get|graph|grep|validate` (#114). Each one reads the same result object `--json` prints
 * and never adds content to it; table and field values are sanitized, and bodies keep their lines with
 * terminal escape sequences stripped.
 */
import type { SpecDeleteResult, SpecWriteResult } from "./spec-write.ts";
import type { SpecCommand } from "./spec-command-table.ts";
import type { SpecEdge, SpecNode } from "./spec-graph.ts";
import type { SpecFreshnessEntry } from "./spec-freshness.ts";
import type { SpecValidationIssue, SpecValidationReport } from "./spec-validate.ts";
import { plural, shellWord, type TextOptions } from "./text-output.ts";

/** What the renderers need from the command line: the spec arguments (`get root --body`) and their parsed values. */
export interface SpecTextContext { args: readonly string[]; values: Record<string, unknown>; repo?: string }
export interface SpecGetResult {
  source: string; worktree: string; id: string; path: string; sha256: string; frontmatter: Record<string, unknown>;
  links: SpecEdge[]; backlinks: SpecEdge[]; children: SpecNode[]; freshness: SpecFreshnessEntry | null; freshnessIssues: SpecValidationIssue[];
  truncated: boolean; totals: { links: number; backlinks: number; children: number };
  body?: string; bodyTruncated?: boolean; nextOffset?: number; headings?: string[]; headingsTruncated?: boolean; section?: string; offset?: number;
}
export interface SpecGraphResult { source: string; worktree: string; nodes: SpecNode[]; edges: SpecEdge[]; truncated: boolean }
export interface SpecGrepHit { id: string; path: string; title: string; type: string; status?: string; snippet: string; score?: number }
export interface SpecGrepResult { source: string; worktree: string; hits: SpecGrepHit[]; offset: number; truncated: boolean; nextOffset?: number }
export type SpecValidateResult = SpecValidationReport & { source?: string; worktree?: string };

const report = (name: string, o: TextOptions) => new Report(o.columns, o.ascii).header("vmem", name);
const done = (out: Report, o: TextOptions) => out.render(o.color).join("\n");
const value = (data: unknown): string => typeof data === "string" ? data : Array.isArray(data) ? data.map(value).join(", ") : data === undefined || data === null ? "" : JSON.stringify(data);
const counted = (shown: number, total: number) => shown < total ? ` (${shown} of ${total})` : "";
/** The same command with `--offset` set, inserted before a `--` separator so it stays an option. */
export function offsetCommand(args: readonly string[], offset: number): string {
  const end = args.includes("--") ? args.indexOf("--") : args.length;
  const head = args.slice(0, end).filter((arg, i, all) => arg !== "--offset" && all[i - 1] !== "--offset");
  return ["vmem", "spec", ...head, "--offset", String(offset), ...args.slice(end)].map(shellWord).join(" ");
}
const staleText = (entry: SpecFreshnessEntry) => [entry.commits > 0 && `${plural(entry.commits, "commit")} since verified-against`, entry.dirty && "uncommitted changes"].filter(Boolean).join(", ") || "source scope changed";

export function renderSpecGet(r: SpecGetResult, o: TextOptions, context: SpecTextContext): string {
  const data = r.frontmatter, out = report("spec get", o);
  if (r.freshnessIssues.length) { out.section("Problems"); for (const issue of r.freshnessIssues) out.bullet(issue.severity === "error" ? "fail" : "warn", `${issue.code}: ${finding(issue)}`); }
  out.section("Spec").kv([["ID", r.id], ["Title", value(data.title)], ["Type", value(data.type)], ["Status", value(data.status)], ["Parent", value(data.parent)], ["Depends on", value(data["depends-on"])], ["Covers", value(data.covers)], ["Paths", value(data.paths)], ["Path", r.path], ["Source", r.source], ["Freshness", r.freshness ? r.freshness.state === "fresh" ? r.freshness.dirty ? "fresh, uncommitted changes" : "fresh" : `stale: ${staleText(r.freshness)}` : null], ["Links", r.links.map(edge => `${edge.kind} ${edge.target}`).join(", ") + counted(r.links.length, r.totals.links)], ["Backlinks", r.backlinks.map(edge => `${edge.kind} ${edge.source}`).join(", ") + counted(r.backlinks.length, r.totals.backlinks)], ["Children", r.children.map(node => node.id).join(", ") + counted(r.children.length, r.totals.children)], ["Section", r.section], ["Offset", r.offset]]);
  if (r.headings?.length) { out.section("Headings"); for (const heading of r.headings) out.bullet("absent", heading); if (r.headingsTruncated) out.note("more headings"); }
  if (r.body === undefined) return done(out, o);
  out.section("Content");
  const body = terminalText(r.body).replace(/\n+$/, "");
  if (!r.bodyTruncated || r.nextOffset === undefined) return `${done(out, o)}\n${body}`;
  const tail = new Report(o.columns, o.ascii).section("Continuation").next(offsetCommand(context.args, r.nextOffset));
  return `${done(out, o)}\n${body}\n\n${done(tail, o)}`;
}

/** The slice as a table in breadth-first order from the root: DEPTH and EDGE say how each node was reached. */
export function renderSpecGraph(r: SpecGraphResult, o: TextOptions, context: SpecTextContext): string {
  const root = r.nodes[0], direction = typeof context.values.direction === "string" ? context.values.direction : "subtree", out = report("spec graph", o);
  if (!root) { out.section("Graph").note("no nodes"); return done(out, o); }
  const reached = new Map<string, { depth: number; edge?: SpecEdge }>([[root.id, { depth: 0 }]]), queue = [root.id];
  for (let i = 0; i < queue.length; i++) { const at = queue[i]!, depth = reached.get(at)!.depth + 1; for (const edge of r.edges) {
    const next = direction !== "subtree" && edge.source === at ? edge.target : direction !== "ancestors" && edge.target === at ? edge.source : undefined;
    if (next === undefined || reached.has(next)) continue; reached.set(next, { depth, edge }); queue.push(next);
  } }
  out.section("Graph").kv([["Root", root.id], ["Direction", direction], ["Edge", typeof context.values.edge === "string" ? context.values.edge : direction === "neighbors" ? "all" : "parent"], ["Depth", typeof context.values.depth === "number" ? context.values.depth : 1], ["Nodes", r.nodes.length], ["Edges", r.edges.length]]);
  const nodes = [...r.nodes].sort((a,b) => (reached.get(a.id)?.depth ?? 9) - (reached.get(b.id)?.depth ?? 9));
  out.section("Nodes").table(["ID", "Type", "Status", "Edge", "Depth", "Title"], nodes.map(node => { const how = reached.get(node.id); return [node.id, node.type, node.status ?? "", how?.edge?.kind ?? "", how ? String(how.depth) : "", node.title]; }));
  const tree = new Set([...reached.values()].flatMap(how => how.edge ? [how.edge] : [])), other = r.edges.filter(edge => !tree.has(edge));
  if (other.length) out.section("Other edges").table(["Source", "Edge", "Target"], other.map(edge => [edge.source, edge.kind, edge.target]));
  if (r.truncated) out.bullet("warn", "truncated: more specs lie beyond this slice; raise --depth (up to 3) or --limit (up to 500)");
  return done(out, o);
}

/** One hit per row, its snippet on the next line; rows never wrap so each snippet stays under its row. */
export function renderSpecGrep(r: SpecGrepResult, o: TextOptions, context: SpecTextContext): string {
  const out = report("spec grep", o).section("Results").kv([["Offset", r.offset], ["Hits", r.hits.length]]);
  if (!r.hits.length) out.note(r.offset ? `no more hits after offset ${r.offset}` : "no specs matched");
  for (const hit of r.hits) { out.bullet("absent", `${hit.id}: ${hit.title} (${hit.type}, ${hit.status ?? "unknown"})`); const snippet = terminalText(hit.snippet).replace(/\s+/g, " ").trim(); if (snippet) out.note(snippet); }
  if (r.truncated && r.nextOffset !== undefined) out.next(offsetCommand(context.args, r.nextOffset));
  return done(out, o);
}

const finding = (item: { path: string; field?: string; target?: string; firstPath?: string; message: string }) =>
  `${item.path}${item.field ? ` ${item.field}` : ""}${item.target ?? item.firstPath ? ` -> ${item.target ?? item.firstPath}` : ""}: ${item.message}`;

/** LEVEL/CHECK/FINDING rows per section, then a verdict line. Stale scopes are their own section unless --require-fresh made them errors. */
export function renderSpecValidate(r: SpecValidateResult, o: TextOptions, context: SpecTextContext): string {
  const out = report("spec validate", o), stale = r.freshness.filter(entry => entry.state === "stale");
  if (r.items.length) { out.section("Findings"); for (const item of [...r.items].sort((a,b) => Number(b.severity === "error") - Number(a.severity === "error"))) out.bullet(item.severity === "error" ? "fail" : "warn", `${item.code}: ${finding(item)}`); }
  if (context.values.requireFresh !== true && stale.length) { out.section("Freshness"); for (const entry of stale) out.bullet("warn", `${entry.path}${entry.id ? ` (${entry.id})` : ""}: ${staleText(entry)}; review the scope and refresh verified-against`); }
  if (r.diagnostics.length) { out.section("Discovery"); for (const item of r.diagnostics) out.bullet("absent", `${item.code}: ${finding(item)}`); }
  if (r.truncated) out.section("Coverage").bullet("warn", `truncated: ${r.items.length} of ${r.errors + r.warnings} findings shown; raise --limit (up to 500) or fix the listed findings and rerun`);
  out.section("Scope").kv([["Source", context.repo !== undefined ? `--repo ${context.repo}` : r.source]]);
  out.summary({ failed: r.errors || (r.ok ? 0 : 1), warnings: r.warnings + (context.values.requireFresh === true ? 0 : stale.length), ok: r.ok && !r.errors && !r.warnings && !stale.length ? 1 : 0 });
  return done(out, o);
}

function specIssues(out: Report, issues: SpecWriteResult["issues"]): void {
  if (!issues.length) return;
  out.section("Problems");
  for (const issue of [...issues].sort((a,b) => Number(b.severity === "error") - Number(a.severity === "error"))) out.bullet(issue.severity === "error" ? "fail" : "warn", `${issue.code}${issue.path ? ` ${issue.path}` : ""}: ${issue.message}${issue.target !== undefined ? `; target: ${issue.target}` : ""}${issue.originalTarget !== undefined ? `; original target: ${issue.originalTarget}` : ""}`);
}
export function renderSpecUpdate(r: SpecWriteResult, o: TextOptions, command: "create" | "update" = "update"): string {
  const applied = command === "create" ? "created" : "updated", verdict = r.changed ? r.ok ? applied : `${applied} with errors` : r.ok ? "unchanged" : "refused", out = report(`spec ${command}`, o);
  specIssues(out, r.issues);
  out.section("Result").bullet(r.ok ? r.changed ? "ok" : "absent" : "fail", `${r.id ?? "spec"}: ${verdict}`).kv([["Source", r.source], ["Worktree", r.worktree], ["Path", r.path], ["SHA256", r.sha256], ["Actor", r.actor]]);
  return done(out, o);
}

export function renderSpecDelete(r: SpecDeleteResult, o: TextOptions): string {
  const verdict = r.changed ? r.ok ? "deleted" : "deleted with errors" : !r.ok ? "refused" : r.preview ? "preview" : "unchanged", out = report("spec delete", o);
  specIssues(out, r.issues);
  out.section("Result").bullet(!r.ok ? "fail" : r.preview ? "pending" : r.changed ? "ok" : "absent", `${r.id ?? "spec"}: ${verdict}`).kv([["Source", r.source], ["Worktree", r.worktree], ["Path", r.path], ["SHA256", r.sha256], ["Actor", r.actor], ["Fingerprint", r.fingerprint]]);
  if (r.preview) {
    out.section("Backlinks"); if (r.backlinks?.length) out.table(["Source", "Edge", "Target"], r.backlinks.map(edge => [edge.source, edge.kind, edge.target])); else out.note("none");
    out.section("Children"); if (r.children?.length) out.table(["ID", "Type", "Path", "Title"], r.children.map(child => [child.id, child.type, child.path, child.title])); else out.note("none");
  }
  if (r.ok && r.preview && r.fingerprint && r.id !== undefined) out.next(["vmem", "spec", "delete", ...(r.source ? ["--source", r.source] : []), ...(r.worktree ? ["--worktree", r.worktree] : []), "--confirm", "--fingerprint", r.fingerprint, "--", r.id].map(shellWord).join(" "));
  return done(out, o);
}

export function renderSpec(command: SpecCommand, result: unknown, o: TextOptions, context: SpecTextContext): string {
  if (command === "delete") return renderSpecDelete(result as SpecDeleteResult, o);
  if (command === "update" || command === "create") return renderSpecUpdate(result as SpecWriteResult, o, command);
  if (command === "get") return renderSpecGet(result as SpecGetResult, o, context);
  if (command === "graph") return renderSpecGraph(result as SpecGraphResult, o, context);
  if (command === "grep") return renderSpecGrep(result as SpecGrepResult, o, context);
  return renderSpecValidate(result as SpecValidateResult, o, context);
}
