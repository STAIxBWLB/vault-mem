/**
 * Read-only exposure report (issue 259; design `docs/specs/2026-11-19-temporal-assertions-design.md`, Retention and
 * deletion). It answers one question about one vault: does a Git object this repository can reach still hold a purged
 * assertion payload? Git plumbing only, bounded like the journal reader, and never a payload in the receipt.
 *
 * A history rewrite changes every later commit id, needs a force push and invalidates other clones, so vmem reports
 * and writes an expressions file; the rewrite itself stays with the person.
 */
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ASSERTIONS_DIR, MAX_BATCH_BYTES, MAX_JOURNAL_BYTES, MAX_SEGMENT_BYTES, evaluateAssertions, payloadHash, readJournal, type AssertionItem, type JournalEntry, type SegmentReport, type VerifiedJournal } from "./assertions.ts";
import { memoryGitArgv, memoryGitEnv } from "./platform.ts";
import { loadRegistry } from "./registry.ts";
import type { VaultSpec } from "./config.ts";

/** Commits one scan may visit. The bound names the scan's own work, not a repository limit. */
export const EXPOSURE_COMMIT_BUDGET = 100_000;
/** One `assertions/*.jsonl` blob: the journal's segment bound plus one batch of framing, as `readJournal` reads it. */
export const EXPOSURE_BLOB_BYTES = MAX_SEGMENT_BYTES + MAX_BATCH_BYTES * 4;
/** One commit: the journal's own 64 MiB total across the assertion blobs that commit holds. */
export const EXPOSURE_COMMIT_BYTES = MAX_JOURNAL_BYTES;
/** Bound of a complete `vmem_assertions_exposure` reply as the encoded JSON-RPC frame. */
export const EXPOSURE_FRAME_BYTES = 48 * 1024;

const GIT_TIMEOUT_MS = 20_000;
/** `rev-list` and `ls-tree` listings: 100000 commit ids, or one line per assertion blob. */
const LIST_BUFFER_BYTES = 16 * 1024 * 1024;
/** Issue sentences kept in one receipt; a corrupt repository must not grow the reply without bound. */
const ISSUE_LIMIT = 15;
const SEGMENT_PATH = /^assertions\/[0-9a-f]{16}\.jsonl$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NO_PURGED_LINE = "the current verified segment no longer holds this entry's purged line, so there is no byte-for-byte replacement to write; restore or re-purge the assertion, then rerun exposure";
const NOT_EXPRESSIBLE = "this line contains a newline, a carriage return, \"==>\" or a leading #, which git-filter-repo --replace-text cannot express literally; open the exposed line by hand in the fresh clone and remove its payload";
const LOCAL_ONLY = "the scan reads this local repository only (local branches, tags and remote-tracking refs); a remote or another clone this repository cannot read may still hold these payloads";

export interface ExposureRequest { vault: string; assertion?: string }
export interface ExposureCommits { count: number; first: string; last: string }
export interface ExposureRow {
  assertion: string; segment: string; seq: number; hash: string;
  /** `first` is the oldest and `last` the newest commit still holding the line, in the scan's newest-first order. */
  commits: ExposureCommits;
  refs: string[];
  /** False when `--replace-file` cannot map the line; `manual` then names the step that replaces it. */
  replaceable: boolean;
  manual?: string;
}
export interface ReplaceFileReceipt { path: string; lines: number; unreplaceable: number; delete: string }
export interface ExposureReceipt {
  vault: string;
  scanned: { commits: number; blobs: number; bytes: number };
  exposed: ExposureRow[];
  clean: boolean | null;
  truncated: string | null;
  issues: string[];
  /** Set when the MCP reply bound dropped `exposed[].refs`. */
  refsOmitted?: true;
  /** Count of exposed rows the MCP reply bound dropped. */
  omitted?: number;
  /** Present only when the CLI wrote a replace file. */
  replaceFile?: ReplaceFileReceipt;
}
/** One literal `git-filter-repo --replace-text` expression's two sides, taken byte for byte from the two lines. */
export interface ExposureLine { exposed: string; purged: string }
export interface ExposureScan { receipt: ExposureReceipt; /** the verified vault root the purged forms are read from */ root: string; lines: ExposureLine[] }

const fail: (code: string, message: string) => never = (code, message) => { throw Object.assign(new Error(message), { code }); };
const text = (value: Buffer) => value.toString("utf8");
const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };

/** One literal line of a `--replace-text` file: a single line, no separator and no comment marker. */
const expressible = (line: string) => line.length > 0 && !line.includes("\n") && !line.includes("\r") && !line.includes("==>") && !line.startsWith("#");

type GitOutcome = { status: number | null; stdout: Buffer; stderr: string };
/** Hardened Git call: no pager, hooks, fsmonitor, external diff, prompts, lazy fetch or inherited Git directories. */
function git(root: string, args: string[], env: NodeJS.ProcessEnv, maxBuffer = 1 << 16): GitOutcome {
  const argv = memoryGitArgv(["-c", "log.follow=false", "-c", "log.showSignature=false", "-c", "gpg.program=", "-C", root, ...args]);
  const safe = memoryGitEnv({ ...env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, { repositoryIsolation: true, readOnlyDiagnostic: true });
  safe.GIT_LITERAL_PATHSPECS = "1";
  const result = spawnSync(argv[0]!, argv.slice(1), { env: safe, timeout: GIT_TIMEOUT_MS, maxBuffer, stdio: ["pipe", "pipe", "pipe"] });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: null, stdout: Buffer.alloc(0), stderr: "ENOENT" };
    if (code === "ENOBUFS") fail("V09", "the exposure scan's Git listing exceeded its bounded buffer; the scan is not reported clean. Narrow the repository or rerun once it is repaired");
    fail("V09", `the exposure scan could not run git (${code ?? "spawn failure"}); install git or fix PATH, then retry`);
  }
  const stdout = result.stdout ?? Buffer.alloc(0), stderr = result.stderr === undefined ? "" : String(result.stderr);
  if (result.status === null) fail("V09", `the exposure scan's Git call was terminated (signal ${result.signal ?? "unavailable"}); retry once the repository is responsive`);
  return { status: result.status, stdout, stderr };
}

/** The registered vault, its verified root and the deny list, gated exactly as `vmem assertions` gates a read. */
function openVault(home: string, request: ExposureRequest): { vault: VaultSpec; root: string; denyPaths: string[] } {
  const config = loadRegistry(home), vault = config.vaults.find(value => value.id === request?.vault);
  if (!vault) fail("V04", "assertions: unknown vault id; list registered vaults with vmem status");
  let root: string;
  try { root = realpathSync(vault.path); }
  catch { fail("V04", "registered vault path is missing; restore it or re-register the vault"); }
  if (root !== resolve(vault.path)) fail("V04", "assertions: registered vault root changed; re-register the vault with vmem vaults add");
  return { vault, root, denyPaths: config.denyPaths ?? [] };
}

interface Target { assertion: string; entry: JournalEntry; exposed: Set<string>; commits: string[]; seen: Set<string> }
const key = (entry: JournalEntry) => `${entry.seg}\u0000${entry.seq}\u0000${entry.hash}`;

/** Every purged entry the current journal holds, each with the assertion it belongs to (`parents` resolve it). */
function purgedTargets(journal: VerifiedJournal, history: readonly AssertionItem[], id: string | undefined): Target[] {
  const targets: Target[] = [];
  for (const item of history) {
    if (item.purged !== true || item.segment === undefined || item.seq === undefined) continue;
    if (id !== undefined && item.id !== id) continue;
    const report = journal.segments.find(segment => segment.segment === item.segment);
    const entry = report?.entries[item.seq - 1];
    // `evaluateAssertions` reads verified entries only; this guard keeps the position and hash honest anyway.
    if (!entry || entry.hash !== item.hash || entry.purged === undefined) continue;
    targets.push({ assertion: item.id, entry, exposed: new Set(), commits: [], seen: new Set() });
  }
  return targets.sort((a, b) => a.assertion < b.assertion ? -1 : a.assertion > b.assertion ? 1 : a.entry.seg < b.entry.seg ? -1 : a.entry.seg > b.entry.seg ? 1 : a.entry.seq - b.entry.seq);
}

interface TreeBlob { oid: string; size: number }
/** The `assertions/<16 hex>.jsonl` blobs of one tree from `ls-tree -r -l -z`, with the sizes it lists. */
function treeBlobs(stdout: Buffer): TreeBlob[] {
  const blobs: TreeBlob[] = [];
  for (const record of text(stdout).split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    // `-l` pads the size column with spaces, so the fields are split on any whitespace.
    const [, type, oid, size] = record.slice(0, tab).split(/\s+/);
    if (type !== "blob" || !oid || !SEGMENT_PATH.test(record.slice(tab + 1))) continue;
    const bytes = Number(size);
    if (!Number.isSafeInteger(bytes) || bytes < 0) continue;
    blobs.push({ oid, size: bytes });
  }
  return blobs;
}

/** Ref names containing `commit`, resolved once per commit. Annotated tags are peeled by `for-each-ref` itself. */
function refsContaining(root: string, env: NodeJS.ProcessEnv, commit: string, cache: Map<string, { refs: string[]; ok: boolean }>): { refs: string[]; ok: boolean } {
  const known = cache.get(commit);
  if (known) return known;
  const out = git(root, ["for-each-ref", `--contains=${commit}`, "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes"], env, 1 << 18);
  const refs = out.status === 0 ? text(out.stdout).split("\n").map(line => line.trim()).filter(line => line.length > 0 && !line.endsWith("/HEAD")) : [];
  const found = { refs, ok: out.status === 0 };
  cache.set(commit, found);
  return found;
}

/** The purged line as the current verified segment holds it, or null when it no longer does. */
function purgedLine(root: string, report: SegmentReport, entry: JournalEntry): string | null {
  try {
    const data = readFileSync(join(root, ASSERTIONS_DIR, `${entry.seg}.jsonl`));
    const prefix = data.subarray(0, Math.min(report.verifiedBytes, data.length)).toString("utf8"), lines = prefix.split("\n");
    const line = lines[entry.seq - 1];
    if (line === undefined) return null;
    const parsed = JSON.parse(line) as { hash?: unknown };
    return parsed?.hash === entry.hash ? line : null;
  } catch { return null; }
}

/** One parsed JSONL line, or undefined when it is not a journal entry shape. */
function parsedEntry(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const entry = parsed as Record<string, unknown>;
    return typeof entry.seg === "string" && Number.isSafeInteger(entry.seq) && typeof entry.hash === "string" ? entry : undefined;
  } catch { return undefined; }
}

/** Mark every target whose line this blob still holds with a payload that hashes to its `payload_sha256`. */
function blobMatches(content: Buffer, targets: Map<string, Target>): { target: Target; line: string }[] {
  const matches: { target: Target; line: string }[] = [];
  for (const line of text(content).split("\n")) {
    // Every exposed line is the same entry with `payload` restored; the marker is a cheap prefilter before parsing.
    if (!line.includes('"payload":')) continue;
    const entry = parsedEntry(line);
    if (!entry || entry.payload === undefined || typeof entry.payload_sha256 !== "string") continue;
    if (payloadHash(entry.payload) !== entry.payload_sha256) continue;
    const target = targets.get(`${entry.seg as string}\u0000${String(entry.seq)}\u0000${entry.hash as string}`);
    if (target) matches.push({ target, line });
  }
  return matches;
}

/**
 * Scan the vault repository for purged payloads this repository can still reach. Never throws for an unreadable
 * repository: `clean: null` with the cause in `issues` is the answer, and a partial scan is never `clean: true`.
 */
export function scanAssertionExposure(home: string, request: ExposureRequest, options: { env?: NodeJS.ProcessEnv } = {}): ExposureScan {
  const env = options.env ?? process.env;
  const { vault, root, denyPaths } = openVault(home, request);
  const receipt: ExposureReceipt = { vault: vault.id, scanned: { commits: 0, blobs: 0, bytes: 0 }, exposed: [], clean: null, truncated: null, issues: [] };
  const scan: ExposureScan = { receipt, root, lines: [] };
  const dropped = { count: 0 };
  const issue = (message: string) => { if (receipt.issues.length < ISSUE_LIMIT) receipt.issues.push(message); else dropped.count++; };
  // The journal is read first, so a denied `assertions/` path refuses here exactly as it refuses `vmem assertions`.
  const journal = readJournal(root, denyPaths);
  const history = evaluateAssertions(journal, { history: true }).items;
  if (request.assertion !== undefined) {
    const found = history.filter(item => item.id === request.assertion);
    if (!found.length) fail("V01", `no verified journal entry belongs to ${request.assertion}; list assertion ids with vmem assertions ${vault.id} --history`);
    if (!found.some(item => item.purged === true)) fail("V01", `${request.assertion} is not purged, so its payload is still in the current journal and no history scan can clear it; purge it with vmem assertions purge ${vault.id} ${request.assertion} --reason TEXT`);
  }
  const targets = purgedTargets(journal, history, request.assertion);
  const top = git(root, ["rev-parse", "--show-toplevel"], env, 1 << 16);
  if (top.status !== 0) {
    if (top.stderr.trim() === "ENOENT") issue("git is not available on PATH; install git and retry");
    else issue("not a git repository");
    return scan;
  }
  if (real(text(top.stdout).trim()) !== root) {
    issue("the registered vault is not the top level of its Git repository; exposure reads the whole repository, so it refuses to scan a parent or an unrelated tree");
    return scan;
  }
  if (!targets.length) { receipt.clean = true; return scan; }
  issue(LOCAL_ONLY);
  const refs = git(root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes"], env, LIST_BUFFER_BYTES);
  if (refs.status !== 0) { issue("git could not list this repository's refs; the scan is incomplete and is not reported clean"); return scan; }
  if (!text(refs.stdout).trim()) { receipt.clean = true; return scan; }
  const listed = git(root, ["rev-list", "--full-history", `--max-count=${EXPOSURE_COMMIT_BUDGET + 1}`, "--branches", "--tags", "--remotes", "--", ASSERTIONS_DIR], env, LIST_BUFFER_BYTES);
  if (listed.status !== 0) {
    const first = listed.stderr.split(/\r?\n/)[0] ?? "";
    issue(`git could not list the commits that touch ${ASSERTIONS_DIR}/ (${first.slice(0, 200) || `exit ${listed.status}`}); the scan is incomplete and is not reported clean`);
    return scan;
  }
  let commits = text(listed.stdout).split("\n").map(line => line.trim()).filter(line => OID.test(line));
  if (commits.length > EXPOSURE_COMMIT_BUDGET) {
    commits = commits.slice(0, EXPOSURE_COMMIT_BUDGET);
    receipt.truncated = `commit budget (${EXPOSURE_COMMIT_BUDGET} commits)`;
  }
  const byKey = new Map(targets.map(target => [key(target.entry), target]));
  const blobCache = new Map<string, { target: Target; line: string }[]>(), refCache = new Map<string, { refs: string[]; ok: boolean }>();
  let incomplete = false;
  for (const commit of commits) {
    const tree = git(root, ["ls-tree", "-r", "-l", "-z", commit, "--", ASSERTIONS_DIR], env, LIST_BUFFER_BYTES);
    if (tree.status !== 0) {
      incomplete = true;
      issue(`git could not list ${ASSERTIONS_DIR}/ in commit ${commit.slice(0, 12)} (exit ${tree.status}); the scan is incomplete`);
      continue;
    }
    const blobs = treeBlobs(tree.stdout);
    // The per-commit total is summed from the sizes Git lists, so the bound is crossed without reading a byte.
    if (blobs.reduce((sum, blob) => sum + blob.size, 0) > EXPOSURE_COMMIT_BYTES) { receipt.truncated ??= `64 MiB per-commit budget (commit ${commit.slice(0, 12)})`; continue; }
    receipt.scanned.commits++;
    for (const blob of blobs) {
      if (blob.size > EXPOSURE_BLOB_BYTES) { receipt.truncated ??= `8 MiB per-blob budget (blob ${blob.oid.slice(0, 12)})`; continue; }
      let matches = blobCache.get(blob.oid);
      if (!matches) {
        const content = git(root, ["cat-file", "blob", blob.oid], env, Math.max(blob.size + 64, 1 << 16));
        if (content.status !== 0 || content.stdout.length !== blob.size) {
          incomplete = true;
          issue(`blob ${blob.oid.slice(0, 12)} could not be read (exit ${content.status}); the scan is incomplete`);
          continue;
        }
        receipt.scanned.blobs++; receipt.scanned.bytes += content.stdout.length;
        matches = blobMatches(content.stdout, byKey);
        blobCache.set(blob.oid, matches);
      }
      // One blob can sit unchanged in several commits, and every one of them still holds the line.
      for (const match of matches) {
        match.target.exposed.add(match.line);
        if (!match.target.seen.has(commit)) { match.target.seen.add(commit); match.target.commits.push(commit); }
      }
    }
  }
  for (const target of targets) {
    if (!target.exposed.size) continue;
    const found = target.commits.map(commit => refsContaining(root, env, commit, refCache));
    if (found.some(item => !item.ok)) {
      incomplete = true;
      issue(`git could not list the refs that contain a commit holding a purged line (${target.entry.seg}:${target.entry.seq}); refs are incomplete`);
    }
    const report = journal.segments.find(segment => segment.segment === target.entry.seg);
    const purged = report ? purgedLine(root, report, target.entry) : null;
    const pairs: ExposureLine[] = [];
    let replaceable = purged !== null;
    if (purged !== null) for (const line of target.exposed) {
      if (!expressible(line) || !expressible(purged)) { replaceable = false; pairs.length = 0; break; }
      pairs.push({ exposed: line, purged });
    }
    scan.lines.push(...pairs);
    receipt.exposed.push({ assertion: target.assertion, segment: target.entry.seg, seq: target.entry.seq, hash: target.entry.hash,
      commits: { count: target.commits.length, first: target.commits[target.commits.length - 1]!, last: target.commits[0]! },
      refs: [...new Set(found.flatMap(item => item.refs))].sort(), replaceable, ...(replaceable ? {} : { manual: purged === null ? NO_PURGED_LINE : NOT_EXPRESSIBLE }) });
  }
  if (receipt.truncated !== null) issue(`the scan stopped at the ${receipt.truncated}; a partial scan is never reported clean`);
  if (dropped.count) issue(`${dropped.count} more issue(s) were dropped from this receipt`);
  receipt.clean = receipt.truncated !== null || incomplete ? false : receipt.exposed.length === 0;
  return scan;
}

/**
 * Write the `git filter-repo --replace-text` expressions file for a scan: one literal `exposed==>purged` line per
 * exposed line, mode 0600, a new path only, outside the vault. It holds the payloads it removes, so the receipt
 * says to delete it.
 */
export function writeReplaceFile(scan: ExposureScan, target: string): ReplaceFileReceipt {
  const receipt = scan.receipt;
  if (receipt.clean !== false) fail("V01", receipt.clean === true
    ? "the exposure scan found no purged payload in reachable history, so there is nothing to replace; no file was written"
    : "the exposure scan did not complete, so no replace file was written; fix the issues it reported and rerun");
  if (!scan.lines.length) fail("V01", "no exposed line can be written as a replace expression; see each unreplaceable row's manual step, and no file was written");
  const absolute = resolve(target), vault = resolve(scan.root);
  const directory = (() => { try { return realpathSync(dirname(absolute)); } catch { return fail("V04", `--replace-file: the directory ${dirname(absolute)} does not exist; create a private directory for the expressions file, then retry`); } })();
  const path = join(directory, basename(absolute));
  if (path === vault || path.startsWith(vault + sep)) fail("V04", "--replace-file must lie outside the vault: the expressions file holds the payloads it removes, so it is never written into the repository it is meant to clean; name a path outside the vault");
  if (existsSync(path)) fail("V04", `--replace-file refuses an existing path (${path}); delete or rename that file first, and never reuse an expressions file across scans`);
  const expressions = scan.lines.map(line => `${line.exposed}==>${line.purged}`).join("\n") + "\n";
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (caught) {
    const code = (caught as NodeJS.ErrnoException).code ?? "unknown error";
    if (code === "EEXIST") fail("V04", `--replace-file refuses an existing path (${path}); delete or rename that file first, and never reuse an expressions file across scans`);
    if (code === "ELOOP") fail("V04", `--replace-file refuses ${path}: it is a symbolic link; name a new regular file outside the vault`);
    fail("V04", `--replace-file could not create ${path} (${code}); check the directory's permissions and free space, then retry`);
  }
  try { writeFileSync(fd, expressions); fsyncSync(fd); }
  catch (caught) {
    closeSync(fd);
    let removed = true;
    try { unlinkSync(path); } catch { removed = false; }
    fail("IO", removed
      ? `the replace file could not be written (${(caught as NodeJS.ErrnoException).code ?? "write failed"}); the partial file was removed and nothing changed`
      : `the replace file could not be written (${(caught as NodeJS.ErrnoException).code ?? "write failed"}); a partial file remains at ${path} and must be deleted, because it holds payload text`);
  }
  closeSync(fd);
  return { path, lines: scan.lines.length, unreplaceable: receipt.exposed.filter(row => !row.replaceable).length,
    delete: "delete this file after the rewrite, and after every failed attempt: it holds the payloads it maps" };
}
