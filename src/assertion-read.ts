/** Verified, policy-screened assertion journal reads. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluateAssertions, readJournal, type AssertionQuery, type VerifiedJournal } from "./assertions.ts";
import { indexedJournal, rebuildAssertionIndex } from "./assertion-index.ts";
import { screenAssertion, type ScreenedAssertion } from "./assertion-policy.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { canonicalPath, isDenied, memoryGitArgv, memoryGitEnv } from "./platform.ts";
import { loadRegistry } from "./registry.ts";
import { MAX_NOTE_BYTES } from "./vault-index.ts";
import type { VaultSpec, VmemConfig } from "./config.ts";
import type { EvidenceReadBudget, EvidenceReads } from "./evidence.ts";
import { screenContent } from "./write-validation.ts";

export const ASSERTIONS_PAGE_LIMIT = 100;
const FRAME_LIMIT = 48 * 1024, FRAME_RESERVE = 2048;
export interface AssertionsReadRequest extends AssertionQuery { vault: string; limit?: number; cursor?: string }
export interface AssertionsReadOptions { env?: NodeJS.ProcessEnv }
export interface AssertionsReadResult {
  schemaVersion: 1; basis: "assertion_journal"; vault: string; at: string | null;
  asOf: ReturnType<typeof evaluateAssertions>["asOf"]; pin: ReturnType<typeof evaluateAssertions>["pin"];
  coverage: ReturnType<typeof evaluateAssertions>["coverage"] & { unsynced: number | null };
  items: (ScreenedAssertion & { subjectNote?: { path?: string; status: "present" | "missing" | "superseded"; supersededBy?: unknown } })[];
  overlaps?: ReturnType<typeof evaluateAssertions>["overlaps"]; truncated: boolean; continuation?: string;
}
const fail = (message: string, code = "V04"): never => { throw Object.assign(new Error(message), { code }); };
const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(JSON.stringify(value))) <= FRAME_LIMIT - FRAME_RESERVE;

/** A bounded Git status over assertion files only, after checking that Git will not run a clean filter. */
function unsynced(root: string, env: NodeJS.ProcessEnv): number | null {
  const git = (args: string[], input?: Buffer) => {
    const argv = memoryGitArgv(["-C", root, ...args]);
    const safeEnv = memoryGitEnv({ ...env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, { repositoryIsolation: true, readOnlyDiagnostic: true });
    safeEnv.GIT_LITERAL_PATHSPECS = "1";
    return spawnSync(argv[0]!, argv.slice(1), { env: safeEnv, timeout: 5000, maxBuffer: 4 * 1024 * 1024, ...(input ? { input } : {}) });
  };
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || top.stdout.toString().trim() !== root) return null;
  const listed = git(["ls-files", "-z", "--", "assertions"]);
  if (listed.status !== 0) return null;
  if (listed.stdout.length) {
    const attrs = git(["check-attr", "-z", "--stdin", "filter"], listed.stdout);
    if (attrs.status !== 0) return null;
    const fields = attrs.stdout.toString().split("\0");
    for (let i = 2; i < fields.length; i += 3) if (fields[i] && fields[i] !== "unspecified") return null;
  }
  const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "assertions"]);
  if (status.status !== 0) return null;
  const records = status.stdout.toString().split("\0").filter(Boolean);
  const changed = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!, name = record.slice(3);
    if (/^assertions\/[0-9a-f]{16}\.jsonl$/.test(name)) changed.add(name);
    if (/[RC]/.test(record.slice(0, 2))) {
      const prior = records[++i];
      if (prior && /^assertions\/[0-9a-f]{16}\.jsonl$/.test(prior)) changed.add(prior);
    }
  }
  return changed.size;
}

function noteStatus(vault: VaultSpec, note: string, config: VmemConfig, budget: EvidenceReadBudget): NonNullable<AssertionsReadResult["items"][number]["subjectNote"]> {
  if (!/^notes\/[^/\\]+\.md$/.test(note) || note.includes("\0")) return { status: "missing" };
  const deny = config.denyPaths ?? [];
  const root = realpathSync(vault.path), dir = join(root, "notes"), file = join(root, note);
  if (isDenied(canonicalPath(file), [...deny]) || isDenied(note, [...deny]) || screenContent(note, vault, config).some(issue => issue.severity === "error")) return { status: "missing" };
  if (budget.remainingFiles <= 0 || budget.remainingBytes <= 0) fail("assertions: subject note read budget exceeded; lower the page limit", "V09");
  budget.remainingFiles--;
  try {
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) return { path: note, status: "missing" };
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_NOTE_BYTES) return { path: note, status: "missing" };
      if (stat.size > budget.remainingBytes) fail("assertions: subject note read budget exceeded; lower the page limit", "V09");
      budget.remainingBytes -= stat.size;
      const data = Buffer.alloc(stat.size); let offset = 0;
      while (offset < data.length) { const n = readSync(fd, data, offset, data.length - offset, null); if (!n) break; offset += n; }
      if (offset !== stat.size || fstatSync(fd).size !== stat.size) return { path: note, status: "missing" };
      const frontmatter = parseFrontmatter(new TextDecoder("utf-8", { fatal: true }).decode(data)).data;
      if (frontmatter.status !== "superseded") return { path: note, status: "present" };
      const target = frontmatter.superseded_by;
      if (typeof target !== "string" || Buffer.byteLength(target) > 1024 || screenContent(target, vault, config).some(issue => issue.severity === "error")) return { path: note, status: "superseded" };
      const stem = target.replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/^notes\//, "").replace(/\.md$/, "");
      if (!stem || /[/\\|#\0]/.test(stem) || isDenied(target, [...deny]) || isDenied(canonicalPath(join(dir, `${stem}.md`)), [...deny])) return { path: note, status: "superseded" };
      return { path: note, status: "superseded", supersededBy: target };
    } finally { closeSync(fd); }
  } catch (error) { if ((error as { code?: string }).code === "V09") throw error; return { path: note, status: "missing" }; }
}
function declaredNotes(journal: VerifiedJournal, cutoff: ReturnType<typeof evaluateAssertions>["asOf"]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  const entries = journal.segments.flatMap(segment => segment.entries.filter(entry => entry.op === "subject"));
  entries.sort((a, b) => a.recorded_at < b.recorded_at ? -1 : a.recorded_at > b.recorded_at ? 1 : a.seg < b.seg ? -1 : a.seg > b.seg ? 1 : a.seq - b.seq);
  for (const entry of entries) {
    if (cutoff && (cutoff.cutoffInclusive ? entry.recorded_at > cutoff.cutoff : entry.recorded_at >= cutoff.cutoff)) continue;
    const subject = entry.payload?.subject;
    if (typeof subject === "string" && !result.has(subject)) result.set(subject, typeof entry.payload?.note === "string" ? entry.payload.note : null);
  }
  return result;
}
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

/** Freshly verifies the journal and applies current policy. The cache is disposable and is never a trust source. */
export function readAssertions(home: string, request: AssertionsReadRequest, options: AssertionsReadOptions = {}): AssertionsReadResult {
  const config = loadRegistry(home), vault = config.vaults.find(value => value.id === request.vault) ?? fail("assertions: unknown vault id; list registered vaults with vmem status");
  const root = realpathSync(vault.path);
  if (root !== resolve(vault.path)) fail("assertions: registered vault root changed; re-register the vault with vmem vaults add");
  const limit = request.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ASSERTIONS_PAGE_LIMIT) fail("assertions: limit must be 1..100; choose a smaller page");
  const journal = readJournal(root, config.denyPaths ?? []);
  const index = rebuildAssertionIndex(home, root, journal, config.vaults.map(value => value.path));
  const query: AssertionQuery = { ...(request.subject !== undefined ? { subject: request.subject } : {}), ...(request.relation !== undefined ? { relation: request.relation } : {}), ...(request.at !== undefined ? { at: request.at } : {}), ...(request.asOf !== undefined ? { asOf: request.asOf } : {}), ...(request.history !== undefined ? { history: request.history } : {}) };
  const answer = evaluateAssertions(indexedJournal(index, journal), query), binding = fingerprint({ root, query, pin: answer.pin, coverage: answer.coverage });
  let offset = 0;
  if (request.cursor !== undefined) {
    try {
      if (request.cursor.length > 512) throw new Error();
      const cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) as { v: number; binding: string; offset: number };
      if (cursor.v !== 1 || cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= answer.items.length) throw new Error();
      offset = cursor.offset;
    } catch { fail("assertions: cursor is invalid or the journal changed; restart without --cursor"); }
  }
  const budget: EvidenceReadBudget = { remainingBytes: 64 * 1024 * 1024, remainingFiles: 1000 }, reads: EvidenceReads = new Map();
  const subjectNotes = declaredNotes(journal, answer.asOf), notes = new Map<string, ReturnType<typeof noteStatus>>();
  const output: AssertionsReadResult = { schemaVersion: 1, basis: "assertion_journal", vault: vault.id, at: answer.at, asOf: answer.asOf, pin: answer.pin,
    coverage: { ...answer.coverage, unsynced: unsynced(root, options.env ?? process.env) }, items: [], ...(request.at ? { overlaps: answer.overlaps } : {}), truncated: false };
  const continuation = (next: number) => Buffer.from(JSON.stringify({ v: 1, binding, offset: next })).toString("base64url");
  if (!fits(output)) fail("assertions: journal coverage exceeds the 48 KiB response bound; narrow the journal or inspect its segments", "V09");
  for (let i = offset; i < answer.items.length && output.items.length < limit; i++) {
    const item = answer.items[i]!, note = subjectNotes.get(item.subject);
    let subjectNote: ReturnType<typeof noteStatus> | undefined;
    if (note) { subjectNote = notes.get(note); if (!subjectNote) { subjectNote = noteStatus(vault, note, config, budget); notes.set(note, subjectNote); } }
    output.items.push({ ...screenAssertion(item, vault, config, reads, budget), ...(subjectNote ? { subjectNote } : {}) });
    const hasMore = i + 1 < answer.items.length;
    output.truncated = hasMore; if (hasMore) output.continuation = continuation(i + 1); else delete output.continuation;
    if (!fits(output)) {
      output.items.pop();
      if (!output.items.length) fail("assertions: one result exceeds the 48 KiB response bound; narrow its evidence or query", "V09");
      output.truncated = true; output.continuation = continuation(i); break;
    }
  }
  return output;
}
