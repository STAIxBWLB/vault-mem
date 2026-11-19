import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
const [home, vault, sha] = process.argv.slice(2);
if (!home || !vault || !sha) throw new Error("fixture arguments required");
const original = { ...fs }, target = join(vault, "notes", "research.md"), lock = join(home, "config.lock");
let targetOpens = 0, lockOpens = 0;
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const file = String(args[0]);
    if (file === lock && typeof args[1] === "number" && (args[1] & fs.constants.O_CREAT) !== 0) lockOpens++;
    if (file === target && ++targetOpens === 2) original.unlinkSync(target);
    return original.openSync(...args);
  },
}));
const { submitProposal } = await import("../../src/proposal-provider.ts");
try {
  submitProposal(home, { vault: "test", operation: { op: "patch", path: "research", expectedSha: sha, edits: [{ oldString: "# Research", newString: "# Research revised" }] } }, { channel: "mcp" });
  console.log(JSON.stringify({ refused: false, lockOpens, lockExists: original.existsSync(lock) }));
} catch (error) {
  console.log(JSON.stringify({ refused: true, message: error instanceof Error ? error.message : "unknown", targetOpens, lockOpens, lockExists: original.existsSync(lock) }));
}
