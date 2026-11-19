/**
 * Append-only assertion journal (issue 250; design `docs/specs/2026-11-19-temporal-assertions-design.md`).
 *
 * Segments `assertions/<16 hex>.jsonl` hold canonical JSON lines chained by `prev`/`hash`. One clone appends one
 * segment, tracked in `<VMEM_HOME>/assertion-writers/<vault-id>.json`. `readJournal` verifies segments,
 * `evaluateAssertions` is the pure evaluation the read surface wraps, and `appendAssertions` is the write contract.
 * Nothing here writes a note, an `updated` stamp or a log line unless the caller supplies a log event.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { unenforceablePii, type VaultSpec, type VmemConfig } from "./config.ts";
import { parseEvidence, verifyEvidenceEntry, type EvidenceEntry, type EvidenceReads } from "./evidence.ts";
import { AGENT_MARKERS } from "./log-format.ts";
import type { LogEvent, LogReceipt } from "./log-types.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { loadRegistry, syncDirectory } from "./registry.ts";
import { sourceReferences, sourceWorkspaceRoot } from "./source.ts";
import { appendLog, checkLogEvent } from "./vault-log.ts";
import { screenContent, screenMetadata } from "./write-validation.ts";
import type { WriteIssue } from "./write-types.ts";
import { canonical, sha256 } from "./writer.ts";

export const ASSERTIONS_DIR = "assertions";
export const ASSERTIONS_LOCK = "assertions.lock";
export const ASSERTION_SCHEMA_VERSION = 1;
export const MAX_BATCH_OPS = 32, MAX_BATCH_BYTES = 64 * 1024, MAX_PAYLOAD_BYTES = 16 * 1024, MAX_VALUE_BYTES = 1024, MAX_LABEL_CHARS = 200;
export const MAX_SEGMENT_BYTES = 8 * 1024 * 1024, MAX_JOURNAL_BYTES = 64 * 1024 * 1024, MAX_JOURNAL_ENTRIES = 100_000;
/** Bound of a complete `vmem_assert` request or reply, measured as the encoded JSON-RPC frame. */
export const ASSERT_FRAME_BYTES = 48 * 1024;
const ENVELOPE_ID_BYTES = 128;
/** Bytes of `value` as a complete JSON-RPC frame (128-byte id, MCP text content, newline), as `src/graph-evidence.ts#encodedBytes`. */
export function assertFrameBytes(value: unknown, kind: "request" | "result" = "request"): number {
  const frame = kind === "request" ? { jsonrpc: "2.0", id: "x".repeat(ENVELOPE_ID_BYTES), method: "tools/call", params: { name: "vmem_assert", arguments: value } }
    : { jsonrpc: "2.0", id: "x".repeat(ENVELOPE_ID_BYTES), result: { content: [{ type: "text", text: JSON.stringify(value) }] } };
  return Buffer.byteLength(JSON.stringify(frame)) + 1;
}
const ZERO = "0".repeat(64);
const SEGMENT = /^[0-9a-f]{16}$/, INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, HEX64 = /^[0-9a-f]{64}$/;
const SUBJECT = /^s:[a-z0-9][a-z0-9-]{0,63}$/, RELATION = /^[a-z0-9][a-z0-9-]{0,63}$/, ASSERTION_ID = /^a:[0-9a-f]{16}:[1-9][0-9]{0,8}$/;
const REASONS = ["recorded_in_error", "evidence_withdrawn", "other"] as const;

// ---------------------------------------------------------------- types

export type EntryOp = "subject" | "assert" | "revise" | "retract";
export interface JournalEntry {
  v: number; seg: string; seq: number; prev: string; hash: string; payload_sha256: string; recorded_at: string;
  channel: "cli" | "mcp"; actor: "person" | "agent"; op: EntryOp; batch: { id: string; size: number; index: number };
  parents?: string[]; payload?: Record<string, unknown>; purged?: { at: string; reason: string };
}
export interface SegmentReport {
  segment: string;
  entries: JournalEntry[];
  /** Last verified (seq, hash), or null for an empty or wholly untrusted segment. */
  tail: { seq: number; hash: string; recordedAt: string } | null;
  /** Byte length of the verified prefix (complete batches only). */
  verifiedBytes: number;
  size: number;
  tornTail: boolean;
  partialBatch: { seq: number } | null;
  untrusted: { seq: number; reason: string } | null;
  unsupported: { seq: number; version: unknown } | null;
}
export interface VerifiedJournal { present: boolean; segments: SegmentReport[]; ignored: string[]; bytes: number; entries: number }

export interface AssertionQuery { at?: string; asOf?: string; subject?: string; relation?: string; history?: boolean }
export type Answer = "yes" | "no" | "unknown";
export interface AssertionItem {
  id: string; rev: number; op: "assert" | "revise" | "retract"; subject: string; relation: string; hash: string;
  value?: string; kind?: "state" | "event"; from?: string; to?: string; held_on?: string; on?: string; reason?: string;
  evidence?: unknown[]; source?: string[];
  answer?: Answer; recordedAt: string; effectiveRecordedAt?: string; clockInverted?: true; replacedAt?: string | null;
  revisionConflict?: true; heads?: string[]; purged?: true;
}
export interface AssertionAnswerSet {
  schemaVersion: 1;
  at: string | null;
  asOf: { requested: string; cutoff: string; cutoffInclusive: boolean } | null;
  pin: { segment: string; seq: number; hash: string }[];
  coverage: {
    journal: "present" | "absent"; beforeFirstEntry: boolean;
    untrusted: { segment: string; seq: number; reason: string }[]; unsupported: { segment: string; seq: number }[];
    tornTail: string[]; partialBatch: { segment: string; seq: number }[]; purged: number;
  };
  items: AssertionItem[];
  overlaps: { subject: string; relation: string; ids: string[]; possible?: true }[];
}

// ---------------------------------------------------------------- hashing and dates

/** The chained hash: SHA-256 of the canonical entry without `hash`, `payload` and `purged`. */
export function entryHash(entry: Omit<JournalEntry, "hash"> & { hash?: string }): string {
  const { hash: _h, payload: _p, purged: _x, ...hashed } = entry;
  return sha256(canonical(hashed));
}
export const payloadHash = (payload: unknown) => sha256(canonical(payload));

/** Days since 1970-01-01 in the proleptic Gregorian calendar (Hinnant's days_from_civil), valid for years 1..9999. */
function days(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y, era = Math.floor(yy / 400), yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1, doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
const monthDays = (y: number, m: number) => m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
/** A date value `YYYY`, `YYYY-MM` or `YYYY-MM-DD` as its first and last candidate day, or undefined when invalid. */
export function dateRange(value: unknown): [number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) return undefined;
  const y = Number(match[1]), m = match[2] === undefined ? undefined : Number(match[2]), d = match[3] === undefined ? undefined : Number(match[3]);
  if (y < 1 || (m !== undefined && (m < 1 || m > 12)) || (m !== undefined && d !== undefined && (d < 1 || d > monthDays(y, m)))) return undefined;
  if (m === undefined) return [days(y, 1, 1), days(y, 12, 31)];
  if (d === undefined) return [days(y, m, 1), days(y, m, monthDays(y, m))];
  return [days(y, m, d), days(y, m, d)];
}
const day = (value: unknown): number | undefined => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? dateRange(value)?.[0] : undefined;
function validInstant(value: unknown): value is string {
  if (typeof value !== "string" || !INSTANT.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) + "Z" === value;
}
const instant = (date: Date) => date.toISOString().slice(0, 19) + "Z";

interface Bounds { sLo: number; sHi: number; eLo: number; eHi: number }
/** State bounds after the `held_on` and start-before-end constraints, or a refusal reason. */
function stateBounds(from: unknown, to: unknown, heldOn: unknown): Bounds | string {
  const start = from === "unknown" ? [-Infinity, Infinity] : dateRange(from);
  if (!start) return "from must be a date value YYYY, YYYY-MM or YYYY-MM-DD, or unknown; write from as one of those";
  const end = to === "open" ? [Infinity, Infinity] : to === "unknown" ? [-Infinity, Infinity] : dateRange(to);
  if (!end) return "to must be a date value, unknown or open; write to as a date, open or unknown";
  let [sLo, sHi] = start as [number, number], [eLo, eHi] = end as [number, number];
  if (heldOn !== undefined) {
    const h = day(heldOn);
    if (h === undefined) return "held_on must be a day YYYY-MM-DD; write the day the value was observed";
    sHi = Math.min(sHi, h); eLo = Math.max(eLo, h + 1);
  }
  sHi = Math.min(sHi, eHi - 1); eLo = Math.max(eLo, sLo + 1);
  if (sLo > sHi || eLo > eHi) return "the bounds leave no start before end; check from, to and held_on";
  if (from === "unknown" && to !== undefined && (to === "unknown" || to === "open") && heldOn === undefined) return "a state with unknown from and unknown or open to is unknown on every day; give held_on or a bound";
  return { sLo, sHi, eLo, eHi };
}
/** The answer of one revision on day `t` (precision section of the design). */
export function answerOn(payload: Record<string, unknown>, t: number): Answer {
  if (payload.kind === "event") {
    const range = dateRange(payload.on);
    if (!range) return "unknown";
    return range[1] <= t ? "yes" : t < range[0] ? "no" : "unknown";
  }
  const bounds = stateBounds(payload.from, payload.to, payload.held_on);
  if (typeof bounds === "string") return "unknown";
  if (bounds.sHi <= t && bounds.eLo > t) return "yes";
  return bounds.sLo <= t && bounds.eHi > t ? "unknown" : "no";
}

// ---------------------------------------------------------------- verification

const ENTRY_KEYS = new Set(["v", "seg", "seq", "prev", "hash", "payload_sha256", "recorded_at", "channel", "actor", "op", "batch", "parents", "payload", "purged"]);
/** A purge marker is exactly `{at, reason}` and never travels with a payload, because neither is inside the hash. */
function purgeShape(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid purged";
  const marker = value as Record<string, unknown>;
  if (Object.keys(marker).some(key => key !== "at" && key !== "reason")) return "invalid purged";
  if (typeof marker.at !== "string" || !validInstant(marker.at)) return "invalid purged";
  if (typeof marker.reason !== "string" || !marker.reason || marker.reason.length > 200 || /\p{Cc}/u.test(marker.reason)) return "invalid purged";
  return undefined;
}
function shapeProblem(entry: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) return `unknown key ${key.slice(0, 32)}`;
  if (!["cli", "mcp"].includes(entry.channel as string) || !["person", "agent"].includes(entry.actor as string)) return "invalid channel or actor";
  if (!["subject", "assert", "revise", "retract"].includes(entry.op as string)) return "invalid op";
  const batch = entry.batch as Record<string, unknown> | undefined;
  if (!batch || typeof batch !== "object" || typeof batch.id !== "string" || !Number.isSafeInteger(batch.size) || !Number.isSafeInteger(batch.index)) return "invalid batch";
  if (!HEX64.test(String(entry.payload_sha256)) || !HEX64.test(String(entry.prev)) || !HEX64.test(String(entry.hash))) return "invalid hash field";
  const revision = entry.op === "revise" || entry.op === "retract";
  if (revision !== Array.isArray(entry.parents) || (revision && (!(entry.parents as unknown[]).length || (entry.parents as unknown[]).some(p => typeof p !== "string" || !HEX64.test(p))))) return "invalid parents";
  if (entry.purged !== undefined) {
    if (entry.payload !== undefined) return "a purged entry still carries a payload";
    return purgeShape(entry.purged);
  }
  if (!entry.payload || typeof entry.payload !== "object" || Array.isArray(entry.payload)) return "missing payload";
  if (revision && typeof (entry.payload as Record<string, unknown>).id !== "string") return "missing payload id";
  return undefined;
}
/** The assertion an entry belongs to: its own `a:seg:seq` for an assert, the named id for a revision. */
const assertionOf = (entry: JournalEntry) => entry.op === "assert" ? `a:${entry.seg}:${entry.seq}` : typeof entry.payload?.id === "string" ? entry.payload.id : undefined;
/** Both caps are checked against the size from `fstat` before any byte is read, so a refusal never reads a budget over. */
function readBounded(file: string, limit: number, remaining = Infinity): Buffer | "too_large" | "over_total" | "not_a_file" {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (caught) {
    // A link is never read or replaced: the segment is reported as ignored, and an append names it.
    if (["ELOOP", "EMLINK"].includes((caught as NodeJS.ErrnoException).code ?? "")) return "not_a_file";
    throw caught;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return "not_a_file";
    if (stat.size > limit) return "too_large";
    if (stat.size > remaining) return "over_total";
    const buffer = Buffer.alloc(stat.size); let read = 0;
    while (read < stat.size) { const n = readSync(fd, buffer, read, stat.size - read, null); if (!n) break; read += n; }
    return buffer.subarray(0, read);
  } finally { closeSync(fd); }
}
/** Verify one segment's bytes (design: Evaluation step 1). Pure over the bytes. */
export function verifySegment(segment: string, bytes: Buffer): SegmentReport {
  const report: SegmentReport = { segment, entries: [], tail: null, verifiedBytes: 0, size: bytes.length, tornTail: false, partialBatch: null, untrusted: null, unsupported: null };
  let offset = 0, prev = ZERO, last = "", pending: { entry: JournalEntry; end: number }[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0) { report.tornTail = true; break; }
    const seq = report.entries.length + pending.length + 1, raw = bytes.subarray(offset, newline);
    const fail = (reason: string) => { report.untrusted = { seq, reason }; };
    let entry: JournalEntry;
    try {
      const text = decoder.decode(raw), parsed = JSON.parse(text) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { fail("not an object"); break; }
      if (parsed.v !== ASSERTION_SCHEMA_VERSION) { report.unsupported = { seq, version: parsed.v }; break; }
      if (canonical(parsed) !== text) { fail("not canonical JSON"); break; }
      const problem = shapeProblem(parsed);
      if (problem) { fail(problem); break; }
      entry = parsed as unknown as JournalEntry;
    } catch { fail("invalid JSON or UTF-8"); break; }
    if (entry.seg !== segment) { fail("segment id differs from the file name"); break; }
    if (entry.seq !== seq) { fail("seq is not contiguous"); break; }
    if (entry.prev !== prev) { fail("prev does not match the previous hash"); break; }
    if (entryHash(entry) !== entry.hash) { fail("hash mismatch"); break; }
    if (entry.purged === undefined && payloadHash(entry.payload) !== entry.payload_sha256) { fail("payload_sha256 mismatch"); break; }
    if (!validInstant(entry.recorded_at) || entry.recorded_at < last) { fail("recorded_at is invalid or earlier than the previous entry"); break; }
    // Batch framing: index 0 opens a batch whose id names its first seq; later entries continue it in order.
    const open = pending[0]?.entry.batch;
    if (entry.batch.index === 0 ? pending.length !== 0 || entry.batch.id !== `${segment}:${seq}` || entry.batch.size < 1 || entry.batch.size > MAX_BATCH_OPS
      : !open || entry.batch.id !== open.id || entry.batch.size !== open.size || entry.batch.index !== pending.length || entry.recorded_at !== pending[0]!.entry.recorded_at) {
      // An interrupted batch followed by a new one: the earlier batch is partial and the chain after it is untrusted.
      fail("batch framing is broken"); break;
    }
    prev = entry.hash; last = entry.recorded_at; offset = newline + 1;
    pending.push({ entry, end: offset });
    if (pending.length === entry.batch.size) {
      report.entries.push(...pending.map(item => item.entry)); report.verifiedBytes = offset; pending = [];
    }
  }
  if (pending.length && !report.untrusted && !report.unsupported) report.partialBatch = { seq: pending[0]!.entry.seq };
  else if (pending.length && report.untrusted) report.untrusted = { seq: pending[0]!.entry.seq, reason: report.untrusted.reason };
  const tail = report.entries.at(-1);
  if (tail) report.tail = { seq: tail.seq, hash: tail.hash, recordedAt: tail.recorded_at };
  return report;
}
/** Read and verify every segment of a vault. Refuses (throws V09) beyond the journal bound instead of reading partial history. */
export function readJournal(vaultPath: string, denyPaths: readonly string[] = []): VerifiedJournal {
  const dir = join(vaultPath, ASSERTIONS_DIR);
  if (isDenied(canonicalPath(dir), [...denyPaths])) throw coded("V06", "the assertions/ path is denied by denyPaths; nothing was read. Remove the deny entry to use assertions in this vault");
  let names: string[];
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw coded("V04", "assertions/ must be a plain directory, not a link or file; restore it from Git or move it aside");
    names = readdirSync(dir).sort();
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return { present: false, segments: [], ignored: [], bytes: 0, entries: 0 };
    throw caught;
  }
  // Every listed file holds at least one entry, so more names than the entry bound is already a journal over its bound.
  if (names.length > MAX_JOURNAL_ENTRIES) throw coded("V09", `${ASSERTIONS_DIR} lists ${names.length} entries, more than the ${MAX_JOURNAL_ENTRIES}-entry journal bound; reads and appends refuse rather than list partial history. Archive old segments with Git outside vmem`);
  const journal: VerifiedJournal = { present: true, segments: [], ignored: [], bytes: 0, entries: 0 };
  for (const name of names) {
    const id = name.endsWith(".jsonl") ? name.slice(0, -6) : "";
    if (!SEGMENT.test(id)) { journal.ignored.push(name); continue; }
    const data = readBounded(join(dir, name), MAX_SEGMENT_BYTES + MAX_BATCH_BYTES * 4, MAX_JOURNAL_BYTES - journal.bytes);
    if (data === "not_a_file") { journal.ignored.push(name); continue; }
    if (data === "too_large") throw coded("V09", `${ASSERTIONS_DIR}/${name} exceeds ${MAX_SEGMENT_BYTES} bytes; reads and appends refuse rather than use partial history. Split the segment with Git outside vmem`);
    if (data === "over_total") throw coded("V09", `the assertion journal exceeds ${MAX_JOURNAL_BYTES} bytes; reads and appends refuse rather than use partial history. Archive old segments with Git outside vmem`);
    const report = verifySegment(id, data);
    journal.bytes += data.length; journal.entries += report.entries.length;
    if (journal.entries > MAX_JOURNAL_ENTRIES) throw coded("V09", `the assertion journal exceeds ${MAX_JOURNAL_ENTRIES} entries; reads and appends refuse rather than use partial history. Archive old segments with Git outside vmem`);
    journal.segments.push(report);
  }
  return journal;
}

// ---------------------------------------------------------------- evaluation

/** `depth` is the longest parent chain below the entry, so a parent always sorts before its child. */
interface Kept { entry: JournalEntry; effective: string; inverted: boolean; depth: number }
interface Resolved { kept: Map<string, Kept>; untrusted: { segment: string; seq: number; reason: string }[] }
/** Steps 2: effective record times across segments; an entry whose parent is missing, untrusted or foreign is untrusted. */
function resolveEntries(journal: VerifiedJournal): Resolved {
  const byHash = new Map<string, JournalEntry>();
  for (const segment of journal.segments) for (const entry of segment.entries) byHash.set(entry.hash, entry);
  const done = new Map<string, Kept | string>(), visiting = new Set<string>();
  const resolve = (entry: JournalEntry): Kept | string => {
    const known = done.get(entry.hash);
    if (known !== undefined) return known;
    if (visiting.has(entry.hash)) return "parent cycle in the journal";
    visiting.add(entry.hash);
    const own = assertionOf(entry);
    let effective = entry.recorded_at, depth = 0, failure = "";
    for (const parent of entry.parents ?? []) {
      const found = byHash.get(parent);
      if (!found) { failure = "parent missing from every verified segment"; break; }
      const kept = resolve(found);
      if (typeof kept === "string") { failure = kept; break; }
      // A revision names its own assertion's heads only; a cross-assertion parent would displace another head set.
      if (own !== undefined && assertionOf(found) !== own) { failure = "a parent belongs to another assertion"; break; }
      if (kept.effective > effective) effective = kept.effective;
      if (kept.depth >= depth) depth = kept.depth + 1;
    }
    visiting.delete(entry.hash);
    const result = failure ? failure : { entry, effective, inverted: effective !== entry.recorded_at, depth };
    done.set(entry.hash, result);
    return result;
  };
  const kept = new Map<string, Kept>(), untrusted: Resolved["untrusted"] = [];
  for (const segment of journal.segments) for (const entry of segment.entries) {
    const result = resolve(entry);
    if (typeof result === "string") untrusted.push({ segment: entry.seg, seq: entry.seq, reason: result });
    else kept.set(entry.hash, result);
  }
  return { kept, untrusted };
}
/** Resolve an `as_of` value to its cutoff (design: `as_of` semantics). */
export function asOfCutoff(value: string): { requested: string; cutoff: string; cutoffInclusive: boolean } {
  if (validInstant(value)) return { requested: value, cutoff: value, cutoffInclusive: true };
  const start = day(value);
  if (start === undefined || dateRange(value)?.[0] !== start) throw coded("V01", "as_of must be a UTC instant YYYY-MM-DDTHH:MM:SSZ or a date YYYY-MM-DD; pass one of those forms");
  // The day after 9999-12-31 has no four-digit instant, so the last representable day keeps its own last second.
  if (start >= days(9999, 12, 31)) return { requested: value, cutoff: "9999-12-31T23:59:59Z", cutoffInclusive: true };
  const next = new Date(Date.UTC(2000, 0, 1) + (start + 1 - days(2000, 1, 1)) * 86400000);
  return { requested: value, cutoff: instant(next), cutoffInclusive: false };
}
interface AssertionState {
  id: string; subject: string; relation: string; entries: Kept[];
  heads: Kept[]; retracted: boolean; purged: boolean;
}
function states(kept: Iterable<Kept>): { assertions: Map<string, AssertionState>; subjects: Map<string, Kept> } {
  const assertions = new Map<string, AssertionState>(), subjects = new Map<string, Kept>(), named = new Set<string>();
  const ordered = [...kept].sort(order);
  for (const item of ordered) {
    const { entry } = item;
    if (entry.op === "subject") {
      const subject = entry.payload?.subject;
      if (typeof subject !== "string" || subjects.has(subject)) continue;
      subjects.set(subject, item);
      for (const parent of entry.parents ?? []) named.add(parent);
      continue;
    }
    const id = entry.op === "assert" ? `a:${entry.seg}:${entry.seq}` : entry.payload?.id;
    if (typeof id !== "string") continue;
    let state = assertions.get(id);
    if (entry.op === "assert") {
      if (state) continue;
      state = { id, subject: String(entry.payload?.subject ?? ""), relation: String(entry.payload?.relation ?? ""), entries: [], heads: [], retracted: false, purged: false };
      assertions.set(id, state);
    }
    if (!state) continue; // a revision whose assertion is outside the cutoff or missing cannot be its own head
    // Only an entry that joins a state displaces its parents from the head set; a dropped one leaves them as heads.
    for (const parent of entry.parents ?? []) named.add(parent);
    state.entries.push(item);
    if (entry.purged) state.purged = true;
  }
  for (const state of assertions.values()) {
    state.heads = state.entries.filter(item => !named.has(item.entry.hash));
    state.retracted = state.heads.length === 1 && state.heads[0]!.entry.op === "retract";
  }
  return { assertions, subjects };
}
/** Causal order: a parent's depth is always below its child's, so an entry is never processed before the one it revises. */
const order = (a: Kept, b: Kept) => a.effective < b.effective ? -1 : a.effective > b.effective ? 1
  : a.depth !== b.depth ? a.depth - b.depth
  : a.entry.seg < b.entry.seg ? -1 : a.entry.seg > b.entry.seg ? 1 : a.entry.seq - b.entry.seq;
function item(state: AssertionState, kept: Kept, t: number | undefined): AssertionItem {
  const { entry } = kept, payload = entry.payload ?? {};
  const out: AssertionItem = { id: state.id, rev: entry.op === "assert" ? 1 : Number(payload.rev), op: entry.op as AssertionItem["op"], subject: state.subject, relation: state.relation, hash: entry.hash, recordedAt: entry.recorded_at };
  if (entry.purged) out.purged = true;
  for (const key of ["value", "kind", "from", "to", "held_on", "on", "reason", "evidence", "source"] as const) if (payload[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = payload[key];
  if (kept.inverted) { out.effectiveRecordedAt = kept.effective; out.clockInverted = true; }
  if (t !== undefined && entry.op !== "retract" && !entry.purged) out.answer = answerOn(payload, t);
  return out;
}
/**
 * Pure evaluation over verified segments (design: Evaluation steps 2 to 5 and overlap grouping). No Git, index,
 * network or file access. Current policy is applied by the read surface (#251), not here.
 */
export function evaluateAssertions(journal: VerifiedJournal, query: AssertionQuery = {}): AssertionAnswerSet {
  const t = query.at === undefined ? undefined : day(query.at);
  if (query.at !== undefined && t === undefined) throw coded("V01", "at must be a civil date YYYY-MM-DD between 0001-01-01 and 9999-12-31; pass a whole day in that range");
  const asOf = query.asOf === undefined ? null : asOfCutoff(query.asOf);
  const resolved = resolveEntries(journal);
  const within = (kept: Kept) => !asOf || (asOf.cutoffInclusive ? kept.effective <= asOf.cutoff : kept.effective < asOf.cutoff);
  const kept = [...resolved.kept.values()].filter(within);
  const { assertions } = states(kept);
  const items: AssertionItem[] = [];
  let purged = 0;
  for (const state of assertions.values()) {
    if (query.subject !== undefined && state.subject !== query.subject) continue;
    if (query.relation !== undefined && state.relation !== query.relation) continue;
    if (state.purged) purged++;
    if (query.history) {
      const replaced = new Map<string, string>();
      for (const k of state.entries) for (const parent of k.entry.parents ?? []) if (!replaced.has(parent)) replaced.set(parent, k.effective);
      for (const k of state.entries) items.push({ ...item(state, k, t), replacedAt: replaced.get(k.entry.hash) ?? null });
      continue;
    }
    if (state.retracted || state.purged) continue;
    const conflict = state.heads.length > 1, heads = state.heads.map(head => head.entry.hash).sort();
    for (const head of state.heads) {
      if (head.entry.op === "retract" && conflict) continue; // reported through the conflict set, not answered
      items.push({ ...item(state, head, t), ...(conflict ? { revisionConflict: true as const, heads } : {}) });
    }
  }
  items.sort((a, b) => a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : a.relation < b.relation ? -1 : a.relation > b.relation ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : a.rev - b.rev || (a.hash < b.hash ? -1 : 1));
  const overlaps: AssertionAnswerSet["overlaps"] = [];
  if (t !== undefined && !query.history) {
    const groups = new Map<string, AssertionItem[]>();
    for (const found of items) if (found.answer === "yes" || found.answer === "unknown") {
      const key = `${found.subject}\u0000${found.relation}`;
      groups.set(key, [...(groups.get(key) ?? []), found]);
    }
    for (const group of groups.values()) {
      if (new Set(group.map(found => found.value)).size < 2) continue;
      const ids = [...new Set(group.map(found => found.id))];
      if (ids.length < 2) continue;
      overlaps.push({ subject: group[0]!.subject, relation: group[0]!.relation, ids, ...(group.some(found => found.answer === "unknown") ? { possible: true as const } : {}) });
    }
  }
  const all = [...resolved.kept.values()];
  return {
    schemaVersion: 1, at: query.at ?? null, asOf,
    pin: journal.segments.filter(s => s.tail).map(s => ({ segment: s.segment, seq: s.tail!.seq, hash: s.tail!.hash })),
    coverage: {
      journal: journal.present ? "present" : "absent",
      beforeFirstEntry: !!asOf && all.length > 0 && kept.length === 0,
      untrusted: [...journal.segments.filter(s => s.untrusted).map(s => ({ segment: s.segment, seq: s.untrusted!.seq, reason: s.untrusted!.reason })), ...resolved.untrusted],
      unsupported: journal.segments.filter(s => s.unsupported).map(s => ({ segment: s.segment, seq: s.unsupported!.seq })),
      tornTail: journal.segments.filter(s => s.tornTail).map(s => s.segment),
      partialBatch: journal.segments.filter(s => s.partialBatch).map(s => ({ segment: s.segment, seq: s.partialBatch!.seq })),
      purged,
    },
    items, overlaps,
  };
}

// ---------------------------------------------------------------- write contract

export type AssertOp =
  | { op: "declare"; subject: string; label?: string; note?: string }
  | { op: "assert"; subject: string; relation: string; value: string; kind: "state" | "event"; from?: string; to?: string; held_on?: string; on?: string; evidence?: EvidenceEntry[]; source?: string[] }
  | { op: "revise"; id: string; expected_heads: string[]; value: string; kind: "state" | "event"; from?: string; to?: string; held_on?: string; on?: string; evidence?: EvidenceEntry[]; source?: string[] }
  | { op: "retract"; id: string; expected_heads: string[]; reason: typeof REASONS[number] };
export interface AssertRequest { vault: string; ops: unknown; channel?: "cli" | "mcp"; dryRun?: boolean; log?: LogEvent }
export interface AssertReceipt {
  ok: boolean; applied: boolean; dryRun: boolean;
  segment: string | null; recordedAt?: string;
  entries: { seq?: number; id: string; rev?: number; op: EntryOp; hash?: string }[];
  /** Recovery and segment notes, for example a truncated torn tail or a new segment and why. */
  recovery: string[];
  issues: WriteIssue[];
  indexUpdated: false;
  log?: LogReceipt;
}
class Refused extends Error { constructor(readonly issues: WriteIssue[]) { super(issues[0]?.message ?? "refused"); } }
/** A refusal from a read-side helper; the MCP guard and receipts surface its code and message. */
export class Coded extends Error { constructor(readonly code: string, message: string) { super(message); } }
function coded(code: string, message: string): Error { return new Coded(code, message); }
const err = (code: string, message: string, path?: string): WriteIssue => ({ code, severity: "error", message, ...(path === undefined ? {} : { path }) });
function refuse(code: string, message: string, path?: string): never { throw new Refused([err(code, message, path)]); }

const OP_KEYS: Record<string, string[]> = {
  declare: ["op", "subject", "label", "note"],
  assert: ["op", "subject", "relation", "value", "kind", "from", "to", "held_on", "on", "evidence", "source"],
  revise: ["op", "id", "expected_heads", "value", "kind", "from", "to", "held_on", "on", "evidence", "source"],
  retract: ["op", "id", "expected_heads", "reason"],
};
const bytes = (text: string) => Buffer.byteLength(text);
/** Shape, bound and temporal checks of one op, returning the world-time payload fields. */
function temporal(op: Record<string, unknown>, at: string): Record<string, unknown> {
  if (op.kind === "event") {
    for (const key of ["from", "to", "held_on"]) if (op[key] !== undefined) refuse("V01", `${at}: an event takes on, not ${key}; move the date to on or use kind state`);
    if (op.on === "unknown" || op.on === "open") refuse("V01", `${at}: on cannot be unknown or open; give the event's date at year, month or day precision`);
    if (!dateRange(op.on)) refuse("V01", `${at}: on must be a date value YYYY, YYYY-MM or YYYY-MM-DD with year 0001..9999; write on as one of those`);
    return { kind: "event", on: op.on };
  }
  if (op.kind !== "state") refuse("V01", `${at}: kind must be state or event; write kind: state with from and to, or kind: event with on`);
  if (op.on !== undefined) refuse("V01", `${at}: a state takes from and to, not on; use kind event for a dated occurrence`);
  if (op.from === undefined || op.to === undefined) refuse("V01", `${at}: a state needs both from and to; write to: open for no asserted end or to: unknown for an unknown end`);
  const bounds = stateBounds(op.from, op.to, op.held_on);
  if (typeof bounds === "string") refuse("V01", `${at}: ${bounds}`);
  return { kind: "state", from: op.from, to: op.to, ...(op.held_on !== undefined ? { held_on: op.held_on } : {}) };
}
function value(op: Record<string, unknown>, at: string): string {
  if (typeof op.value !== "string" || !op.value || bytes(op.value) > MAX_VALUE_BYTES || /\p{Cc}/u.test(op.value) || !op.value.isWellFormed()) refuse("V01", `${at}: value must be 1..${MAX_VALUE_BYTES} UTF-8 bytes of well-formed text without control characters; shorten it and remove control characters`);
  return op.value;
}
interface Support { evidence: (EvidenceEntry & { status: "verified" | "unverified_external" })[]; source?: string[] }
/** Evidence per entry with `verifyEvidenceEntry`, source references, and owner decision O2 (at least one of either). */
function support(op: Record<string, unknown>, at: string, vault: VaultSpec, config: VmemConfig, reads: EvidenceReads): Support {
  const out: Support = { evidence: [] };
  if (op.source !== undefined) {
    if (!Array.isArray(op.source)) refuse("V01", `${at}: source must be a list of 1..32 source references; send an array of workspace paths, URLs or mem: ids`);
    let refs: ReturnType<typeof sourceReferences>;
    try { refs = sourceReferences(op.source); } catch (caught) { refuse("V01", `${at}: ${(caught as Error).message}`); }
    // A path reference is denied by its own value or by the workspace path it resolves to, as `src/analysis-input.ts` reads it.
    const root = sourceWorkspaceRoot(vault), denyPaths = config.denyPaths ?? [];
    const denied = (ref: (typeof refs)[number]) => ref.kind === "path" && (isDenied(ref.value, denyPaths) || (root !== undefined && isDenied(canonicalPath(resolve(root, ref.value)), denyPaths)));
    for (const ref of refs) if (denied(ref)) refuse("V06", `${at}: source ${ref.value} is denied by current policy; cite another source`);
    out.source = refs.map(ref => ref.value);
  }
  if (op.evidence !== undefined) {
    const list = op.evidence;
    if (Array.isArray(list) && list.some(entry => !entry || typeof entry !== "object" || typeof (entry as Record<string, unknown>).source !== "string"))
      refuse("V01", `${at}: each evidence entry needs source, sha256 and quote (issue 233 version 1 shape); copy the entry shape from vmem evidence output`);
    const sources = Array.isArray(list) ? list.map(entry => (entry as { source: string }).source) : [];
    const parsed = parseEvidence(list, sources.length ? sources : undefined);
    if (parsed.problem) refuse("V01", `${at}: ${parsed.problem}`);
    for (const [index, entry] of parsed.entries.entries()) {
      if ("problem" in entry) refuse("V01", `${at}.evidence[${index}]: ${entry.problem}`);
      const result = verifyEvidenceEntry(vault, entry, index, config.denyPaths ?? [], reads);
      if (result.reason === "denied") refuse("V06", `${at}.evidence[${index}]: source is denied by current policy; cite another source`);
      if (result.status === "unverified_external") { out.evidence.push({ ...entry, status: "unverified_external" }); continue; }
      if (result.status !== "verified") {
        const next = result.reason === "unresolved_source_root" ? "register the vault with --registry so its workspace root resolves, or cite the source as an external reference (URL or mem: id)"
          : result.reason === "outside_vault" ? "cite a flat notes/*.md of this vault by its workspace-relative path, for example vault/notes/x.md"
          : "re-read the source and copy the quote and its current sha256 exactly";
        refuse("EVIDENCE", `${at}.evidence[${index}]: ${result.status}${result.reason ? ` (${result.reason})` : ""}; ${next}`);
      }
      out.evidence.push({ ...entry, status: "verified" });
    }
  }
  if (!out.evidence.length && !out.source?.length) refuse("V01", `${at}: an assertion needs at least one evidence entry or source reference (owner decision O2); add evidence or source`);
  return out;
}

interface Planned { op: EntryOp; payload: Record<string, unknown>; parents?: string[]; id: string; target?: string }
interface Context { vault: VaultSpec; config: VmemConfig; root: string; channel: "cli" | "mcp" }
function context(home: string, request: AssertRequest): Context {
  const config = loadRegistry(home), vault = config.vaults.find(item => item.id === request.vault);
  if (!vault) refuse("V04", "unknown vault id; list registered vaults with vmem status");
  const channel = request.channel ?? "cli";
  if (channel !== "cli" && channel !== "mcp") refuse("POLICY", "unknown write channel; use cli or mcp");
  if (vault.write === "none" || (channel === "mcp" && vault.write !== "mcp")) refuse("POLICY", `vault write policy (${vault.write}) refuses assertion appends over ${channel}; change the policy with vmem vaults add or use an allowed channel`);
  const unenforceable = unenforceablePii(vault);
  if (unenforceable) refuse("PII_POLICY", unenforceable);
  let root: string;
  try { root = realpathSync(vault.path); } catch { refuse("V04", "registered vault path is missing; restore it or re-register the vault"); }
  if (root !== vault.path || !lstatSync(root).isDirectory()) refuse("V04", "registered vault path changed or is not a plain directory; re-register the vault");
  if (isDenied(canonicalPath(join(root, ASSERTIONS_DIR)), config.denyPaths ?? [])) refuse("V06", "the assertions/ path is denied by denyPaths; remove the deny entry to record assertions in this vault");
  return { vault, config, root, channel };
}
/** Validate a batch against the journal as read (shapes, bounds, temporal rules, evidence, screening, heads). */
function plan(ctx: Context, ops: unknown, journal: VerifiedJournal): Planned[] {
  if (!ops || !Array.isArray(ops) || ops.length < 1 || ops.length > MAX_BATCH_OPS) refuse("V01", `ops must be a list of 1..${MAX_BATCH_OPS} operations; split larger batches`);
  if (bytes(canonical(ops)) > MAX_BATCH_BYTES) refuse("V09", `the canonical batch exceeds ${MAX_BATCH_BYTES} bytes; split it into smaller batches`);
  const resolved = resolveEntries(journal), { assertions, subjects } = states(resolved.kept.values());
  const declared = new Set(subjects.keys()), touched = new Set<string>(), reads: EvidenceReads = new Map(), planned: Planned[] = [];
  for (const [index, raw] of ops.entries()) {
    const at = `ops[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse("V01", `${at}: expected an object with op; send {op: declare|assert|revise|retract, ...}`);
    const op = raw as Record<string, unknown>, keys = OP_KEYS[op.op as string];
    if (!keys) refuse("V01", `${at}: op must be declare, assert, revise or retract; correct the op name`);
    for (const key of Object.keys(op)) if (!keys.includes(key)) refuse("V01", `${at}: unknown field ${key.slice(0, 32)} for ${String(op.op)}; vmem assigns ids, times and hashes itself`);
    let entry: Planned;
    if (op.op === "declare") {
      if (typeof op.subject !== "string" || !SUBJECT.test(op.subject)) refuse("V01", `${at}: subject must match s:[a-z0-9][a-z0-9-]{0,63}; write s: then lowercase letters, digits and hyphens`);
      if (declared.has(op.subject)) refuse("V01", `${at}: subject ${op.subject} is already declared; drop the declare op`);
      if (op.label !== undefined && (typeof op.label !== "string" || !op.label.trim() || [...op.label].length > MAX_LABEL_CHARS || /\p{Cc}/u.test(op.label) || !op.label.isWellFormed())) refuse("V01", `${at}: label must be 1..${MAX_LABEL_CHARS} characters without control characters; shorten it and remove control characters`);
      if (op.note !== undefined && (typeof op.note !== "string" || !/^notes\/[^/\\]+\.md$/.test(op.note) || /\p{Cc}/u.test(op.note))) refuse("V01", `${at}: note must be a flat notes/<stem>.md path of this vault; cite this vault's note by its notes/<stem>.md path`);
      declared.add(op.subject);
      entry = { op: "subject", id: op.subject, payload: { subject: op.subject, ...(op.label !== undefined ? { label: op.label } : {}), ...(op.note !== undefined ? { note: op.note } : {}) } };
    } else if (op.op === "assert") {
      if (typeof op.subject !== "string" || !declared.has(op.subject)) refuse("V01", `${at}: subject ${String(op.subject).slice(0, 80)} is not declared; add a declare op earlier in this batch`);
      if (typeof op.relation !== "string" || !RELATION.test(op.relation)) refuse("V01", `${at}: relation must match [a-z0-9][a-z0-9-]{0,63}; write lowercase letters, digits and hyphens`);
      const world = temporal(op, at), held = value(op, at), backing = support(op, at, ctx.vault, ctx.config, reads);
      entry = { op: "assert", id: "", payload: { rev: 1, subject: op.subject, relation: op.relation, value: held, ...world, evidence: backing.evidence, ...(backing.source ? { source: backing.source } : {}) } };
    } else {
      if (typeof op.id !== "string" || !ASSERTION_ID.test(op.id)) refuse("V01", `${at}: id must be an assertion id a:<segment>:<seq> as returned by a receipt`);
      const state = assertions.get(op.id);
      if (!state) refuse("V01", `${at}: assertion ${op.id} is not in the verified journal; check the id, or sync the segment that holds it`);
      if (touched.has(op.id)) refuse("V01", `${at}: ${op.id} appears twice in this batch; send the second change in a later batch with the new head`);
      if (state.purged) refuse("V01", `${at}: ${op.id} is purged; assert a new id instead`);
      if (state.retracted) refuse("V01", `${at}: ${op.id} is retracted; assert a new id instead`);
      const heads = state.heads.map(head => head.entry.hash).sort(), expected = op.expected_heads;
      if (!Array.isArray(expected) || !expected.length || expected.length > 32 || expected.some(h => typeof h !== "string" || !HEX64.test(h))) refuse("V01", `${at}: expected_heads must list the hashes of the assertion's current heads; re-read the assertion and send every head hash`);
      const given = [...new Set(expected as string[])].sort();
      if (given.length !== heads.length || given.some((h, i) => h !== heads[i])) refuse("STALE_HEADS", `${at}: expected_heads does not equal the current head set of ${op.id} (${heads.join(", ")}); re-read the assertion and resend with every head`);
      touched.add(op.id);
      const rev = Math.max(...state.heads.map(head => head.entry.op === "assert" ? 1 : Number(head.entry.payload?.rev ?? 1))) + 1;
      if (op.op === "retract") {
        if (!REASONS.includes(op.reason as typeof REASONS[number])) refuse("V01", `${at}: reason must be ${REASONS.join(", ")}; pick one of those reasons`);
        entry = { op: "retract", id: op.id, target: op.id, parents: heads, payload: { id: op.id, rev, reason: op.reason } };
      } else {
        const world = temporal(op, at), held = value(op, at), backing = support(op, at, ctx.vault, ctx.config, reads);
        entry = { op: "revise", id: op.id, target: op.id, parents: heads, payload: { id: op.id, rev, value: held, ...world, evidence: backing.evidence, ...(backing.source ? { source: backing.source } : {}) } };
      }
    }
    const text = canonical(entry.payload);
    if (bytes(text) > MAX_PAYLOAD_BYTES) refuse("V09", `${at}: payload exceeds ${MAX_PAYLOAD_BYTES} bytes as canonical JSON; shorten quotes or split evidence`);
    const screened = [...screenContent(text, ctx.vault, ctx.config, "notes"), ...screenMetadata(entry.payload, { vault: ctx.vault, config: ctx.config, piiSurface: "notes" }, at)]
      .filter(found => found.severity === "error");
    if (screened.length) throw new Refused(screened.map(found => ({ ...found, path: at, message: `${at}: ${found.message}; remove the secret or personal data, or cite it by reference` })));
    planned.push(entry);
  }
  return planned;
}
/** CLOCK (design: Write contract): no time before the segment tail or before any parent's effective record time. */
function clockCheck(planned: Planned[], journal: VerifiedJournal, tailTime: string | undefined, recordedAt: string): void {
  if (tailTime && recordedAt < tailTime) refuse("CLOCK", `the writer clock (${recordedAt}) is before the segment's last entry (${tailTime}); wait until after ${tailTime} or correct the system clock`);
  const resolved = resolveEntries(journal);
  for (const entry of planned) for (const parent of entry.parents ?? []) {
    const kept = resolved.kept.get(parent);
    if (kept && recordedAt < kept.effective) refuse("CLOCK", `the writer clock (${recordedAt}) is before parent ${parent.slice(0, 12)} of ${entry.id} (recorded ${kept.effective}); wait until after ${kept.effective} or correct the system clock`);
  }
}
interface WriterRecord { segment: string; seq: number; hash: string }
const writerFile = (home: string, vault: string) => join(home, "assertion-writers", `${vault}.json`);
function loadWriter(home: string, vault: string): WriterRecord | undefined {
  try {
    const data = readBounded(writerFile(home, vault), 4096);
    if (typeof data === "string") return undefined;
    const parsed = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    return typeof parsed.segment === "string" && SEGMENT.test(parsed.segment) && Number.isSafeInteger(parsed.seq) && typeof parsed.hash === "string" && HEX64.test(parsed.hash)
      ? { segment: parsed.segment, seq: parsed.seq as number, hash: parsed.hash } : undefined;
  } catch { return undefined; }
}
function saveWriter(home: string, vault: string, record: WriterRecord): void {
  const dir = join(home, "assertion-writers");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.${vault}-${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, writerFile(home, vault));
  syncDirectory(dir);
}
/** Choose the segment for the next batch: the clone's own healthy segment, or a new one and why. */
function chooseSegment(home: string, vaultId: string, journal: VerifiedJournal, batchBytes: number): { segment: string; report?: SegmentReport; fresh: boolean; note?: string } {
  const record = loadWriter(home, vaultId), fresh = (note?: string) => ({ segment: randomBytes(8).toString("hex"), fresh: true, ...(note ? { note } : {}) });
  if (!record) return fresh();
  const report = journal.segments.find(s => s.segment === record.segment);
  if (!report) return fresh(`segment ${record.segment} named by the writer record is missing; started a new segment`);
  if (report.untrusted || report.unsupported) return fresh(`segment ${record.segment} fails verification from seq ${(report.untrusted ?? report.unsupported)!.seq}; started a new segment (restore the file from Git to read its later entries)`);
  const at = report.entries[record.seq - 1];
  if (!at || at.hash !== record.hash) return fresh(`segment ${record.segment} is shorter than or differs from the writer record (seq ${record.seq}); truncation detected, started a new segment`);
  if (report.verifiedBytes + batchBytes > MAX_SEGMENT_BYTES) return fresh(`segment ${record.segment} reached ${MAX_SEGMENT_BYTES} bytes; started a new segment`);
  return { segment: record.segment, report, fresh: false };
}
function actorOf(channel: "cli" | "mcp", env: NodeJS.ProcessEnv): "person" | "agent" {
  return channel === "mcp" || AGENT_MARKERS.some(marker => typeof env[marker] === "string" && env[marker]!.length > 0) ? "agent" : "person";
}
/** Take `assertions.lock`. Only EEXIST means another writer; any other open failure names its own cause. */
function acquire(root: string): { fd: number; file: string; ino: number; dev: number } {
  const file = join(root, ASSERTIONS_LOCK), deadline = Date.now() + 2000, sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let fd: number;
    try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (caught) {
      const code = (caught as NodeJS.ErrnoException).code ?? "unknown error";
      if (code !== "EEXIST") refuse("LOCK", `${ASSERTIONS_LOCK} cannot be created in the vault root (${code}); fix the vault directory's permission, ownership or read-only mount, then retry`);
      if (Date.now() < deadline) { Atomics.wait(sleeper, 0, 0, 5); continue; }
      refuse("LOCKED", `${ASSERTIONS_LOCK} is held by another writer; retry shortly, or remove the lock file only after confirming no vmem process is appending`);
    }
    let stat;
    try { stat = fstatSync(fd); writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), created: new Date().toISOString() }) + "\n"); }
    catch (caught) {
      // A half-created lock is removed by identity so later appends do not read it as another writer.
      const code = (caught as NodeJS.ErrnoException).code ?? "unknown error";
      try { closeSync(fd); } catch { /* the refusal below is the signal */ }
      try { const owned = lstatSync(file); if (Number(owned.ino) === Number(stat?.ino ?? -1) && Number(owned.dev) === Number(stat?.dev ?? -1)) unlinkSync(file); }
      catch { /* the refusal below is the signal */ }
      refuse("LOCK", `the ${ASSERTIONS_LOCK} record could not be written (${code}); check free space and permissions in the vault root, then retry`);
    }
    return { fd, file, ino: Number(stat.ino), dev: Number(stat.dev) };
  }
}
function release(lock: { fd: number; file: string; ino: number; dev: number }, issues: WriteIssue[]): void {
  try { closeSync(lock.fd); } catch { issues.push({ code: "CLEANUP", severity: "warning", message: "assertions lock descriptor close failed" }); }
  try {
    const stat = lstatSync(lock.file);
    if (stat.isSymbolicLink() || Number(stat.ino) !== lock.ino || Number(stat.dev) !== lock.dev) issues.push({ code: "CLEANUP", severity: "warning", message: "assertions lock ownership changed; retained it, inspect before removing" });
    else unlinkSync(lock.file);
  } catch { issues.push({ code: "CLEANUP", severity: "warning", message: "assertions lock retained; inspect before removing it manually" }); }
}

/**
 * Validate and append one batch (design: Write contract). All-or-nothing: any error refuses the whole batch before
 * any byte is written. A dry run validates against the journal as read, without lock, append or `recordedAt`.
 */
export function appendAssertions(home: string, request: AssertRequest, options: { env?: NodeJS.ProcessEnv; now?: Date } = {}): AssertReceipt {
  const env = options.env ?? process.env;
  const receipt: AssertReceipt = { ok: false, applied: false, dryRun: request?.dryRun === true, segment: null, entries: [], recovery: [], issues: [], indexUpdated: false };
  let lock: ReturnType<typeof acquire> | undefined;
  try {
    if (!request || typeof request !== "object" || Object.keys(request).some(key => !["vault", "ops", "channel", "dryRun", "log"].includes(key))) refuse("V01", "unknown request option; send {vault, ops[, dryRun, log]}");
    if (request.dryRun !== undefined && typeof request.dryRun !== "boolean") refuse("V01", "dryRun must be a boolean");
    const ctx = context(home, request);
    if (request.log !== undefined) {
      const logIssues = checkLogEvent(home, { vault: request.vault, event: request.log, channel: ctx.channel }, env);
      if (logIssues.length) throw new Refused(logIssues.map(found => ({ ...found, message: `log event refused, nothing written: ${found.message}; fix the event fields (rules as for log append) or omit it` })));
    }
    if (receipt.dryRun) {
      const journal = readJournal(ctx.root, ctx.config.denyPaths ?? []);
      const planned = plan(ctx, request.ops, journal);
      receipt.entries = planned.map(entry => ({ id: entry.id || "(assigned at append)", op: entry.op, ...(entry.op !== "subject" ? { rev: Number(entry.payload.rev) } : {}) }));
      receipt.ok = true;
      return receipt;
    }
    lock = acquire(ctx.root);
    const journal = readJournal(ctx.root, ctx.config.denyPaths ?? []);
    const planned = plan(ctx, request.ops, journal);
    if (journal.entries + planned.length > MAX_JOURNAL_ENTRIES) refuse("V09", `the journal would exceed ${MAX_JOURNAL_ENTRIES} entries; appends refuse rather than rotate history`);
    // An over-estimate only, so a segment chosen on it has room for the real lines; `parents` cost their own bytes.
    const estimate = planned.reduce((sum, entry) => sum + bytes(canonical(entry.payload)) + 1024 + (entry.parents ?? []).reduce((cost, parent) => cost + parent.length + 4, 0), 0);
    if (journal.bytes + estimate > MAX_JOURNAL_BYTES) refuse("V09", `the journal would exceed ${MAX_JOURNAL_BYTES} bytes; appends refuse rather than rotate history`);
    const chosen = chooseSegment(home, ctx.vault.id, journal, estimate);
    if (chosen.note) receipt.recovery.push(chosen.note);
    const recordedAt = instant(options.now ?? new Date());
    clockCheck(planned, journal, chosen.report?.tail?.recordedAt, recordedAt);
    // Lines: assert ids name the seq of their own entry in the chosen segment.
    const actor = actorOf(ctx.channel, env), base = chosen.report?.entries.length ?? 0, batchId = `${chosen.segment}:${base + 1}`;
    let prev = chosen.report?.tail?.hash ?? ZERO;
    const lines: string[] = [];
    for (const [index, entry] of planned.entries()) {
      const seq = base + index + 1;
      if (entry.op === "assert") entry.id = `a:${chosen.segment}:${seq}`;
      const payload = entry.op === "assert" ? { id: entry.id, ...entry.payload } : entry.payload;
      const draft = { v: ASSERTION_SCHEMA_VERSION, seg: chosen.segment, seq, prev, recorded_at: recordedAt, channel: ctx.channel, actor, op: entry.op,
        batch: { id: batchId, size: planned.length, index }, ...(entry.parents ? { parents: entry.parents } : {}), payload_sha256: payloadHash(payload), payload };
      const hash = entryHash(draft as Omit<JournalEntry, "hash">), line = canonical({ ...draft, hash });
      lines.push(line + "\n"); prev = hash;
      receipt.entries.push({ seq, id: entry.id, op: entry.op, hash, ...(entry.op !== "subject" ? { rev: Number(entry.payload.rev) } : {}) });
    }
    const buffer = Buffer.from(lines.join(""));
    // The journal bound is checked on the bytes that will be written, before the file is opened.
    if (journal.bytes + buffer.length > MAX_JOURNAL_BYTES) refuse("V09", `the journal would exceed ${MAX_JOURNAL_BYTES} bytes once this batch is written; appends refuse rather than rotate history`);
    const dir = join(ctx.root, ASSERTIONS_DIR);
    let createdDir = false;
    try { const stat = lstatSync(dir); if (stat.isSymbolicLink() || !stat.isDirectory()) refuse("V04", "assertions/ must be a plain directory; move the file or link aside"); }
    catch (caught) { if ((caught as NodeJS.ErrnoException).code !== "ENOENT") throw caught; mkdirSync(dir, { mode: 0o755 }); createdDir = true; }
    const file = join(dir, `${chosen.segment}.jsonl`);
    let fd: number;
    try { fd = openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (chosen.fresh ? constants.O_EXCL : 0) | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644); }
    catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ELOOP") refuse("V04", `${ASSERTIONS_DIR}/${chosen.segment}.jsonl is a symbolic link; restore the segment from Git or move the link aside, then retry`);
      throw caught;
    }
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1) refuse("V04", "the segment must be a plain nonlinked file; restore it from Git");
      // Forward recovery on the clone's own segment: drop a torn tail or partial batch after the verified prefix.
      if (chosen.report && before.size !== chosen.report.verifiedBytes) {
        if (before.size < chosen.report.verifiedBytes) refuse("CONCURRENT", "the segment shrank while it was read; retry the batch");
        const dropped = before.size - chosen.report.verifiedBytes;
        ftruncateSync(fd, chosen.report.verifiedBytes); fsyncSync(fd);
        receipt.recovery.push(`truncated ${dropped} bytes after seq ${chosen.report.tail?.seq ?? 0} of segment ${chosen.segment} (${chosen.report.partialBatch ? "partial batch" : "torn tail"})`);
      }
      const start = chosen.report?.verifiedBytes ?? 0;
      /** Undo the batch bytes after a failed write or fsync; true when the segment is back at its verified prefix. */
      const rollback = () => { try { ftruncateSync(fd, start); fsyncSync(fd); return true; } catch { return false; } };
      const unpublished = (code: string, message: string): never => {
        receipt.applied = false; receipt.segment = null; delete receipt.recordedAt; receipt.entries = [];
        refuse(code, message);
      };
      let written = 0;
      try { written = writeSync(fd, buffer, 0, buffer.length, null); }
      catch {
        const after = fstatSync(fd);
        if (after.size > start && !rollback()) refuse("DURABILITY", "the batch write failed and the segment could not be truncated back; inspect the segment before retrying");
        unpublished("WRITE", "the batch write failed and was truncated back; nothing was appended. Check disk space and retry");
      }
      if (written !== buffer.length) {
        if (!rollback()) refuse("DURABILITY", `short batch write (${written} of ${buffer.length} bytes) left in the segment and it could not be truncated back; inspect it before retrying`);
        unpublished("WRITE", "short batch write truncated back; nothing was appended. Check disk space and retry");
      }
      // The batch bytes are in the segment from here on: report them, so a later failure never invites a replay that
      // would duplicate the assertions.
      receipt.applied = true; receipt.segment = chosen.segment; receipt.recordedAt = recordedAt;
      try { fsyncSync(fd); }
      catch {
        if (rollback()) unpublished("WRITE", "the batch fsync failed and the batch was truncated back; nothing was appended. Check disk space and retry");
        refuse("DURABILITY", `fsync of segment ${chosen.segment} failed after the batch was written; its ${receipt.entries.length} entries may not survive a crash. Inspect the segment and the writer record before appending again`);
      }
    } finally { closeSync(fd); }
    if (chosen.fresh) syncDirectory(dir);
    if (createdDir) syncDirectory(ctx.root);
    receipt.segment = chosen.segment; receipt.recordedAt = recordedAt;
    const last = receipt.entries.at(-1)!;
    try { saveWriter(home, ctx.vault.id, { segment: chosen.segment, seq: last.seq!, hash: last.hash! }); }
    catch { receipt.issues.push({ code: "WRITER_RECORD", severity: "warning", message: "the batch is appended but the writer record was not updated; the next append starts a new segment" }); }
    receipt.ok = true;
  } catch (caught) {
    if (caught instanceof Refused) receipt.issues.push(...caught.issues);
    else if (caught instanceof Coded) receipt.issues.push(err(caught.code, caught.message));
    // Once the batch bytes are in the segment, a later failure keeps `applied` and never advises a replay.
    else if (receipt.applied) receipt.issues.push(err("DURABILITY", `the batch is in segment ${receipt.segment} but a later step failed (${(caught as NodeJS.ErrnoException).code ?? (caught as Error).message}); inspect the segment and the writer record before appending again`));
    else receipt.issues.push(err("IO", "assertion append failed on file I/O; check permissions and disk space, then retry"));
    receipt.ok = false;
  } finally {
    if (lock) release(lock, receipt.issues);
  }
  if (receipt.applied && request.log !== undefined) {
    receipt.log = appendLog(home, { vault: request.vault, event: request.log, channel: request.channel ?? "cli" }, { env });
  }
  return receipt;
}
