import { mock } from "bun:test";
import * as fs from "node:fs";
const [root] = process.argv.slice(2);
if (!root) throw new Error("fixture root required");
const original = { ...fs }, notes = new Set<number>(); let reads = 0;
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const fd = original.openSync(...args);
    if (String(args[0]).startsWith(`${root}/notes/`)) notes.add(fd);
    return fd;
  },
  readSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    if (notes.has(fd)) reads++;
    return original.readSync(fd, buffer, offset, length, position);
  },
}));
const { snapshot } = await import("../../src/writer.ts");
try { snapshot(root, [], 1); console.log(JSON.stringify({ refused: false, reads })); }
catch { console.log(JSON.stringify({ refused: true, reads })); }
