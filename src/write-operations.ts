import { isDeepStrictEqual } from "node:util";
import { normalizeSource } from "./source.ts";
import { parseFrontmatter, emitFrontmatter } from "./frontmatter.ts";
import { normalizeTarget, proseLines, rewriteLinkTargets, extractLinks, resolveLinks, type LinkNote } from "./links.ts";
import type { PlannedChange, WriteIssue, WriteOp } from "./write-types.ts";
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
  for (let i = start + 1; i < raw.length; i++) {
    const line = visible[i] ?? "";
    if (/^ {0,3}#{1,2}[ \t]/.test(line)) break;
    if (/^[ \t]*(?:[-*+][ \t]+)?(\[\[[^\]|#]+\]\])[ \t]*$/.test(line)) items.add(i);
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
/** Plan transformations in memory. This function never touches files. */
export function planOperation(operation: WriteOp, notes: Map<string, string>, reportBefore?: string | null): PlannedChange[] {
  const planned = new Map<string, PlannedChange>();
  const set = (path: string, after: string | null) => {
    const before = notes.get(path) ?? (operation.op === "report" ? reportBefore ?? null : null);
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
      if (typeof operation.oldString !== "string" || !operation.oldString || typeof operation.newString !== "string" || Buffer.byteLength(operation.oldString) > 8192 || Buffer.byteLength(operation.newString) > 8192) refuse("V09", "patch strings must be bounded and oldString nonempty", path);
      const first = source.indexOf(operation.oldString);
      if (first < 0 || source.indexOf(operation.oldString, first + 1) >= 0) refuse("V09", "oldString must match exactly once", path);
      if(first < (document(source,path).frontmatter?.length ?? 0))refuse("V01","patch cannot target frontmatter; use vmem_set_frontmatter or the frontmatter command",path);
      set(path, source.slice(0, first) + operation.newString + source.slice(first + operation.oldString.length));
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
      if (!["supports", "contradicts", "extends", "applies-to", "context-for"].includes(operation.relation)) refuse("V01", "invalid relation");
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
      set(old.path, emitFrontmatter(document(old.source, old.path), { status: "superseded", superseded_by: `[[${next.path.slice(6, -3)}]]` }));
      set(next.path, appendSection(next.source, "Relevant Notes", `- Supersedes [[${old.path.slice(6, -3)}]]`, next.path));
      break;
    }
    case "delete": { const { path } = existing(operation.path); set(path, null); break; }
    case "move": {
      const fromPath = moveSourcePath(operation.from, notes), from = { path: fromPath, source: needed(notes, fromPath) }, to = notePath(operation.to);
      if (notes.has(to)) refuse("V08", "move destination already exists", to);
      const names = new Map<string, Set<string>>();
      for (const [path, source] of notes) {
        document(source, path); // Every note must still parse before a move rewrites links.
        // Links resolve by path only, so alias-only links are left untouched.
        const key = normalizeTarget(path.slice(6, -3)), values = names.get(key) ?? new Set<string>(); values.add(path); names.set(key, values);
      }
      const replace = (target: string): string | undefined => {
        const candidates = names.get(normalizeTarget(target.replace(/^\.\//, "").replace(/^notes\//i, "").replace(/\.md$/i, "")));
        return candidates?.size === 1 && candidates.has(from.path) ? to.slice(6, -3) : undefined;
      };
      const rewriteValue = (value: unknown): unknown => {
        if (typeof value === "string") return rewriteLinkTargets(value, replace);
        if (Array.isArray(value)) return value.map(rewriteValue);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteValue(item)]));
        return value;
      };
      for (const [path, source] of notes) {
        const doc = document(source, path), changes: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(doc.data)) changes[key] = rewriteValue(value);
        const frontmatter = emitFrontmatter(doc, changes).slice(0, -doc.body.length || undefined);
        const output = (doc.body.length ? frontmatter : emitFrontmatter(doc, changes)) + rewriteLinkTargets(doc.body, replace);
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
