import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

const [home, vault, mode] = process.argv.slice(2);
if (!home || !vault || !mode) throw new Error("home, vault and fault mode required");
const original = { ...fs };
let injected = true;
mock.module("node:fs", () => ({
  ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    if (injected && mode === "open" && String(args[0]).includes(".config-")) throw new Error("injected temp open failure");
    return original.openSync(...args);
  },
  writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (injected && mode === "cleanup") throw new Error("injected write failure");
    return original.writeFileSync(...args);
  },
  unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
    if (injected && mode === "cleanup" && String(args[0]).includes(".config-")) throw new Error("injected temp cleanup failure");
    return original.unlinkSync(...args);
  },
}));
const { addVault } = await import("../../src/registry.ts");
let message = "";
try { addVault(home, { id: "personal", path: vault, kind: "personal", write: "mcp" }); }
catch (error) { message = (error as Error).message; }
const released = !original.existsSync(join(home, "config.lock"));
const unchanged = !original.existsSync(join(home, "vmem.config.json"));
injected = false;
const recovered = addVault(home, { id: "personal", path: vault, kind: "personal", write: "mcp" }).id === "personal";
console.log(JSON.stringify({ message, released, unchanged, recovered }));
