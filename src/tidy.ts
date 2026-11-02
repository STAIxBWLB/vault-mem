import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { VaultSpec, VmemConfig } from "./config.ts";
import { unenforceablePii } from "./config.ts";
import { emitFrontmatter, parseFrontmatter } from "./frontmatter.ts";
import { extractLinks, normalizeTarget } from "./links.ts";
import { isDenied } from "./platform.ts";
import { loadRegistry, syncDirectory } from "./registry.ts";
import { normalizeSource, sourceReferences, sourceWorkspaceRoot, missingSourceWarnings } from "./source.ts";
import { appendLog, logBinding, LOG_LOCK } from "./vault-log.ts";
import { appendSection, foldConnections, h2Sections } from "./write-operations.ts";
import { SCHEMA_KEYS, SECRET_PATTERNS, TYPED_KEYS, screenContent } from "./write-validation.ts";
import { redactPii } from "./pii.ts";
import { applyWrite, sha256, snapshot } from "./writer.ts";
import type { WriteIssue } from "./write-types.ts";

export const TIDY_RULES = ["connections", "escapes", "enums", "keys", "sources", "topics", "secrets", "log"] as const;
export type TidyRule = typeof TIDY_RULES[number];
export interface TidyMap { enums: Record<string, Record<string, string>>; keys: Record<string, "drop" | "keep" | { rename: string }> }
export interface TidyRequest { vault: string; rules: TidyRule[]; map?: TidyMap; mapText?: string; confirm?: boolean; fingerprint?: string; channel?: "cli" | "mcp" }
export interface TidyNoteChange { path: string; changes: string[]; before: string; after: string; counts: Record<string, number> }
export interface TidyResult {
  ok: boolean;
  applied: boolean;
  preview?: boolean;
  rules: TidyRule[];
  counts: Record<string, number>;
  notes: { path: string; changes: string[] }[];
  /** Values and keys left unchanged because no rule or map entry covers them. */
  reported: { path: string; message: string }[];
  log?: { lines: number; redactions: number; formats: number; changes: string[] };
  fingerprint?: string;
  written: string[];
  issues: WriteIssue[];
  event?: string;
  /** Notes with planned changes that the writer would refuse; left unchanged and listed in `reported`. */
  skipped?: string[];
}

const CONFIDENCE: Record<string, string> = { confirmed: "proven", verified: "proven", observed: "likely", possible: "experimental", speculative: "experimental", web_unverified: "experimental" };
const CONFIDENCE_ORDER = ["experimental", "likely", "proven"];
const VALID_CONFIDENCE = new Set(CONFIDENCE_ORDER);
const VALID_STATUS = new Set(["active", "superseded", "archived"]);
const VALID_TYPE = new Set(["insight", "decision", "observation", "person", "project", "method", "moc", "reference"]);
const DROP = new Set(["origin", "ideation_stage", "keywords", "priority", "deadline", "completedDate", "taskSourceType", "submission_status"]);
const RELATED = ["related", "relatedMeetings", "github"];
const MAX_MAP_BYTES = 64 * 1024;
const issue = (code: string, message: string, path?: string): WriteIssue => ({ code, severity: "error", message, ...(path ? { path } : {}) });
/** Echo a value into a change line or report: secret-looking values (and PII when the vault denies it) print as [redacted]. */
function shown(value: unknown, vault: VaultSpec, config: VmemConfig): string {
  const text = JSON.stringify(value) ?? String(value);
  if (screenContent(text, vault, config).length || screenContent(String(value), vault, config).length) return '"[redacted]"';
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}
const ruleCount = (counts: Record<string, number>, rule: string, n = 1) => { counts[rule] = (counts[rule] ?? 0) + n; };

/** Strictly parse a `--map` file: `{enums: {field: {from: to}}, keys: {key: "drop" | "keep" | {rename: key}}}`. */
export function parseTidyMap(text: string): TidyMap {
  if (Buffer.byteLength(text) > MAX_MAP_BYTES) throw new Error("tidy map: exceeds 64 KiB");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("tidy map: invalid JSON"); }
  const object = (value: unknown, label: string) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`tidy map: ${label} must be an object`);
    return value as Record<string, unknown>;
  };
  const root = object(raw, "map");
  for (const key of Object.keys(root)) if (key !== "enums" && key !== "keys") throw new Error(`tidy map: unknown key ${key}`);
  const map: TidyMap = { enums: {}, keys: {} };
  const name = (value: string, label: string) => { if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error(`tidy map: invalid ${label} ${JSON.stringify(value).slice(0, 80)}`); return value; };
  let entries = 0;
  for (const [field, values] of Object.entries(object(root.enums ?? {}, "enums"))) {
    if (!["confidence", "status", "type"].includes(field)) throw new Error(`tidy map: enum field must be confidence, status or type`);
    map.enums[field] = {};
    for (const [from, to] of Object.entries(object(values, `enums.${field}`))) {
      if (typeof to !== "string" || Buffer.byteLength(from) > 200 || Buffer.byteLength(to) > 200) throw new Error("tidy map: enum values must be strings <=200 bytes");
      if (++entries > 1000) throw new Error("tidy map: more than 1000 entries");
      map.enums[field]![from] = to;
    }
  }
  for (const [key, action] of Object.entries(object(root.keys ?? {}, "keys"))) {
    name(key, "key");
    if (++entries > 1000) throw new Error("tidy map: more than 1000 entries");
    if (action === "drop" || action === "keep") map.keys[key] = action;
    else {
      const target = object(action, `keys.${key}`);
      if (Object.keys(target).length !== 1 || typeof target.rename !== "string") throw new Error(`tidy map: keys.${key} must be "drop", "keep" or {rename}`);
      map.keys[key] = { rename: name(target.rename, "rename target") };
    }
  }
  return map;
}

/**
 * Keys whose raw YAML holds a backslash (escapes or the old writer's trailing-backslash wraps) and whose canonical
 * re-emission differs. Canonical output never re-triggers, so the rule is idempotent.
 */
function escapedKeys(doc: ReturnType<typeof parseFrontmatter>): string[] {
  if (!doc.frontmatter || !doc.frontmatter.includes("\\")) return [];
  const keys: string[] = [];
  let current: string | undefined;
  for (const line of doc.frontmatter.split(/\r?\n/)) {
    const key = /^("?)([A-Za-z_][A-Za-z0-9_-]*)\1:(?:\s|$)/.exec(line);
    if (key) current = key[2];
    if (current && line.includes("\\") && !keys.includes(current) && Object.hasOwn(doc.data, current)) keys.push(current);
  }
  return keys.filter(key => emitFrontmatter(doc, { [key]: doc.data[key] }, new Set([key])) !== doc.source);
}
function lowerConfidence(value: string): string | undefined {
  const parts = value.split("|").map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  const mapped = parts.map(part => VALID_CONFIDENCE.has(part) ? part : CONFIDENCE[part]);
  if (mapped.some(part => part === undefined)) return undefined;
  return mapped.sort((a, b) => CONFIDENCE_ORDER.indexOf(a!) - CONFIDENCE_ORDER.indexOf(b!))[0];
}
function asList(value: unknown): string[] { return typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []; }
function redact(text: string): { text: string; hits: number } {
  let hits = 0, out = text;
  for (const pattern of SECRET_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    out = out.replace(global, () => { hits++; return "[redacted]"; });
  }
  return { text: out, hits };
}
function lineOf(text: string, needle: RegExp): number[] {
  return text.split("\n").flatMap((line, index) => needle.test(line) ? [index + 1] : []);
}

/** Apply every selected rule to one note. Returns the new text and human-readable change lines (values never secrets). */
function sanitizeNote(path: string, source: string, ctx: { rules: Set<TidyRule>; map: TidyMap; vault: VaultSpec; config: VmemConfig; stems: Map<string, string>; sourceRoot: string | undefined }, counts: Record<string, number>, reported: { path: string; message: string }[]): { text: string; changes: string[] } {
  let text = source;
  const changes: string[] = [];
  const has = (rule: TidyRule) => ctx.rules.has(rule);
  const show = (value: unknown) => shown(value, ctx.vault, ctx.config);
  if (has("connections")) {
    const folded = foldConnections(text, path);
    if (folded !== text) { const n = h2Sections(parseFrontmatter(text).body).filter(s => /^Connections(?:\s*\(.*\))?$/i.test(s.name)).length; changes.push(`connections: folded ${n} section${n === 1 ? "" : "s"} into Relevant Notes`); ruleCount(counts, "connections", n); text = folded; }
  }
  let doc = parseFrontmatter(text);
  const set: Record<string, unknown> = {}, force = new Set<string>();
  const data = { ...doc.data };
  const assign = (key: string, value: unknown, line: string, rule: string) => { set[key] = value; if (value === undefined) delete data[key]; else data[key] = value; changes.push(line); ruleCount(counts, rule); };
  if (has("escapes")) for (const key of escapedKeys(doc)) { force.add(key); set[key] = doc.data[key]; changes.push(`escapes: ${key} re-emitted as a canonical scalar`); ruleCount(counts, "escapes"); }
  if (has("enums")) for (const field of ["confidence", "status", "type"] as const) {
    const value = data[field];
    if (value === undefined || value === null) continue;
    const valid = field === "confidence" ? VALID_CONFIDENCE : field === "status" ? VALID_STATUS : VALID_TYPE;
    if (typeof value === "string" && valid.has(value)) continue;
    const mapped = typeof value === "string" ? ctx.map.enums[field]?.[value] ?? (field === "confidence" ? CONFIDENCE[value] ?? lowerConfidence(value) : undefined) : undefined;
    if (mapped !== undefined && valid.has(mapped)) assign(field, mapped, `${field}: ${show(value)} -> ${show(mapped)}`, "enums");
    else reported.push({ path, message: `enums: ${field} ${show(value)} has no mapping; unchanged` });
  }
  if (has("keys")) {
    const relatedLinks: string[] = [], relatedSources: string[] = [];
    for (const key of Object.keys(doc.data)) {
      if (!Object.hasOwn(data, key)) continue;
      const value = data[key], typed = TYPED_KEYS[key];
      const override = ctx.map.keys[key];
      if (override === "keep") continue;
      if (SCHEMA_KEYS.has(key) && (!typed || data.type === typed) && !(typed === "person" && ctx.vault.kind !== "personal")) continue;
      if (override === "drop") { assign(key, undefined, `keys: dropped ${key} = ${show(value)}`, "keys"); continue; }
      if (override && typeof override === "object") {
        if (Object.hasOwn(data, override.rename)) { reported.push({ path, message: `keys: ${key} not renamed, ${override.rename} already set` }); continue; }
        assign(override.rename, value, `keys: ${key} -> ${override.rename}`, "keys"); assign(key, undefined, `keys: removed ${key}`, "keys"); counts.keys = (counts.keys ?? 1) - 1; continue;
      }
      if (key === "date" || key === "record_date") {
        if (data.created === undefined) { assign("created", value, `keys: ${key} -> created`, "keys"); assign(key, undefined, `keys: removed ${key}`, "keys"); counts.keys!--; }
        else if (isDeepStrictEqual(String(data.created), String(value))) assign(key, undefined, `keys: dropped ${key} (equals created)`, "keys");
        else reported.push({ path, message: `keys: ${key} differs from created; kept` });
      } else if (["decided_date", "decision_date", "decided"].includes(key)) {
        if (data.type !== "decision") reported.push({ path, message: `keys: ${key} on a non-decision note; kept` });
        else if (data.decided_at !== undefined) reported.push({ path, message: `keys: ${key} not renamed, decided_at already set` });
        else { assign("decided_at", value, `keys: ${key} -> decided_at`, "keys"); assign(key, undefined, `keys: removed ${key}`, "keys"); counts.keys!--; }
      } else if (RELATED.includes(key)) {
        for (const item of asList(value)) {
          const wiki = /^\s*\[\[([^\]|#]+)/.exec(item), target = (wiki?.[1] ?? item).trim().replace(/^notes\//, "").replace(/\.md$/, "");
          const resolved = ctx.stems.get(normalizeTarget(target));
          if (resolved && resolved !== path) relatedLinks.push(resolved);
          else if (!wiki && (/^[a-z][a-z0-9+.-]*:\/\//i.test(item) || item.includes("/"))) relatedSources.push(item);
          else reported.push({ path, message: `keys: ${key} entry does not resolve; dropped with the key` });
        }
        assign(key, undefined, `keys: ${key} moved (${relatedLinks.length} links, ${relatedSources.length} sources)`, "keys");
      } else if (DROP.has(key)) assign(key, undefined, `keys: dropped ${key} = ${show(value)}`, "keys");
      else reported.push({ path, message: `keys: unknown key ${key} has no mapping; unchanged` });
    }
    if (relatedSources.length) {
      const merged = [...new Set([...asList(data.source), ...relatedSources])];
      try { sourceReferences(merged); assign("source", merged.length === 1 ? merged[0] : merged, `keys: ${relatedSources.length} related path/URL entr${relatedSources.length === 1 ? "y" : "ies"} joined source`, "keys"); counts.keys!--; }
      catch { reported.push({ path, message: "keys: related paths could not join source (invalid reference); dropped with the key" }); }
    }
    if (relatedLinks.length) {
      const body = emitFrontmatter(doc, set, force);
      doc = parseFrontmatter(body);
      for (const key of Object.keys(set)) delete set[key];
      force.clear();
      text = body;
      const existing = new Set(extractLinks(doc.body).map(link => normalizeTarget(link.target.replace(/^notes\//, "").replace(/\.md$/, ""))));
      const lines = [...new Set(relatedLinks)].map(target => target.slice(6, -3)).filter(stem => !existing.has(normalizeTarget(stem))).map(stem => `- [[${stem}]]`);
      if (lines.length) { text = appendSection(text, "Relevant Notes", lines.join("\n"), path); changes.push(`keys: ${lines.length} related link${lines.length === 1 ? "" : "s"} added to Relevant Notes`); }
      doc = parseFrontmatter(text);
    }
  }
  if (has("sources") && data.source !== undefined) {
    try {
      const normalized = normalizeSource(data.source);
      // Only a path reference may hold several joined paths; URLs and mem ids are never split.
      let joined: string[] | undefined;
      if (typeof normalized === "string" && sourceReferences(normalized)[0]!.kind === "path" && /\s[,;]\s|,\s*(?:work\/)?[\w.-]+\//.test(normalized)) {
        const parts = normalized.split(/\s*[,;]\s*/).map(part => part.trim()).filter(Boolean);
        try { if (parts.length > 1 && sourceReferences(parts).every(ref => ref.kind === "path")) joined = parts; } catch { /* not cleanly splittable: keep as one reference */ }
      }
      const next = joined ? normalizeSource(joined) : normalized;
      if (!isDeepStrictEqual(next, data.source)) assign("source", next, `sources: ${show(data.source)} -> ${show(next)}`, "sources");
      for (const warning of missingSourceWarnings(next, ctx.sourceRoot)) reported.push({ path, message: `sources: ${screenContent(warning, ctx.vault, ctx.config).length ? "source path does not exist: [redacted]" : warning}` });
    } catch { reported.push({ path, message: "sources: invalid source reference; unchanged" }); }
  }
  if (Object.keys(set).length) text = emitFrontmatter(doc, set, force);
  doc = parseFrontmatter(text);
  if (has("topics") && Array.isArray(doc.data.topics) && doc.data.topics.length) {
    const sections = h2Sections(doc.body).filter(s => s.name.trim().toLowerCase() === "topics");
    if (!sections.length) {
      const list = doc.data.topics.filter((t): t is string => typeof t === "string").map(t => `- ${t.startsWith("[[") ? t : `[[${t}]]`}`);
      text = `${text.replace(/\s*$/, "")}\n\n## Topics\n\n${list.join("\n")}\n`;
      changes.push("topics: added ## Topics section"); ruleCount(counts, "topics");
    } else {
      const body = doc.body.slice(sections.at(-1)!.start, sections.at(-1)!.end);
      const listed = new Set(extractLinks(body).map(link => normalizeTarget(link.target)));
      const expected = doc.data.topics.filter((t): t is string => typeof t === "string").map(t => normalizeTarget(t.replace(/^\[\[|\]\]$/g, "")));
      if (expected.length !== listed.size || expected.some(t => !listed.has(t))) reported.push({ path, message: "topics: existing ## Topics section differs from frontmatter; unchanged" });
    }
  }
  if (has("secrets")) {
    const lines = SECRET_PATTERNS.flatMap(pattern => lineOf(text, pattern));
    // Frontmatter: replace the whole value of any field whose text matches, keeping `key: "[redacted]"` valid YAML.
    // Body: replace each match in place.
    const parsed = parseFrontmatter(text);
    const fields: Record<string, unknown> = {};
    let hits = 0;
    const scrub = (value: unknown): unknown => {
      if (typeof value === "string") { const r = redact(value); hits += r.hits; return r.hits ? "[redacted]" : value; }
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
      return value;
    };
    for (const [key, value] of Object.entries(parsed.data)) {
      const before = hits, next = scrub(value);
      if (hits > before) fields[key] = next;
    }
    // A secret in raw frontmatter that the parsed values do not show (for example a comment) cannot be fixed safely.
    const rawFrontmatter = redact(parsed.frontmatter ?? "").hits;
    let output = Object.keys(fields).length ? emitFrontmatter(parsed, fields) : text;
    const reparsed = parseFrontmatter(output), body = redact(reparsed.body);
    hits += body.hits;
    output = output.slice(0, output.length - reparsed.body.length) + body.text;
    if (redact(parseFrontmatter(output).frontmatter ?? "").hits || (rawFrontmatter && !Object.keys(fields).length)) reported.push({ path, message: "secrets: a secret-looking value in frontmatter outside a field value (for example a comment); repair by hand" });
    else if (hits) { text = output; changes.push(`secrets: ${hits} value${hits === 1 ? "" : "s"} redacted at line ${[...new Set(lines)].sort((a, b) => a - b).join(", ")}`); ruleCount(counts, "secrets", hits); }
  }
  return { text, changes };
}

function readLogFile(root: string): string | null {
  const file = join(root, "log");
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) throw new Error("tidy: log must be a plain nonlinked file <=32 MiB");
    const buffer = Buffer.alloc(stat.size); let read = 0;
    while (read < stat.size) { const n = readSync(fd, buffer, read, stat.size - read, null); if (!n) break; read += n; }
    return buffer.subarray(0, read).toString("utf8");
  } finally { closeSync(fd); }
}
/** The lint L09 structure check (kept identical to vault-lint.ts). */
const LOG_STRUCTURE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\s+(\S+)\s+(.*)$/;
/** Fix a legacy line that fails L09: drop a seconds field when that makes it valid, otherwise comment it out verbatim. */
function normalizeLogLine(line: string): string | undefined {
  const body = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!body.trim() || body.startsWith("#") || LOG_STRUCTURE.test(body)) return undefined;
  const seconds = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}):\d{2}(\s.*)$/.exec(body);
  if (seconds && LOG_STRUCTURE.test(seconds[1]! + seconds[2]!)) return seconds[1]! + seconds[2]! + line.slice(body.length);
  return `# legacy: ${line}`;
}
/** PII is redacted where the vault policy denies it on the log surface; secrets always are. */
function sanitizeLog(text: string, vault: VaultSpec, config: VmemConfig): { text: string; lines: number; redactions: number; formats: number; changes: string[] } {
  let lines = 0, redactions = 0, formats = 0;
  const changes: string[] = [];
  const out = text.split("\n").map((line, index) => {
    const secret = redact(line);
    let hits = secret.hits, next = secret.text;
    const pii = redactPii(next, vault, config, "log"); hits += pii.hits; next = pii.text;
    const normalized = normalizeLogLine(next);
    if (normalized !== undefined) { next = normalized; formats++; }
    if (hits || normalized !== undefined) {
      lines++; redactions += hits;
      changes.push(`log: line ${index + 1}, ${[hits ? `${hits} redaction${hits === 1 ? "" : "s"}` : "", normalized !== undefined ? "format" : ""].filter(Boolean).join(", ")}`);
    }
    return next;
  }).join("\n");
  return { text: out, lines, redactions, formats, changes };
}
/**
 * Replace the log under its own lock, atomically (the one sanctioned in-place rewrite of the append-only log).
 * `state.committed` turns true once the rename lands, so a caller can tell a later failure (fsync, lock removal) apart.
 */
function rewriteLog(root: string, expected: string, next: string, state: { committed: boolean }): void {
  const lock = join(root, LOG_LOCK);
  const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let temp: string | undefined;
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), created: new Date().toISOString(), purpose: "tidy --log" }) + "\n");
    if (readLogFile(root) !== expected) throw new Error("tidy: log changed since preview");
    temp = join(root, `.vmem-log-${randomUUID()}.tmp`);
    const tfd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(tfd, next); fsyncSync(tfd); } finally { closeSync(tfd); }
    renameSync(temp, join(root, "log")); temp = undefined; state.committed = true;
    syncDirectory(root);
  } finally {
    if (temp) try { unlinkSync(temp); } catch { /* best effort */ }
    closeSync(fd); unlinkSync(lock);
  }
}

/**
 * Two-step migration sanitizer. The preview lists per-rule counts and per-note changes and writes nothing.
 * Confirm requires the fingerprint over the canonical arguments, the map and every touched file; each note
 * is then written through applyWrite (atomic per note, under the vault lock), the log is rewritten only for
 * `--log`, and one LINT event summarises the run. A rerun after an interruption completes the rest.
 */
export function tidyVault(home: string, request: TidyRequest, options: { env?: NodeJS.ProcessEnv; validate?: boolean } = {}): TidyResult {
  const rules = [...new Set(request.rules)].filter((rule): rule is TidyRule => (TIDY_RULES as readonly string[]).includes(rule)).sort((a, b) => TIDY_RULES.indexOf(a) - TIDY_RULES.indexOf(b));
  const result: TidyResult = { ok: false, applied: false, rules, counts: {}, notes: [], reported: [], written: [], issues: [] };
  if (!rules.length) return { ...result, issues: [issue("V01", "select at least one rule or --all")] };
  const config = loadRegistry(home), vault = config.vaults.find(v => v.id === request.vault);
  if (!vault) return { ...result, issues: [issue("V04", "unknown vault id")] };
  if (vault.write === "none" || (request.channel === "mcp" && vault.write !== "mcp")) return { ...result, issues: [issue("POLICY", "vault write policy refuses this channel")] };
  const unenforceable = unenforceablePii(vault);
  if (unenforceable) return { ...result, issues: [issue("PII_POLICY", unenforceable)] };
  const root = realpathSync(vault.path);
  if (root !== vault.path || isDenied(root, config.denyPaths)) return { ...result, issues: [issue("V06", "vault path denied or changed")] };
  // The LINT event must land in the vault this run read and wrote, even if the registry is changed meanwhile.
  const binding = logBinding(vault, config);
  const map = request.map ?? { enums: {}, keys: {} };
  // Only flat notes/*.md are read: .obsidian/, templates/ and self/ are never touched.
  let notes: Map<string, string>;
  try { notes = snapshot(root, config.denyPaths); }
  catch (error) { return { ...result, issues: [issue("V09", error instanceof Error ? error.message.slice(0, 200) : "snapshot failed")] }; }
  const stems = new Map([...notes.keys()].map(path => [normalizeTarget(path.slice(6, -3)), path]));
  for (const [path, source] of notes) try {
    const aliases = parseFrontmatter(source).data.aliases;
    for (const alias of asList(aliases)) if (!stems.has(normalizeTarget(alias))) stems.set(normalizeTarget(alias), path);
  } catch { /* unparsable notes are reported below */ }
  const ctx = { rules: new Set(rules), map, vault, config, stems, sourceRoot: sourceWorkspaceRoot(vault) };
  const planned: TidyNoteChange[] = [];
  for (const [path, source] of notes) {
    try {
      const noteCounts: Record<string, number> = {};
      const { text, changes } = sanitizeNote(path, source, ctx, noteCounts, result.reported);
      if (text !== source) planned.push({ path, changes, before: source, after: text, counts: noteCounts });
    } catch (error) {
      result.reported.push({ path, message: `unparsable note skipped (${error instanceof Error ? error.message.slice(0, 120) : "error"})` });
    }
  }
  result.notes = planned.map(change => ({ path: change.path, changes: change.changes }));
  let logPlan: { before: string; text: string; lines: number; redactions: number; formats: number; changes: string[] } | undefined;
  if (rules.includes("log") && isDenied(join(root, "log"), config.denyPaths)) return { ...result, issues: [issue("V06", "the vault log is denied by the path policy; drop --log")] };
  if (rules.includes("log")) {
    const before = readLogFile(root);
    if (before !== null) {
      const sanitized = sanitizeLog(before, vault, config);
      result.log = { lines: sanitized.lines, redactions: sanitized.redactions, formats: sanitized.formats, changes: sanitized.changes };
      if (sanitized.text !== before) { logPlan = { before, ...sanitized }; result.counts.log = sanitized.redactions + sanitized.formats; }
    }
  }
  // Doctor needs planning counts only: do not resnapshot the vault once per planned note.
  // A confirmation always keeps writer validation, even if this internal option is supplied.
  if (options.validate === false && request.confirm !== true) {
    for (const change of planned) for (const [rule, n] of Object.entries(change.counts)) if (n > 0) ruleCount(result.counts, rule, n);
    return { ...result, ok: true, preview: true };
  }
  // Validate every planned note with the writer (dry-run). A note the writer would refuse is reported and skipped
  // (left fully unchanged for manual repair) instead of blocking the rest of the migration.
  for (const change of [...planned]) {
    const dry = applyWrite(home, { vault: vault.id, operation: { op: "sanitize", path: change.path, text: change.after }, channel: request.channel ?? "cli", dryRun: true, log: false }, { env: options.env, binding });
    const errors = dry.issues.filter(found => found.severity === "error");
    if (errors.some(found => found.code === "VAULT_DRIFT")) return { ...result, issues: errors.filter(found => found.code === "VAULT_DRIFT") };
    if (!errors.length) continue;
    planned.splice(planned.indexOf(change), 1);
    result.reported.push({ path: change.path, message: `skipped: the writer refuses the sanitized note (${[...new Set(errors.map(found => found.code))].join(", ")}); repair by hand` });
  }
  result.skipped = result.notes.filter(note => !planned.some(change => change.path === note.path)).map(note => note.path);
  result.notes = result.notes.filter(note => planned.some(change => change.path === note.path));
  // Counts and the LINT event describe only what will be written: skipped notes are excluded.
  for (const change of planned) for (const [rule, n] of Object.entries(change.counts)) if (n > 0) ruleCount(result.counts, rule, n);
  result.fingerprint = sha256(JSON.stringify({ vault: vault.id, root, rules, map: request.mapText ?? map, files: planned.map(c => [c.path, sha256(c.before), sha256(c.after)]), log: logPlan ? [sha256(logPlan.before), sha256(logPlan.text)] : null }));
  result.event = `tidy: ${rules.filter(rule => rule !== "log" || logPlan).map(rule => `${rule} ${result.counts[rule] ?? 0}`).join(", ")}`;

  if (request.confirm !== true) return { ...result, ok: true, preview: true };
  if (request.fingerprint !== result.fingerprint) return { ...result, issues: [issue("V09", "stale or missing preview fingerprint")] };
  for (const change of planned) {
    const receipt = applyWrite(home, { vault: vault.id, operation: { op: "sanitize", path: change.path, text: change.after }, channel: request.channel ?? "cli", expectedShas: { [change.path]: sha256(change.before) }, log: false }, { env: options.env, binding });
    // Notes written before a failure stay committed, so the result reports them as applied.
    if (!receipt.ok || !receipt.applied) {
      if (receipt.applied) result.written.push(change.path); // committed, then a later step of the write failed
      return { ...result, applied: result.written.length > 0, issues: receipt.issues.length ? receipt.issues : [issue("IO", "note write failed", change.path)] };
    }
    result.written.push(change.path);
  }
  if (logPlan) {
    if (isDenied(join(root, "log"), loadRegistry(home).denyPaths)) return { ...result, applied: result.written.length > 0, issues: [issue("V06", "the vault log is denied by the path policy; log not rewritten")] };
    const state = { committed: false };
    try { rewriteLog(root, logPlan.before, logPlan.text, state); result.written.push("log"); }
    catch (error) {
      if (state.committed) result.written.push("log"); // the new log is in place; a later step failed
      return { ...result, applied: result.written.length > 0, issues: [issue("LOG", error instanceof Error ? error.message.slice(0, 200) : "log rewrite failed")] };
    }
  }
  const counted = Object.values(result.counts).reduce((sum, n) => sum + n, 0);
  if (planned.length || logPlan) {
    const receipt = appendLog(home, { vault: vault.id, event: { type: "LINT", project: "-", source: "vmem:tidy", note: result.event! }, channel: request.channel ?? "cli" }, { env: options.env, binding });
    if (!receipt.ok) return { ...result, applied: true, issues: receipt.issues };
  }
  return { ...result, ok: true, applied: result.written.length > 0 || counted > 0 };
}
