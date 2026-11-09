import { mock } from "bun:test";
import * as fs from "node:fs";
import { VaultIndex } from "../../src/vault-index.ts";
const [home, mode, fingerprint, nthRaw] = process.argv.slice(2);
if (!home || !mode || !fingerprint) throw new Error("synthetic merge fault needs home, mode and fingerprint");
const original = { ...fs }, nth = Number(nthRaw ?? "1"), staged = new Set<number>(), logs = new Set<number>();
let injected = false, renames = 0;
const fail = () => { injected = true; throw Object.assign(new Error("synthetic merge step failure"), { code: "EIO" }); };
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const fd = original.openSync(...args);
    if (String(args[0]).includes("/.vmem-")) staged.add(fd); else staged.delete(fd);
    if (String(args[0]).endsWith("/log")) logs.add(fd); else logs.delete(fd);
    return fd;
  },
  writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (mode === "stage" && !injected && typeof args[0] === "number" && staged.has(args[0])) fail();
    return original.writeFileSync(...args);
  },
  writeSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    if (mode === "log-append" && !injected && logs.has(fd)) fail();
    return original.writeSync(fd, buffer, offset, length, position);
  },
  renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    renames++;
    if (mode === "rename" && !injected && renames === nth) fail();
    return original.renameSync(...args);
  },
  fsyncSync: (fd: number) => {
    if (mode === "directory-sync" && !injected && original.fstatSync(fd).isDirectory()) fail();
    return original.fsyncSync(fd);
  },
}));
if (mode === "index-refresh") {
  const scan = VaultIndex.prototype.scan;
  VaultIndex.prototype.scan = function(...args) {
    if (!injected) fail();
    return scan.apply(this, args);
  };
}
const { applyWrite } = await import("../../src/writer.ts");
const receipt = applyWrite(home, { vault: "test", operation: { op: "merge", keep: "keep", absorb: "absorb" }, confirm: true, fingerprint }, { env: {}, now: new Date(2026, 0, 2, 1) });
console.log(JSON.stringify({ receipt, injected, renames }));
