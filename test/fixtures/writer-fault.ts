import { mock } from "bun:test";
import * as fs from "node:fs";
const [home, vault, mode, raw] = process.argv.slice(2);
if (!home || !vault || !mode || !raw) throw new Error("fixture arguments required");
const original = { ...fs }; let injected = false, cleanupInjected = false, renames = 0;
let firstTarget: string | undefined;
const tempFds = new Set<number>();
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const temporary = String(args[0]).includes(".vmem-");
    if (temporary && mode === "temp-open" && !injected) { injected = true; throw new Error("injected temp open failure"); }
    const fd = original.openSync(...args); if (temporary) tempFds.add(fd); return fd;
  },
  writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (tempFds.has(Number(args[0])) && ["temp-write", "temp-cleanup"].includes(mode) && !injected) { injected = true; throw new Error("injected temp write failure"); }
    return original.writeFileSync(...args);
  },
  fsyncSync: (fd: number) => {
    if (tempFds.has(fd) && mode === "temp-fsync" && !injected) { injected = true; throw new Error("injected temp flush failure"); }
    if (mode === "directory-fsync" && original.fstatSync(fd).isDirectory() && !injected) { injected = true; throw new Error("injected directory flush failure"); }
    return original.fsyncSync(fd);
  },
  renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[0]).includes(".vmem-")) {
      renames++;
      if (renames === 2 && ["second-rename", "rollback-fail", "external-edit"].includes(mode) && !injected) {
        injected = true;
        if (mode === "external-edit" && firstTarget) original.writeFileSync(firstTarget, original.readFileSync(firstTarget, "utf8") + "\nExternal edit preserved.\n");
        throw new Error("injected second rename failure");
      }
      if (injected && mode === "rollback-fail") throw new Error("injected rollback rename failure");
    }
    const result = original.renameSync(...args);
    if (renames === 1) firstTarget = String(args[1]);
    return result;
  },
  unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
    if (!cleanupInjected && ((mode === "temp-cleanup" && String(args[0]).includes(".vmem-")) || (mode === "lock-cleanup" && String(args[0]).endsWith("/mutation.lock")))) { cleanupInjected = true; throw new Error("injected cleanup failure"); }
    return original.unlinkSync(...args);
  },
}));
if (mode === "index") {
  const { VaultIndex } = await import("../../src/vault-index.ts");
  const scan = VaultIndex.prototype.scan;
  VaultIndex.prototype.scan = function(...args) {
    if (!injected) { injected = true; throw new Error("injected index failure"); }
    return scan.apply(this, args);
  };
}
const { applyWrite } = await import("../../src/writer.ts");
console.log(JSON.stringify(applyWrite(home, { vault: "test", operation: JSON.parse(raw) })));
