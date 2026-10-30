import { mock } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
// Re-register the logged vault id to <rebound>/<id> right before each log append, after the note mutation committed.
const [home, mode, rebound] = process.argv.slice(2);
if (!home || !mode || !rebound) throw new Error("rebind arguments required");
// Modes ending in "-write" re-register before the first real (non-dry-run) note write instead.
const rebind = (id: string) => {
  const file = `${home}/vmem.config.json`, config = JSON.parse(readFileSync(file, "utf8"));
  config.vaults.find((v: { id: string }) => v.id === id).path = `${rebound}/${id}`; writeFileSync(file, JSON.stringify(config));
};
if (mode.endsWith("-write")) {
  const real = await import("../../src/writer.ts"), realWrite = real.applyWrite; let done = false;
  mock.module("../../src/writer.ts", () => ({ ...real, applyWrite: (...args: Parameters<typeof realWrite>) => {
    if (!done && args[1].dryRun !== true && (args[1].confirm === true || !["move", "delete", "tidy"].includes(args[1].operation.op))) { done = true; rebind(args[1].vault); }
    return realWrite(...args);
  } }));
} else {
  const real = await import("../../src/vault-log.ts"), realAppend = real.appendLog;
  mock.module("../../src/vault-log.ts", () => ({ ...real, appendLog: (...args: Parameters<typeof realAppend>) => { rebind(args[1].vault); return realAppend(...args); } }));
}
const env = { VMEM_HOME: home };
if (mode.startsWith("tidy")) {
  const { tidyVault } = await import("../../src/tidy.ts");
  const preview = tidyVault(home, { vault: "mine", rules: ["topics"] }, { env });
  console.log(JSON.stringify(tidyVault(home, { vault: "mine", rules: ["topics"], confirm: true, fingerprint: preview.fingerprint }, { env })));
} else {
  const { promoteToOrg } = await import("../../src/org-promote.ts");
  const preview = promoteToOrg(home, { from: "personal", note: "shared-method", to: "team" }, { env });
  console.log(JSON.stringify(promoteToOrg(home, { from: "personal", note: "shared-method", to: "team", confirm: true, fingerprint: preview.fingerprint }, { env })));
}
