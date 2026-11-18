import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
const [home, id, fingerprint, recordFile] = process.argv.slice(2);
if (!home || !id || !fingerprint || !recordFile) throw new Error("fixture arguments required");
const original = { ...fs }; let changed = false, deniedOpens = 0;
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const name = String(args[0]);
    if (changed && name === recordFile) deniedOpens++;
    return original.openSync(...args);
  },
  unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
    const result = original.unlinkSync(...args);
    if (!changed && String(args[0]) === join(home, "config.lock")) {
      const file = join(home, "vmem.config.json"), config = JSON.parse(original.readFileSync(file, "utf8"));
      config.denyPaths = [recordFile]; original.writeFileSync(file, JSON.stringify(config)); changed = true;
    }
    return result;
  },
}));
const { applyProposal } = await import("../../src/proposal-provider.ts");
const result = applyProposal(home, { vault: "test", id, fingerprint }, { channel: "mcp" });
console.log(JSON.stringify({ result, deniedOpens }));
