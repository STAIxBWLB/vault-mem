import { isDeepStrictEqual } from "node:util";
import { normalizeSource, sourceReferences } from "./source.ts";
import { parseFrontmatter, emitFrontmatter, frontmatterReferences } from "./frontmatter.ts";
import { LINK_RELATIONS, normalizeTarget, proseLines, visibleProseLines, rewriteLinkTargets, extractLinks, resolveLinks, type LinkNote } from "./links.ts";
import { MAX_WRITE_BYTES, type MergeInboundLink, type MergePreview, type PatchEdit, type PlannedChange, type WriteIssue, type WriteOp } from "./write-types.ts";
export class WriteRefusal extends Error {
  constructor(readonly issues: WriteIssue[]) { super(issues[0]?.message ?? "write refused"); }
}
export function refuse(code: string, message: string, path?: string): never {
  throw new WriteRefusal([{ code, severity: "error", message, ...(path ? { path } : {}) }]);
}
export function notePath(path: string): string {
  if (typeof path !== "string") refuse("V04", "expected note path");
  const value = path.startsWith("notes/") ? path : `notes/${path.endsWith(".md") ? path : `${path}.md`}`;
  if (!/^notes\/[a-z0-9][a-z0-9-]*\.md$/.test(value) || Buffer.byteLength(value) > 200) refuse("V04", "expected flat lowercase ASCII note path <=200 bytes");
  return value;
}
/** A move source may keep a legacy file name (lint L13) as long as it is an existing flat note; `to` still uses notePath. */
export function moveSourcePath(value: string, notes: ReadonlyMap<string, string>): string {
  try { return notePath(value); } catch (error) {
    if (typeof value !== "string") throw error;
    const path = value.startsWith("notes/") ? value : `notes/${value.endsWith(".md") ? value : `${value}.md`}`;
    if (path.slice(6).includes("/") || path.includes("\\") || !path.endsWith(".md") || !notes.has(path)) throw error;
    return path;
  }
}
function needed(notes: Map<string, string>, path: string): string {
  const source = notes.get(path);
  if (source === undefined) refuse("V04", "note does not exist", path);
  return source;
}
function document(source: string, path: string) {
  try { return parseFrontmatter(source); } catch { return refuse("V01", "invalid frontmatter", path); }
}
export function h2Sections(body: string): { name: string; start: number; end: number }[] {
  const visible = proseLines(body), raw = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const sections: { name: string; start: number; end: number }[] = [];
  let offset = 0;
  for (let i = 0; i < raw.length; i++) {
    const heading = /^ {0,3}##[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(visible[i] ?? "");
    if (heading) {
      if (sections.length) sections[sections.length - 1]!.end = offset;
      sections.push({ name: heading[1]!, start: offset, end: body.length });
    }
    offset += raw[i]!.length;
  }
  return sections;
}
/** Replace the last prose `## Topics` section (never one inside a fence) with the given topics; append one if absent. */
export function replaceTopicsSection(body: string, topics: string[]): string {
  const prose = proseLines(body), raw = body.split("\n");
  let start = -1;
  for (let i = prose.length - 1; i >= 0; i--) if (/^ {0,3}##[ \t]+Topics[ \t]*#*[ \t]*$/i.test(prose[i]!)) { start = i; break; }
  const section = ["## Topics", "", ...topics.map(topic => `- ${topic}`), ""];
  if (start < 0) return `${body.replace(/\n*$/, "")}\n\n${section.join("\n")}`;
  // The section ends at the next prose heading of level 1 or 2.
  let end = raw.length;
  for (let i = start + 1; i < prose.length; i++) if (/^ {0,3}#{1,2}[ \t]/.test(prose[i]!)) { end = i; break; }
  const tail = raw.slice(end);
  return [...raw.slice(0, start), ...section, ...(tail.length ? tail : [])].join("\n").replace(/\n*$/, "\n");
}
/** In-place refiling replaces only visible wiki-list lines, preserving all other bytes. */
function replaceTopicsList(body: string, topics: string[], newline: string): string {
  const visible = proseLines(body), raw = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let start = -1;
  for (let i = visible.length - 1; i >= 0; i--) if (/^ {0,3}##[ \t]+Topics(?:[ \t]+#+)?[ \t]*$/i.test(visible[i]!)) { start = i; break; }
  const list = topics.map(topic => `- ${topic}`).join(newline);
  if (start < 0) return body + (body && !body.endsWith("\n") ? newline : "") + newline + `## Topics${newline}${newline}${list}${newline}`;
  const items = new Set<number>();
  // The Topics list is the leading run of list lines as V05 sees them: blank and fenced lines continue it (fences are kept),
  // the first visible heading or prose line ends it.
  for (let i = start + 1; i < raw.length; i++) {
    const line = visible[i] ?? "";
    if (/^[ \t]*(?:[-*+][ \t]+)?(\[\[[^\]|#]+\]\])[ \t]*$/.test(line)) items.add(i);
    else if (line.trim()) break;
  }
  const first = items.values().next().value;
  if (first === undefined) {
    const addition = (raw[start]!.endsWith("\n") ? "" : newline) + list + (list ? newline : "");
    return raw.slice(0, start + 1).join("") + addition + raw.slice(start + 1).join("");
  }
  const ending = /\r?\n$/.exec(raw[first]!)?.[0] ?? "";
  return raw.map((line, i) => i === first ? list + (list ? ending : "") : items.has(i) ? "" : line).join("");
}
export function appendSection(source: string, section: string, markdown: string, path: string): string {
  if (typeof section !== "string" || !section.trim() || section.length > 120 || /[\r\n]/.test(section) || section.trim().replace(/[ \t]+#+$/, "").trim().toLowerCase() === "topics") refuse("V05", "append cannot target Topics or an invalid section");
  if (typeof markdown !== "string" || Buffer.byteLength(markdown) > 16384 || proseLines(markdown).some(line => /^ {0,3}##[ \t]+Topics(?:[ \t]+#+)?[ \t]*$/i.test(line))) refuse("V05", "append cannot introduce a Topics section or exceed 16384 bytes");
  const doc = document(source, path), sections = h2Sections(doc.body);
  const found = sections.filter(item => normalizeTarget(item.name) === normalizeTarget(section.trim()));
  if (found.length > 1) refuse("V05", "append section is ambiguous");
  const end = found[0]?.end ?? sections.find(item => item.name.toLowerCase() === "topics")?.start ?? doc.body.length;
  const addition = found.length ? `\n${markdown.trimEnd()}\n\n` : `\n## ${section.trim()}\n\n${markdown.trimEnd()}\n\n`;
  return (doc.frontmatter ?? "") + doc.body.slice(0, end).trimEnd() + "\n" + addition + doc.body.slice(end);
}
/** Fold scattered `## Connections (...)` sections into `## Relevant Notes`. */
export function foldConnections(source: string, path: string): string {
  const doc = document(source, path), sections = h2Sections(doc.body);
  const connections = sections.filter(section => /^Connections(?:\s*\(.*\))?$/i.test(section.name));
  if (!connections.length) return source;
  let body = doc.body, collected: string[] = [];
  for (const section of connections) collected.push(body.slice(section.start, section.end).replace(/^[^\n]*(?:\n|$)/, "").trim());
  for (const section of [...connections].reverse()) body = body.slice(0, section.start) + body.slice(section.end);
  return appendSection((doc.frontmatter ?? "") + body, "Relevant Notes", collected.join("\n\n"), path);
}
function normalizedSourceChanges(data:Record<string,unknown>):Record<string,unknown>{
  const result={...data};
  if(Object.hasOwn(result,"source")&&result.source!==undefined)try{result.source=normalizeSource(result.source);}catch{refuse("V01","source must contain workspace-relative paths, mem ids or URLs");}
  return result;
}
function bodyAlreadyLinks(notes:Map<string,string>,from:string,to:string):boolean{
  const doc=document(needed(notes,from),from);let body=doc.body;
  for(const section of h2Sections(body).filter(section=>section.name.toLowerCase()==="topics").reverse())body=body.slice(0,section.start)+body.slice(section.start,section.end).replace(/[^\r\n]/g," ")+body.slice(section.end);
  const references=extractLinks(body).map(link=>({...link,heading:null,block:null}));
  if(!references.length)return false;
  const metadata:LinkNote[]=[];
  for(const [path,source] of notes)try{
    const parsed=parseFrontmatter(source),aliases=parsed.data.aliases??parsed.data.alias;
    metadata.push({path,title:typeof parsed.data.title==="string"?parsed.data.title:path,aliases:typeof aliases==="string"?[aliases]:Array.isArray(aliases)?aliases.filter((value):value is string=>typeof value==="string"):[],body:""});
  }catch{ /* Unrelated malformed legacy YAML cannot resolve an alias. */ }
  return resolveLinks(metadata,new Map([[from,references]])).some(link=>link.source===from&&link.resolved===to);
}
/** Conservative lexical fast path; escaped, tagged or anchored YAML keys still take semantic parsing. */
function mayHaveDoi(source: string): boolean {
  const closing = /^(?:---|\.\.\.)[ \t]*\r?$/gm;
  closing.lastIndex = source.indexOf("\n") + 1;
  const header = source.slice(0, closing.exec(source)?.index ?? source.length);
  return /(?:^|[{\n,])[ \t]*(?:doi|["']doi["'])[ \t]*:|[\\!&*?]/.test(header);
}
/** Shared date emission for validated note content, including promotion previews. */
export function stampNoteContent(source: string, today: string, create: boolean, warning?: (message: string) => void): string {
  const doc = parseFrontmatter(source);
  const dates = { updated: today, ...(create && !Object.hasOwn(doc.data, "created") ? { created: today } : {}) };
  const references = frontmatterReferences(doc);
  const skipStamp = (cause: string) => {
    const repair = "open this note in a text editor and rewrite the header as a block mapping with plain literal values" + (references.length ? ", replacing any aliases with their literal values and removing anchors" : "");
    warning?.(`automatic dates were not set: ${cause}; ${repair}; later authored writes stamp updated automatically${create && !Object.hasOwn(doc.data, "created") ? "; set created explicitly in the repaired header if it was also skipped" : ""}`);
    return source;
  };
  let candidate: string;
  try { candidate = emitFrontmatter(doc, dates); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "frontmatter: editing requires a block mapping") throw error;
    // Canonicalizing a flow or merge-key header would erase its reference graph.
    if (references.length) return skipStamp("rewriting this header would change YAML anchor/alias relationships");
    const newline = /\r?\n/.exec(doc.frontmatter ?? "")?.[0] ?? "\n";
    try {
      const header = emitFrontmatter(parseFrontmatter(""), { ...doc.data, ...dates }).replaceAll("\n", newline);
      candidate = source.slice(0, source.indexOf("---")) + header + doc.body;
    } catch (cause) {
      if (!(cause instanceof Error) || cause.message !== "frontmatter: changed values must be JSON-compatible") throw cause;
      return skipStamp("the header contains values that cannot round-trip through JSON (such as .inf, .nan or -0)");
    }
  }
  try {
    const stamped = parseFrontmatter(candidate);
    if (!isDeepStrictEqual(references, frontmatterReferences(stamped))) return skipStamp(references.length ? "date emission would change YAML anchor/alias relationships" : "the header could not be rewritten without changing its structure");
    if (!isDeepStrictEqual(stamped.data, { ...doc.data, ...dates })) return skipStamp(references.length ? "date emission would alter metadata or YAML anchor/alias values" : "the header could not be rewritten without changing a value");
  } catch { return skipStamp(references.length ? "the stamped YAML header would not parse after an anchor or alias changed" : "the stamped YAML header could not be parsed"); }
  return candidate;
}
/** Date authored content only; mechanical rewrites retain their existing freshness. */
export function stampContentChanges(operation: WriteOp, changes: PlannedChange[], today: string, issues: WriteIssue[] = []): PlannedChange[] {
  if (["check", "report", "move", "tidy", "sanitize"].includes(operation.op)) return changes;
  return changes.map(change => {
    if (change.after === null || change.after === change.before) return change;
    if (operation.op === "merge" && change.path !== notePath(operation.keep) && change.path !== notePath(operation.absorb)) return change;
    return { ...change, after: stampNoteContent(change.after, today, operation.op === "create", message => issues.push({ code: "V01", severity: "warning", path: change.path, message })) };
  }).filter(change => change.before !== change.after);
}

/** Path-only reference identity shared by move and merge; alias-only links remain untouched. */
function referenceReplacement(notes: Map<string, string>, from: string, to: string): (target: string) => string | undefined {
  const names = new Map<string, Set<string>>();
  for (const [path, source] of notes) {
    document(source, path);
    const key = normalizeTarget(path.slice(6, -3)), values = names.get(key) ?? new Set<string>(); values.add(path); names.set(key, values);
  }
  return target => {
    const candidates = names.get(normalizeTarget(target.replace(/^\.\//, "").replace(/^notes\//i, "").replace(/\.md$/i, "")));
    return candidates?.size === 1 && candidates.has(from) ? to.slice(6, -3) : undefined;
  };
}
/** Same metadata recursion and visible-body rewrite that move has always used. */
function rewriteNoteReferences(source: string, path: string, replace: (target: string) => string | undefined, inbound?: MergeInboundLink[], preserve: ReadonlySet<string> = new Set()): string {
  const doc = document(source, path);
  const record = (value: string, field: string, body = false) => {
    if (!inbound) return;
    for (const link of extractLinks(value)) {
      const replacement = replace(link.target);
      if (replacement !== undefined) inbound.push({ path, field, target: link.target, replacement, ...(body ? { line: link.line } : {}), ...(link.heading ? { heading: link.heading } : {}), ...(link.block ? { block: link.block } : {}) });
    }
  };
  const rewriteValue = (value: unknown, field: string): unknown => {
    if (typeof value === "string") { record(value, field); return rewriteLinkTargets(value, replace); }
    if (Array.isArray(value)) return value.map((item, index) => rewriteValue(item, `${field}[${index}]`));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteValue(item, `${field}.${key}`)]));
    return value;
  };
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc.data)) changes[key] = preserve.has(key) ? value : rewriteValue(value, key);
  record(doc.body, "body", true);
  const frontmatter = emitFrontmatter(doc, changes).slice(0, -doc.body.length || undefined);
  return (doc.body.length ? frontmatter : emitFrontmatter(doc, changes)) + rewriteLinkTargets(doc.body, replace);
}
function supersededNote(source: string, path: string, next: string): string {
  return emitFrontmatter(document(source, path), { status: "superseded", superseded_by: `[[${next.slice(6, -3)}]]` });
}
function topicKey(value: string): string { return normalizeTarget(value.slice(2, -2).trim().replace(/^\.\//, "").replace(/^notes\//i, "").replace(/\.md$/i, "")); }
function mergeTopics(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(topic => typeof topic !== "string" || !/^\[\[[^\]|#]+\]\]$/.test(topic))) refuse("V01", "merge topics must be a list of plain wiki targets; repair topics in this note before merging", path);
  return value as string[];
}
/** Remove only a plain Topics list; unusual authored contents need an explicit repair, never silent deletion. */
function withoutMergeTopics(body: string, topics: string[], path: string): string {
  const visible = mergeHeadingLines(body), raw = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (visible.some((line, index) => /^Topics[ \t]*$/i.test(line.trim()) && /^ {0,3}-+[ \t]*$/.test(visible[index + 1] ?? ""))) refuse("V05", "merge cannot consolidate a Setext Topics heading safely; convert it to a plain ## Topics list before merging", path);
  const headings = visible.flatMap((line, index) => /^ {0,3}##[ \t]+Topics(?:[ \t]+#+)?[ \t]*$/i.test(line) ? [index] : []);
  if (headings.length > 1) refuse("V05", "merge found multiple Topics sections; consolidate them into one matching topic list before merging", path);
  const start = headings[0]; if (start === undefined) return body;
  let end = start + 1;
  while (end < raw.length && !/^ {0,3}#{1,2}(?:[ \t]+|$)/.test(visible[end] ?? "")) end++;
  const found: string[] = [];
  for (const line of raw.slice(start + 1, end)) {
    if (!line.trim()) continue;
    const wiki = /^[ \t]*(?:[-*+][ \t]+)?(\[\[[^\]|#]+\]\])[ \t]*(?:\r?\n)?$/.exec(line);
    if (!wiki) refuse("V05", "merge cannot discard prose, headings or code inside Topics; move that content outside Topics and retry the merge", path);
    found.push(topicKey(wiki[1]!));
  }
  const expected = topics.map(topicKey).sort(); found.sort();
  if (found.length !== expected.length || found.some((value, index) => value !== expected[index])) refuse("V05", "merge Topics list does not match its metadata; align the body list with frontmatter topics before merging", path);
  return raw.slice(0, start).join("") + raw.slice(end).join("");
}
/** Merge structural edits ignore raw HTML conservatively, through the next blank line. */
function mergeHeadingLines(body: string): string[] {
  const raw = body.split(/\r?\n/); let html = false;
  return visibleProseLines(body).map((line, index) => {
    if (!raw[index]?.trim()) html = false;
    else if (/^ {0,3}</.test(line)) html = true;
    return html ? "" : line;
  });
}
/** Remove only a leading title H1; demote other ATX headings and leave Setext/code/HTML untouched. */
function demoteMergeHeadings(body: string): string {
  const visible = mergeHeadingLines(body), raw = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const leading = raw.findIndex(line => line.trim());
  return raw.map((line, index) => {
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(visible[index] ?? "");
    if (!heading) return line;
    if (index === leading && heading[1]!.length === 1 && /^ {0,3}#[ \t]+\S/.test(line)) return "";
    return heading[1]!.length < 6 ? line.replace(/^( {0,3})(#+)/, "$1#$2") : line;
  }).join("");
}
function mergeGap(body: string, newline: string): string {
  if (body.endsWith("\n\n") || body.endsWith("\r\n\r\n")) return body;
  return body + (body.endsWith("\n") ? newline : newline + newline);
}
/** Pure all-note merge plan, composed after rewriting existing references so its new provenance link is retained. */
export function planMerge(operation: Extract<WriteOp, { op: "merge" }>, notes: Map<string, string>): { changes: PlannedChange[]; preview: MergePreview } {
  const keep = notePath(operation.keep), absorb = notePath(operation.absorb);
  if (keep === absorb) refuse("V10", "merge endpoints must differ; choose separate keep and absorb notes", keep);
  const kept = document(needed(notes, keep), keep), absorbed = document(needed(notes, absorb), absorb);
  if (typeof kept.data.type !== "string" || !kept.data.type.trim() || kept.data.type !== absorbed.data.type || [kept.data.type, absorbed.data.type].some(type => type === "person" || type === "moc")) refuse("V01", "merge requires matching types other than person or moc; choose compatible notes", keep);
  const replace = referenceReplacement(notes, absorb, keep), inboundLinks: MergeInboundLink[] = [], rewritten = new Map<string, string>();
  for (const [path, source] of notes) {
    try { rewritten.set(path, rewriteNoteReferences(source, path, replace, inboundLinks, path === keep ? new Set(["supersedes"]) : undefined)); }
    catch (error) {
      if (error instanceof WriteRefusal) throw error;
      refuse("V01", "merge cannot rewrite this note's metadata losslessly; repair its YAML or convert the header to a block mapping, then request a fresh merge preview", path);
    }
  }
  const keepDoc = document(rewritten.get(keep)!, keep), absorbDoc = document(rewritten.get(absorb)!, absorb);
  const sources: string[] = [];
  for (const [path, doc] of [[keep, keepDoc], [absorb, absorbDoc]] as const) if (doc.data.source !== undefined) {
    let refs: string[];
    try { refs = sourceReferences(doc.data.source).map(reference => reference.value); }
    catch { refuse("V01", "merge source must contain at most 32 valid references; repair source entries in either note before merging", path); }
    for (const value of refs) if (!sources.includes(value)) sources.push(value);
  }
  if (sources.length > 32) refuse("V01", "merge source union exceeds 32 entries; trim sources in either note first, then retry the merge", keep);
  const keepTopics = mergeTopics(keepDoc.data.topics, keep), absorbTopics = mergeTopics(absorbDoc.data.topics, absorb), topics: string[] = [], seen = new Set<string>();
  for (const topic of [...keepTopics, ...absorbTopics]) if (!seen.has(topicKey(topic))) { seen.add(topicKey(topic)); topics.push(topic); }
  const newline = /\r?\n/.exec(keepDoc.body)?.[0] ?? "\n";
  const first = withoutMergeTopics(keepDoc.body, keepTopics, keep), second = demoteMergeHeadings(withoutMergeTopics(absorbDoc.body, absorbTopics, absorb));
  const body = mergeGap(mergeGap(first, newline) + `## Merged from [[${absorb.slice(6, -3)}]]${newline}${newline}` + second, newline) + `## Topics${newline}${newline}` + topics.map(topic => `- ${topic}${newline}`).join("");
  if (Buffer.byteLength(body) > MAX_WRITE_BYTES) refuse("V09", "merged body exceeds 256 KiB; shorten either note's content before retrying the merge", keep);
  try {
    const metadata = emitFrontmatter(keepDoc, { source: sources.length ? sources : undefined, topics });
    rewritten.set(keep, (parseFrontmatter(metadata).frontmatter ?? "") + body);
    rewritten.set(absorb, supersededNote(rewritten.get(absorb)!, absorb, keep));
  } catch { refuse("V01", "merge metadata cannot be edited losslessly; convert endpoint headers to editable block mappings and retry the merge", keep); }
  const changes = [...rewritten].filter(([path, after]) => after !== notes.get(path)).map(([path, after]) => ({ path, before: notes.get(path)!, after })).sort((a, b) => a.path.localeCompare(b.path));
  const oversized = changes.find(change => Buffer.byteLength(change.after) > MAX_WRITE_BYTES);
  if (oversized) refuse("V09", "merged file or inbound rewrite exceeds 256 KiB; shorten the affected note before retrying the merge", oversized.path);
  return { changes, preview: { keep, absorb, body, source: sources, topics, inboundLinks } };
}

/** Plan transformations in memory. This function never touches files. */
export function planOperation(operation: WriteOp, notes: Map<string, string>, reportBefore?: string | null): PlannedChange[] {
  const planned = new Map<string, PlannedChange>();
  const set = (path: string, after: string | null) => {
    const before = notes.get(path) ?? (operation.op === "report" ? reportBefore ?? null : null);
    if (after === before) return;
    if (after !== null && operation.op !== "report" && mayHaveDoi(after)) {
      try {
        const previousText = operation.op === "move" && path === notePath(operation.to)
          ? needed(notes, moveSourcePath(operation.from, notes)) : before;
        const doc = parseFrontmatter(after), previous = previousText === null ? undefined : parseFrontmatter(previousText).data;
        // Normalize newly assigned identifiers; edits and moves leave untouched legacy metadata byte-identical.
        if (doc.data.type === "reference" && typeof doc.data.doi === "string" &&
          (previous?.type !== "reference" || previous.doi !== doc.data.doi ||
            (operation.op === "frontmatter" && Object.hasOwn(operation.set, "doi")))) {
          after = emitFrontmatter(doc, { doi: doc.data.doi.toLowerCase() });
        }
      } catch { /* Invalid YAML is reported by validation, without obscuring its named issue. */ }
    }
    if (after !== before) planned.set(path, { path, before, after });
  };
  const existing = (value: string) => { const path = notePath(value); return { path, source: needed(notes, path) }; };
  switch (operation.op) {
    case "check": {
      const path = notePath(operation.path);
      if (typeof operation.text !== "string") refuse("V01", "check input must be text");
      // Include unchanged candidates too, so check still validates existing content.
      planned.set(path, { path, before: notes.get(path) ?? null, after: operation.text });
      break;
    }
    case "create": {
      const path = notePath(operation.path);
      if (notes.has(path)) refuse("V08", "note already exists", path);
      if (!operation.frontmatter || typeof operation.frontmatter !== "object" || Array.isArray(operation.frontmatter)) refuse("V01", "frontmatter must be a mapping");
      const title = typeof operation.frontmatter.title === "string" ? operation.frontmatter.title : path.slice(6, -3).replaceAll("-", " ");
      const topics = Array.isArray(operation.frontmatter.topics) ? operation.frontmatter.topics.filter(v => typeof v === "string").join("\n- ") : "";
      const body = operation.body ?? `# ${title}\n\nThis note argues that ${title}.\n\n## Relevant Notes\n\n## Topics\n\n${topics ? `- ${topics}\n` : ""}`;
      if (typeof body !== "string") refuse("V01", "body must be text");
      try { const doc=parseFrontmatter(body),fields={...operation.frontmatter};if(!Object.hasOwn(fields,"source")&&doc.data.source!==undefined)fields.source=doc.data.source;set(path, emitFrontmatter(doc, normalizedSourceChanges(fields))); }
      catch (error) { if (error instanceof WriteRefusal) throw error; refuse("V01", "cannot emit frontmatter", path); }
      break;
    }
    case "patch": {
      const { path, source } = existing(operation.path);
      const single = operation.oldString !== undefined || operation.newString !== undefined;
      if (single === (operation.edits !== undefined)) refuse("V01", "patch takes either oldString/newString or edits, not both or neither; send one form", path);
      const edits: unknown[] = single ? [{ oldString: operation.oldString, newString: operation.newString }] : Array.isArray(operation.edits) ? operation.edits : [];
      if (edits.length < 1 || edits.length > 32) refuse("V09", "edits must list 1 to 32 replacements; split a larger change into several patches", path);
      const frontmatterEnd = document(source, path).frontmatter?.length ?? 0;
      // Every edit is located in the original text, so earlier edits cannot create or remove a later match.
      const spans = edits.map((edit, index) => {
        const at = single ? "" : `edits[${index}]: `;
        if (!edit || typeof edit !== "object" || Array.isArray(edit) || Object.keys(edit).some(key => key !== "oldString" && key !== "newString")) refuse("V01", `${at}an edit is exactly {oldString, newString}`, path);
        const { oldString, newString } = edit as Partial<PatchEdit>;
        if (typeof oldString !== "string" || !oldString || typeof newString !== "string" || Buffer.byteLength(oldString) > 8192 || Buffer.byteLength(newString) > 8192) refuse("V09", `${at}patch strings must be bounded and oldString nonempty`, path);
        const first = source.indexOf(oldString);
        if (first < 0 || source.indexOf(oldString, first + 1) >= 0) refuse("V09", single ? "oldString must match exactly once" : `${at}oldString must match exactly once in the original note; re-read the note and widen the string`, path);
        if (first < frontmatterEnd) refuse("V01", `${at}patch cannot target frontmatter; use vmem_set_frontmatter or the frontmatter command`, path);
        return { start: first, end: first + oldString.length, text: newString, index };
      }).sort((a, b) => a.start - b.start);
      let after = "", cursor = 0;
      for (const span of spans) {
        if (span.start < cursor) refuse("V09", `edits[${span.index}]: oldString overlaps another edit; merge overlapping edits into one`, path);
        after += source.slice(cursor, span.start) + span.text; cursor = span.end;
      }
      set(path, after + source.slice(cursor));
      break;
    }
    case "append": { const { path, source } = existing(operation.path); set(path, appendSection(source, operation.section, operation.markdown, path)); break; }
    case "frontmatter": {
      const { path, source } = existing(operation.path);
      if (!operation.set || typeof operation.set !== "object" || Array.isArray(operation.set) || (operation.unset !== undefined && (!Array.isArray(operation.unset) || operation.unset.some(key => typeof key !== "string")))) refuse("V01", "invalid frontmatter update");
      const changes = {...operation.set};
      for (const key of operation.unset ?? []) changes[key] = undefined;
      try {
        const before = document(source, path);
        // An explicit equal legacy DOI assignment still canonicalizes before the unchanged-text fast path.
        if ((Object.hasOwn(changes, "type") ? changes.type : before.data.type) === "reference" && typeof changes.doi === "string") changes.doi = changes.doi.toLowerCase();
        let after = emitFrontmatter(before, normalizedSourceChanges(changes));
        if (Object.hasOwn(operation.set, "topics") && !isDeepStrictEqual(changes.topics, before.data.topics) && Array.isArray(changes.topics) && changes.topics.every((value): value is string => typeof value === "string")) {
          const doc = document(after, path);
          after = (doc.frontmatter ?? "") + replaceTopicsList(doc.body, changes.topics, /\r?\n/.exec(source)?.[0] ?? "\n");
        }
        set(path, after);
      } catch (error) { if (error instanceof WriteRefusal) throw error; refuse("V01", "cannot emit frontmatter", path); }
      break;
    }
    case "link": {
      const from = existing(operation.from), to = existing(operation.to);
      if (!(LINK_RELATIONS as readonly string[]).includes(operation.relation)) refuse("V01", "invalid relation");
      if (operation.context !== undefined && (typeof operation.context !== "string" || /[\r\n]/.test(operation.context) || operation.context.length > 500)) refuse("V01", "link context must be one line <=500 characters");
      if (from.path === to.path) refuse("V01", "link endpoints must differ");
      const line = (path: string) => `- [[${path.slice(6, -3)}]] (${operation.relation})${operation.context ? `: ${operation.context}` : ""}`;
      if(!bodyAlreadyLinks(notes,from.path,to.path))set(from.path, appendSection(from.source, "Relevant Notes", line(to.path), from.path));
      if (operation.bidirectional !== false && !bodyAlreadyLinks(notes,to.path,from.path)) set(to.path, appendSection(to.source, "Relevant Notes", line(from.path), to.path));
      break;
    }
    case "supersede": {
      const old = existing(operation.old), next = existing(operation.next);
      if (old.path === next.path) refuse("V10", "supersession endpoints must differ");
      set(old.path, supersededNote(old.source, old.path, next.path));
      set(next.path, appendSection(next.source, "Relevant Notes", `- Supersedes [[${old.path.slice(6, -3)}]]`, next.path));
      break;
    }
    case "merge": return planMerge(operation, notes).changes;
    case "delete": { const { path } = existing(operation.path); set(path, null); break; }
    case "move": {
      const fromPath = moveSourcePath(operation.from, notes), from = { path: fromPath, source: needed(notes, fromPath) }, to = notePath(operation.to);
      if (notes.has(to)) refuse("V08", "move destination already exists", to);
      const replace = referenceReplacement(notes, from.path, to);
      for (const [path, source] of notes) {
        const output = rewriteNoteReferences(source, path, replace);
        if (path === from.path) { set(path, null); set(to, output); }
        else set(path, output);
      }
      break;
    }
    case "tidy": { for (const [path, source] of notes) set(path, foldConnections(source, path)); break; }
    case "sanitize": {
      if (typeof operation.path !== "string" || !notes.has(operation.path) || typeof operation.text !== "string") refuse("V04", "sanitize requires an existing snapshot note path and text");
      set(operation.path, operation.text); break;
    }
    case "report": {
      if (typeof operation.path !== "string" || !/^(?:reports|ops)\/[a-z0-9][a-z0-9./-]*$/.test(operation.path) || operation.path.split("/").some(part => !part || part === "." || part === "..") || Buffer.byteLength(operation.path) > 200 || typeof operation.text !== "string") refuse("V04", "invalid report path");
      set(operation.path, operation.text); break;
    }
    default: refuse("V01", "unknown write operation");
  }
  return [...planned.values()].sort((a, b) => a.path.localeCompare(b.path));
}
