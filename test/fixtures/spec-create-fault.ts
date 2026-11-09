import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
const [home, mode] = process.argv.slice(2);
if (!home || !mode) throw new Error("synthetic create fault fixture needs home and mode");
const original = { ...fs }, configFile = join(home, "vmem.config.json"), config = JSON.parse(original.readFileSync(configFile, "utf8"));
const root = config.specs[0].path, target = join(root, "new/deep/SPEC.md"), temps = new Set<number>(), modes = new Set<number>(), synced = new Set<number>();
let injected = false;
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const fd = original.openSync(...args), file = String(args[0]);
    if (file.includes(".spec-")) temps.add(fd);
    if (file.endsWith(".lock") && file.includes("/spec-mutations/")) {
      if (mode === "policy-drift") { config.specs[0].write = "none"; original.writeFileSync(configFile, JSON.stringify(config)); }
      if (mode === "target-appears") { original.mkdirSync(join(root, "new/deep"), { recursive: true }); original.writeFileSync(target, "foreign file\n"); }
    }
    return fd;
  },
  writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (mode === "temp-write" && temps.has(Number(args[0]))) throw new Error("synthetic create staging fault");
    return original.writeFileSync(...args);
  },
  fchmodSync: (fd: number, mode: number) => { original.fchmodSync(fd, mode); if (temps.has(fd) && mode === 0o600) modes.add(fd); },
  fsyncSync: (fd: number) => {
    if (!injected && temps.has(fd) && mode === "tree-drift") { injected = true; original.appendFileSync(join(root, "SPEC.md"), "External tree edit.\n"); }
    original.fsyncSync(fd); if (temps.has(fd) && modes.has(fd)) synced.add(fd);
  },
  linkSync: (...args: Parameters<typeof fs.linkSync>) => {
    if (![...temps].some(fd => synced.has(fd))) throw new Error("create must finalize mode and fsync before publication");
    if (mode.startsWith("link-")) throw Object.assign(new Error("synthetic unsupported link"), { code: mode.slice(5) });
    if (mode === "publish") throw new Error("synthetic create publication fault");
    if (mode === "publish-race") original.writeFileSync(target, "foreign file\n");
    return original.linkSync(...args);
  },
  renameSync: () => { throw new Error("unexpected create rename fallback"); },
}));
const { createSpec } = await import("../../src/spec-write.ts");
console.log(JSON.stringify(createSpec(home, { path: "new/deep/SPEC.md", id: "child", type: "module", title: "Attempted create", parent: "root" }, { env: process.env })));
