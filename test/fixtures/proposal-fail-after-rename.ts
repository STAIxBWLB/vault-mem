import { mock } from "bun:test";
import * as fs from "node:fs";
const [home, vault, id, fingerprint] = process.argv.slice(2);
if (!home || !vault || !id || !fingerprint) throw new Error("fixture arguments required");
const original = { ...fs }; let failed = false;
mock.module("node:fs", () => ({ ...original,
  renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    const target = !failed && String(args[0]).includes(".vmem-") && String(args[1]).startsWith(`${vault}/notes/`);
    const result = original.renameSync(...args);
    if (target) { failed = true; throw Object.assign(new Error("synthetic ambiguous rename"), { code: "EIO" }); }
    return result;
  },
}));
const { applyProposal } = await import("../../src/proposal-provider.ts");
console.log(JSON.stringify(applyProposal(home, { vault: "test", id, fingerprint }, { channel: "mcp" })));
