import { mock } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
// Re-register the logged vault id to <rebound>/<id> right before each log append, after the note mutation committed.
const [home, mode, rebound] = process.argv.slice(2);
if (!home || !mode || !rebound) throw new Error("rebind arguments required");
const real = await import("../../src/vault-log.ts"), realAppend = real.appendLog;
mock.module("../../src/vault-log.ts", () => ({ ...real, appendLog: (...args: Parameters<typeof realAppend>) => {
  const file = `${home}/vmem.config.json`, config = JSON.parse(readFileSync(file, "utf8"));
  config.vaults.find((v: { id: string }) => v.id === args[1].vault).path = `${rebound}/${args[1].vault}`; writeFileSync(file, JSON.stringify(config));
  return realAppend(...args);
} }));
const env = { VMEM_HOME: home };
if (mode === "tidy") {
  const { tidyVault } = await import("../../src/tidy.ts");
  const preview = tidyVault(home, { vault: "mine", rules: ["topics"] }, { env });
  console.log(JSON.stringify(tidyVault(home, { vault: "mine", rules: ["topics"], confirm: true, fingerprint: preview.fingerprint }, { env })));
} else {
  const { promoteToOrg } = await import("../../src/org-promote.ts");
  const preview = promoteToOrg(home, { from: "personal", note: "shared-method", to: "team" }, { env });
  console.log(JSON.stringify(promoteToOrg(home, { from: "personal", note: "shared-method", to: "team", confirm: true, fingerprint: preview.fingerprint }, { env })));
}
