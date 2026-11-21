/** Bounded, vault-bound local enrichment storage. No model is called here. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDenied } from "./platform.ts";
import { loadRegistry, LOCK_FILE, syncDirectory } from "./registry.ts";
import { MUTATION_LOCK } from "./writer.ts";
import { logBinding, matchesBinding } from "./vault-log.ts";
import { capturePublicationPath, cleanupOwnedFile, publishFile } from "./write-files.ts";
import type { VaultSpec } from "./config.ts";

export const MAX_ENRICHMENT_STORE_BYTES = 128 * 1024 * 1024;
export const MAX_ENRICHMENT_RECORDS = 50000;
export const MAX_EMBEDDING_DIMENSION = 4096;
export type EnrichmentKind = "embedding" | "summary" | "community-label" | "inferred-link" | "fact";
export interface EnrichmentProducer { skill: string; version: string; model: string }
export interface EnrichmentRecord { path: string; contentHash: string; kind: EnrichmentKind; producer: EnrichmentProducer; createdAt: string; value: unknown }
export interface EnrichmentStore { schemaVersion: 1; binding: string; model?: string; dimension?: number; records: EnrichmentRecord[] }
function fail(message: string): never { throw new Error(`enrichment: ${message}`); }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const within = (root: string, target: string) => { const r = relative(root, target); return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)); };
const digest = /^[a-f0-9]{64}$/;
const kinds = new Set(["embedding", "summary", "community-label", "inferred-link", "fact"]);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const text = (v: unknown, maximum: number) => typeof v === "string" && !!v.trim() && Buffer.byteLength(v) <= maximum && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(v);
function validVector(value: unknown, dimension: number): value is number[] {
  return Array.isArray(value) && value.length === dimension && value.every(n => typeof n === "number" && Number.isFinite(n)) && value.some(n => n !== 0);
}
/** Float32 encoding keeps a 1536-dimensional vector to exactly 8192 base64 bytes. */
function encodeVector(value: unknown, dimension: number): { encoding: "float32le"; data: string } {
  if (!validVector(value, dimension)) fail("embedding vector is invalid; supply finite nonzero values within the dimension limit");
  const bytes = Buffer.alloc(dimension * 4); let nonzero = false;
  for (let i = 0; i < dimension; i++) {
    const rounded = Math.fround(value[i]!);
    if (!Number.isFinite(rounded)) fail("embedding value overflows Float32; use finite Float32-range values");
    if (rounded !== 0) nonzero = true;
    bytes.writeFloatLE(rounded, i * 4);
  }
  if (!nonzero) fail("embedding becomes zero in Float32; provide a nonzero representable vector");
  return { encoding: "float32le", data: bytes.toString("base64") };
}
function decodeVector(value: unknown, dimension: number): number[] {
  if (Array.isArray(value)) { encodeVector(value, dimension); return value; } // unpublished v1 data
  if (!object(value) || Object.keys(value).sort().join(",") !== "data,encoding" || value.encoding !== "float32le" || typeof value.data !== "string" || value.data.length !== Math.ceil(dimension * 4 / 3) * 4) fail("sidecar vector encoding is invalid; inspect the local enrichment store");
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.length !== dimension * 4 || bytes.toString("base64") !== value.data) fail("sidecar vector encoding is invalid; inspect the local enrichment store");
  const vector = Array.from({ length: dimension }, (_, i) => bytes.readFloatLE(i * 4));
  if (!validVector(vector, dimension)) fail("sidecar vector is invalid; inspect the local enrichment store");
  return vector;
}
function parseStore(value: unknown, binding: string): EnrichmentStore {
  if (!object(value) || Object.keys(value).some(k => !["schemaVersion", "binding", "model", "dimension", "records"].includes(k)) || value.schemaVersion !== 1 || value.binding !== binding || !Array.isArray(value.records) || value.records.length > MAX_ENRICHMENT_RECORDS) fail("sidecar metadata is invalid or bound to another vault; inspect the local enrichment store");
  if ((value.model === undefined) !== (value.dimension === undefined) || (value.model !== undefined && (!text(value.model, 256) || !Number.isSafeInteger(value.dimension) || (value.dimension as number) < 1 || (value.dimension as number) > MAX_EMBEDDING_DIMENSION))) fail("sidecar model metadata is invalid; inspect the local enrichment store");
  const seen = new Set<string>();
  for (const item of value.records) {
    if (!object(item) || Object.keys(item).some(k => !["path", "contentHash", "kind", "producer", "createdAt", "value"].includes(k)) || typeof item.path !== "string" || !/^notes\/(?!\.)[^/\\\p{Cc}]+\.md$/u.test(item.path) || Buffer.byteLength(item.path) > 1024 || typeof item.contentHash !== "string" || !digest.test(item.contentHash) || typeof item.kind !== "string" || !kinds.has(item.kind) || !object(item.producer) || Object.keys(item.producer).sort().join(",") !== "model,skill,version" || !text(item.producer.skill, 128) || !text(item.producer.version, 128) || !text(item.producer.model, 256) || typeof item.createdAt !== "string" || Number.isNaN(Date.parse(item.createdAt)) || new Date(item.createdAt).toISOString() !== item.createdAt || !("value" in item)) fail("sidecar record is invalid; inspect the local enrichment store");
    const key = JSON.stringify([item.path, item.kind, item.contentHash]);
    if (seen.has(key)) fail("sidecar contains duplicate records; inspect the local enrichment store");
    seen.add(key);
    if (item.kind === "embedding") {
      if (item.producer.model !== value.model || typeof value.dimension !== "number") fail("sidecar vector has a different model or dimension; inspect the local enrichment store");
      item.value = decodeVector(item.value, value.dimension);
    }
  }
  return value as unknown as EnrichmentStore;
}
function location(home: string, vault: VaultSpec, roots: VaultSpec[], denyPaths: string[], create: boolean) {
  const configured = resolve(home);
  if (isDenied(configured, denyPaths)) fail("home is denied; choose an allowed VMEM_HOME");
  let root: string;
  try { root = realpathSync(configured); } catch { return fail("home is unavailable; restore the configured VMEM_HOME and retry"); }
  let protectedRoots: string[];
  try { protectedRoots = roots.map(v => realpathSync(v.path)); } catch { return fail("a registered vault root is unavailable; restore it or unregister it before using enrichment"); }
  if (isDenied(root, denyPaths) || protectedRoots.some(path => within(path, root))) fail("home is denied or inside a vault; choose an allowed VMEM_HOME outside all vaults");
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(vault.path); } catch { return fail("vault root is unavailable; inspect the registry and restore the vault"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(vault.path) !== vault.path || isDenied(vault.path, denyPaths)) fail("vault root is linked, changed or denied; inspect the registry and policy");
  const binding = hash(JSON.stringify([vault.id, vault.path, stat.dev, stat.ino]));
  const dir = join(root, "enrichment"), file = join(dir, `${binding}.json`);
  if (isDenied(dir, denyPaths) || isDenied(file, denyPaths)) fail("sidecar is denied; inspect configured deny paths");
  if (create) {
    try { mkdirSync(dir, { mode: 0o700 }); syncDirectory(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  try {
    const d = lstatSync(dir);
    if (!d.isDirectory() || d.isSymbolicLink() || (d.mode & 0o077) !== 0 || (typeof process.getuid === "function" && d.uid !== process.getuid())) fail("sidecar directory is linked or not private; inspect VMEM_HOME/enrichment");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || create) throw error; }
  return { root, dir, file, binding };
}
function readFile(loc: ReturnType<typeof location>): EnrichmentStore {
  const empty: EnrichmentStore = { schemaVersion: 1, binding: loc.binding, records: [] };
  let fd: number;
  try { fd = openSync(loc.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty; throw new Error("enrichment: sidecar cannot be read; inspect VMEM_HOME/enrichment", { cause: error }); }
  try {
    const captured = capturePublicationPath(loc.root, loc.file);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (typeof process.getuid === "function" && before.uid !== process.getuid()) || before.size > MAX_ENRICHMENT_STORE_BYTES) fail("sidecar is linked, not private or exceeds its byte limit; inspect the local enrichment store");
    const bytes = Buffer.alloc(before.size + 1); let count = 0;
    while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
    const after = fstatSync(fd), named = lstatSync(loc.file);
    if (count !== before.size || after.size !== before.size || before.ino !== after.ino || before.dev !== after.dev || after.ino !== named.ino || after.dev !== named.dev || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || JSON.stringify(captured.parents) !== JSON.stringify(capturePublicationPath(loc.root, loc.file).parents)) fail("sidecar changed during read; stop concurrent edits and retry");
    const raw = bytes.subarray(0, count), content = raw.toString("utf8");
    if (!Buffer.from(content).equals(raw)) fail("sidecar is not UTF-8; inspect the local enrichment store");
    let parsed: unknown; try { parsed = JSON.parse(content); } catch { return fail("sidecar is not valid JSON; inspect the local enrichment store"); }
    return parseStore(parsed, loc.binding);
  } finally { closeSync(fd); }
}
export function readEnrichmentStore(home: string, vault: VaultSpec, roots: VaultSpec[], denyPaths: string[]): EnrichmentStore {
  return readFile(location(home, vault, roots, denyPaths, false));
}
/** Validate complete metadata and vector shape before any side effects. */
export function validateEnrichmentRecord(record: EnrichmentRecord): void {
  if (!record || typeof record !== "object") fail("intake record is missing; supply a complete result");
  const provisional: EnrichmentStore = { schemaVersion: 1, binding: "0".repeat(64), records: [record] };
  if (record.kind === "embedding") {
    if (!object(record.producer) || !Array.isArray(record.value) || !validVector(record.value, record.value.length) || record.value.length < 1 || record.value.length > MAX_EMBEDDING_DIMENSION) fail("embedding is invalid; supply a producer and a finite nonzero vector");
    encodeVector(record.value, record.value.length);
    provisional.model = record.producer.model; provisional.dimension = record.value.length;
  }
  parseStore(provisional, provisional.binding);
}
/** Serialize under the registry lock; callers must recheck the note hash before returning their receipt. */
export function writeEnrichmentRecord(home: string, vault: VaultSpec, record: EnrichmentRecord, validateCurrent: () => void, validateStore: (store: EnrichmentStore) => void = () => {}, heldMutation?: number): { applied: true; issues: string[] } {
  validateEnrichmentRecord(record);
  const config = loadRegistry(home), currentVault = config.vaults.find(v => v.id === vault.id);
  if (!currentVault || JSON.stringify(currentVault) !== JSON.stringify(vault)) fail("vault registration changed; reload settings and retry");
  if (!vault.enrichment?.enabled) fail("enrichment is disabled for this vault; enable it in settings first");
  location(home, vault, config.vaults, config.denyPaths ?? [], false);
  const binding = logBinding(vault, config), lock = join(resolve(home), LOCK_FILE);
  if (isDenied(lock, config.denyPaths ?? [])) fail("registry lock is denied; inspect configured deny paths");
  const mutation = join(vault.path, MUTATION_LOCK);
  if (isDenied(mutation, config.denyPaths ?? [])) fail("vault mutation lock is denied; inspect configured deny paths");
  let mutationFd: number;
  if (heldMutation !== undefined) mutationFd = heldMutation;
  else {
    try { mutationFd = openSync(mutation, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { throw new Error("enrichment: vault mutation lock is unavailable; stop concurrent writers and inspect the lock", { cause: error }); }
  }
  const verifyMutation = () => {
    const held = fstatSync(mutationFd), named = lstatSync(mutation);
    if (!held.isFile() || named.isSymbolicLink() || held.dev !== named.dev || held.ino !== named.ino) fail("vault mutation lock ownership changed; inspect the lock before retrying");
  };
  let fd: number | undefined, published = false, failure: unknown;
  const issues: string[] = [];
  try {
    if (heldMutation === undefined) { writeFileSync(mutationFd, JSON.stringify({ pid: process.pid, host: hostname(), created: new Date().toISOString() }) + "\n"); fsyncSync(mutationFd); }
    verifyMutation();
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { throw new Error("enrichment: registry lock is unavailable; stop concurrent writers and inspect the lock", { cause: error }); }
    writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), created: new Date().toISOString() }) + "\n"); fsyncSync(fd);
    const current = loadRegistry(home);
    if (!matchesBinding(current, vault.id, binding)) fail("vault binding or policy changed; reload settings and retry");
    validateCurrent();
    const loc = location(home, vault, current.vaults, current.denyPaths ?? [], true), store = readFile(loc);
    validateStore(store);
    if (record.kind === "embedding") {
      if (!Array.isArray(record.value) || record.value.length < 1 || record.value.length > MAX_EMBEDDING_DIMENSION || !validVector(record.value, record.value.length)) fail("embedding vector is invalid; supply finite nonzero values within the dimension limit");
      if (store.model !== undefined && (store.model !== record.producer.model || store.dimension !== record.value.length)) fail("embedding model or dimension differs from this vault's sidecar; use the recorded model and dimension");
      store.model = record.producer.model; store.dimension = record.value.length;
    }
    const replaceLatest = ["embedding", "summary", "community-label"].includes(record.kind);
    store.records = store.records.filter(r => r.path !== record.path || r.kind !== record.kind || (!replaceLatest && r.contentHash !== record.contentHash));
    store.records.push(record);
    parseStore(store, loc.binding);
    const persisted = { ...store, records: store.records.map(r => r.kind === "embedding" ? { ...r, value: encodeVector(r.value, store.dimension!) } : r) };
    const bytes = Buffer.from(JSON.stringify(persisted));
    if (bytes.length > MAX_ENRICHMENT_STORE_BYTES) fail("sidecar exceeds the aggregate byte limit; reduce stored records before retrying");
    validateCurrent(); verifyMutation();
    const captured = capturePublicationPath(loc.root, loc.file), temp = join(loc.dir, `.enrichment-${randomUUID()}.tmp`);
    if (isDenied(temp, current.denyPaths ?? [])) fail("temporary sidecar is denied; inspect configured deny paths");
    const out = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(out, bytes); fsyncSync(out); publishFile(captured, { kind: "rename", temp }, () => { published = true; }); syncDirectory(loc.dir); }
    finally { try { cleanupOwnedFile(temp, out); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } finally { closeSync(out); } }
    try { validateCurrent(); } catch { issues.push("source changed after the sidecar was published; inspect the note and regenerate the result"); }
    if (!matchesBinding(loadRegistry(home), vault.id, binding)) issues.push("vault binding or policy changed after publication; inspect the registry and sidecar before retrying");
  } catch (error) { failure = error; }
  finally {
    if (fd !== undefined) {
      try { cleanupOwnedFile(lock, fd); } catch { issues.push("registry lock cleanup failed; inspect the lock before retrying"); }
      try { closeSync(fd); } catch { issues.push("registry lock close failed; inspect the lock before retrying"); }
    }
    if (heldMutation === undefined) {
      try { cleanupOwnedFile(mutation, mutationFd); } catch { issues.push("vault mutation lock cleanup failed; inspect the lock before retrying"); }
      try { closeSync(mutationFd); } catch { issues.push("vault mutation lock close failed; inspect the lock before retrying"); }
    }
  }
  if (!published && failure) {
    if (issues.length) throw new Error(`enrichment: sidecar was not published; ${issues.join("; ")}`, { cause: failure });
    throw failure;
  }
  if (!published) fail("sidecar was not published; inspect the local store before retrying");
  if (failure) issues.push("sidecar was published but finalization failed; inspect the local store before retrying");
  return { applied: true, issues };
}
