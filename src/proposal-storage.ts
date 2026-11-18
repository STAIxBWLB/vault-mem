/** Internal bounded proposal record storage. Public lifecycle operations are not yet available. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { syncDirectory } from "./registry.ts";
import { capturePublicationPath, cleanupOwnedFile, publishFile } from "./write-files.ts";
import { decodeProposalRecord, encodeProposalRecord, MAX_PROPOSAL_RECORD_BYTES, type ProposalRecord } from "./proposals.ts";

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
/** Publishes a new record atomically without overwriting any existing proposal. */
export function createStoredProposal(home: string, record: ProposalRecord): void {
  const bytes = encodeProposalRecord(record), { root, file } = recordFile(home, record.bindingDigest, record.id, true);
  const captured = capturePublicationPath(root, file), temporary = join(directory(root, record.bindingDigest, false), `.proposal-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes); fsyncSync(fd);
    publishFile(captured, { kind: "link", temp: temporary }, () => {});
    syncDirectory(directory(root, record.bindingDigest, false));
  } finally {
    try { cleanupOwnedFile(temporary, fd); } finally { closeSync(fd); }
  }
}
