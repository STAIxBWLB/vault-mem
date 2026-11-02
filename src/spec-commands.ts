import { isDeepStrictEqual } from "node:util";
import { argumentError } from "./mcp.ts";
import { specCommandSchema, type SpecCommand } from "./spec-command-table.ts";
import { loadRegistry } from "./registry.ts";
import { proseLines } from "./links.ts";
import { SpecIndex, discoverSpecs, type SpecDocument, type SpecSnapshot, type SpecSearchResult } from "./spec-source.ts";
import { buildSpecGraph, specReference, specSlice, type SpecEdgeKind } from "./spec-graph.ts";
import { specFreshness, specsCoveringPath } from "./spec-freshness.ts";
import { validateSpecs } from "./spec-validate.ts";

const MAX_RESPONSE_BYTES = 240 * 1024, MAX_RELATIONS = 500, BUDGET_RESERVE = 512;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function bytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value)); }
  catch (error) { throw new Error("spec result: metadata cannot be serialized safely; remove cyclic or unsupported frontmatter values before retrying", { cause: error }); }
}
function fits(result: unknown): boolean { return bytes(result) + BUDGET_RESERVE <= MAX_RESPONSE_BYTES; }
function checkBudget(result: unknown): void {
  if (bytes(result) > MAX_RESPONSE_BYTES) throw new Error("spec result: required metadata/body exceeds 240 KiB; reduce --max-bytes or oversized frontmatter before retrying");
}
function rows<T>(result: Record<string, unknown>, key: string, values: readonly T[], limit = MAX_RELATIONS): T[] {
  const out: T[] = []; result[key] = out;
  let used = bytes(result) + BUDGET_RESERVE;
  for (const value of values) {
    if (out.length >= limit) break;
    const size = bytes(value) + (out.length ? 1 : 0);
    if (used + size > MAX_RESPONSE_BYTES) break;
    out.push(value); used += size;
  }
  if (out.length < values.length) result.truncated = true;
  return out;
}
function clip(value: string, maximum: number): string {
  const data = Buffer.from(value); if (data.length <= maximum) return value;
  let end = maximum; while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString("utf8");
}
function sections(body: string): { name: string; start: number; end: number }[] {
  const visible = proseLines(body), lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [], out: { name: string; start: number; end: number }[] = [];
  let offset = 0, active: number | undefined;
  for (const [index, line] of lines.entries()) {
    const heading = /^ {0,3}##(?:[ \t]+(.*)|[ \t]*)$/.exec(visible[index] ?? "");
    if (heading) {
      if (active !== undefined) out[active]!.end = offset;
      out.push({ name: (heading[1] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim(), start: offset, end: body.length }); active = out.length - 1;
    } else if (/^ {0,3}#(?:[ \t]+|[ \t]*$)/.test(visible[index] ?? "") && active !== undefined) { out[active]!.end = offset; active = undefined; }
    offset += line.length;
  }
  return out;
}
function bodyPage(document: SpecDocument, args: Record<string, unknown>): Record<string, unknown> {
  const section = typeof args.section === "string" ? args.section : undefined, offset = (args.offset as number | undefined) ?? 0, maximum = (args.maxBytes as number | undefined) ?? 16384;
  if (section !== undefined && (!section.trim() || /[\r\n]/.test(section) || Buffer.byteLength(section) > 1024)) throw new Error("spec get: section must be one exact H2 name within 1024 UTF-8 bytes; choose a heading from the spec body");
  let body = document.body;
  const all = sections(body);
  if (section !== undefined) {
    const selected = all.filter(item => item.name === section);
    if (selected.length !== 1) throw new Error(selected.length ? "spec get: section is ambiguous; rename duplicate H2 headings before requesting this section" : "spec get: section was not found; select an exact H2 heading from the spec body");
    body = body.slice(selected[0]!.start, selected[0]!.end);
  }
  const data = Buffer.from(body);
  if (offset > data.length) throw new Error("spec get: offset exceeds the selected body/section; restart at offset 0 or use the last returned nextOffset");
  if (offset < data.length && (data[offset]! & 0xc0) === 0x80) throw new Error("spec get: offset is not a UTF-8 boundary; use a nextOffset returned by the previous page");
  let end = Math.min(offset + maximum, data.length);
  while (end > offset && end < data.length && (data[end]! & 0xc0) === 0x80) end--;
  if (end === offset && offset < data.length) throw new Error("spec get: maxBytes cannot fit the next UTF-8 character; increase --max-bytes before retrying");
  const truncated = end < data.length, headings: string[] = []; let headingBytes = 2, headingsTruncated = false;
  if (truncated) for (const item of all) {
    const size = bytes(item.name) + 1;
    if (headings.length >= 64 || Buffer.byteLength(item.name) > 1024 || headingBytes + size > 8192) { headingsTruncated = true; continue; }
    headings.push(item.name); headingBytes += size;
  }
  return { body: data.subarray(offset, end).toString("utf8"), bodyTruncated: truncated,
    ...(truncated ? { nextOffset: end, headings, ...(headingsTruncated ? { headingsTruncated: true } : {}) } : {}),
    ...(section === undefined ? {} : { section }), ...(args.offset === undefined ? {} : { offset }) };
}
function metadataMatch(document: SpecDocument, args: Record<string, unknown>): boolean {
  const data = document.frontmatter;
  if (args.type !== undefined && data.type !== args.type || args.status !== undefined && data.status !== args.status) return false;
  if (args.tag !== undefined && !(Array.isArray(data.tags) ? data.tags : [data.tags]).some(tag => tag === args.tag)) return false;
  if (args.parent !== undefined && specReference(data.parent) !== specReference(args.parent)) return false;
  if (args.dependsOn !== undefined && (!Array.isArray(data["depends-on"]) || !data["depends-on"].some(value => specReference(value) === specReference(args.dependsOn)))) return false;
  return true;
}
function grep(index: SpecIndex, snapshot: SpecSnapshot, args: Record<string, unknown>, env: NodeJS.ProcessEnv, source: string): Record<string, unknown> {
  const query = text(args.query), offset = (args.offset as number | undefined) ?? 0, limit = (args.limit as number | undefined) ?? 50;
  if (Buffer.byteLength(query) > 1024) throw new Error("spec grep: query exceeds 1024 UTF-8 bytes; shorten the query before retrying");
  let documents = snapshot.specs.filter(document => metadataMatch(document, args));
  if (typeof args.coversPath === "string") {
    const covered = new Set(specsCoveringPath({ ...snapshot, specs: documents }, args.coversPath, { env }).map(document => document.path));
    documents = documents.filter(document => covered.has(document.path));
  }
  const byPath = new Map(documents.map(document => [document.path, document]));
  const selected: Record<string, unknown>[] = [];
  const hit = (document: SpecDocument, indexed?: SpecSearchResult): Record<string, unknown> => {
    const start = query ? Math.max(0, document.source.indexOf(query) - 80) : 0;
    return { id: document.id, path: document.path, title: clip(text(document.frontmatter.title) || document.id, 512), type: text(document.frontmatter.type),
      ...(typeof document.frontmatter.status === "string" ? { status: document.frontmatter.status } : {}),
      snippet: indexed?.snippet ?? clip(document.source.slice(start), 1024), ...(indexed ? { score: indexed.score } : {}) };
  };
  let matched = 0;
  if (!query || args.literal === true) {
    for (const document of [...documents].sort((a, b) => compare(a.path.normalize("NFC"), b.path.normalize("NFC")) || compare(a.path, b.path))) {
      if (query && !document.source.includes(query)) continue;
      if (matched++ < offset) continue;
      selected.push(hit(document)); if (selected.length > limit) break;
    }
  } else {
    // A peer may rescan the cache while this request runs. Materialize one bounded
    // statement result so metadata filtering and continuation use a stable hit set.
    for (const item of index.searchAll(query)) {
      const document = byPath.get(item.path); if (!document) continue;
      if (matched++ < offset) continue;
      selected.push(hit(document, item)); if (selected.length > limit) break;
    }
  }
  const result: Record<string, unknown> = { source, worktree: snapshot.root, hits: [], offset, truncated: false };
  const kept = rows(result, "hits", selected.slice(0, limit), limit);
  if (selected.length > kept.length) {
    if (!kept.length) throw new Error("spec grep: matching result metadata exceeds the response budget; narrow metadata filters or shorten oversized source metadata before retrying");
    result.truncated = true; result.nextOffset = offset + kept.length;
  }
  return result;
}

/** Shared read-only provider for CLI and MCP; caches may be derived outside all registered sources. */
export function executeSpecCommand(home: string, command: SpecCommand, args: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): unknown {
  if (!["get", "graph", "grep", "validate"].includes(command)) throw new Error("spec provider: unknown command; choose get, graph, grep or validate");
  const invalid = argumentError(args, specCommandSchema(command));
  if (invalid) throw new Error(`spec ${command}: ${invalid}; use vmem spec ${command} --help to correct the arguments`);
  const config = loadRegistry(home), sources = config.specs ?? [];
  const source = args.source === undefined ? sources[0] : sources.find(item => item.id === args.source);
  if (!source) throw new Error(sources.length ? "spec source is not registered; use vmem specs list and pass --source with a registered id" : "no spec sources are registered; run vmem specs add <id> <absolute-repository-root> first");
  const currentRegistry = () => {
    let current;
    try { current = loadRegistry(home); }
    catch (error) { throw new Error("spec registry became unreadable during the request; repair the registry and retry the read", { cause: error }); }
    if (!isDeepStrictEqual(current.specs?.find(item => item.id === source.id), source) || args.source === undefined && current.specs?.[0]?.id !== source.id) throw new Error("spec registry changed during the request; use vmem specs list to select the current source and retry the read");
  };
  let snapshot: SpecSnapshot, result: Record<string, unknown>;
  if (command === "validate") {
    snapshot = discoverSpecs(source, { env, ...(typeof args.worktree === "string" ? { worktree: args.worktree } : {}) });
    result = { ...validateSpecs(snapshot, { env, requireFresh: args.requireFresh === true, ...(typeof args.limit === "number" ? { limit: args.limit } : {}) }) };
  } else {
    const index = new SpecIndex(home, source, { env, ...(typeof args.worktree === "string" ? { worktree: args.worktree } : {}), protectedRoots: [...config.vaults, ...sources].map(item => item.path) });
    try {
      index.scan(); snapshot = index.snapshot();
      if (command === "grep") result = grep(index, snapshot, args, env, source.id);
      else {
        const graph = buildSpecGraph(snapshot), id = text(args.id), document = snapshot.specs.find(item => item.id === id);
        if (!document) throw new Error("spec id was not found; use vmem spec grep --source <source> to select a registered spec id");
        if (command === "graph") {
          const slice = specSlice(graph, id, { ...(typeof args.direction === "string" ? { direction: args.direction as "subtree" | "ancestors" | "neighbors" } : {}), ...(typeof args.edge === "string" ? { edge: args.edge as SpecEdgeKind } : {}), ...(typeof args.depth === "number" ? { depth: args.depth } : {}), ...(typeof args.limit === "number" ? { limit: args.limit } : {}) });
          result = { source: source.id, worktree: snapshot.root, nodes: [], edges: [], truncated: slice.truncated };
          const root = slice.nodes.find(node => node.id === id)!;
          if (!fits({ ...result, nodes: [root] })) throw new Error("spec graph: root metadata exceeds the response budget; shorten oversized spec metadata before requesting its graph");
          const ordered = [root, ...slice.nodes.filter(node => node.id !== id)];
          const nodes = rows(result, "nodes", ordered), ids = new Set(nodes.map(node => node.id));
          rows(result, "edges", slice.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)));
        } else {
          const freshness = specFreshness({ ...snapshot, specs: [document], candidates: [document] }, { env });
          const links = [], backlinks = [], childIds = new Set<string>();
          for (const edge of graph.edges) {
            if (edge.source === id) links.push(edge);
            if (edge.target === id) {
              backlinks.push(edge);
              if (edge.kind === "parent") childIds.add(edge.source);
            }
          }
          const children = graph.nodes.filter(node => childIds.has(node.id));
          result = { source: source.id, worktree: snapshot.root, id, path: document.path, sha256: document.hash, frontmatter: document.frontmatter, links: [], backlinks: [], children: [], freshness: freshness.items[0] ?? null, freshnessIssues: freshness.issues,
            truncated: false, totals: { links: links.length, backlinks: backlinks.length, children: children.length } };
          if (args.body === true || args.maxBytes !== undefined || args.section !== undefined || args.offset !== undefined) {
            Object.assign(result, bodyPage(document, args)); if (result.bodyTruncated === true) result.truncated = true;
          }
          if (!fits(result)) throw new Error("spec get: frontmatter/body metadata exceeds the response budget; reduce --max-bytes or shorten oversized frontmatter before retrying");
          rows(result, "links", links); rows(result, "backlinks", backlinks); rows(result, "children", children);
        }
      }
    } finally { index.close(); }
  }
  currentRegistry();
  result = { source: source.id, worktree: snapshot.root, ...result };
  checkBudget(result);
  return result;
}
