/** Internal bounded proposal record storage. Public lifecycle operations are not yet available. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, writeFileSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { syncDirectory } from "./registry.ts";
import { capturePublicationPath, cleanupOwnedFile, publishFile } from "./write-files.ts";
import { decodeProposalRecord, encodeProposalRecord, MAX_PROPOSAL_RECORD_BYTES, proposalRecordDigest, type ProposalRecord } from "./proposals.ts";

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BINDINGS = 256, MAX_BINDING_BYTES = 4096;
function validateDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid()))
    throw new Error("proposal: store directory is linked or not private; inspect the configured home");
}
/** The binding is derived internally by the caller, never accepted from a CLI or MCP request. */
function directory(home: string, binding: string, create: boolean): string {
  if (!DIGEST.test(binding)) throw new Error("proposal: invalid internal vault binding; inspect the registered vault");
  const root = resolve(home);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error("proposal: configured home is linked or unavailable; inspect the configured home");
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
function recordFile(home: string, binding: string, id: string, create: boolean): { root: string; file: string } {
  if (!ID.test(id)) throw new Error("proposal: invalid proposal id; use an id from proposal list");
  const root = resolve(home), dir = directory(root, binding, create);
  return { root, file: join(dir, `${id}.json`) };
}
function validRecordFile(info: Stats): void {
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid()))
    throw new Error("proposal: record is linked or not private; inspect the proposal store");
  if (info.size > MAX_PROPOSAL_RECORD_BYTES) throw new Error("proposal: stored record exceeds 32 KiB; inspect the proposal store");
}
/** Binding metadata contains no note or proposal body. Each read is bounded before allocation. */
function readBinding(home: string, binding: string): { vault: string; bindingDigest: string } {
  const root = resolve(home), dir = directory(root, binding, false), file = join(dir, "binding.json"), captured = capturePublicationPath(root, file);
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
export function checkStoredBinding(home: string, vault: string, expected: string): boolean {
  if (!DIGEST.test(expected) || !/^[a-z][a-z0-9-]{0,63}$/.test(vault)) throw new Error("proposal: invalid internal vault binding; inspect the registered vault");
  const root = resolve(home), base = join(root, "proposals");
  if (realpathSync(root) !== root) throw new Error("proposal: configured home is linked; inspect the configured home");
  try { validateDirectory(base); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  const parent = capturePublicationPath(root, join(base, ".scan")), dir = opendirSync(base); let count = 0, found = false;
  try {
    let entry;
    while ((entry = dir.readSync()) !== null) {
      if (entry.name === ".binding.lock") { validRecordFile(lstatSync(join(base, entry.name))); continue; }
      if (++count > MAX_BINDINGS) throw new Error("proposal: too many vault bindings to inspect; inspect the proposal store");
      if (!DIGEST.test(entry.name)) throw new Error("proposal: unexpected entry in proposal store; inspect the proposal store");
      const binding = readBinding(root, entry.name);
      if (binding.vault === vault && binding.bindingDigest !== expected) throw new Error("proposal: vault id was registered with a different root; inspect the registered vault and existing proposals");
      if (binding.vault === vault && binding.bindingDigest === expected) found = true;
    }
  } finally { dir.closeSync(); }
  if (JSON.stringify(parent.parents) !== JSON.stringify(capturePublicationPath(root, join(base, ".scan")).parents)) throw new Error("proposal: store path changed during binding lookup; inspect the configured home");
  return found;
}

function publishNew(root: string, dir: string, file: string, bytes: Uint8Array): void {
  const captured = capturePublicationPath(root, file), temporary = join(dir, `.proposal-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes); fsyncSync(fd);
    publishFile(captured, { kind: "link", temp: temporary }, () => {});
    syncDirectory(dir);
  } finally { try { cleanupOwnedFile(temporary, fd); } finally { closeSync(fd); } }
}
/** Reads at most 32 KiB and rejects a rebound filename or changed descriptor. */
export function readStoredProposal(home: string, binding: string, id: string): ProposalRecord {
  const { root, file } = recordFile(home, binding, id, false), captured = capturePublicationPath(root, file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
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
export function listStoredProposalIds(home: string, binding: string): string[] {
  const root = resolve(home), dir = directory(root, binding, false), target = join(dir, ".scan"), captured = capturePublicationPath(root, target);
  const fd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW), before = fstatSync(fd);
  let entries;
  try { entries = opendirSync(dir); } catch (error) { closeSync(fd); throw error; }
  const ids: string[] = [];
  try {
    let item, count = 0;
    while ((item = entries.readSync()) !== null) {
      if (++count > 10001) throw new Error("proposal: store exceeds the listing bound; inspect the proposal store");
      if (item.name === "binding.json") continue;
      const id = item.name.endsWith(".json") ? item.name.slice(0, -5) : "";
      if (!ID.test(id)) throw new Error("proposal: unexpected entry in proposal store; inspect the proposal store");
      ids.push(id);
    }
    const after = fstatSync(fd), named = lstatSync(dir), parents = capturePublicationPath(root, target);
    validateDirectory(dir);
    if (!named.isDirectory() || named.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || after.dev !== named.dev || after.ino !== named.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || JSON.stringify(captured.parents) !== JSON.stringify(parents.parents))
      throw new Error("proposal: store changed during listing; retry after concurrent writes stop");
  } finally { try { entries.closeSync(); } finally { closeSync(fd); } }
  return ids.sort();
}
/** Serializes store updates and keeps the descriptor for the lock throughout cleanup. */
function withStoreLock<T>(home: string, create: boolean, work: (root: string) => T): T {
  const root = resolve(home), base = join(root, "proposals");
  if (realpathSync(root) !== root) throw new Error("proposal: configured home is linked; inspect the configured home");
  if (create) {
    let made = false;
    try { mkdirSync(base, { mode: 0o700 }); made = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (made) syncDirectory(root);
  }
  validateDirectory(base);
  const lock = join(base, ".binding.lock");
  let fd: number;
  try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("proposal: binding store is locked; stop concurrent submissions and inspect the proposal store");
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, token: randomUUID() })); fsyncSync(fd); syncDirectory(base);
    return work(root);
  } finally {
    try { cleanupOwnedFile(lock, fd); syncDirectory(base); } finally { closeSync(fd); }
  }
}
/** Publishes a new record atomically without overwriting any existing proposal. */
export function createStoredProposal(home: string, record: ProposalRecord): void {
  const bytes = encodeProposalRecord(record);
  withStoreLock(home, true, root => {
    const found = checkStoredBinding(root, record.vault, record.bindingDigest);
    const { file } = recordFile(root, record.bindingDigest, record.id, true), dir = directory(root, record.bindingDigest, false);
    if (!found) publishNew(root, dir, join(dir, "binding.json"), Buffer.from(JSON.stringify({ schemaVersion: 1, vault: record.vault, bindingDigest: record.bindingDigest }), "utf8"));
    publishNew(root, dir, file, bytes);
  });
}

/** Compare-and-replace a record while retaining the proposal payload and vault identity. */
export function replaceStoredProposal(home: string, binding: string, id: string, expectedDigest: string, next: ProposalRecord): void {
  if (!DIGEST.test(expectedDigest)) throw new Error("proposal: invalid record fingerprint; request a new preview");
  const bytes = encodeProposalRecord(next);
  let published = false;
  try { withStoreLock(home, false, root => {
    const { file } = recordFile(root, binding, id, false), dir = directory(root, binding, false);
    const sourceFd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(sourceFd); validRecordFile(before);
      const current = readStoredProposal(root, binding, id);
      if (proposalRecordDigest(current) !== expectedDigest) throw new Error("proposal: record changed since preview; request a new preview");
      if (current.id !== next.id || current.vault !== next.vault || current.bindingDigest !== next.bindingDigest || current.createdAt !== next.createdAt || current.payloadDigest !== next.payloadDigest || current.agentLabel !== next.agentLabel)
        throw new Error("proposal: decision cannot change immutable record fields; request a new preview");
      if (!checkStoredBinding(root, current.vault, binding)) throw new Error("proposal: vault binding is missing; inspect the proposal store");
      const path = capturePublicationPath(root, file), temporary = join(dir, `.proposal-${randomUUID()}.tmp`);
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
  }); } catch (error) {
    if (published) throw new Error("proposal: record update was published but finalization failed; inspect the proposal store before retrying", { cause: error });
    throw error;
  }
}
