import { mock } from "bun:test";
import * as fs from "node:fs";
// Fail the first removal of one lock file, after the write it guarded has committed.
const [home, mode, lock] = process.argv.slice(2);
if (!home || !mode || !lock) throw new Error("commit-fault arguments required");
const original = { ...fs }; let injected = false;
mock.module("node:fs", () => ({ ...original,
  unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
    if (!injected && String(args[0]) === lock) { injected = true; throw new Error("injected lock removal failure"); }
    return original.unlinkSync(...args);
  },
}));
const env = { VMEM_HOME: home };
if (mode === "tidy-log") {
  const { tidyVault } = await import("../../src/tidy.ts");
  const preview = tidyVault(home, { vault: "mine", rules: ["log"] }, { env });
  console.log(JSON.stringify(tidyVault(home, { vault: "mine", rules: ["log"], confirm: true, fingerprint: preview.fingerprint }, { env })));
} else {
  const { promoteToOrg } = await import("../../src/org-promote.ts");
  const preview = promoteToOrg(home, { from: "personal", note: "shared-method", to: "team" }, { env });
  console.log(JSON.stringify(promoteToOrg(home, { from: "personal", note: "shared-method", to: "team", confirm: true, fingerprint: preview.fingerprint }, { env })));
}
