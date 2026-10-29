import { mock } from "bun:test";
import * as fs from "node:fs";
const [home, vault, mode, rebound] = process.argv.slice(2);
if (!home || !vault || !mode) throw new Error("fault arguments required");
const original = { ...fs }, logFds = new Set<number>();
let writes = 0, syncs = 0, injected = false;
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const fd = original.openSync(...args);
    if (String(args[0]) === `${vault}/log`) {
      logFds.add(fd);
      if (mode === "rotate" && !injected) { injected = true; original.renameSync(`${vault}/log`, `${vault}/rotated-log`); original.writeFileSync(`${vault}/log`, "replacement\n"); }
    } else logFds.delete(fd);
    return fd;
  },
  writeSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    if (!logFds.has(fd)) return original.writeSync(fd, buffer, offset, length, position);
    writes++;
    if (mode === "write") throw new Error("injected append failure");
    if (mode === "short" || mode === "partial-throw" || mode === "short-external") {
      const count = original.writeSync(fd, buffer, offset, Math.min(7, length), position);
      if (mode === "short-external") {
        const contents = original.readFileSync(`${vault}/log`); contents.fill("Z", contents.length - count); original.writeFileSync(`${vault}/log`, contents);
      }
      if (mode === "partial-throw") throw new Error("injected error after partial write");
      return count;
    }
    const count = original.writeSync(fd, buffer, offset, length, position);
    if (mode === "post-throw") throw new Error("injected error after full write");
    return count;
  },
  fsyncSync: (fd: number) => {
    if (logFds.has(fd)) {
      syncs++;
      if ((mode === "fsync" || mode === "writer-flush") && !injected) { injected = true; throw new Error("injected log flush failure"); }
    }
    const result = original.fsyncSync(fd);
    if (logFds.has(fd) && mode === "remove" && !injected) { injected = true; original.unlinkSync(`${vault}/log`); }
    return result;
  },
  closeSync: (fd: number) => {
    const log = logFds.has(fd); original.closeSync(fd); logFds.delete(fd);
    if (mode === "close" && log && !injected) { injected = true; throw new Error("injected close failure"); }
  },
  unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
    if (mode === "cleanup" && String(args[0]).endsWith("/log.lock") && !injected) { injected = true; throw new Error("injected lock cleanup failure"); }
    return original.unlinkSync(...args);
  },
}));
if (mode === "writer-flush" || mode === "writer-rebind") {
  if (mode === "writer-rebind") {
    if (!rebound) throw new Error("rebound path required");
    const { VaultIndex } = await import("../../src/vault-index.ts"); const scan = VaultIndex.prototype.scan;
    VaultIndex.prototype.scan = function(...args) {
      const result = scan.apply(this, args), file = `${home}/vmem.config.json`, config = JSON.parse(original.readFileSync(file, "utf8"));
      config.vaults[0].path = rebound; original.writeFileSync(file, JSON.stringify(config)); return result;
    };
  }
  const { applyWrite } = await import("../../src/writer.ts");
  const result = applyWrite(home, { vault: "test", operation: { op: "patch", path: "old", oldString: "Original text.", newString: "Persisted text." } }, { env: {} });
  console.log(JSON.stringify({ result, writes, syncs }));
} else {
  const { appendLog } = await import("../../src/vault-log.ts");
  const result = appendLog(home, { vault: "test", event: { type: "EXTRACT", project: "-", source: "synthetic:source", note: "Synthetic fault event" } }, { env: {} });
  console.log(JSON.stringify({ result, writes, syncs }));
}
