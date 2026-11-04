/**
 * Text views for the read, log and analysis commands (#114). Each renderer is pure, takes the same result the
 * command prints with `--json`, and never shows more than that result carries.
 */
import type { SearchResult, NoteReadResult } from "./vault-index.ts";
import type { ResolvedLink } from "./links.ts";
import type { LogReadResult, LogReceipt } from "./log-types.ts";
import type { LintCode, LintReport } from "./analysis-types.ts";
import type { GraphNeighborhood } from "./vault-graph.ts";
import type { WriteIssue, WriteReceipt } from "./write-types.ts";
import { blocks, clean, fields, heading, issueTable, nextCommand, paint, paragraph, plural, shellWord, table, tone, type TextOptions, stripTerminal } from "./text-output.ts";

const command = (...words: string[]) => ["vmem", ...words].map(shellWord).join(" ");

export function searchText(hits: SearchResult[], o: TextOptions, c: { vault: string; query: string; limit: number; type?: string; domain?: string }): string {
  const count = `${plural(hits.length, "result")} for ${JSON.stringify(clean(c.query))}`;
  if (!hits.length) return count;
  // Rows stay on one line so each snippet sits under its own hit.
  const rows = table(["PATH", "TITLE", "TYPE"], hits.map(h => [h.path, h.title, h.type]), { ...o, columns: undefined }).split("\n");
  const list = [rows[0]!, ...hits.flatMap((h, i) => [rows[i + 1]!, ...(stripTerminal(h.snippet).trim() ? [paragraph(stripTerminal(h.snippet).trim(), o, "muted", "  ")] : [])])].join("\n");
  const filters = [...(c.type ? ["--type", c.type] : []), ...(c.domain ? ["--domain", c.domain] : [])];
  const more = hits.length >= c.limit && c.limit < 500 ? nextCommand("next", command("search", c.vault, c.query, ...filters, "--limit", String(Math.min(500, c.limit * 2))), o) : undefined;
  return blocks(list, [count, more].filter(Boolean).join("\n"));
}

export function showText(r: NoteReadResult, o: TextOptions, c: { vault: string; target: string; maxBytes?: number }): string {
  const head = [heading(r.path, o), fields([["section", r.section], ["sha256", r.hash.slice(0, 12)], ["bytes", Buffer.byteLength(r.content)], ["offset", r.offset]], o)].join("\n");
  if (!r.truncated) return blocks(head, stripTerminal(r.content).replace(/\n+$/, ""));
  const words = ["show", c.vault, c.target, ...(r.section ? ["--section", r.section] : []), ...(c.maxBytes !== undefined ? ["--max-bytes", String(c.maxBytes)] : []), "--offset", String(r.nextOffset)];
  const tail = [paint("truncated", "warn", o), ...(r.nextOffset !== undefined ? [nextCommand("next", command(...words), o)] : [])];
  const headings = r.headings?.length ? ["H2 headings (read one with --section):", ...r.headings.map(h => `  ${clean(h)}`), ...(r.headingsTruncated ? [paint("  ... more headings", "muted", o)] : [])].join("\n") : undefined;
  return blocks(head, stripTerminal(r.content).replace(/\n+$/, ""), tail.join("\n"), headings);
}

export function linksText(links: ResolvedLink[], o: TextOptions, c: { vault: string; target: string; limit: number }): string {
  const from = links[0]?.source ?? c.target;
  const count = `${plural(links.length, "link")} from ${clean(from)}`;
  if (!links.length) return count;
  const target = (l: ResolvedLink) => l.target + (l.heading !== null ? `#${l.heading}` : "") + (l.block !== null ? `#^${l.block}` : "");
  const rows = links.map(l => [target(l), l.resolved ?? tone(l.reason ?? "unresolved", "warn"), l.line]);
  const more = links.length >= c.limit && c.limit < 500 ? nextCommand("next", command("links", c.vault, c.target, "--limit", String(Math.min(500, c.limit * 2))), o) : undefined;
  return blocks(heading("OUT", o) + "\n" + table(["TARGET", "RESOLVED", "LINE"], rows, o), [count, more].filter(Boolean).join("\n"));
}

export function rebuildText(r: { vault: string; notes: number; changed: number; removed: number; skipped?: string[] }, _o: TextOptions): string {
  return `rebuilt ${clean(r.vault)}: ${plural(r.notes, "note")}, ${r.changed} changed, ${r.removed} removed${r.skipped?.length ? `, ${r.skipped.length} skipped` : ""}`;
}

const warnings = (list: string[], o: TextOptions) => list.length ? list.map(w => paint(`warning: ${clean(w)}`, "warn", o)).join("\n") : undefined;
export function logReadText(r: LogReadResult, o: TextOptions, c: { command: "tail" | "grep"; vault: string; pattern?: string; limit: number; type?: string }): string {
  if (!r.ok) return blocks(paint(`log ${c.command}: not read`, "fail", o), issueTable(r.issues, o), warnings(r.warnings, o));
  const count = `${plural(r.lines.length, "line")}${r.dataLines !== null ? ` (log has ${r.dataLines})` : ""}`;
  const words = ["log", c.command, c.vault, ...(c.pattern !== undefined ? [c.pattern] : []), ...(c.type ? ["--type", c.type] : []), "--limit", String(Math.min(200, c.limit * 2))];
  const more = r.lines.length >= c.limit && c.limit < 200 ? nextCommand("next", command(...words), o) : undefined;
  return blocks(r.lines.length ? r.lines.map(clean).join("\n") : undefined, [count, more].filter(Boolean).join("\n"), warnings(r.warnings, o), issueTable(r.issues, o));
}
export function logAppendText(r: LogReceipt, o: TextOptions, c: { vault: string; type: string }): string {
  const line = r.ok && r.appended ? paint(`appended ${clean(c.type)} to the ${clean(c.vault)} log${r.bytesWritten ? ` (${plural(r.bytesWritten, "byte")})` : ""}`, "ok", o)
    : paint(`log append: ${clean(c.type)} not appended${r.rolledBack ? " (rolled back)" : ""}`, "fail", o);
  return blocks(line, issueTable(r.issues, o));
}

const LEVELS: Record<LintCode, "error" | "warn"> = { L01: "error", L02: "error", L03: "warn", L09: "warn", L10: "warn", L11: "warn", L12: "warn", L13: "error", L14: "warn" };
const verdict = (r: { errors: number; warnings: number; summary: string }, o: TextOptions) => paint(clean(r.summary), r.errors ? "fail" : r.warnings ? "warn" : "ok", o);
export function lintText(d: { report: LintReport; notes: number; titles: Record<LintCode, string>; info: Partial<Record<LintCode, string>> }, o: TextOptions, c: { vault: string; note?: string }): string {
  const rows = (Object.keys(d.report.findings) as LintCode[]).flatMap(code => {
    const check = d.titles[code].replace(" — ", " "), found = d.report.findings[code];
    return [...(found.length ? found.map(f => [tone(LEVELS[code], LEVELS[code] === "error" ? "fail" : "warn"), check, f]) : [[tone("ok", "ok"), check, "위반 없음"]]),
      ...(d.info[code] ? [[tone("info", "muted"), check, d.info[code]]] : [])];
  });
  return blocks(heading(`lint ${c.vault}${c.note ? ` ${c.note}` : ""}: ${plural(d.notes, "note")}`, o), table(["LEVEL", "CHECK", "FINDING"], rows, o), verdict(d.report, o));
}

/** `lint --write` and `graph build`: what was written or would be, then issues and the log event. */
export function analysisWriteText(r: { ok: boolean; applied: boolean; summary: unknown; paths: string[]; receipts: WriteReceipt[]; log?: LogReceipt }, o: TextOptions, c: { kind: "lint" | "graph"; dryRun: boolean }): string {
  const verb = c.dryRun && r.ok ? "would write" : r.applied ? "wrote" : "did not write";
  const line = paint(`${c.kind === "lint" ? "lint" : "graph build"}: ${verb} ${plural(r.paths.length, "report")}`, r.ok ? "ok" : "fail", o);
  const s = (r.summary ?? {}) as Record<string, unknown>;
  const counts = c.kind === "lint" ? verdict(s as { errors: number; warnings: number; summary: string }, o)
    : fields((["nodes", "edges", "communities", "work_docs"] as const).map(k => [k.replace("_", " "), typeof s[k] === "number" ? s[k] : undefined]), o);
  const issues: WriteIssue[] = [...r.receipts.flatMap(x => x.issues), ...(r.log?.issues ?? [])];
  const logged = r.log ? (r.log.ok ? `logged ${c.kind === "lint" ? "LINT" : "GRAPH"} event` : paint("log event not appended", "fail", o)) : undefined;
  return blocks(line, r.paths.map(p => `  ${clean(p)}`).join("\n"), counts, issueTable(issues, o), logged);
}

export function neighborsText(r: GraphNeighborhood, o: TextOptions, c: { vault: string; limit: number }): string {
  // Hops and relations follow from the returned edges: every selected node's nearer neighbour is selected too.
  const hops = new Map([[r.start, 0]]), queue = [r.start];
  for (let i = 0; i < queue.length; i++) for (const e of r.edges) {
    const other = e.source === queue[i] ? e.target : e.target === queue[i] ? e.source : undefined;
    if (other !== undefined && !hops.has(other)) { hops.set(other, hops.get(queue[i]!)! + 1); queue.push(other); }
  }
  const relation = (id: string) => [...new Set(r.edges.filter(e => (e.source === id && hops.get(e.target) === hops.get(id)! - 1) || (e.target === id && hops.get(e.source) === hops.get(id)! - 1)).map(e => e.relation))].join(",");
  const nodes = r.nodes.filter(n => n.id !== r.start).sort((a, b) => (hops.get(a.id) ?? 9) - (hops.get(b.id) ?? 9));
  const count = `${plural(nodes.length, "neighbour")} of ${clean(r.start)} within ${plural(r.hops, "hop")}`;
  const more = r.truncated && c.limit < 500 ? nextCommand("next", command("graph", "neighbors", c.vault, r.start, "--hops", String(r.hops), "--limit", String(Math.min(500, c.limit * 2))), o) : undefined;
  if (!nodes.length) return [count, more].filter(Boolean).join("\n");
  return blocks(table(["NOTE", "HOPS", "RELATION", "TITLE"], nodes.map(n => [n.id, hops.get(n.id), relation(n.id), n.label]), o), [count, more].filter(Boolean).join("\n"));
}
