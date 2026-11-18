import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
const [home, id, fingerprint] = process.argv.slice(2);
if (!home || !id || !fingerprint) throw new Error("fixture arguments required");
const original = { ...fs }; let locks = 0;
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === join(home, "config.lock") && typeof args[1] === "number" && (args[1] & fs.constants.O_CREAT) !== 0 && ++locks === 2) {
      throw Object.assign(new Error("synthetic competing registry lock"), { code: "EEXIST" });
    }
    return original.openSync(...args);
  },
}));
const { applyProposal } = await import("../../src/proposal-provider.ts");
console.log(JSON.stringify(applyProposal(home, { vault: "test", id, fingerprint }, { channel: "mcp" })));
