import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { VaultSpec } from "./config.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { sourceReferences, sourceWorkspaceRoot, type SourceReference } from "./source.ts";
import { MAX_NOTE_BYTES, h2Sections } from "./vault-index.ts";

/** Version-1 evidence entry: quoted bytes that occur in one version of one source. Not a claim of truth. */
export interface EvidenceEntry { source: string; sha256: string; quote: string; section?: string }
export const EVIDENCE_SCHEMA_VERSION = 1;
export const MAX_EVIDENCE_ENTRIES = 16, MAX_EVIDENCE_BYTES = 16 * 1024, MAX_QUOTE_BYTES = 2048, MAX_SECTION_BYTES = 1024;
export type EvidenceStatus = "verified" | "stale" | "missing" | "ambiguous" | "unverified_external" | "unsupported";
export type EvidenceReason = "sha_mismatch" | "source_not_found" | "quote_not_found" | "section_not_found" | "section_ambiguous" | "quote_ambiguous"
  | "outside_vault" | "denied" | "oversized" | "invalid_utf8" | "not_a_file" | "unresolved_source_root" | "invalid_metadata" | "external_reference";
export interface EvidenceResult {
  index: number;
  source: string | null;
  kind: SourceReference["kind"] | null;
  section?: string;
  expectedSha256: string | null;
  observedSha256?: string;
  status: EvidenceStatus;
  reason?: EvidenceReason;
  /** Zero-based UTF-8 byte offsets of the single match in the full source file. */
  match?: { start: number; end: number };
  matches?: number;
}
export interface EvidenceReport {
  schemaVersion: 1;
  vault: string;
  note: { path: string; sha256: string };
  evidence: EvidenceResult[];
  truncated: false;
}

const KEYS = new Set(["source", "sha256", "quote", "section"]);
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const bytes = (text: string) => Buffer.byteLength(text);

/** One entry's problem, or the entry. `sources` are the note's normalized source references. */
function entryProblem(value: unknown, sources: Set<string>): string | EvidenceEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "entry must be an object";
  const entry = value as Record<string, unknown>;
  for (const key of Object.keys(entry)) if (!KEYS.has(key)) return `unknown key ${key.slice(0, 32)}`;
  if (typeof entry.source !== "string") return "source must be a string";
  let ref: SourceReference;
  try { [ref] = sourceReferences(entry.source) as [SourceReference]; } catch { return "source must be one valid source reference"; }
  if (!sources.has(ref.value)) return "source must also be listed in the note source field";
  if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) return "sha256 must be 64 lowercase hex characters";
  if (typeof entry.quote !== "string" || !entry.quote || bytes(entry.quote) > MAX_QUOTE_BYTES) return `quote must be 1..${MAX_QUOTE_BYTES} UTF-8 bytes`;
  if (entry.section !== undefined && (typeof entry.section !== "string" || !entry.section.trim() || /[\r\n]/.test(entry.section) || bytes(entry.section) > MAX_SECTION_BYTES)) return `section must be one exact H2 heading <=${MAX_SECTION_BYTES} bytes`;
  return { source: ref.value, sha256: entry.sha256, quote: entry.quote, ...(entry.section !== undefined ? { section: entry.section as string } : {}) };
}
function noteSources(source: unknown): Set<string> {
  try { return new Set(source === undefined ? [] : sourceReferences(source).map(ref => ref.value)); } catch { return new Set(); }
}
/** The first schema problem of an `evidence` field, or undefined when valid. Used by write validation. */
export function evidenceProblem(value: unknown, source: unknown): string | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EVIDENCE_ENTRIES) return `evidence must be a list of 1..${MAX_EVIDENCE_ENTRIES} entries`;
  if (bytes(JSON.stringify(value)) > MAX_EVIDENCE_BYTES) return `evidence must serialize to at most ${MAX_EVIDENCE_BYTES} bytes`;
  const sources = noteSources(source);
  for (const [index, item] of value.entries()) {
    const found = entryProblem(item, sources);
    if (typeof found === "string") return `evidence[${index}]: ${found}`;
  }
  return undefined;
}
/** Parse evidence leniently: valid entries, or the problem per entry. A non-list or oversized field is one problem. */
export function parseEvidence(value: unknown, source: unknown): { entries: (EvidenceEntry | { problem: string })[]; problem?: string } {
  if (value === undefined) return { entries: [] };
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EVIDENCE_ENTRIES || bytes(JSON.stringify(value)) > MAX_EVIDENCE_BYTES)
    return { entries: [], problem: `evidence must be a list of 1..${MAX_EVIDENCE_ENTRIES} entries within ${MAX_EVIDENCE_BYTES} bytes` };
  const sources = noteSources(source);
  return { entries: value.map(item => { const found = entryProblem(item, sources); return typeof found === "string" ? { problem: found } : found; }) };
}

/** Read a plain file without following a final symlink, refusing over the note bound. */
function boundedRead(file: string): Buffer | "not_a_file" | "oversized" {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return "not_a_file";
    if (stat.size > MAX_NOTE_BYTES) return "oversized";
    const buffer = Buffer.alloc(stat.size); let read = 0;
    while (read < stat.size) { const n = readSync(fd, buffer, read, stat.size - read, null); if (!n) break; read += n; }
    if (fstatSync(fd).size !== stat.size) return "oversized";
    return buffer.subarray(0, read);
  } finally { closeSync(fd); }
}
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Resolve a workspace-relative path reference to a flat `notes/*.md` of `vault`, or the reason it is not one. */
function resolveVaultNote(vault: VaultSpec, root: string, value: string, denyPaths: readonly string[]): string | EvidenceReason {
  const lexical = resolve(root, value);
  if (isDenied(canonicalPath(lexical), [...denyPaths]) || isDenied(value, [...denyPaths])) return "denied";
  let real: string, vaultReal: string;
  try { vaultReal = realpathSync(vault.path); } catch { return "source_not_found"; }
  try { real = realpathSync(lexical); } catch { return "source_not_found"; }
  const notes = join(vaultReal, "notes") + sep;
  if (!real.startsWith(notes) || real.slice(notes.length).includes(sep) || !/^[^/\\]+\.md$/.test(real.slice(notes.length))) return "outside_vault";
  if (isDenied(real, [...denyPaths])) return "denied";
  try { if (lstatSync(real).isSymbolicLink()) return "outside_vault"; } catch { return "source_not_found"; }
  return real;
}
/** Literal occurrence count (overlapping) and the first index, capped at two. */
function occurrences(haystack: string, needle: string): { count: number; first: number } {
  const first = haystack.indexOf(needle);
  if (first < 0) return { count: 0, first };
  return { count: haystack.indexOf(needle, first + 1) < 0 ? 1 : 2, first };
}

/** Verify one parsed entry. Every call reads the source afresh; nothing is cached. */
export function verifyEvidenceEntry(vault: VaultSpec, entry: EvidenceEntry, index: number, denyPaths: readonly string[] = []): EvidenceResult {
  const ref = sourceReferences(entry.source)[0]!;
  const base: EvidenceResult = { index, source: ref.value, kind: ref.kind, ...(entry.section !== undefined ? { section: entry.section } : {}), expectedSha256: entry.sha256, status: "unsupported" };
  if (ref.kind !== "path") return { ...base, status: "unverified_external", reason: "external_reference" };
  const root = sourceWorkspaceRoot(vault);
  if (!root) return { ...base, reason: "unresolved_source_root" };
  const located = resolveVaultNote(vault, root, ref.value, denyPaths);
  if (located === "source_not_found") return { ...base, status: "missing", reason: located };
  if (!located.startsWith("/") && !/^[A-Za-z]:/.test(located)) return { ...base, reason: located as EvidenceReason };
  let data: ReturnType<typeof boundedRead>;
  try { data = boundedRead(located); } catch { return { ...base, status: "missing", reason: "source_not_found" }; }
  if (data === "not_a_file" || data === "oversized") return { ...base, reason: data };
  let text: string;
  try { text = utf8.decode(data); } catch { return { ...base, reason: "invalid_utf8" }; }
  const observed = sha256(data), seen = { ...base, observedSha256: observed };
  let start = 0, end = text.length;
  if (entry.section !== undefined) {
    let body: string;
    try { body = parseFrontmatter(text).body; } catch { body = text; }
    const offset = text.length - body.length, found = h2Sections(body).filter(s => s.name === entry.section);
    if (!found.length) return { ...seen, status: "missing", reason: "section_not_found" };
    if (found.length > 1) return { ...seen, status: "ambiguous", reason: "section_ambiguous" };
    start = offset + found[0]!.start; end = offset + found[0]!.end;
  }
  const { count, first } = occurrences(text.slice(start, end), entry.quote);
  if (count === 0) return { ...seen, status: observed === entry.sha256 ? "missing" : "stale", reason: observed === entry.sha256 ? "quote_not_found" : "sha_mismatch", matches: 0 };
  if (count > 1) return { ...seen, status: observed === entry.sha256 ? "ambiguous" : "stale", reason: observed === entry.sha256 ? "quote_ambiguous" : "sha_mismatch", matches: count };
  const byteStart = bytes(text.slice(0, start + first)), match = { start: byteStart, end: byteStart + bytes(entry.quote) };
  if (observed !== entry.sha256) return { ...seen, status: "stale", reason: "sha_mismatch", matches: 1, match };
  return { ...seen, status: "verified", matches: 1, match };
}
/** Verify every evidence entry of a parsed note's frontmatter, in order. Malformed entries are `unsupported`/`invalid_metadata`. */
export function verifyNoteEvidence(vault: VaultSpec, data: Record<string, unknown>, denyPaths: readonly string[] = []): EvidenceResult[] {
  const parsed = parseEvidence(data.evidence, data.source);
  if (parsed.problem) return [{ index: 0, source: null, kind: null, expectedSha256: null, status: "unsupported", reason: "invalid_metadata" }];
  return parsed.entries.map((entry, index) => "problem" in entry
    ? { index, source: null, kind: null, expectedSha256: null, status: "unsupported", reason: "invalid_metadata" }
    : verifyEvidenceEntry(vault, entry, index, denyPaths));
}

/** Locate a flat note of `vault` by stem or `notes/<stem>.md` without the index, refusing links and denied paths. */
function noteFile(vault: VaultSpec, target: string, denyPaths: readonly string[]): string {
  const stem = target.replace(/^notes\//, "").replace(/\.md$/, "");
  if (!stem || Buffer.byteLength(stem) > 200 || /[/\\\0]/.test(stem) || stem.startsWith(".")) throw Object.assign(new Error("note: expected a flat note stem or notes/<stem>.md"), { code: "V04" });
  const root = realpathSync(vault.path);
  if (root !== resolve(vault.path)) throw Object.assign(new Error(`vault ${vault.id}: registered path changed; re-register it`), { code: "V04" });
  const file = join(root, "notes", `${stem}.md`);
  if (isDenied(file, [...denyPaths])) throw Object.assign(new Error("note: denied by the path policy"), { code: "V06" });
  for (const part of [join(root, "notes"), file]) {
    let stat;
    try { stat = lstatSync(part); } catch { throw Object.assign(new Error("note: unknown target"), { code: "V04" }); }
    if (stat.isSymbolicLink()) throw Object.assign(new Error("note: symlinked paths are refused"), { code: "V04" });
  }
  return file;
}

/**
 * Shared read provider for `vmem evidence` and `vmem_evidence`. Pass the vault spec freshly loaded from the registry:
 * the source root is rebound on every call. Writes nothing, takes no lock and keeps no cache.
 */
export function evidenceReport(vault: VaultSpec, target: string, denyPaths: readonly string[] = []): EvidenceReport {
  const file = noteFile(vault, target, denyPaths), data = boundedRead(file);
  if (data === "not_a_file" || data === "oversized") throw Object.assign(new Error(`note: ${data === "oversized" ? "exceeds the read bound" : "not a regular file"}`), { code: "V09" });
  let text: string;
  try { text = utf8.decode(data); } catch { throw Object.assign(new Error("note: not valid UTF-8"), { code: "V01" }); }
  let fm: Record<string, unknown>;
  try { fm = parseFrontmatter(text).data; } catch { throw Object.assign(new Error("note: frontmatter is not parseable"), { code: "V01" }); }
  const path = `notes/${file.slice(file.lastIndexOf(sep) + 1)}`;
  return { schemaVersion: 1, vault: vault.id, note: { path, sha256: sha256(data) }, evidence: verifyNoteEvidence(vault, fm, denyPaths), truncated: false };
}

/**
 * Org promotion screen: keep only entries whose source stays meaningful at `target`. URLs stay unverified external;
 * memory ids and paths that do not resolve to a target-vault note are removed. Removal reasons carry no path or quote.
 */
export function screenEvidenceForTarget(value: unknown, source: unknown, target: VaultSpec, denyPaths: readonly string[] = []): { kept: EvidenceEntry[] | undefined; removed: { index: number; reason: string }[] } {
  if (value === undefined) return { kept: undefined, removed: [] };
  const parsed = parseEvidence(value, source);
  if (parsed.problem) return { kept: undefined, removed: [{ index: 0, reason: "invalid_metadata" }] };
  const root = sourceWorkspaceRoot(target), kept: EvidenceEntry[] = [], removed: { index: number; reason: string }[] = [];
  for (const [index, entry] of parsed.entries.entries()) {
    if ("problem" in entry) { removed.push({ index, reason: "invalid_metadata" }); continue; }
    const ref = sourceReferences(entry.source)[0]!;
    if (ref.kind === "url") { kept.push(entry); continue; }
    if (ref.kind === "memory") { removed.push({ index, reason: "memory_not_retained" }); continue; }
    if (!root) { removed.push({ index, reason: "unresolved_source_root" }); continue; }
    const located = resolveVaultNote(target, root, ref.value, denyPaths);
    if (located.startsWith("/") || /^[A-Za-z]:/.test(located)) kept.push(entry);
    else removed.push({ index, reason: located === "denied" ? "denied" : "not_in_destination" });
  }
  return { kept: kept.length ? kept : undefined, removed };
}
