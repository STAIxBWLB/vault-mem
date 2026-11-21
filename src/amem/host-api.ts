import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Read the version of the package containing the resolved entry, not the host's declared range. */
export function installedAmemVersion(entry: string): string {
  let dir = dirname(entry);
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (manifest.name === "@staix/agent-mem" && typeof manifest.version === "string") return manifest.version;
    } catch { /* Continue to the package root. */ }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("agent-mem: cannot determine installed version; reinstall @staix/agent-mem");
    dir = parent;
  }
}
export const amemVersion = () => installedAmemVersion(createRequire(import.meta.url).resolve("@staix/agent-mem/platform"));
export function checkHostApi(api: { HOST_API_MIN?: unknown; HOST_API_VERSION?: unknown }, version: string): void {
  const min = api.HOST_API_MIN, max = api.HOST_API_VERSION;
  if (Number.isSafeInteger(min) && Number.isSafeInteger(max) && (min as number) >= 1 && (min as number) <= 1 && (max as number) >= 1) return;
  throw new Error(`agent-mem ${version}: host API ${String(min ?? "missing")}..${String(max ?? "missing")} is incompatible with vmem host API 1; update @staix/agent-mem or @staix/vault-mem to compatible versions`);
}
