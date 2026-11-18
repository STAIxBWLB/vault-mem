import { mock } from "bun:test";
import * as fs from "node:fs";
const [home, vault, id, fingerprint, mode] = process.argv.slice(2);
if (!home || !vault || !id || !fingerprint || !["before", "after", "before-receipt", "after-receipt"].includes(mode ?? "")) throw new Error("fixture arguments required");
const original = { ...fs };
let recordWrites = 0;
mock.module("node:fs", () => ({ ...original,
  renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    const notePublication = String(args[0]).includes(".vmem-") && String(args[1]).startsWith(`${vault}/notes/`);
    const recordPublication = String(args[0]).includes(".proposal-") && String(args[1]).endsWith(`/${id}.json`);
    if (recordPublication) recordWrites++;
    if (notePublication && mode === "before") process.kill(process.pid, "SIGKILL");
    if (recordPublication && recordWrites === 2 && mode === "before-receipt") process.kill(process.pid, "SIGKILL");
    const result = original.renameSync(...args);
    if (notePublication && mode === "after") process.kill(process.pid, "SIGKILL");
    if (recordPublication && recordWrites === 2 && mode === "after-receipt") process.kill(process.pid, "SIGKILL");
    return result;
  },
}));
const { applyProposal } = await import("../../src/proposal-provider.ts");
applyProposal(home, { vault: "test", id, fingerprint }, { channel: "mcp" });
