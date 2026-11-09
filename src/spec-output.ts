/**
 * Text renderers for `vmem spec get|graph|grep|validate` (#114). Each one reads the same result object `--json` prints
 * and never adds content to it; data goes through `clean()` in tables and fields, and bodies keep their lines with
 * terminal escape sequences stripped.
 */
import type { SpecWriteResult } from "./spec-write.ts";
import type { SpecCommand } from "./spec-command-table.ts";
import type { SpecEdge, SpecNode } from "./spec-graph.ts";
import type { SpecFreshnessEntry } from "./spec-freshness.ts";
import type { SpecValidationIssue, SpecValidationReport } from "./spec-validate.ts";
import type { SpecDiagnostic } from "./spec-source.ts";
import { blocks, fields, heading, issueTable, nextCommand, paint, paragraph, plural, shellWord, table, tone, type CellInput, type TextOptions, stripTerminal } from "./text-output.ts";

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

const value = (data: unknown): string => typeof data === "string" ? data : Array.isArray(data) ? data.map(value).join(", ") : data === undefined || data === null ? "" : JSON.stringify(data);
const statusTone = (status: string | undefined): CellInput => status === "active" ? tone(status, "ok") : status === "deprecated" ? tone(status, "warn") : status ?? "-";
const counted = (shown: number, total: number) => shown < total ? ` (${shown} of ${total})` : "";
/** The same command with `--offset` set, inserted before a `--` separator so it stays an option. */
export function offsetCommand(args: readonly string[], offset: number): string {
  const end = args.includes("--") ? args.indexOf("--") : args.length;
  const head = args.slice(0, end).filter((arg, i, all) => arg !== "--offset" && all[i - 1] !== "--offset");
  return ["vmem", "spec", ...head, "--offset", String(offset), ...args.slice(end)].map(shellWord).join(" ");
}
function freshnessText(entry: SpecFreshnessEntry | null): CellInput {
  if (!entry) return undefined;
  if (entry.state === "fresh") return tone(entry.dirty ? "fresh, uncommitted changes" : "fresh", entry.dirty ? "warn" : "ok");
  return tone(`stale: ${staleText(entry)}`, "warn");
}
const staleText = (entry: SpecFreshnessEntry) => [entry.commits > 0 && `${plural(entry.commits, "commit")} since verified-against`, entry.dirty && "uncommitted changes"].filter(Boolean).join(", ") || "source scope changed";

export function renderSpecGet(r: SpecGetResult, o: TextOptions, context: SpecTextContext): string {
  const data = r.frontmatter, title = typeof data.title === "string" ? data.title : "";
  const info = fields([
    ["type", value(data.type)], ["status", typeof data.status === "string" ? statusTone(data.status) : value(data.status)],
    ["parent", value(data.parent)], ["depends-on", value(data["depends-on"])], ["covers", value(data.covers)], ["paths", value(data.paths)],
    ["path", r.path], ["source", r.source], ["freshness", freshnessText(r.freshness)],
    ["links", r.links.map(edge => `${edge.kind} ${edge.target}`).join(", ") + counted(r.links.length, r.totals.links)],
    ["backlinks", r.backlinks.map(edge => `${edge.kind} ${edge.source}`).join(", ") + counted(r.backlinks.length, r.totals.backlinks)],
    ["children", r.children.map(node => node.id).join(", ") + counted(r.children.length, r.totals.children)],
    ["section", r.section], ["offset", r.offset],
    ["sections", r.headings?.length ? r.headings.join(", ") + (r.headingsTruncated ? ", ..." : "") : undefined],
  ], o);
  const body = r.body === undefined ? undefined : stripTerminal(r.body).replace(/\n+$/, "");
  return blocks(heading(`spec ${r.id}${title ? `: ${title}` : ""}`, o), info, issueTable(r.freshnessIssues, o), body,
    r.bodyTruncated && r.nextOffset !== undefined && nextCommand("next", offsetCommand(context.args, r.nextOffset), o));
}

/** The slice as a table in breadth-first order from the root: DEPTH and EDGE say how each node was reached. */
export function renderSpecGraph(r: SpecGraphResult, o: TextOptions, context: SpecTextContext): string {
  const root = r.nodes[0], direction = typeof context.values.direction === "string" ? context.values.direction : "subtree";
  if (!root) return paragraph("spec graph: no nodes", o);
  const reached = new Map<string, { depth: number; edge?: SpecEdge }>([[root.id, { depth: 0 }]]), queue = [root.id];
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]!, depth = reached.get(at)!.depth + 1;
    for (const edge of r.edges) {
      const next = direction !== "subtree" && edge.source === at ? edge.target : direction !== "ancestors" && edge.target === at ? edge.source : undefined;
      if (next === undefined || reached.has(next)) continue;
      reached.set(next, { depth, edge }); queue.push(next);
    }
  }
  const order = (node: SpecNode) => reached.get(node.id)?.depth ?? 9;
  const nodes = [...r.nodes].sort((a, b) => order(a) - order(b));
  const rows = nodes.map(node => { const how = reached.get(node.id); return [tone(node.id, "info"), node.type || "-", statusTone(node.status), how?.edge?.kind ?? "-", how ? how.depth : "-", node.title]; });
  const tree = new Set([...reached.values()].flatMap(how => how.edge ? [how.edge] : []));
  const other = r.edges.filter(edge => !tree.has(edge));
  const edge = typeof context.values.edge === "string" ? `${context.values.edge} edges` : direction === "neighbors" ? "all edges" : "parent edges";
  return blocks(heading(`spec graph ${root.id}: ${direction}, ${edge}, depth ${typeof context.values.depth === "number" ? context.values.depth : 1}`, o),
    table(["ID", "TYPE", "STATUS", "EDGE", "DEPTH", "TITLE"], rows, o),
    other.length > 0 && table(["SOURCE", "EDGE", "TARGET"], other.map(item => [item.source, item.kind, item.target]), o),
    [paragraph(`${plural(r.nodes.length, "node")}, ${plural(r.edges.length, "edge")}`, o),
      r.truncated && paragraph("truncated: more specs lie beyond this slice; raise --depth (up to 3) or --limit (up to 500)", o, "warn")].filter(Boolean).join("\n"));
}

/** One hit per row, its snippet on the next line; rows never wrap so each snippet stays under its row. */
export function renderSpecGrep(r: SpecGrepResult, o: TextOptions, context: SpecTextContext): string {
  if (!r.hits.length) return paragraph(r.offset ? `no more hits after offset ${r.offset}` : "no specs matched", o);
  const lines = table(["ID", "TYPE", "STATUS", "TITLE"], r.hits.map(hit => [tone(hit.id, "info"), hit.type || "-", statusTone(hit.status), hit.title]), { color: o.color }).split("\n");
  const body = [lines[0]!, ...r.hits.flatMap((hit, i) => [lines[i + 1]!, paragraph(stripTerminal(hit.snippet).replace(/\s+/g, " ").trim(), o, "muted", "  ")])].join("\n");
  const range = r.offset || r.truncated ? `hits ${r.offset + 1}-${r.offset + r.hits.length}` : plural(r.hits.length, "hit");
  return blocks(body, [paragraph(range + (r.truncated ? ", more remain" : ""), o),
    r.truncated && r.nextOffset !== undefined && nextCommand("next", offsetCommand(context.args, r.nextOffset), o)].filter(Boolean).join("\n"));
}

const finding = (item: { path: string; field?: string; target?: string; firstPath?: string; message: string }) =>
  `${item.path}${item.field ? ` ${item.field}` : ""}${item.target ?? item.firstPath ? ` -> ${item.target ?? item.firstPath}` : ""}: ${item.message}`;
const levelCell = (severity: SpecValidationIssue["severity"]) => tone(severity, severity === "error" ? "fail" : "warn");

/** LEVEL/CHECK/FINDING rows per section, then a verdict line. Stale scopes are their own section unless --require-fresh made them errors. */
export function renderSpecValidate(r: SpecValidateResult, o: TextOptions, context: SpecTextContext): string {
  const section = (title: string, rows: CellInput[][]) => rows.length > 0 && `${heading(title, o)}\n${table(["LEVEL", "CHECK", "FINDING"], rows, o)}`;
  const stale = r.freshness.filter(entry => entry.state === "stale");
  const target = context.repo !== undefined ? `--repo ${context.repo}` : r.source ?? "";
  const verdict = `${r.ok ? "ok" : "fail"}: ${plural(r.errors, "error")}, ${plural(r.warnings, "warning")}, ${plural(stale.length, "stale scope")}`;
  return blocks(heading(`spec validate ${target}`.trim(), o),
    section("Findings", r.items.map(item => [levelCell(item.severity), item.code, finding(item)])),
    section("Discovery", r.diagnostics.map((item: SpecDiagnostic) => [tone("note", "muted"), item.code, finding(item)])),
    context.values.requireFresh !== true && section("Freshness", stale.map(entry => [tone("warning", "warn"), "stale",
      `${entry.path}${entry.id ? ` (${entry.id})` : ""}: ${staleText(entry)}; review the scope and refresh verified-against`])),
    [r.truncated && paragraph(`truncated: ${r.items.length} of ${r.errors + r.warnings} findings shown; raise --limit (up to 500) or fix the listed findings and rerun`, o, "warn"),
      paint(verdict, r.ok ? "ok" : "fail", o)].filter(Boolean).join("\n"));
}

/** A frontmatter mutation receipt shows the verdict and SHA without repeating authored content. */
export function renderSpecUpdate(r: SpecWriteResult, o: TextOptions): string {
  const verdict = r.ok ? r.changed ? "updated" : "unchanged" : "refused";
  return blocks(heading(`spec update ${r.id ?? ""}: ${verdict}`.trim(), o),
    fields([["source", r.source], ["worktree", r.worktree], ["path", r.path], ["sha256", r.sha256], ["actor", r.actor]], o),
    issueTable(r.issues.map(issue => ({ ...issue, message: [issue.message,
      issue.target !== undefined ? `target: ${issue.target}` : undefined,
      issue.originalTarget !== undefined ? `original target: ${issue.originalTarget}` : undefined].filter(Boolean).join("; ") })), o));
}

export function renderSpec(command: SpecCommand, result: unknown, o: TextOptions, context: SpecTextContext): string {
  if (command === "update") return renderSpecUpdate(result as SpecWriteResult, o);
  if (command === "get") return renderSpecGet(result as SpecGetResult, o, context);
  if (command === "graph") return renderSpecGraph(result as SpecGraphResult, o, context);
  if (command === "grep") return renderSpecGrep(result as SpecGrepResult, o, context);
  return renderSpecValidate(result as SpecValidateResult, o, context);
}
