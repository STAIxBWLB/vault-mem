import { mock } from "bun:test";
import * as fs from "node:fs";
const [home, vault, mode, raw] = process.argv.slice(2);
if (!home || !vault || !mode || !raw) throw new Error("fixture arguments required");
const original = { ...fs }; let injected = false, cleanupInjected = false, renames = 0;
let firstTarget: string | undefined;
const tempFds = new Set<number>();
const noteFds = new Map<number, string>();
const reads: { capacity: number; size: number }[] = [];
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const temporary = String(args[0]).includes(".vmem-");
    if (temporary && mode === "temp-open" && !injected) { injected = true; throw new Error("injected temp open failure"); }
    const fd = original.openSync(...args); if (temporary) tempFds.add(fd);
    if (String(args[0]).startsWith(`${vault}/notes/`) && !temporary) noteFds.set(fd, String(args[0]));
    else noteFds.delete(fd);
    return fd;
  },
  readSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    const file = noteFds.get(fd);
    if (file) {
      reads.push({ capacity: buffer.byteLength, size: original.fstatSync(fd).size });
      if (!injected && (mode === "grow" || mode === "shrink")) {
        injected = true;
        if (mode === "grow") original.appendFileSync(file, "x");
        else original.truncateSync(file, original.fstatSync(fd).size - 1);
      }
    }
    return original.readSync(fd, buffer, offset, length, position);
  },
  writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (tempFds.has(Number(args[0])) && ["temp-write", "temp-cleanup"].includes(mode) && !injected) { injected = true; throw new Error("injected temp write failure"); }
    return original.writeFileSync(...args);
  },
  fsyncSync: (fd: number) => {
    if (tempFds.has(fd) && mode === "mmap-edit" && !injected) {
      // A shared mapping changes bytes without moving size, mtime or ctime.
      injected = true; const other = `${vault}/notes/next.md`, map = Bun.mmap(other);
      map[original.readFileSync(other, "utf8").indexOf("Replacement") + 8] = "a".charCodeAt(0);
    }
    if (tempFds.has(fd) && mode === "silent-edit" && !injected) {
      // Same size and restored mtime: only ctime records the unrelated edit.
      injected = true; const other = `${vault}/notes/next.md`, text = original.readFileSync(other, "utf8");
      original.writeFileSync(other, text.replace("Replacement", "Replacemant")); original.utimesSync(other, 1_700_000_000, 1_700_000_000);
    }
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
// Whole-second mtime, so restoring it after the silent edit is exact to the nanosecond.
if (mode === "silent-edit") original.utimesSync(`${vault}/notes/next.md`, 1_700_000_000, 1_700_000_000);
if (mode === "index") {
  const { VaultIndex } = await import("../../src/vault-index.ts");
  const scan = VaultIndex.prototype.scan;
  VaultIndex.prototype.scan = function(...args) {
    if (!injected) { injected = true; throw new Error("injected index failure"); }
    return scan.apply(this, args);
  };
}
const { applyWrite } = await import("../../src/writer.ts");
const result = applyWrite(home, { vault: "test", operation: JSON.parse(raw), ...(mode === "allocation" ? { dryRun: true } : {}) });
console.log(JSON.stringify(mode === "allocation" ? { result, reads } : result));
