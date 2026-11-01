import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const CONFIG_FILE = "vmem.config.json";
export const MAX_CONFIG_BYTES = 64 * 1024;
export interface VaultSpec {
  id: string;
  path: string;
  kind: "personal" | "org";
  write: "mcp" | "cli" | "none";
  pii?: "allow" | "deny" | PiiSpec;
  remote?: string;
  registry?: string;
}
export type PiiAction = "allow" | "warn" | "deny";
export const PII_SURFACES = ["notes", "log", "promotion"] as const;
export type PiiSurface = typeof PII_SURFACES[number];
export type PiiCell = PiiAction | Partial<Record<PiiSurface, PiiAction>>;
export interface PiiPattern { name: string; regex: string; action?: PiiCell }
/** Fine-grained PII policy: per category, optionally per surface; omitted cells take the vault default. */
export interface PiiSpec { email?: PiiCell; phone?: PiiCell; custom?: PiiCell; patterns?: PiiPattern[]; allow?: string[] }
/**
 * The config format this build writes. A build that adds a key bumps it. A config whose `version` is newer
 * than this build is read tolerantly: unknown keys are kept as they are and written back unchanged, so an
 * older vmem can share a config with a newer one. At or below this version unknown keys stay errors (typos).
 * An absent `version` means 1, and this build never adds one, so 0.2.4 and older keep reading what it writes.
 */
export const CONFIG_VERSION = 1;
export interface VmemConfig { version?: number; home?: string; vaults: VaultSpec[]; denyPaths?: string[]; piiPatterns?: string[] }
const controls = /[\x00-\x1f\x7f]/;
function object(value: unknown, keys: string[], label: string, tolerant = false): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected object`);
  const record = value as Record<string, unknown>;
  if (!tolerant) for (const key of Object.keys(record)) if (!keys.includes(key)) throw new Error(`${label}: unknown key ${key}`);
  return record;
}
/** The keys of `record` this build does not know, kept only when the config is newer than this build. */
function unknown(record: Record<string, unknown>, keys: string[], tolerant: boolean): Record<string, unknown> {
  return tolerant ? Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key))) : {};
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || controls.test(value)) throw new Error(`${label}: expected nonempty string without control characters`);
  return value;
}
export function absolute(value: unknown, label: string): string {
  const text = string(value, label);
  if (!isAbsolute(text)) throw new Error(`${label}: expected absolute path`);
  return text;
}
function strings(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${label}: expected at most 64 strings`);
  return value.map((item) => {
    const text = string(item, label);
    if (Buffer.byteLength(text) > 256) throw new Error(`${label}: item exceeds 256 bytes`);
    return text;
  });
}
const ACTIONS = new Set(["allow", "warn", "deny"]);
function cell(value: unknown, label: string, tolerant = false): PiiCell {
  if (typeof value === "string") {
    if (!ACTIONS.has(value)) throw new Error(`${label}: expected allow, warn or deny`);
    return value as PiiAction;
  }
  const record = object(value, [...PII_SURFACES], label, tolerant), result = unknown(record, [...PII_SURFACES], tolerant) as Partial<Record<PiiSurface, PiiAction>>;
  for (const surface of PII_SURFACES) if (record[surface] !== undefined) {
    if (typeof record[surface] !== "string" || !ACTIONS.has(record[surface] as string)) throw new Error(`${label}.${surface}: expected allow, warn or deny`);
    result[surface] = record[surface] as PiiAction;
  }
  return result;
}
/** Validate `vault.pii`: the `allow`/`deny` shorthand or a PiiSpec object. */
export function parsePii(value: unknown, tolerant = false): "allow" | "deny" | PiiSpec {
  if (value === "allow" || value === "deny") return value;
  if (typeof value === "string") throw new Error("vault.pii: expected allow, deny or a policy object");
  const keys = ["email", "phone", "custom", "patterns", "allow"], raw = object(value, keys, "vault.pii", tolerant), spec: PiiSpec = unknown(raw, keys, tolerant);
  for (const key of ["email", "phone", "custom"] as const) if (raw[key] !== undefined) spec[key] = cell(raw[key], `vault.pii.${key}`, tolerant);
  if (raw.patterns !== undefined) {
    if (!Array.isArray(raw.patterns) || raw.patterns.length > 32) throw new Error("vault.pii.patterns: expected at most 32 patterns");
    const names = new Set<string>();
    spec.patterns = raw.patterns.map((item, index) => {
      const p = object(item, ["name", "regex", "action"], `vault.pii.patterns[${index}]`, tolerant);
      const name = string(p.name, "vault.pii.patterns.name"), regex = string(p.regex, "vault.pii.patterns.regex");
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || names.has(name)) throw new Error(`vault.pii.patterns: invalid or duplicate name ${name.slice(0, 40)}`);
      if (Buffer.byteLength(regex) > 256) throw new Error("vault.pii.patterns.regex: exceeds 256 bytes");
      try { new RegExp(regex, "u"); } catch { throw new Error(`vault.pii.patterns.${name}: invalid regular expression`); }
      names.add(name);
      return { ...unknown(p, ["name", "regex", "action"], tolerant), name, regex, ...(p.action !== undefined ? { action: cell(p.action, `vault.pii.patterns.${name}.action`, tolerant) } : {}) };
    });
  }
  if (raw.allow !== undefined) spec.allow = strings(raw.allow, "vault.pii.allow");
  return spec;
}
export function parseVault(value: unknown, tolerant = false): VaultSpec {
  const keys = ["id", "path", "kind", "write", "pii", "remote", "registry"], v = object(value, keys, "vault", tolerant);
  const id = string(v.id, "vault.id");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error("vault.id: invalid id");
  if (v.kind !== "personal" && v.kind !== "org") throw new Error("vault.kind: expected personal or org");
  if (v.write !== "mcp" && v.write !== "cli" && v.write !== "none") throw new Error("vault.write: expected mcp, cli or none");
  const result: VaultSpec = { ...unknown(v, keys, tolerant), id, path: absolute(v.path, "vault.path"), kind: v.kind, write: v.write };
  if (v.pii !== undefined) result.pii = parsePii(v.pii, tolerant);
  if (v.remote !== undefined) result.remote = string(v.remote, "vault.remote");
  if (v.registry !== undefined) result.registry = absolute(v.registry, "vault.registry");
  return result;
}
export function parseConfig(value: unknown): VmemConfig {
  const keys = ["version", "home", "vaults", "denyPaths", "piiPatterns"];
  const version = (value as Record<string, unknown> | null)?.version;
  if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 1)) throw new Error("config.version: expected a positive integer");
  const tolerant = version !== undefined && (version as number) > CONFIG_VERSION, raw = object(value, keys, "config", tolerant);
  const stamp = version === undefined ? {} : { version: version as number };
  if (raw.home !== undefined) {
    if (["vaults", "denyPaths", "piiPatterns"].some(key => raw[key] !== undefined)) throw new Error("config: home pointer must not contain vaults or policy");
    return { ...unknown(raw, keys, tolerant), ...stamp, home: absolute(raw.home, "config.home"), vaults: [] };
  }
  if (!Array.isArray(raw.vaults)) throw new Error("config.vaults: expected array");
  const vaults = raw.vaults.map(item => parseVault(item, tolerant));
  if (new Set(vaults.map(v => v.id)).size !== vaults.length) throw new Error("config: duplicate vault id");
  if (new Set(vaults.map(v => v.path)).size !== vaults.length) throw new Error("config: duplicate vault path");
  const denyPaths = strings(raw.denyPaths, "denyPaths"), piiPatterns = strings(raw.piiPatterns, "piiPatterns");
  for (const pattern of piiPatterns ?? []) {
    try { new RegExp(pattern); } catch { throw new Error("piiPatterns: invalid regular expression"); }
  }
  return { ...unknown(raw, keys, tolerant), ...stamp, vaults, ...(denyPaths ? { denyPaths } : {}), ...(piiPatterns ? { piiPatterns } : {}) };
}
/** Bounded descriptor read: reject links, devices and oversized/growing files. */
export function readConfig(home: string): VmemConfig {
  const file = join(home, CONFIG_FILE);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { vaults: [] };
    throw new Error(`${file}: cannot read plain config file`, { cause: error });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error(`${file}: expected plain file <= ${MAX_CONFIG_BYTES} bytes`);
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > MAX_CONFIG_BYTES) throw new Error(`${file}: config too large`);
    let parsed: unknown;
    // Do not echo parser messages: they can quote config content.
    try { parsed = JSON.parse(buffer.subarray(0, size).toString("utf8")); }
    catch { throw new Error(`${file}: invalid JSON`); }
    try { return parseConfig(parsed); }
    catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : "invalid config"}`, { cause: error }); }
  } finally { closeSync(fd); }
}
