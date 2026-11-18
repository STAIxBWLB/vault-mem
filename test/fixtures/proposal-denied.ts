import { mock } from "bun:test";
import * as fs from "node:fs";
const [home, suffix = "binding.json"] = process.argv.slice(2);
if (!home) throw new Error("fixture home required");
const original = { ...fs }; let opens = 0;
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).endsWith(`/${suffix}`)) opens++;
    return original.openSync(...args);
  },
}));
const { listProposals } = await import("../../src/proposal-provider.ts");
try { listProposals(home, { vault: "test" }, { channel: "mcp" }); console.log(JSON.stringify({ refused: false, opens })); }
catch { console.log(JSON.stringify({ refused: true, opens })); }
