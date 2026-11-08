import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
const [home, mode] = process.argv.slice(2);
if (!home || !mode) throw new Error("synthetic spec fault fixture needs home and mode");
const original = { ...fs }, configFile = join(home, "vmem.config.json"), config = JSON.parse(original.readFileSync(configFile, "utf8"));
const root = config.specs[0].path, target = join(root, "nested/SPEC.md"), temps = new Set<number>();
let injected = false, lock: string | undefined, temp: string | undefined;
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const file = String(args[0]), fd = original.openSync(...args);
    if (file.includes(".spec-")) { temps.add(fd); temp = file; }
    if (file.includes("/spec-mutations/") && file.endsWith(".lock")) {
      lock = file;
      if (mode === "lock-open-replaced") { original.unlinkSync(lock); original.writeFileSync(lock, "foreign replacement\n"); }
      if (mode === "reread") original.appendFileSync(target, "External edit.\r\n");
      if (mode === "policy-drift") { config.specs[0].write = "none"; original.writeFileSync(configFile, JSON.stringify(config)); }
    }
    return fd;
  },
  writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (mode === "temp-write" && temps.has(Number(args[0])) && !injected) { injected = true; throw new Error("synthetic temp write fault"); }
    return original.writeFileSync(...args);
  },
  fsyncSync: (fd: number) => {
    if (temps.has(fd) && !injected) {
      if (mode === "temp-corrupt" && temp) { injected = true; original.appendFileSync(temp, "external staging edit"); }
      if (mode === "temp-replaced" && temp) { injected = true; original.unlinkSync(temp); original.writeFileSync(temp, "foreign staged replacement"); }
      if (mode === "tree-drift") { injected = true; original.appendFileSync(join(root, "design.md"), "External tree edit.\n"); }
      if (mode === "lock-replaced" && lock) { injected = true; original.unlinkSync(lock); original.writeFileSync(lock, "foreign replacement\n"); }
    }
    return original.fsyncSync(fd);
  },
  renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (mode === "rename" && String(args[0]).includes(".spec-")) throw new Error("synthetic rename fault");
    return original.renameSync(...args);
  },
}));
const { updateSpec } = await import("../../src/spec-write.ts");
console.log(JSON.stringify(updateSpec(home, { id: "child", set: { title: "Attempted edit" } }, { env: process.env })));
