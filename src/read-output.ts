import { markerCell } from "@staix/cli-output";
import { paint } from "@staix/cli-output";
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
import { blocks, clean, fields, heading, issueTable, nextCommand, paragraph, plural, shellWord, status, summary, table, tableParts, tone, type CellInput, type TextOptions, stripTerminal } from "./text-output.ts";

const command = (...words: string[]) => ["vmem", ...words].map(shellWord).join(" ");

export function searchText(hits: SearchResult[], o: TextOptions, c: { vault: string; query: string; limit: number; type?: string; domain?: string }): string {
  const count = `${plural(hits.length, "result")} for ${JSON.stringify(clean(c.query))}`;
  if (!hits.length) return count;
  // Rows stay on one line so each snippet sits under its own hit.
  const rows = tableParts(["PATH", "TITLE", "TYPE"], hits.map(h => [h.path, h.title, h.type]), { ...o, columns: undefined });
  const list = [rows[0]!, ...hits.flatMap((h, i) => [rows[i + 1]!, ...(stripTerminal(h.snippet).trim() ? [paragraph(stripTerminal(h.snippet).trim(), o, "muted", "  ")] : [])])].join("\n");
  const filters = [...(c.type ? ["--type", c.type] : []), ...(c.domain ? ["--domain", c.domain] : [])];
  const more = hits.length >= c.limit && c.limit < 500 ? nextCommand("next", command("search", c.vault, c.query, ...filters, "--limit", String(Math.min(500, c.limit * 2))), o) : undefined;
  return blocks(list, [count, more].filter(Boolean).join("\n"));
}

export function showText(r: NoteReadResult, o: TextOptions, c: { vault: string; target: string; maxBytes?: number }): string {
  const head = [heading(r.path, o), fields([["section", r.section], ["sha256", r.hash.slice(0, 12)], ["bytes", Buffer.byteLength(r.content)], ["offset", r.offset]], o)].join("\n");
  if (!r.truncated) return blocks(head, stripTerminal(r.content).replace(/\n+$/, ""));
  const words = ["show", c.vault, c.target, ...(r.section ? ["--section", r.section] : []), ...(c.maxBytes !== undefined ? ["--max-bytes", String(c.maxBytes)] : []), "--offset", String(r.nextOffset)];
  const tail = [status("warn", "truncated", o), ...(r.nextOffset !== undefined ? [nextCommand("next", command(...words), o)] : [])];
  const headings = r.headings?.length ? ["H2 headings (read one with --section):", ...r.headings.map(h => `  ${clean(h)}`), ...(r.headingsTruncated ? [paint([{ text: "  ... more headings", role: "hint" }], o.color)] : [])].join("\n") : undefined;
  return blocks(head, stripTerminal(r.content).replace(/\n+$/, ""), tail.join("\n"), headings);
}

/** A listed link; a dead one may carry the one hinted target, as `vmem links --json` and `vmem_links` return it. */
export function linksText(links: SuggestedLink[], o: TextOptions, c: { vault: string; target: string; limit: number }): string {
  const from = links[0]?.source ?? c.target;
  const count = `${plural(links.length, "link")} from ${clean(from)}`;
  if (!links.length) return count;
  const target = (l: ResolvedLink) => l.target + (l.heading !== null ? `#${l.heading}` : "") + (l.block !== null ? `#^${l.block}` : "");
  const resolution = (l: SuggestedLink): CellInput => l.resolved ?? tone(`${markerCell("warn", o.ascii === true)} ${l.reason ?? "unresolved"}${l.suggested ? `; suggested ${clean(l.suggested.path)} (${l.suggested.score.toFixed(3)})` : ""}`, "warn");
  const rows = links.map(l => [target(l), resolution(l), l.line]);
  const more = links.length >= c.limit && c.limit < 500 ? nextCommand("next", command("links", c.vault, c.target, "--limit", String(Math.min(500, c.limit * 2))), o) : undefined;
  return blocks(heading("OUT", o) + "\n" + table(["TARGET", "RESOLVED", "LINE"], rows, o), [count, more].filter(Boolean).join("\n"));
}

export function rebuildText(r: { vault: string; notes: number; changed: number; removed: number; skipped?: string[] }, _o: TextOptions): string {
  return `rebuilt ${clean(r.vault)}: ${plural(r.notes, "note")}, ${r.changed} changed, ${r.removed} removed${r.skipped?.length ? `, ${r.skipped.length} skipped` : ""}`;
}

const warnings = (list: string[], o: TextOptions) => list.length ? list.map(w => status("warn", `warning: ${w}`, o)).join("\n") : undefined;
export function logReadText(r: LogReadResult, o: TextOptions, c: { command: "tail" | "grep"; vault: string; pattern?: string; limit: number; type?: string }): string {
  if (!r.ok) return blocks(status("fail", `log ${c.command}: not read`, o), issueTable(r.issues, o), warnings(r.warnings, o));
  const count = `${plural(r.lines.length, "line")}${r.dataLines !== null ? ` (log has ${r.dataLines})` : ""}`;
  const words = ["log", c.command, c.vault, ...(c.pattern !== undefined ? [c.pattern] : []), ...(c.type ? ["--type", c.type] : []), "--limit", String(Math.min(200, c.limit * 2))];
  const more = r.lines.length >= c.limit && c.limit < 200 ? nextCommand("next", command(...words), o) : undefined;
  return blocks(r.lines.length ? r.lines.map(clean).join("\n") : undefined, [count, more].filter(Boolean).join("\n"), warnings(r.warnings, o), issueTable(r.issues, o));
}
export function logAppendText(r: LogReceipt, o: TextOptions, c: { vault: string; type: string }): string {
  const line = r.ok && r.appended ? status("ok", `appended ${clean(c.type)} to the ${clean(c.vault)} log${r.bytesWritten ? ` (${plural(r.bytesWritten, "byte")})` : ""}`, o)
    : status("fail", `log append: ${clean(c.type)} not appended${r.rolledBack ? " (rolled back)" : ""}`, o);
  return blocks(line, issueTable(r.issues, o));
}

const LEVELS: Record<LintCode, "error" | "warn"> = { L01: "error", L02: "error", L03: "warn", L09: "warn", L10: "warn", L11: "warn", L12: "warn", L13: "error", L14: "warn", L15: "warn", L16: "warn", L17: "warn", L18: "warn", L19: "warn" };
const verdict = (r: { errors: number; warnings: number; summary: string }, o: TextOptions) => paint([{ text: clean(r.summary), role: r.errors ? "error" : r.warnings ? "warning" : "success" }], o.color);
export function lintText(d: { report: LintReport; notes: number; titles: Record<LintCode, string>; info: Partial<Record<LintCode, string>> }, o: TextOptions, c: { vault: string; note?: string }): string {
  const rows = (Object.keys(d.report.findings) as LintCode[]).flatMap(code => {
    const check = d.titles[code].replace(" — ", " "), found = d.report.findings[code];
    return [...(found.length ? found.map(f => [tone(`${markerCell(LEVELS[code] === "error" ? "fail" : "warn", o.ascii === true)} ${LEVELS[code]}`, LEVELS[code] === "error" ? "fail" : "warn"), check, f]) : [[tone(`${markerCell("ok", o.ascii === true)} ok`, "ok"), check, "위반 없음"]]),
      ...(d.info[code] ? [[tone("info", "muted"), check, d.info[code]]] : [])];
  });
  const ok = (Object.keys(d.report.findings) as LintCode[]).filter(code => !d.report.findings[code].length).length;
  return blocks(heading(`lint ${c.vault}${c.note ? ` ${c.note}` : ""}: ${plural(d.notes, "note")}`, o), table(["LEVEL", "CHECK", "FINDING"], rows, o), verdict(d.report, o), summary({ failed: d.report.errors, warnings: d.report.warnings, ok }, o));
}

/** `lint --write` and `graph build`: what was written or would be, then issues and the log event. */
export function analysisWriteText(r: { ok: boolean; applied: boolean; summary: unknown; paths: string[]; receipts: WriteReceipt[]; log?: LogReceipt }, o: TextOptions, c: { kind: "lint" | "graph"; dryRun: boolean }): string {
  const verb = c.dryRun && r.ok ? "would write" : r.applied ? "wrote" : "did not write";
  const line = status(r.ok ? "ok" : "fail", `${c.kind === "lint" ? "lint" : "graph build"}: ${verb} ${plural(r.paths.length, "report")}`, o);
  const s = (r.summary ?? {}) as Record<string, unknown>;
  const counts = c.kind === "lint" ? verdict(s as { errors: number; warnings: number; summary: string }, o)
    : fields((["nodes", "edges", "communities", "work_docs"] as const).map(k => [k.replace("_", " "), typeof s[k] === "number" ? s[k] : undefined]), o);
  const issues: WriteIssue[] = [...r.receipts.flatMap(x => x.issues), ...(r.log?.issues ?? [])];
  const logged = r.log ? (r.log.ok ? `logged ${c.kind === "lint" ? "LINT" : "GRAPH"} event` : status("fail", "log event not appended", o)) : undefined;
  const lintSummary = c.kind === "lint" ? summary({ failed: Number(s.errors ?? 0) || (r.ok ? 0 : 1), warnings: Number(s.warnings ?? 0), ok: r.ok && !s.errors && !s.warnings ? 1 : 0 }, o) : undefined;
  return blocks(line, r.paths.map(p => `  ${clean(p)}`).join("\n"), counts, issueTable(issues, o), logged, lintSummary);
}

export function neighborsText(r: GraphNeighborhood, o: TextOptions, c: { vault: string; limit: number; relation?: string }): string {
  // Hops and relations follow from the returned edges: every selected node's nearer neighbour is selected too.
  const hops = new Map([[r.start, 0]]), queue = [r.start];
  for (let i = 0; i < queue.length; i++) for (const e of r.edges) {
    const other = e.source === queue[i] ? e.target : e.target === queue[i] ? e.source : undefined;
    if (other !== undefined && !hops.has(other)) { hops.set(other, hops.get(queue[i]!)! + 1); queue.push(other); }
  }
  const relation = (id: string) => [...new Set(r.edges.filter(e => (e.source === id && hops.get(e.target) === hops.get(id)! - 1) || (e.target === id && hops.get(e.source) === hops.get(id)! - 1)).map(e => e.relation === "wiki_link" ? e.rel ?? e.relation : e.relation))].join(",");
  const nodes = r.nodes.filter(n => n.id !== r.start).sort((a, b) => (hops.get(a.id) ?? 9) - (hops.get(b.id) ?? 9));
  const count = `${plural(nodes.length, "neighbour")} of ${clean(r.start)} within ${plural(r.hops, "hop")}`;
  const more = r.truncated && c.limit < 500 ? nextCommand("next", command("graph", "neighbors", c.vault, r.start, "--hops", String(r.hops), "--limit", String(Math.min(500, c.limit * 2)), ...(c.relation ? ["--relation", c.relation] : [])), o) : undefined;
  if (!nodes.length) return [count, more].filter(Boolean).join("\n");
  return blocks(table(["NOTE", "HOPS", "RELATION", "TITLE"], nodes.map(n => [n.id, hops.get(n.id), relation(n.id), n.label]), o), [count, more].filter(Boolean).join("\n"));
}

export function pathText(r: GraphPath, o: TextOptions, c: { vault: string; maxHops: number; viaHubs: boolean; relation?: string }): string {
  if (!r.found) {
    const words = ["graph", "path", c.vault, r.from, r.to, ...(c.relation ? ["--relation", c.relation] : [])];
    const hints = [...(c.viaHubs ? [] : [nextCommand("next", command(...words, "--max-hops", String(c.maxHops), "--via-hubs"), o)]),
      ...(c.maxHops < 6 ? [nextCommand("next", command(...words, "--max-hops", "6", ...(c.viaHubs ? ["--via-hubs"] : [])), o)] : [])];
    return [`no path from ${clean(r.from)} to ${clean(r.to)} within ${plural(c.maxHops, "hop")}`, ...hints].join("\n");
  }
  const lines = r.edges.map(e => `${clean(e.source)} -[${e.relation === "wiki_link" ? e.rel ?? e.relation : e.relation}]-> ${clean(e.target)}`);
  return [...lines, `path from ${clean(r.from)} to ${clean(r.to)}: ${plural(r.length, "hop")}`].join("\n");
}

/** `vmem evidence`: one row per entry with status, reason and byte offsets. Quotes are not echoed. */
export function evidenceText(r: EvidenceReport, o: TextOptions): string {
  const head = heading(`evidence ${r.vault} ${r.note.path}: ${plural(r.evidence.length, "entry", "entries")}`, o);
  if (!r.evidence.length) return blocks(head, paint([{ text: "no evidence metadata", role: "hint" }], o.color));
  const t = (s: EvidenceReport["evidence"][number]["status"]) => s === "verified" ? "ok" : s === "unverified_external" ? "muted" : s === "unsupported" ? "fail" : "warn";
  const rows = r.evidence.map(e => {
    const name = t(e.status), glyph = name === "muted" ? "unknown" : name;
    return [String(e.index), tone(`${markerCell(glyph, o.ascii === true)} ${e.status}`, name), e.reason ?? "", e.match ? `${e.match.start}..${e.match.end}` : "", e.source ?? ""];
  });
  return blocks(head, table(["#", "STATUS", "REASON", "BYTES", "SOURCE"], rows, o));
}

/** `vmem graph explain`: each hop, then its occurrences as rows. Structural metadata only; never a probability. */
export function explainText(r: GraphExplanation, o: TextOptions, c: { vault: string }): string {
  if (!r.path.found) return `no path from ${clean(r.path.from)} to ${clean(r.path.to)} within ${plural(r.path.options.maxHops, "hop")}`;
  const parts = r.hops.map(hop => {
    const head = heading(`hop ${hop.index + 1}: ${hop.from} -> ${hop.to} (structural ${hop.edge.rel ?? hop.edge.relation})`, o);
    const rows = hop.occurrences.map(x => [x.kind === "legacy_graph_match" && x.authored ? tone(`${markerCell("ok", o.ascii === true)} link`, "ok") : tone(`${markerCell("unknown", o.ascii === true)} ${x.kind === "legacy_graph_match" ? "legacy" : "note"}`, "muted"),
      x.relation, x.traversal, `${x.origin.path}:${x.line}`, `${x.bytes.start}..${x.bytes.end}`, x.source === "frontmatter" ? `frontmatter ${x.field ?? ""}` : "body"]);
    return blocks(head, rows.length ? table(["KIND", "RELATION", "WALK", "AT", "BYTES", "SOURCE"], rows, o) : paint([{ text: "no occurrences found", role: "warning" }], o.color), hop.omitted ? status("warn", `${plural(hop.omitted, "occurrence")} omitted`, o) : undefined);
  });
  return blocks(...parts, `explained path ${clean(r.path.from)} to ${clean(r.path.to)} in ${clean(c.vault)}: ${plural(r.path.length, "hop")}${r.truncated ? " (truncated)" : ""}`);
}
