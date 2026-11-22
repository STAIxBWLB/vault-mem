import { Report } from "@staix/cli-output";
/**
 * Text views for the read, log and analysis commands (#114). Each renderer is pure, takes the same result the
 * command prints with `--json`, and never shows more than that result carries.
 */
import type { SearchResult, NoteReadResult } from "./vault-index.ts";
import type { ResolvedLink, SuggestedLink } from "./links.ts";
import type { LogReadResult, LogReceipt } from "./log-types.ts";
import type { LintCode, LintReport } from "./analysis-types.ts";
import type { GraphNeighborhood, GraphPath } from "./vault-graph.ts";
import type { WriteIssue, WriteReceipt } from "./write-types.ts";
import type { EvidenceReport } from "./evidence.ts";
import type { GraphExplanation } from "./graph-evidence.ts";
import { plural, shellWord, type TextOptions, stripTerminal } from "./text-output.ts";

const command = (...words: string[]) => ["vmem", ...words].map(shellWord).join(" ");
const report = (name: string, o: TextOptions) => new Report(o.columns, o.ascii).header("vmem", name);
const done = (r: Report, o: TextOptions) => r.render(o.color).join("\n");

export function searchText(hits: SearchResult[], o: TextOptions, c: { vault: string; query: string; limit: number; type?: string; domain?: string }): string {
  const out = report("search", o).section("Results").kv([["Vault", c.vault], ["Query", c.query], ["Results", hits.length]]);
  for (const hit of hits) { out.bullet("absent", `${hit.path}: ${hit.title} (${hit.type})`); if (stripTerminal(hit.snippet).trim()) out.note(stripTerminal(hit.snippet).trim()); }
  if (hits.length >= c.limit && c.limit < 500) out.next(command("search", c.vault, c.query, ...(c.type ? ["--type", c.type] : []), ...(c.domain ? ["--domain", c.domain] : []), "--limit", String(Math.min(500, c.limit * 2))));
  return done(out, o);
}

export function showText(r: NoteReadResult, o: TextOptions, c: { vault: string; target: string; maxBytes?: number }): string {
  const out = report("show", o).section("Note").kv([["Path", r.path], ["Section", r.section], ["SHA256", r.hash.slice(0, 12)], ["Bytes", Buffer.byteLength(r.content)], ["Offset", r.offset]]).section("Content");
  const body = stripTerminal(r.content).replace(/\n+$/, "");
  if (!r.truncated) return `${done(out, o)}\n${body}`;
  const tail = new Report(o.columns, o.ascii).section("Continuation").bullet("warn", "truncated");
  if (r.nextOffset !== undefined) tail.next(command("show", c.vault, c.target, ...(r.section ? ["--section", r.section] : []), ...(c.maxBytes !== undefined ? ["--max-bytes", String(c.maxBytes)] : []), "--offset", String(r.nextOffset)));
  if (r.headings?.length) { tail.section("H2 headings"); for (const heading of r.headings) tail.bullet("absent", heading); if (r.headingsTruncated) tail.note("more headings"); }
  return `${done(out, o)}\n${body}\n\n${done(tail, o)}`;
}

/** A listed link; a dead one may carry the one hinted target, as `vmem links --json` and `vmem_links` return it. */
export function linksText(links: SuggestedLink[], o: TextOptions, c: { vault: string; target: string; limit: number }): string {
  const out = report("links", o).section("Outgoing links").kv([["Source", links[0]?.source ?? c.target], ["Links", links.length]]);
  const target = (l: ResolvedLink) => l.target + (l.heading !== null ? `#${l.heading}` : "") + (l.block !== null ? `#^${l.block}` : "");
  for (const l of [...links].sort((a,b) => Number(!b.resolved) - Number(!a.resolved))) out.bullet(l.resolved ? "ok" : "warn", `${target(l)}: ${l.resolved ?? l.reason ?? "unresolved"}${l.suggested ? `; suggested ${l.suggested.path} (${l.suggested.score.toFixed(3)})` : ""} (line ${l.line})`);
  if (links.length >= c.limit && c.limit < 500) out.next(command("links", c.vault, c.target, "--limit", String(Math.min(500, c.limit * 2))));
  return done(out, o);
}

export function rebuildText(r: { vault: string; notes: number; changed: number; removed: number; skipped?: string[] }, o: TextOptions): string {
  return done(report("rebuild", o).section("Index").kv([["Vault", r.vault], ["Notes", r.notes], ["Changed", r.changed], ["Removed", r.removed], ["Skipped", r.skipped?.length ?? 0]]), o);
}

export function logReadText(r: LogReadResult, o: TextOptions, c: { command: "tail" | "grep"; vault: string; pattern?: string; limit: number; type?: string }): string {
  const out = report(`log ${c.command}`, o);
  if (r.issues.length || r.warnings.length || !r.ok) { out.section("Problems"); if (!r.ok) out.bullet("fail", "log not read"); for (const issue of r.issues) out.bullet("fail", `${issue.code}: ${issue.message}`); for (const warning of r.warnings) out.bullet("warn", warning); }
  out.section("Events").kv([["Vault", c.vault], ["Lines", r.lines.length], ["Log lines", r.dataLines]]);
  for (const line of r.lines) out.bullet("absent", line);
  if (r.lines.length >= c.limit && c.limit < 200) out.next(command("log", c.command, c.vault, ...(c.pattern !== undefined ? [c.pattern] : []), ...(c.type ? ["--type", c.type] : []), "--limit", String(Math.min(200, c.limit * 2))));
  return done(out, o);
}

export function logAppendText(r: LogReceipt, o: TextOptions, c: { vault: string; type: string }): string {
  const out = report("log append", o);
  if (r.issues.length) { out.section("Problems"); for (const issue of r.issues) out.bullet(issue.severity === "error" ? "fail" : "warn", `${issue.code}: ${issue.message}`); }
  out.section("Result").bullet(r.ok && r.appended ? "ok" : "fail", r.ok && r.appended ? `appended ${c.type} to the ${c.vault} log${r.bytesWritten ? ` (${plural(r.bytesWritten, "byte")})` : ""}` : `log append: ${c.type} not appended${r.rolledBack ? " (rolled back)" : ""}`);
  return done(out, o);
}

const LEVELS: Record<LintCode, "error" | "warn"> = { L01: "error", L02: "error", L03: "warn", L09: "warn", L10: "warn", L11: "warn", L12: "warn", L13: "error", L14: "warn", L15: "warn", L16: "warn", L17: "warn", L18: "warn", L19: "warn" };
export function lintText(d: { report: LintReport; notes: number; titles: Record<LintCode, string>; info: Partial<Record<LintCode, string>> }, o: TextOptions, c: { vault: string; note?: string }): string {
  const out = report("lint", o).section("Findings");
  const codes = Object.keys(d.report.findings) as LintCode[];
  for (const code of codes) for (const finding of d.report.findings[code]) out.bullet(LEVELS[code] === "error" ? "fail" : "warn", `${code}: ${finding.replaceAll("`", "")}`);
  for (const code of codes) if (d.info[code]) out.note(`${code}: ${d.info[code]!.replaceAll("`", "")}`);
  out.section("Scope").kv([["Vault", c.vault], ["Note", c.note], ["Notes", d.notes]]);
  out.summary({ failed: d.report.errors, warnings: d.report.warnings, ok: codes.filter(code => !d.report.findings[code].length).length });
  return done(out, o);
}

/** `lint --write` and `graph build`: what was written or would be, then issues and the log event. */
export function analysisWriteText(r: { ok: boolean; applied: boolean; summary: unknown; paths: string[]; receipts: WriteReceipt[]; log?: LogReceipt }, o: TextOptions, c: { kind: "lint" | "graph"; dryRun: boolean }): string {
  const out = report(c.kind === "lint" ? "lint" : "graph build", o);
  const issues: WriteIssue[] = [...r.receipts.flatMap(x => x.issues), ...(r.log?.issues ?? [])];
  if (issues.length || !r.ok) { out.section("Problems"); if (!r.ok) out.bullet("fail", "report not written"); for (const issue of issues) out.bullet("fail", `${issue.code}: ${issue.message}`); }
  const verb = c.dryRun && r.ok ? "would write" : r.applied ? "wrote" : "did not write";
  out.section("Reports").bullet(r.ok ? "ok" : "fail", `${verb} ${plural(r.paths.length, "report")}`);
  for (const path of r.paths) out.bullet("absent", path);
  const counts = (r.summary ?? {}) as Record<string, unknown>;
  if (c.kind === "graph") out.section("Graph").kv((["nodes", "edges", "communities", "work_docs"] as const).map(k => [k.replace("_", " "), typeof counts[k] === "number" ? counts[k] : null]));
  if (r.log) out.bullet(r.log.ok ? "ok" : "fail", r.log.ok ? `logged ${c.kind === "lint" ? "LINT" : "GRAPH"} event` : "log event not appended");
  if (c.kind === "lint") out.summary({ failed: Number(counts.errors ?? 0) || (r.ok ? 0 : 1), warnings: Number(counts.warnings ?? 0), ok: r.ok && !counts.errors && !counts.warnings ? 1 : 0 });
  return done(out, o);
}

export function neighborsText(r: GraphNeighborhood, o: TextOptions, c: { vault: string; limit: number; relation?: string }): string {
  const hops = new Map([[r.start, 0]]), queue = [r.start];
  for (let i = 0; i < queue.length; i++) for (const e of r.edges) {
    const other = e.source === queue[i] ? e.target : e.target === queue[i] ? e.source : undefined;
    if (other !== undefined && !hops.has(other)) { hops.set(other, hops.get(queue[i]!)! + 1); queue.push(other); }
  }
  const relation = (id: string) => [...new Set(r.edges.filter(e => (e.source === id && hops.get(e.target) === hops.get(id)! - 1) || (e.target === id && hops.get(e.source) === hops.get(id)! - 1)).map(e => e.relation === "wiki_link" ? e.rel ?? e.relation : e.relation))].join(",");
  const nodes = r.nodes.filter(n => n.id !== r.start).sort((a, b) => (hops.get(a.id) ?? 9) - (hops.get(b.id) ?? 9));
  const out = report("graph neighbors", o).section("Neighborhood").kv([["Vault", c.vault], ["Start", r.start], ["Hops", r.hops], ["Neighbors", nodes.length]]);
  if (nodes.length) out.table(["Note", "Hops", "Relation", "Title"], nodes.map(n => [n.id, String(hops.get(n.id) ?? ""), relation(n.id), n.label]));
  if (r.truncated && c.limit < 500) out.next(command("graph", "neighbors", c.vault, r.start, "--hops", String(r.hops), "--limit", String(Math.min(500, c.limit * 2)), ...(c.relation ? ["--relation", c.relation] : [])));
  return done(out, o);
}

export function pathText(r: GraphPath, o: TextOptions, c: { vault: string; maxHops: number; viaHubs: boolean; relation?: string }): string {
  const out = report("graph path", o).section("Path").kv([["Vault", c.vault], ["From", r.from], ["To", r.to], ["Hops", r.found ? r.length : c.maxHops]]);
  if (!r.found) {
    out.bullet("absent", "no path found");
    const words = ["graph", "path", c.vault, r.from, r.to, ...(c.relation ? ["--relation", c.relation] : [])];
    if (!c.viaHubs) out.next(command(...words, "--max-hops", String(c.maxHops), "--via-hubs"));
    if (c.maxHops < 6) out.next(command(...words, "--max-hops", "6", ...(c.viaHubs ? ["--via-hubs"] : [])));
  } else for (const e of r.edges) out.bullet("absent", `${e.source} -[${e.relation === "wiki_link" ? e.rel ?? e.relation : e.relation}]-> ${e.target}`);
  return done(out, o);
}

/** `vmem evidence`: one row per entry with status, reason and byte offsets. Quotes are not echoed. */
export function evidenceText(r: EvidenceReport, o: TextOptions): string {
  const out = report("evidence", o).section("Evidence").kv([["Vault", r.vault], ["Note", r.note.path], ["Entries", r.evidence.length]]);
  if (!r.evidence.length) out.note("no evidence metadata");
  for (const e of [...r.evidence].sort((a,b) => Number(b.status !== "verified") - Number(a.status !== "verified"))) {
    const marker = e.status === "verified" ? "ok" : e.status === "unverified_external" ? "unknown" : e.status === "unsupported" ? "fail" : "warn";
    out.bullet(marker, `${e.index}: ${e.status}${e.reason ? `; ${e.reason}` : ""}${e.match ? `; bytes ${e.match.start}..${e.match.end}` : ""}${e.source ? `; ${e.source}` : ""}`);
  }
  return done(out, o);
}

/** `vmem graph explain`: each hop, then its occurrences as rows. Structural metadata only; never a probability. */
export function explainText(r: GraphExplanation, o: TextOptions, c: { vault: string }): string {
  const out = report("graph explain", o).section("Path").kv([["Vault", c.vault], ["From", r.path.from], ["To", r.path.to], ["Hops", r.path.found ? r.path.length : r.path.options.maxHops]]);
  if (!r.path.found) { out.note("no path found"); return done(out, o); }
  for (const hop of r.hops) {
    out.section(`Hop ${hop.index + 1}`).kv([["From", hop.from], ["To", hop.to], ["Relation", hop.edge.rel ?? hop.edge.relation]]);
    if (!hop.occurrences.length) out.note("no occurrences found");
    for (const x of hop.occurrences) out.bullet(x.kind === "legacy_graph_match" && x.authored ? "ok" : "unknown", `${x.kind}: ${x.relation}, ${x.traversal}, ${x.origin.path}:${x.line}, ${x.bytes.start}..${x.bytes.end}, ${x.source === "frontmatter" ? `frontmatter ${x.field ?? ""}` : "body"}`);
    if (hop.omitted) out.bullet("warn", `${plural(hop.omitted, "occurrence")} omitted`);
  }
  if (r.truncated) out.note("truncated");
  return done(out, o);
}
