import { parseFrontmatter, emitFrontmatter } from "./frontmatter.ts";
import { normalizeTarget, proseLines, rewriteLinkTargets } from "./links.ts";
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
function needed(notes: Map<string, string>, path: string): string {
  const source = notes.get(path);
  if (source === undefined) refuse("V04", "note does not exist", path);
  return source;
}
function document(source: string, path: string) {
  try { return parseFrontmatter(source); } catch { return refuse("V01", "invalid frontmatter", path); }
}
function h2Sections(body: string): { name: string; start: number; end: number }[] {
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
function appendSection(source: string, section: string, markdown: string, path: string): string {
  if (typeof section !== "string" || !section.trim() || section.length > 120 || /[\r\n]/.test(section) || section.trim().replace(/[ \t]+#+$/, "").trim().toLowerCase() === "topics") refuse("V05", "append cannot target Topics or an invalid section");
  if (typeof markdown !== "string" || Buffer.byteLength(markdown) > 16384 || proseLines(markdown).some(line => /^ {0,3}##[ \t]+Topics(?:[ \t]+#+)?[ \t]*$/i.test(line))) refuse("V05", "append cannot introduce a Topics section or exceed 16384 bytes");
  const doc = document(source, path), sections = h2Sections(doc.body);
  const found = sections.filter(item => normalizeTarget(item.name) === normalizeTarget(section.trim()));
  if (found.length > 1) refuse("V05", "append section is ambiguous");
  const end = found[0]?.end ?? sections.find(item => item.name.toLowerCase() === "topics")?.start ?? doc.body.length;
  const addition = found.length ? `\n${markdown.trimEnd()}\n\n` : `\n## ${section.trim()}\n\n${markdown.trimEnd()}\n\n`;
  return (doc.frontmatter ?? "") + doc.body.slice(0, end).trimEnd() + "\n" + addition + doc.body.slice(end);
}
function tidy(source: string, path: string): string {
  const doc = document(source, path), sections = h2Sections(doc.body);
  const connections = sections.filter(section => /^Connections(?:\s*\(.*\))?$/i.test(section.name));
  if (!connections.length) return source;
  let body = doc.body, collected: string[] = [];
  for (const section of connections) collected.push(body.slice(section.start, section.end).replace(/^[^\n]*(?:\n|$)/, "").trim());
  for (const section of [...connections].reverse()) body = body.slice(0, section.start) + body.slice(section.end);
  return appendSection((doc.frontmatter ?? "") + body, "Relevant Notes", collected.join("\n\n"), path);
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
      try { set(path, emitFrontmatter(parseFrontmatter(body), operation.frontmatter)); }
      catch (error) { if (error instanceof WriteRefusal) throw error; refuse("V01", "cannot emit frontmatter", path); }
      break;
    }
    case "patch": {
      const { path, source } = existing(operation.path);
      if (typeof operation.oldString !== "string" || !operation.oldString || typeof operation.newString !== "string" || Buffer.byteLength(operation.oldString) > 8192 || Buffer.byteLength(operation.newString) > 8192) refuse("V09", "patch strings must be bounded and oldString nonempty", path);
      const first = source.indexOf(operation.oldString);
      if (first < 0 || source.indexOf(operation.oldString, first + 1) >= 0) refuse("V09", "oldString must match exactly once", path);
      set(path, source.slice(0, first) + operation.newString + source.slice(first + operation.oldString.length));
      break;
    }
    case "append": { const { path, source } = existing(operation.path); set(path, appendSection(source, operation.section, operation.markdown, path)); break; }
    case "frontmatter": {
      const { path, source } = existing(operation.path);
      if (!operation.set || typeof operation.set !== "object" || Array.isArray(operation.set) || (operation.unset !== undefined && (!Array.isArray(operation.unset) || operation.unset.some(key => typeof key !== "string")))) refuse("V01", "invalid frontmatter update");
      const changes = { ...operation.set };
      for (const key of operation.unset ?? []) changes[key] = undefined;
      try { set(path, emitFrontmatter(document(source, path), changes)); } catch (error) { if (error instanceof WriteRefusal) throw error; refuse("V01", "cannot emit frontmatter", path); }
      break;
    }
    case "link": {
      const from = existing(operation.from), to = existing(operation.to);
      if (!["supports", "contradicts", "extends", "applies-to", "context-for"].includes(operation.relation)) refuse("V01", "invalid relation");
      if (operation.context !== undefined && (typeof operation.context !== "string" || /[\r\n]/.test(operation.context) || operation.context.length > 500)) refuse("V01", "link context must be one line <=500 characters");
      if (from.path === to.path) refuse("V01", "link endpoints must differ");
      const line = (path: string) => `- [[${path.slice(6, -3)}]] (${operation.relation})${operation.context ? `: ${operation.context}` : ""}`;
      set(from.path, appendSection(from.source, "Relevant Notes", line(to.path), from.path));
      if (operation.bidirectional !== false) set(to.path, appendSection(to.source, "Relevant Notes", line(from.path), to.path));
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
      const from = existing(operation.from), to = notePath(operation.to);
      if (notes.has(to)) refuse("V08", "move destination already exists", to);
      const names = new Map<string, Set<string>>();
      for (const [path, source] of notes) {
        const data = document(source, path).data;
        const namesForNote = [path.slice(6, -3), ...(Array.isArray(data.aliases) ? data.aliases : typeof data.aliases === "string" ? [data.aliases] : [])];
        for (const name of namesForNote) if (typeof name === "string") {
          const key = normalizeTarget(name.replace(/^\.\//, "").replace(/^notes\//i, "").replace(/\.md$/i, "")), values = names.get(key) ?? new Set<string>(); values.add(path); names.set(key, values);
        }
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
    case "tidy": { for (const [path, source] of notes) set(path, tidy(source, path)); break; }
    case "report": {
      if (typeof operation.path !== "string" || !/^(?:reports|ops)\/[a-z0-9][a-z0-9./-]*$/.test(operation.path) || operation.path.split("/").some(part => !part || part === "." || part === "..") || Buffer.byteLength(operation.path) > 200 || typeof operation.text !== "string") refuse("V04", "invalid report path");
      set(operation.path, operation.text); break;
    }
    default: refuse("V01", "unknown write operation");
  }
  return [...planned.values()].sort((a, b) => a.path.localeCompare(b.path));
}
