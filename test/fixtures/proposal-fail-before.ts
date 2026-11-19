import { mock } from "bun:test";
import * as fs from "node:fs";
const [home, vault, id, fingerprint, target = "proposed"] = process.argv.slice(2);
if (!home || !vault || !id || !fingerprint) throw new Error("fixture arguments required");
const original = { ...fs }; let failed = false;
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    if (!failed && String(args[0]) === `${vault}/notes/${target}.md`) {
      failed = true; throw Object.assign(new Error("synthetic pre-publication read failure"), { code: "EIO" });
    }
    return original.openSync(...args);
  },
}));
const { applyProposal } = await import("../../src/proposal-provider.ts");
console.log(JSON.stringify(applyProposal(home, { vault: "test", id, fingerprint }, { channel: "mcp" })));
