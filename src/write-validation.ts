import { basename } from "node:path";
import type { VaultSpec, VmemConfig } from "./config.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { extractLinks, normalizeTarget, proseLines, resolveLinks, type LinkNote, type ResolvedLink } from "./links.ts";
import { isDenied } from "./platform.ts";
import type { PlannedChange, ValidationContext, WriteIssue } from "./write-types.ts";

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
]);
const WIKI_FIELDS = ["topics", "project", "superseded_by", "supersedes", "source_ref"];
// Exact regex set from @staix/agent-mem v0.11.0 src/memory/screen.ts; parity-tested against its root export.
const SECRETS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{40,}/, /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{35}\b/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}/i];
const EMAIL = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/i;
const MAX_BYTES = 256 * 1024;

function issue(code: string, message: string, severity: WriteIssue["severity"] = "error", path?: string): WriteIssue {
  return { code, severity, message, ...(path ? { path } : {}) };
}
function hasPhone(text: string): boolean {
  // A complete ISO calendar timestamp is metadata, not a phone-number candidate.
  const withoutTimestamps = text.replace(/\b[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])[ T](?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\.[0-9]{1,3})?)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])?\b/g, "\n");
  // The newline replacement is outside the candidate class, so neighbours of a timestamp never merge.
  const digits = (value: string) => value.replace(/\D/g, "").length;
  for (const match of withoutTimestamps.matchAll(/(?<![\p{L}\p{N}])\+?\d(?:[\d ().-]{6,}\d)(?![\p{L}\p{N}])/gu)) {
    const count = digits(match[0]);
    if (count >= 9 && count <= 15) return true;
    if (count <= 15) continue;
    // Oversized run, e.g. two phones separated by spaces: evaluate every contiguous run of
    // whitespace-separated groups alone so each embedded phone is screened (fails closed).
    const groups = match[0].split(/\s+/).filter(Boolean);
    for (let start = 0; start < groups.length; start++) {
      let total = 0;
      for (let end = start; end < groups.length && total <= 15; end++) {
        total += digits(groups[end]!);
        if (total >= 9 && total <= 15) return true;
      }
    }
  }
  return false;
}
/** Screen the whole prospective text, including frontmatter, without returning matched values. */
export function screenContent(text: string, vault: VaultSpec, config: VmemConfig): WriteIssue[] {
  const issues: WriteIssue[] = [];
  if (SECRETS.some(pattern => pattern.test(text))) issues.push(issue("V06", "secret-looking content is refused"));
  const pii = vault.pii ?? (vault.kind === "org" ? "deny" : "allow");
  if (pii === "deny") {
    const normalized = text.normalize("NFKC");
    if (EMAIL.test(normalized) || hasPhone(normalized)) issues.push(issue("V07", "PII is refused by the vault policy"));
    for (const pattern of config.piiPatterns ?? []) {
      try {
        if (new RegExp(pattern).test(text)) { issues.push(issue("V07", "configured PII pattern matched")); break; }
      } catch { issues.push(issue("V07", "invalid PII screening configuration")); break; }
    }
  }
  return issues;
}

interface ParsedNote extends LinkNote { data: Record<string, unknown>; h1: string; text: string }
function strings(value: unknown): string[] {
  return typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function fold(value: string): string { return value.normalize("NFKC").toLowerCase().replace(/[-_\s]+/g, " ").trim(); }
function parseNotes(notes: Map<string, string>): Map<string, ParsedNote> {
  const parsed = new Map<string, ParsedNote>();
  for (const [path, text] of notes) {
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
  for (const note of notes.values()) for (const name of [note.path, ...note.aliases]) {
    const key = noteKey(name), candidates = result.get(key) ?? new Set<ParsedNote>();
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
function references(notes: Map<string, ParsedNote>): ResolvedLink[] {
  const metadata = new Map([...notes].map(([path, note]) => [path,
    WIKI_FIELDS.flatMap(key => strings(note.data[key]).flatMap(value => extractLinks(value))),
  ]));
  return resolveLinks([...notes.values()], metadata);
}
function linkSignature(link: ResolvedLink, source: string = link.source): string {
  return JSON.stringify([source, noteKey(link.target), link.heading ? normalizeTarget(link.heading) : null,
    link.block ? normalizeTarget(link.block) : null, link.embed, link.reason]);
}
function changedBrokenLinks(oldNotes: Map<string, ParsedNote>, newNotes: Map<string, ParsedNote>, context: ValidationContext): WriteIssue[] {
  const oldCounts = new Map<string, number>();
  const move = context.operation.op === "move" ? context.operation : undefined;
  const from = move ? `notes/${move.from.replace(/^notes\//, "").replace(/\.md$/, "")}.md` : "";
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
function schema(note: ParsedNote): WriteIssue[] {
  const issues: WriteIssue[] = [], { data, path } = note;
  if ([...Object.keys(data)].some(key => !KEYS.has(key))) issues.push(issue("V01", "unknown frontmatter key", "error", path));
  const description = data.description;
  if (typeof description !== "string" || !description.trim() || [...description].length > 200) issues.push(issue("V01", "description must contain 1..200 Unicode characters", "error", path));
  else if ([note.title, note.h1, basename(path, ".md")].some(value => value && fold(description) === fold(value))) issues.push(issue("V01", "description must supplement the title", "error", path));
  if (typeof data.type !== "string" || !TYPES.has(data.type)) issues.push(issue("V01", "invalid or missing note type", "error", path));
  if (data.type !== "moc" || data.domain !== undefined) {
    if (typeof data.domain !== "string" || !DOMAINS.has(data.domain)) issues.push(issue("V01", "invalid or missing domain", "error", path));
  }
  for (const [key, allowed] of [["confidence", CONFIDENCE], ["status", STATUS], ["category", CATEGORY]] as const) {
    if (data[key] !== undefined && (typeof data[key] !== "string" || !allowed.has(data[key]))) issues.push(issue("V01", `invalid ${key} enum`, "error", path));
  }
  if (data.source !== undefined && (typeof data.source !== "string" || !data.source.trim())) issues.push(issue("V01", "source must be a nonempty string", "error", path));
  return issues;
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
    if (!validPath(change.path, report)) issues.push(issue("V04", "invalid mutation path"));
    if (change.after === null) final.delete(change.path);
    else if (change.path.startsWith("notes/")) final.set(change.path, change.after);
    if (change.after === null) continue;
    if (Buffer.byteLength(change.after) > MAX_BYTES) issues.push(issue("V09", "prospective file exceeds 256 KiB", "error", change.path));
    issues.push(...screenContent(change.after, context.vault, context.config).map(value => ({ ...value, path: change.path })));
  }
  const oldNotes = parseNotes(context.notes), newNotes = parseNotes(final), oldNames = names(oldNotes), newNames = names(newNotes);
  for (const change of changes) {
    if (change.after === null || report) continue;
    const note = newNotes.get(change.path);
    if (!note) { issues.push(issue("V01", "invalid frontmatter", "error", change.path)); continue; }
    issues.push(...schema(note), ...topicPlacement(note));
    const source = note.data.source;
    if (typeof source === "string" && isDenied(source.replaceAll("\\", "/"), context.config.denyPaths)) issues.push(issue("V06", "source is denied by the path policy", "error", change.path));
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
