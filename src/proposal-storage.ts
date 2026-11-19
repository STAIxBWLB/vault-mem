/** Internal bounded storage for proposal records and binding metadata. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, writeFileSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { LOCK_FILE, syncDirectory } from "./registry.ts";
import { capturePublicationPath, cleanupOwnedFile, publishFile } from "./write-files.ts";
import { isDenied } from "./platform.ts";
import { decodeProposalEvidence, decodeProposalReason, decodeProposalRecord, encodeProposalEvidence, encodeProposalReason, encodeProposalRecord, MAX_PROPOSAL_RECORD_BYTES, proposalRecordDigest, type ProposalExecutionEvidence, type ProposalReason, type ProposalRecord } from "./proposals.ts";
import type { WriteIssue } from "./write-types.ts";

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BINDINGS = 256, MAX_BINDING_BYTES = 4096;
function leftover(name: string): WriteIssue {
  const display = /^[A-Za-z0-9._-]{1,100}$/.test(name) && !/(?:secret|token|password|credential)/i.test(name) ? name : "name withheld";
  return { code: "PROPOSAL_LEFTOVER", severity: "warning", message: `proposal store skipped unexpected entry ${display}; inspect the proposal store and retry after concurrent writes finish` };
}
function requireAllowed(denyPaths: string[], ...paths: string[]): void {
  if (paths.some(path => isDenied(path, denyPaths))) throw new Error("proposal: storage path is denied by current policy; inspect the configured deny paths");
}
function storeRoot(home: string, denyPaths: string[]): string {
  const configured = resolve(home); requireAllowed(denyPaths, configured);
  let root: string;
  try { root = realpathSync(configured); } catch { throw new Error("proposal: configured home is unavailable; set VMEM_HOME to an existing home or restore it from backup"); }
  requireAllowed(denyPaths, root);
  if (!lstatSync(root).isDirectory()) throw new Error("proposal: configured home is not a directory; set VMEM_HOME to an existing home");
  return root;
}
function validateDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid()))
    throw new Error("proposal: store directory is linked or not private; inspect the configured home");
}
/** The binding is derived internally by the caller, never accepted from a CLI or MCP request. */
function directory(home: string, binding: string, create: boolean, denyPaths: string[] = []): string {
  if (!DIGEST.test(binding)) throw new Error("proposal: invalid internal vault binding; inspect the registered vault");
  const root = storeRoot(home, denyPaths);
  requireAllowed(denyPaths, root, join(root, "proposals"), join(root, "proposals", binding));
  let current = root;
  for (const part of ["proposals", binding]) {
    current = join(current, part);
    if (create) {
      let made = false;
      try { mkdirSync(current, { mode: 0o700 }); made = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (made) syncDirectory(dirname(current));
    }
    validateDirectory(current);
  }
  return current;
}
function recordFile(home: string, binding: string, id: string, create: boolean, denyPaths: string[] = []): { root: string; file: string } {
  if (!ID.test(id)) throw new Error("proposal: invalid proposal id; use an id from proposal list");
  const root = storeRoot(home, denyPaths), file = join(root, "proposals", binding, `${id}.json`);
  requireAllowed(denyPaths, file);
  directory(root, binding, create, denyPaths);
  return { root, file };
}
function validRecordFile(info: Stats): void {
  if (info.nlink !== 1) throw new Error("proposal: record is linked or publication is in progress; retry after concurrent writes finish, then inspect the proposal store");
  if (!info.isFile() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid()))
    throw new Error("proposal: record is linked or not private; inspect the proposal store");
  if (info.size > MAX_PROPOSAL_RECORD_BYTES) throw new Error("proposal: stored record exceeds 32 KiB; inspect the proposal store");
}
/** Binding metadata contains no note or proposal body. Each read is bounded before allocation. */
function readBinding(home: string, binding: string, denyPaths: string[] = []): { vault: string; bindingDigest: string } {
  const root = storeRoot(home, denyPaths), file = join(root, "proposals", binding, "binding.json");
  requireAllowed(denyPaths, file);
  directory(root, binding, false, denyPaths);
  const captured = capturePublicationPath(root, file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd); validRecordFile(before);
    if (before.size > MAX_BINDING_BYTES) throw new Error("proposal: binding metadata exceeds its bound; inspect the proposal store");
    const bytes = Buffer.alloc(MAX_BINDING_BYTES + 1); let length = 0, n = 0;
    while (length < bytes.length && (n = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += n;
    const after = fstatSync(fd), named = lstatSync(file), parents = capturePublicationPath(root, file);
    validRecordFile(after); validRecordFile(named);
    if (length > MAX_BINDING_BYTES || length !== after.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.dev !== named.dev || after.ino !== named.ino || JSON.stringify(captured.parents) !== JSON.stringify(parents.parents))
      throw new Error("proposal: binding metadata changed while reading; inspect the proposal store");
    const data = bytes.subarray(0, length), text = data.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(data)) throw new Error("proposal: binding metadata is not UTF-8; inspect the proposal store");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("proposal: binding metadata is not JSON; inspect the proposal store"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || JSON.stringify(parsed) !== text) throw new Error("proposal: binding metadata is corrupt; inspect the proposal store");
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "bindingDigest,schemaVersion,vault" || value.schemaVersion !== 1 || typeof value.vault !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.vault) || value.bindingDigest !== binding)
      throw new Error("proposal: binding metadata is invalid; inspect the proposal store");
    return { vault: value.vault, bindingDigest: binding };
  } finally { closeSync(fd); }
}

/** Bounded lookup prevents a re-registered vault id from silently choosing another store. */
export function checkStoredBinding(home: string, vault: string, expected: string, denyPaths: string[] = [], issues: WriteIssue[] = []): boolean {
  if (!DIGEST.test(expected) || !/^[a-z][a-z0-9-]{0,63}$/.test(vault)) throw new Error("proposal: invalid internal vault binding; inspect the registered vault");
  const root = storeRoot(home, denyPaths), base = join(root, "proposals");
  requireAllowed(denyPaths, root, base);
  try { validateDirectory(base); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  const parent = capturePublicationPath(root, join(base, ".scan")), dir = opendirSync(base); let count = 0, found = false;
  try {
    let entry;
    while ((entry = dir.readSync()) !== null) {
      if (entry.name === ".binding.lock") { issues.push(leftover(entry.name)); continue; }
      if (++count > MAX_BINDINGS) throw new Error("proposal: too many vault bindings to inspect; inspect the proposal store");
      if (!DIGEST.test(entry.name)) { issues.push(leftover(entry.name)); continue; }
      let binding: { vault: string; bindingDigest: string };
      try { binding = readBinding(root, entry.name, denyPaths); }
      catch (error) {
        if (error instanceof Error && /denied by current policy/.test(error.message)) throw error;
        issues.push({ code: "PROPOSAL_BINDING_UNREADABLE", severity: "warning", message: `proposal binding ${entry.name}: metadata is incomplete, linked or corrupt; inspect the proposal store and retry after concurrent writes finish` });
        continue;
      }
      if (binding.vault === vault && binding.bindingDigest !== expected) issues.push({ code: "PROPOSAL_ORPHANED_BINDING", severity: "warning", message: "vault root identity changed; old proposals remain bound to the previous root; restore that root or inspect the proposal store" });
      if (binding.vault === vault && binding.bindingDigest === expected) found = true;
    }
  } finally { dir.closeSync(); }
  if (JSON.stringify(parent.parents) !== JSON.stringify(capturePublicationPath(root, join(base, ".scan")).parents)) throw new Error("proposal: store path changed during binding lookup; inspect the configured home");
  return found;
}

function publishNew(root: string, dir: string, file: string, bytes: Uint8Array, denyPaths: string[] = []): void {
  const captured = capturePublicationPath(root, file), temporary = join(dir, `.proposal-${randomUUID()}.tmp`);
  requireAllowed(denyPaths, file, temporary);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes); fsyncSync(fd);
    publishFile(captured, { kind: "link", temp: temporary }, () => {});
    syncDirectory(dir);
  } finally { try { cleanupOwnedFile(temporary, fd); } finally { closeSync(fd); } }
}
/** Reads at most 32 KiB and rejects a rebound filename or changed descriptor. */
export function readStoredProposal(home: string, binding: string, id: string, denyPaths: string[] = []): ProposalRecord {
  const { root, file } = recordFile(home, binding, id, false, denyPaths), captured = capturePublicationPath(root, file);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error("proposal: id not found; use proposal list to find an existing id"), { code: "ENOENT" });
    throw new Error("proposal: record is linked or unreadable; inspect the proposal store before retrying", { cause: error });
  }
  try {
    const before = fstatSync(fd); validRecordFile(before);
    const bytes = Buffer.alloc(MAX_PROPOSAL_RECORD_BYTES + 1);
    let size = 0, read = 0;
    while (size < bytes.length && (read = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += read;
    const after = fstatSync(fd), named = lstatSync(file);
    validRecordFile(after); validRecordFile(named);
    if (size > MAX_PROPOSAL_RECORD_BYTES || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.dev !== named.dev || after.ino !== named.ino || size !== after.size)
      throw new Error("proposal: stored record changed while reading; retry after concurrent writes stop");
    const parents = capturePublicationPath(root, file);
    if (JSON.stringify(captured.parents) !== JSON.stringify(parents.parents)) throw new Error("proposal: store path changed while reading; inspect the configured home");
    const record = decodeProposalRecord(bytes.subarray(0, size));
    if (record.id !== id || record.bindingDigest !== binding) throw new Error("proposal: stored record binding differs from its path; inspect the proposal store");
    return record;
  } finally { closeSync(fd); }
}
/** Enumerate only generated record names, with bounded directory traversal and parent identity checks. */
export function listStoredProposalIds(home: string, binding: string, denyPaths: string[] = [], issues: WriteIssue[] = []): string[] {
  const root = storeRoot(home, denyPaths), dir = directory(root, binding, false, denyPaths), target = join(dir, ".scan"), captured = capturePublicationPath(root, target);
  const fd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW), before = fstatSync(fd);
  let entries;
  try { entries = opendirSync(dir); } catch (error) { closeSync(fd); throw error; }
  const ids: string[] = [];
  try {
    let item, count = 0;
    while ((item = entries.readSync()) !== null) {
      if (++count > 10001) throw new Error("proposal: store exceeds the listing bound; inspect the proposal store");
      if (item.name === "binding.json") continue;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-f0-9]{64}\.receipt\.json$/.test(item.name)) continue;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-f0-9]{64}\.reason\.json$/.test(item.name)) continue;
      const id = item.name.endsWith(".json") ? item.name.slice(0, -5) : "";
      if (!ID.test(id)) { issues.push(leftover(item.name)); continue; }
      ids.push(id);
    }
    const after = fstatSync(fd), named = lstatSync(dir), parents = capturePublicationPath(root, target);
    validateDirectory(dir);
    if (!named.isDirectory() || named.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || after.dev !== named.dev || after.ino !== named.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || JSON.stringify(captured.parents) !== JSON.stringify(parents.parents))
      throw new Error("proposal: store changed during listing; retry after concurrent writes stop");
  } finally { try { entries.closeSync(); } finally { closeSync(fd); } }
  return ids.sort();
}
/** Store mutations require the caller's owned registry lock; no second, unrecoverable store lock is created. */
function withStoreLock<T>(home: string, create: boolean, work: (root: string) => T, denyPaths: string[], registryFd: number): T {
  const root = storeRoot(home, denyPaths), base = join(root, "proposals"), lock = join(root, LOCK_FILE);
  requireAllowed(denyPaths, root, base, lock);
  const owned = fstatSync(registryFd), named = lstatSync(lock);
  validRecordFile(owned); validRecordFile(named);
  if (owned.dev !== named.dev || owned.ino !== named.ino) throw new Error("proposal: registry lock ownership changed; inspect the lock before retrying");
  if (create) {
    let made = false;
    try { mkdirSync(base, { mode: 0o700 }); made = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (made) syncDirectory(root);
  }
  validateDirectory(base);
  const result = work(root), after = lstatSync(lock), held = fstatSync(registryFd);
  validRecordFile(after); validRecordFile(held);
  if (after.dev !== held.dev || after.ino !== held.ino) throw new Error("proposal: registry lock ownership changed during storage; inspect the proposal before retrying");
  return result;
}
function evidenceFile(home: string, binding: string, id: string, fingerprint: string, denyPaths: string[]): { root: string; dir: string; file: string } {
  if (!DIGEST.test(fingerprint) || !ID.test(id)) throw new Error("proposal: invalid evidence identifier; inspect the proposal");
  const root = storeRoot(home, denyPaths), dir = directory(root, binding, false, denyPaths), file = join(dir, `${id}.${fingerprint}.receipt.json`);
  requireAllowed(denyPaths, file);
  return { root, dir, file };
}
/** A missing sidecar is not evidence that publication did or did not occur. */
export function readStoredEvidence(home: string, binding: string, id: string, fingerprint: string, denyPaths: string[] = []): ProposalExecutionEvidence | null {
  const { root, file } = evidenceFile(home, binding, id, fingerprint, denyPaths), captured = capturePublicationPath(root, file);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("proposal: execution evidence is linked or unreadable; inspect the proposal store", { cause: error }); }
  try {
    const before = fstatSync(fd); validRecordFile(before);
    if (before.size > 4096) throw new Error("proposal: execution evidence exceeds its bound; inspect the proposal store");
    const bytes = Buffer.alloc(4097); let length = 0, n = 0;
    while (length < bytes.length && (n = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += n;
    const after = fstatSync(fd), named = lstatSync(file), parents = capturePublicationPath(root, file);
    validRecordFile(after); validRecordFile(named);
    if (length > 4096 || length !== after.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.dev !== named.dev || after.ino !== named.ino || JSON.stringify(captured.parents) !== JSON.stringify(parents.parents)) throw new Error("proposal: execution evidence changed during reading; inspect the proposal store");
    const evidence = decodeProposalEvidence(bytes.subarray(0, length));
    if (evidence.id !== id || evidence.bindingDigest !== binding || evidence.fingerprint !== fingerprint) throw new Error("proposal: execution evidence binding differs; inspect the proposal store");
    // A prior publication may have reported a directory flush failure. Re-flush the existing name before using it as durable evidence.
    if (!syncDirectory(dirname(file))) throw new Error("proposal: execution evidence cannot be durably verified on this platform; inspect the proposal store");
    const flushed = lstatSync(file), finalParents = capturePublicationPath(root, file);
    validRecordFile(flushed);
    if (flushed.dev !== after.dev || flushed.ino !== after.ino || JSON.stringify(captured.parents) !== JSON.stringify(finalParents.parents)) throw new Error("proposal: execution evidence changed while flushing; inspect the proposal store");
    return evidence;
  } finally { closeSync(fd); }
}
/** Record a writer-observed outcome under the owned registry lock, never from a caller. */
export function createStoredEvidence(home: string, evidence: ProposalExecutionEvidence, denyPaths: string[], registryFd: number): void {
  const bytes = encodeProposalEvidence(evidence);
  withStoreLock(home, false, root => {
    const record = readStoredProposal(root, evidence.bindingDigest, evidence.id, denyPaths);
    if (record.state !== "apply_unknown" || record.intent?.fingerprint !== evidence.fingerprint || record.intent.beforeSha !== evidence.beforeSha || record.intent.afterSha !== evidence.afterSha)
      throw new Error("proposal: execution evidence does not match the recorded intent; inspect the proposal store");
    const { dir, file } = evidenceFile(root, evidence.bindingDigest, evidence.id, evidence.fingerprint, denyPaths);
    try { publishNew(root, dir, file, bytes, denyPaths); }
    catch (error) {
      const cause = error instanceof Error ? error.cause as NodeJS.ErrnoException | undefined : undefined;
      if (cause?.code !== "EEXIST") throw error;
      const existing = readStoredEvidence(root, evidence.bindingDigest, evidence.id, evidence.fingerprint, denyPaths);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(evidence)) throw error;
    }
  }, denyPaths, registryFd);
}
function reasonFile(home: string, binding: string, id: string, digest: string, denyPaths: string[]): { root: string; dir: string; file: string } {
  if (!DIGEST.test(digest) || !ID.test(id)) throw new Error("proposal: invalid reason identifier; inspect the proposal");
  const root = storeRoot(home, denyPaths), dir = directory(root, binding, false, denyPaths), file = join(dir, `${id}.${digest}.reason.json`);
  requireAllowed(denyPaths, file);
  return { root, dir, file };
}
export function readStoredReason(home: string, binding: string, id: string, digest: string, denyPaths: string[] = []): string {
  const { root, file } = reasonFile(home, binding, id, digest, denyPaths), captured = capturePublicationPath(root, file);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new Error("proposal: rejection reason record is missing, linked or unreadable; inspect the proposal store", { cause: error }); }
  try {
    const before = fstatSync(fd); validRecordFile(before);
    const bytes = Buffer.alloc(MAX_PROPOSAL_RECORD_BYTES + 1); let length = 0, n = 0;
    while (length < bytes.length && (n = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += n;
    const after = fstatSync(fd), named = lstatSync(file), parents = capturePublicationPath(root, file);
    validRecordFile(after); validRecordFile(named);
    if (length > MAX_PROPOSAL_RECORD_BYTES || length !== after.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.dev !== named.dev || after.ino !== named.ino || JSON.stringify(captured.parents) !== JSON.stringify(parents.parents)) throw new Error("proposal: rejection reason changed while reading; inspect the proposal store");
    const reason = decodeProposalReason(bytes.subarray(0, length));
    if (reason.id !== id || reason.bindingDigest !== binding || reason.digest !== digest) throw new Error("proposal: rejection reason binding differs; inspect the proposal store");
    if (!syncDirectory(dirname(file))) throw new Error("proposal: rejection reason cannot be durably verified on this platform; inspect the proposal store");
    const flushed = lstatSync(file), finalParents = capturePublicationPath(root, file);
    validRecordFile(flushed);
    if (flushed.dev !== after.dev || flushed.ino !== after.ino || JSON.stringify(captured.parents) !== JSON.stringify(finalParents.parents)) throw new Error("proposal: rejection reason changed while flushing; inspect the proposal store");
    return reason.reason;
  } finally { closeSync(fd); }
}
/** Store the screened overflow reason before atomically replacing the proposal record. */
export function createStoredReason(home: string, reason: ProposalReason, recordDigest: string, denyPaths: string[], registryFd: number): void {
  const bytes = encodeProposalReason(reason);
  withStoreLock(home, false, root => {
    const current = readStoredProposal(root, reason.bindingDigest, reason.id, denyPaths);
    if (current.state !== "pending" || proposalRecordDigest(current) !== recordDigest) throw new Error("proposal: record changed before rejection; request a new preview");
    const { dir, file } = reasonFile(root, reason.bindingDigest, reason.id, reason.digest, denyPaths);
    try { publishNew(root, dir, file, bytes, denyPaths); }
    catch (error) {
      const cause = error instanceof Error ? error.cause as NodeJS.ErrnoException | undefined : undefined;
      if (cause?.code !== "EEXIST" || readStoredReason(root, reason.bindingDigest, reason.id, reason.digest, denyPaths) !== reason.reason) throw error;
    }
  }, denyPaths, registryFd);
}
/** Publishes a new record atomically without overwriting any existing proposal. */
export function createStoredProposal(home: string, record: ProposalRecord, denyPaths: string[], registryFd: number): void {
  const bytes = encodeProposalRecord(record);
  withStoreLock(home, true, root => {
    const found = checkStoredBinding(root, record.vault, record.bindingDigest, denyPaths);
    const { file } = recordFile(root, record.bindingDigest, record.id, true, denyPaths), dir = directory(root, record.bindingDigest, false, denyPaths);
    if (!found) publishNew(root, dir, join(dir, "binding.json"), Buffer.from(JSON.stringify({ schemaVersion: 1, vault: record.vault, bindingDigest: record.bindingDigest }), "utf8"), denyPaths);
    publishNew(root, dir, file, bytes, denyPaths);
  }, denyPaths, registryFd);
}

/** Compare-and-replace a record while retaining the proposal payload and vault identity. */
export function replaceStoredProposal(home: string, binding: string, id: string, expectedDigest: string, next: ProposalRecord, denyPaths: string[], registryFd: number): void {
  if (!DIGEST.test(expectedDigest)) throw new Error("proposal: invalid record fingerprint; request a new preview");
  const bytes = encodeProposalRecord(next);
  let published = false;
  try { withStoreLock(home, false, root => {
    const { file } = recordFile(root, binding, id, false, denyPaths), dir = directory(root, binding, false, denyPaths);
    const sourceFd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(sourceFd); validRecordFile(before);
      const current = readStoredProposal(root, binding, id, denyPaths);
      if (proposalRecordDigest(current) !== expectedDigest) throw new Error("proposal: record changed since preview; request a new preview");
      if (current.id !== next.id || current.vault !== next.vault || current.bindingDigest !== next.bindingDigest || current.createdAt !== next.createdAt || current.payloadDigest !== next.payloadDigest || current.agentLabel !== next.agentLabel)
        throw new Error("proposal: decision cannot change immutable record fields; request a new preview");
      if (!checkStoredBinding(root, current.vault, binding, denyPaths)) throw new Error("proposal: vault binding is missing; inspect the proposal store");
      const path = capturePublicationPath(root, file), temporary = join(dir, `.proposal-${randomUUID()}.tmp`);
      requireAllowed(denyPaths, temporary);
      const tempFd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(tempFd, bytes); fsyncSync(tempFd);
        const named = lstatSync(file), held = fstatSync(sourceFd); validRecordFile(named); validRecordFile(held);
        if (before.dev !== held.dev || before.ino !== held.ino || before.size !== held.size || before.mtimeMs !== held.mtimeMs || before.ctimeMs !== held.ctimeMs || named.dev !== held.dev || named.ino !== held.ino)
          throw new Error("proposal: record changed during decision; request a new preview");
        publishFile(path, { kind: "rename", temp: temporary }, () => { published = true; });
        syncDirectory(dir);
      } catch (error) {
        if (published) throw new Error("proposal: record update was published but durability or path verification failed; inspect the proposal store before retrying", { cause: error });
        throw error;
      } finally {
        try { if (!published) cleanupOwnedFile(temporary, tempFd); } finally { closeSync(tempFd); }
      }
    } finally { closeSync(sourceFd); }
  }, denyPaths, registryFd); } catch (error) {
    if (published) throw new Error("proposal: record update was published but finalization failed; inspect the proposal store before retrying", { cause: error });
    throw error;
  }
}
