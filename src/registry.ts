import { closeSync, constants, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG_FILE, MAX_CONFIG_BYTES, parseConfig, parseVault, readConfig, type VaultSpec, type VmemConfig } from "./config.ts";
export function loadRegistry(home: string): VmemConfig {
  const config = readConfig(home);
  if (config.home) throw new Error("config: redirected home cannot contain another home pointer");
  return config;
}
function mutate<T>(home: string, update: (config: VmemConfig) => T): T {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, "config.lock");
  const lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let temporary: string | undefined;
  let failed = false;
  try {
    const config = loadRegistry(home), result = update(config);
    parseConfig(config);
    const text = JSON.stringify(config, null, 2) + "\n";
    if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error("config: serialized config exceeds 64 KiB");
    const candidate = join(home, `.config-${randomUUID()}.tmp`);
    const fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    temporary = candidate;
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, join(home, CONFIG_FILE));
    temporary = undefined;
    return result;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Each cleanup is independent: a temp cleanup error must not strand our lock.
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      () => { if (temporary) unlinkSync(temporary); },
      () => closeSync(lockFd),
      () => unlinkSync(lock),
    ]) {
      try { cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
    if (!failed && cleanupErrors.length) throw cleanupErrors[0];
  }
}
export function addVault(home: string, value: unknown): VaultSpec {
  const vault = parseVault(value);
  vault.path = realpathSync(vault.path);
  if (!statSync(join(vault.path, "notes")).isDirectory()) throw new Error("vault.path: must contain notes directory");
  const notes = realpathSync(join(vault.path, "notes"));
  if (notes !== join(vault.path, "notes")) throw new Error("vault.path: notes must not be a symlink");
  return mutate(home, config => {
    if (config.vaults.some(v => v.id === vault.id)) throw new Error("vault.id: already registered");
    if (config.vaults.some(v => {
      if (v.path === vault.path) return true;
      try { return realpathSync(v.path) === vault.path; }
      catch (error) {
        if (["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
        throw error;
      }
    })) throw new Error("vault.path: already registered");
    config.vaults.push(vault);
    return vault;
  });
}
export function removeVault(home: string, id: string, confirm = false): { applied: boolean; vault: VaultSpec } {
  const remove = (config: VmemConfig) => {
    const vault = config.vaults.find(v => v.id === id);
    if (!vault) throw new Error(`vault: unknown id ${id}`);
    if (confirm) config.vaults = config.vaults.filter(v => v.id !== id);
    return { applied: confirm, vault };
  };
  return confirm ? mutate(home, remove) : remove(loadRegistry(home));
}
export function registryStatus(home: string) {
  const config = loadRegistry(home);
  return config.vaults.map(vault => {
    try {
      const root = realpathSync(vault.path), notes = join(root, "notes");
      if (root !== vault.path || realpathSync(notes) !== notes || !statSync(notes).isDirectory()) throw new Error("vault path or notes directory changed");
      return { ...vault, healthy: true, pii: vault.pii ?? (vault.kind === "org" ? "deny" : "allow") };
    } catch { return { ...vault, healthy: false, issue: "vault path or notes directory unavailable or changed" }; }
  });
}
