export { resolveHome } from "./home.ts";
export { parseConfig, parseVault, readConfig, CONFIG_FILE, MAX_CONFIG_BYTES } from "./config.ts";
export type { VaultSpec, VmemConfig } from "./config.ts";
export { addVault, removeVault, loadRegistry, registryStatus, recoverRegistry, effectivePii, syncDirectory, LOCK_FILE } from "./registry.ts";
export type { RecoveryReport, LockOwner } from "./registry.ts";
