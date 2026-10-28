import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const CONFIG_FILE = "vmem.config.json";
export const MAX_CONFIG_BYTES = 64 * 1024;
export interface VaultSpec {
  id: string;
  path: string;
  kind: "personal" | "org";
  write: "mcp" | "cli" | "none";
  pii?: "allow" | "deny";
  remote?: string;
  registry?: string;
}
export interface VmemConfig { home?: string; vaults: VaultSpec[]; denyPaths?: string[]; piiPatterns?: string[] }
const controls = /[\x00-\x1f\x7f]/;
function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.includes(key)) throw new Error(`${label}: unknown key ${key}`);
  return record;
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
export function parseVault(value: unknown): VaultSpec {
  const v = object(value, ["id", "path", "kind", "write", "pii", "remote", "registry"], "vault");
  const id = string(v.id, "vault.id");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error("vault.id: invalid id");
  if (v.kind !== "personal" && v.kind !== "org") throw new Error("vault.kind: expected personal or org");
  if (v.write !== "mcp" && v.write !== "cli" && v.write !== "none") throw new Error("vault.write: expected mcp, cli or none");
  const result: VaultSpec = { id, path: absolute(v.path, "vault.path"), kind: v.kind, write: v.write };
  if (v.pii !== undefined) {
    if (v.pii !== "allow" && v.pii !== "deny") throw new Error("vault.pii: expected allow or deny");
    result.pii = v.pii;
  }
  if (v.remote !== undefined) result.remote = string(v.remote, "vault.remote");
  if (v.registry !== undefined) result.registry = absolute(v.registry, "vault.registry");
  return result;
}
export function parseConfig(value: unknown): VmemConfig {
  const raw = object(value, ["home", "vaults", "denyPaths", "piiPatterns"], "config");
  if (raw.home !== undefined) {
    if (Object.keys(raw).length !== 1) throw new Error("config: home pointer must not contain vaults or policy");
    return { home: absolute(raw.home, "config.home"), vaults: [] };
  }
  if (!Array.isArray(raw.vaults)) throw new Error("config.vaults: expected array");
  const vaults = raw.vaults.map(parseVault);
  if (new Set(vaults.map(v => v.id)).size !== vaults.length) throw new Error("config: duplicate vault id");
  if (new Set(vaults.map(v => v.path)).size !== vaults.length) throw new Error("config: duplicate vault path");
  const denyPaths = strings(raw.denyPaths, "denyPaths"), piiPatterns = strings(raw.piiPatterns, "piiPatterns");
  for (const pattern of piiPatterns ?? []) {
    try { new RegExp(pattern); } catch { throw new Error("piiPatterns: invalid regular expression"); }
  }
  return { vaults, ...(denyPaths ? { denyPaths } : {}), ...(piiPatterns ? { piiPatterns } : {}) };
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
    return parseConfig(JSON.parse(buffer.subarray(0, size).toString("utf8")));
  } finally { closeSync(fd); }
}
