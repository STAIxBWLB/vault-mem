import { isDeepStrictEqual } from "node:util";
import { sourceReferences, sourceWorkspaceRoot, missingSourceWarnings } from "./source.ts";
import { basename, resolve } from "node:path";
import type { VaultSpec, VmemConfig } from "./config.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { extractLinks, normalizeTarget, proseLines, resolveLinks, type Link, type LinkNote, type ResolvedLink } from "./links.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import type { PlannedChange, ValidationContext, WriteIssue } from "./write-types.ts";
import type { PiiSurface } from "./config.ts";
import { screenPii } from "./pii.ts";
import { moveSourcePath } from "./write-operations.ts";

const TYPES = new Set(["insight", "decision", "observation", "person", "project", "method", "moc", "reference"]);
const DOMAINS = new Set(["research", "projects", "teaching", "operations", "people", "ai-practice"]);
const CONFIDENCE = new Set(["proven", "likely", "experimental"]);
const STATUS = new Set(["active", "superseded", "archived"]);
const CATEGORY = new Set(["gap", "prompt", "workflow"]);
const KEYS = new Set([
  "description", "type", "domain", "topics", "source", "confidence", "status",
  "methodology", "evidence_strength", "project", "alternatives", "superseded_by", "supersedes", "stakeholders",
  "course", "semester", "student_level", "institution", "policy_area", "role", "affiliation", "last_contact",
  "tool", "category", "resolution_status", "aliases", "tags", "cssclasses", "title", "created", "updated", "received", "entities",
  "promoted_from", "promoted_at", "promoted_to", "source_ref",
  // Adopted in the V2 cutover (#22): decision dates/owners and person contact fields.
  "decided_at", "decided_by", "email", "phone",
]);
/** Adopted keys valid only on one note type (contact fields additionally only in personal vaults, by PII policy). */
export const TYPED_KEYS: Readonly<Record<string, string>> = { decided_at: "decision", decided_by: "decision", email: "person", phone: "person" };
export const SCHEMA_KEYS: ReadonlySet<string> = KEYS;
const WIKI_FIELDS = ["topics", "project", "superseded_by", "supersedes", "source_ref"];
// Exact regex set from @staix/agent-mem v0.11.0 src/memory/screen.ts; parity-tested against its root export.
const SECRETS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{40,}/, /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{35}\b/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}/i];
export const SECRET_PATTERNS: readonly RegExp[] = SECRETS;
export { EMAIL_PATTERN } from "./pii.ts";
const MAX_BYTES = 256 * 1024;
function issue(code: string, message: string, severity: WriteIssue["severity"] = "error", path?: string): WriteIssue {
  return { code, severity, message, ...(path ? { path } : {}) };
}
/** Screen the whole prospective text, including frontmatter, without returning matched values. Secrets are always refused; PII follows the vault policy for this surface. */
export function screenContent(text: string, vault: VaultSpec, config: VmemConfig, surface: PiiSurface = "notes"): WriteIssue[] {
  const issues: WriteIssue[] = [];
  if (SECRETS.some(pattern => pattern.test(text))) issues.push(issue("V06", "secret-looking content is refused"));
  return [...issues, ...screenPii(text, vault, config, surface)];
}

/** Quoted escapes must not hide semantic metadata from the same content policy. */
function screenMetadata(data:Record<string,unknown>,context:ValidationContext,path:string):WriteIssue[]{
  const found=new Map<string,WriteIssue>(),active=new WeakSet<object>();let nodes=0,bytes=0;
  const inspect=(text:string)=>{
    bytes+=Buffer.byteLength(text);if(bytes>MAX_BYTES*4)throw new Error("budget");
    // One issue per code; an error is never downgraded by a later warning of the same code.
    for(const item of screenContent(text,context.vault,context.config,context.piiSurface)){const prior=found.get(item.code);if(!prior||(prior.severity!=="error"&&item.severity==="error"))found.set(item.code,{...item,path});}
  };
  const visit=(value:unknown,key:string|undefined,depth:number):void=>{
    if(++nodes>10000||depth>32)throw new Error("budget");
    if(value===null||typeof value!=="object"){
      const text=String(value);inspect(text);if(key!==undefined)inspect(key+": "+text);return;
    }
    if(active.has(value))throw new Error("cycle");active.add(value);
    try{if(Array.isArray(value))for(const item of value)visit(item,key,depth+1);
      else for(const [name,item] of Object.entries(value)){inspect(name);visit(item,name,depth+1);}}
    finally{active.delete(value);}
  };
  try{visit(data,undefined,0);}catch{return [...found.values(),issue("V09","frontmatter semantic screening exceeds safe traversal bounds","error",path)];}
  return [...found.values()];
}

interface ParsedNote extends LinkNote { data: Record<string, unknown>; h1: string; text: string }
function strings(value: unknown): string[] {
  return typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function fold(value: string): string { return value.normalize("NFKC").toLowerCase().replace(/[-_\s]+/g, " ").trim(); }
/** Notes whose path and text match `reuse` keep that parsed object, so link analysis is shared too. */
function parseNotes(notes: Map<string, string>, reuse?: Map<string, ParsedNote>): Map<string, ParsedNote> {
  const parsed = new Map<string, ParsedNote>();
  for (const [path, text] of notes) {
    const previous = reuse?.get(path);
    if (previous?.text === text) { parsed.set(path, previous); continue; }
    try {
      const { data, body } = parseFrontmatter(text);
      const h1 = proseLines(body).map(line => /^ {0,3}#(?:[ \t]+(.*)|[ \t]*)$/.exec(line)).find(match => match)?.[1]?.replace(/[ \t]+#+[ \t]*$/, "").trim() ?? "";
      parsed.set(path, { path, title: typeof data.title === "string" ? data.title : h1 || basename(path, ".md"), aliases: strings(data.aliases), body, data, h1, text });
    } catch { /* An invalid changed note is reported separately; unrelated legacy YAML is not exposed. */ }
  }
  return parsed;
}
function noteKey(value: string): string {
  return normalizeTarget(value.replace(/^\.\//, "").replace(/^notes\//i, "").replace(/\.md$/i, ""));
}
function names(notes: Map<string, ParsedNote>): Map<string, Set<ParsedNote>> {
  const result = new Map<string, Set<ParsedNote>>();
  // Path-only, matching Obsidian, lint L01 and resolveLinks.
  for (const note of notes.values()) {
    const key = noteKey(note.path), candidates = result.get(key) ?? new Set<ParsedNote>();
    candidates.add(note); result.set(key, candidates);
  }
  return result;
}
function target(value: unknown, index: Map<string, Set<ParsedNote>>): ParsedNote | undefined {
  if (typeof value !== "string") return undefined;
  const wiki = /^\[\[([^\]|#]+)\]\]$/.exec(value.trim());
  if (!wiki || !wiki[1]!.trim()) return undefined;
  const candidates = index.get(noteKey(wiki[1]!.trim()));
  return candidates?.size === 1 ? candidates.values().next().value : undefined;
}
const metadataLinks = new WeakMap<ParsedNote, Link[]>();
function references(notes: Map<string, ParsedNote>): ResolvedLink[] {
  const metadata = new Map([...notes].map(([path, note]) => {
    let links = metadataLinks.get(note);
    if (!links) metadataLinks.set(note, links = WIKI_FIELDS.flatMap(key => strings(note.data[key]).flatMap(value => extractLinks(value))));
    return [path, links];
  }));
  return resolveLinks([...notes.values()], metadata);
}
function linkSignature(link: ResolvedLink, source: string = link.source): string {
  return JSON.stringify([source, noteKey(link.target), link.heading ? normalizeTarget(link.heading) : null,
    link.block ? normalizeTarget(link.block) : null, link.embed, link.reason]);
}
/** The snapshot path a move removes, legacy file names included. */
function movedFrom(value: string, context: ValidationContext): string {
  try { return moveSourcePath(value, context.notes); } catch { return `notes/${value.replace(/^notes\//, "").replace(/\.md$/, "")}.md`; }
}
function changedBrokenLinks(oldNotes: Map<string, ParsedNote>, newNotes: Map<string, ParsedNote>, context: ValidationContext): WriteIssue[] {
  const oldCounts = new Map<string, number>();
  const move = context.operation.op === "move" ? context.operation : undefined;
  const from = move ? movedFrom(move.from, context) : "";
  const to = move ? `notes/${move.to.replace(/^notes\//, "").replace(/\.md$/, "")}.md` : "";
  const oldNames = move ? names(oldNotes) : undefined;
  for (const link of references(oldNotes)) if (link.reason) {
    const candidates = oldNames?.get(noteKey(link.target));
    const renamedTarget = candidates?.size === 1 && [...candidates][0]!.path === from;
    const signature = linkSignature(renamedTarget ? { ...link, target: to } : link, link.source === from ? to : link.source);
    oldCounts.set(signature, (oldCounts.get(signature) ?? 0) + 1);
  }
  const issues: WriteIssue[] = [];
  for (const link of references(newNotes)) if (link.reason) {
    const signature = linkSignature(link), count = oldCounts.get(signature) ?? 0;
    if (count) oldCounts.set(signature, count - 1);
    issues.push(issue("V03", count ? "pre-existing unresolved link retained" : "new unresolved link is refused", count ? "warning" : "error", link.source));
  }
  return issues;
}
interface SchemaIssue extends WriteIssue { fields: string[] }
function schema(note: ParsedNote): SchemaIssue[] {
  const issues: SchemaIssue[] = [], { data, path } = note;
  const add=(field:string,message:string,dependencies=[field])=>issues.push({...issue("V01",message,"error",path),fields:dependencies});
  for(const key of Object.keys(data))if(!KEYS.has(key)||(TYPED_KEYS[key]!==undefined&&data.type!==TYPED_KEYS[key]))add(key,"unknown frontmatter key",[key,"type"]);
  const description = data.description;
  if (typeof description !== "string" || !description.trim() || [...description].length > 200) add("description","description must contain 1..200 Unicode characters");
  else if ([note.title, note.h1, basename(path, ".md")].some(value => value && fold(description) === fold(value))) add("description","description must supplement the title");
  if (typeof data.type !== "string" || !TYPES.has(data.type)) add("type","invalid or missing note type");
  if (data.type !== "moc" || data.domain !== undefined) {
    if (typeof data.domain !== "string" || !DOMAINS.has(data.domain)) add("domain","invalid or missing domain");
  }
  for (const [key, allowed] of [["confidence", CONFIDENCE], ["status", STATUS], ["category", CATEGORY]] as const) {
    if (data[key] !== undefined && (typeof data[key] !== "string" || !allowed.has(data[key]))) add(key,`invalid ${key} enum`);
  }
  if(data.source!==undefined)try{sourceReferences(data.source);}catch{add("source","source must contain workspace-relative paths, mem ids or URLs");}
  return issues;
}
function schemaIssues(note:ParsedNote,old:ParsedNote|undefined,context:ValidationContext):WriteIssue[]{
  const op=context.operation;
  const explicit=op.op==="frontmatter"&&noteKey(op.path)===noteKey(note.path)?new Set(Object.keys(op.set)):new Set<string>();
  const value=(n:ParsedNote,key:string)=>n.data[key];
  const previous=old?schema(old):[];
  return schema(note).map(({fields,...finding})=>{
    const retained=op.op!=="create"&&old&&!fields.some(key=>explicit.has(key))&&fields.every(key=>isDeepStrictEqual(value(note,key),value(old,key)))&&previous.some(before=>before.message===finding.message&&isDeepStrictEqual(before.fields,fields));
    return {...finding,severity:retained?"warning":"error"};
  });
}
function validPath(path: string, report: boolean): boolean {
  if (Buffer.byteLength(path) > 200 || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) return false;
  return report ? /^(?:reports|ops)\//.test(path) && path.split("/").slice(1).every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) : /^notes\/[a-z0-9][a-z0-9-]*\.md$/.test(path);
}
function topicIssues(note: ParsedNote, index: Map<string, Set<ParsedNote>>, severity: WriteIssue["severity"]): WriteIssue[] {
  if (note.data.type === "moc" && note.data.topics === undefined) return [];
  if (!Array.isArray(note.data.topics) || note.data.topics.length === 0 || note.data.topics.some(value => !target(value, index) || target(value, index)!.data.type !== "moc")) {
    return [issue("V02", "topics must be nonempty wiki links to existing MOC notes", severity, note.path)];
  }
  return [];
}
function topicPlacement(note: ParsedNote): WriteIssue[] {
  if (note.data.type === "moc" && note.data.topics === undefined) return [];
  const lines = proseLines(note.body), h2s = lines.flatMap((line, index) => /^ {0,3}##[ \t]+/.test(line) ? [index] : []);
  const topics = h2s.filter(index => /^ {0,3}##[ \t]+Topics(?:[ \t]+#+)?[ \t]*$/i.test(lines[index]!));
  let valid = topics.length === 1 && h2s[h2s.length - 1] === topics[0];
  const actual: string[] = [];
  if (valid) for (const line of lines.slice(topics[0]! + 1)) {
    if (!line.trim()) continue;
    const wiki = /^[ \t]*(?:[-*+][ \t]+)?(\[\[[^\]|#]+\]\])[ \t]*$/.exec(line);
    if (!wiki) { valid = false; break; }
    actual.push(noteKey(wiki[1]!.slice(2, -2)));
  }
  const expected = Array.isArray(note.data.topics) ? note.data.topics.map(value => typeof value === "string" ? noteKey(value.slice(2, -2)) : "") : [];
  const sortedExpected = [...expected].sort();
  if (actual.length !== expected.length || [...actual].sort().some((value, index) => value !== sortedExpected[index])) valid = false;
  return valid ? [] : [issue("V05", "Topics must be the final H2 and list exactly the frontmatter topics", "warning", note.path)];
}

/** Validate a complete mutation plan against the final overlaid snapshot, without filesystem writes. */
export function validateWrite(changes: PlannedChange[], context: ValidationContext): WriteIssue[] {
  const issues: WriteIssue[] = [], final = new Map(context.notes), touched = new Set(changes.map(change => change.path));
  const report = context.operation.op === "report";
  for (const change of changes) {
    // Sanitize and move may touch an existing legacy-named note (L13 names stay until moved); move destinations stay strict.
    const legacy = context.notes.has(change.path) && (context.operation.op === "sanitize" || context.operation.op === "move");
    if (!validPath(change.path, report) && !legacy) issues.push(issue("V04", "invalid mutation path"));
    if (change.after === null) final.delete(change.path);
    else if (change.path.startsWith("notes/")) final.set(change.path, change.after);
    if (change.after === null) continue;
    if (Buffer.byteLength(change.after) > MAX_BYTES) issues.push(issue("V09", "prospective file exceeds 256 KiB", "error", change.path));
    issues.push(...screenContent(change.after, context.vault, context.config, context.piiSurface).map(value => ({ ...value, path: change.path })));
    try{issues.push(...screenMetadata(parseFrontmatter(change.after).data,context,change.path));}catch{ /* Invalid note YAML is reported separately; reports remain schema-exempt. */ }
  }
  const sourceRoot=sourceWorkspaceRoot(context.vault);
  const oldNotes = parseNotes(context.notes), newNotes = parseNotes(final, oldNotes), oldNames = names(oldNotes), newNames = names(newNotes);
  const candidates=[...changes];
  if(context.operation.op==="frontmatter"){
    const key=noteKey(context.operation.path),existing=[...newNotes.values()].find(note=>noteKey(note.path)===key);
    if(existing&&!candidates.some(change=>change.path===existing.path))candidates.push({path:existing.path,before:existing.text,after:existing.text});
  }
  for (const change of candidates) {
    if (change.after === null || report) continue;
    const note = newNotes.get(change.path);
    if (!note) { issues.push(issue("V01", "invalid frontmatter", "error", change.path)); continue; }
    const prior=context.operation.op==="move"&&noteKey(context.operation.to)===noteKey(note.path)?oldNotes.get(movedFrom(context.operation.from, context)):oldNotes.get(note.path);
    issues.push(...schemaIssues(note,prior,context), ...topicPlacement(note));
    const source = note.data.source;
    let sourceDenied=strings(source).some(entry=>isDenied(entry.replaceAll("\\","/"),context.config.denyPaths));
    if(source!==undefined&&!sourceDenied)try{
      const references=sourceReferences(source);
      if(sourceRoot&&references.some(ref=>ref.kind==="path"&&isDenied(canonicalPath(resolve(sourceRoot,ref.value)),context.config.denyPaths)))sourceDenied=true;
      if(!sourceDenied)issues.push(...missingSourceWarnings(source,sourceRoot).map(message=>issue("V11",message,"warning",change.path)));
    }catch{ /* Typed source errors are emitted as field-sensitive V01 above. */ }
    if(sourceDenied)issues.push(issue("V06","source is denied by the path policy","error",change.path));
    if (change.before === null && context.operation.op === "create") {
      const stem = noteKey(change.path);
      if (context.notes.has(change.path) || [...newNotes.values()].some(other => other.path !== note.path && (noteKey(other.path) === stem || (note.h1 && other.h1 && fold(note.h1) === fold(other.h1))))) {
        issues.push(issue("V08", "a note with the same stem or normalized H1 already exists", "error", change.path));
      }
    }
  }
  if (!report) {
    for (const note of newNotes.values()) {
      const old = oldNotes.get(note.path);
      const topicsPreviouslyValid = old && topicIssues(old, oldNames, "error").length === 0;
      issues.push(...topicIssues(note, newNames, touched.has(note.path) || topicsPreviouslyValid ? "error" : "warning"));
      if (note.data.status === "superseded" && !target(note.data.superseded_by, newNames)) {
        const wasValid = old?.data.status === "superseded" && target(old.data.superseded_by, oldNames);
        issues.push(issue("V10", "superseded notes require an existing superseded_by wiki target", touched.has(note.path) || wasValid ? "error" : "warning", note.path));
      }
      for (const field of ["supersedes", "superseded_by"] as const) if (note.data[field] !== undefined && (!strings(note.data[field]).length || !strings(note.data[field]).every(value => target(value, newNames)))) {
        issues.push(issue("V10", "supersession references must resolve to existing notes", touched.has(note.path) ? "error" : "warning", note.path));
      }
    }
    issues.push(...changedBrokenLinks(oldNotes, newNotes, context));
  }
  return issues;
}
