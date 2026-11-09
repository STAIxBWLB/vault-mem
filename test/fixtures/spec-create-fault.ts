import { mock } from "bun:test";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import type { SpecWriteResult } from "../../src/spec-write.ts";
const [home, mode] = process.argv.slice(2);
if (!home || !mode) throw new Error("synthetic create fault fixture needs home and mode");
const original = { ...fs }, configFile = join(home, "vmem.config.json"), config = JSON.parse(original.readFileSync(configFile, "utf8"));
const root = config.specs[0].path, target = join(root, "new/deep/SPEC.md"), temps = new Set<number>(), modes = new Set<number>(), synced = new Set<number>(), tempReads = new Set<number>();
const fault = mode.replace(/^mcp-/, "");
if (fault === "umask-027") process.umask(0o027);
const expectedFileMode = 0o666 & ~process.umask(), descriptorPaths = new Map<number, string>(), syncPaths: string[] = [];
let injected = false, published = false, updating = false, lockDescriptor: number | undefined;
let registerContainer: (() => void) | undefined;
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const file = String(args[0]);
    if (fault === "lock-permission" && file.endsWith(".lock") && file.includes("/spec-mutations/")) throw Object.assign(new Error("synthetic non-writable lock directory"), { code: "EACCES" });
    const fd = original.openSync(...args);
    descriptorPaths.set(fd, file);
    if (file.includes(".spec-")) {
      temps.add(fd);
      if ((Number(args[1]) & (original.constants.O_WRONLY | original.constants.O_RDWR)) === 0) tempReads.add(fd);
    }
    if (file.endsWith(".lock") && file.includes("/spec-mutations/")) {
      lockDescriptor = fd;
      if (mode === "policy-drift") { config.specs[0].write = "none"; original.writeFileSync(configFile, JSON.stringify(config)); }
      if (mode === "target-appears") { original.mkdirSync(join(root, "new/deep"), { recursive: true }); original.writeFileSync(target, "foreign file\n"); }
    }
    return fd;
  },
  writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (mode === "temp-write" && temps.has(Number(args[0]))) throw new Error("synthetic create staging fault");
    return original.writeFileSync(...args);
  },
  fchmodSync: (fd: number, mode: number) => { original.fchmodSync(fd, mode); if (temps.has(fd) && mode === expectedFileMode) modes.add(fd); },
  fsyncSync: (fd: number) => {
    if (published && original.fstatSync(fd).isDirectory()) {
      const file = descriptorPaths.get(fd)!; syncPaths.push(file);
      if (fault === "dir-fsync") throw new Error("synthetic create directory sync failure");
      if (fault === "ancestor-sync" && file === join(root, "new")) throw new Error("synthetic created ancestor sync failure");
    }
    if (!injected && temps.has(fd) && mode === "tree-drift") { injected = true; original.appendFileSync(join(root, "SPEC.md"), "External tree edit.\n"); }
    original.fsyncSync(fd); if (temps.has(fd) && modes.has(fd)) synced.add(fd);
  },
  linkSync: (...args: Parameters<typeof fs.linkSync>) => {
    if (![...temps].some(fd => synced.has(fd))) throw new Error("create must finalize mode and fsync before publication");
    if (mode.startsWith("link-")) throw Object.assign(new Error("synthetic unsupported link"), { code: mode.slice(5) });
    if (mode === "publish") throw new Error("synthetic create publication fault");
    if (mode === "publish-race") original.writeFileSync(target, "foreign file\n");
    original.linkSync(...args); published = true;
  },
  closeSync: (fd: number) => {
    if (tempReads.delete(fd)) {
      if (fault === "final-policy") { config.specs[0].write = "none"; original.writeFileSync(configFile, JSON.stringify(config)); }
      if (fault.startsWith("final-home-")) registerContainer!();
    }
    original.closeSync(fd);
    if (fault === "lock-close" && published && fd === lockDescriptor) throw new Error("synthetic create lock close failure");
  },
  renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (!updating && String(args[0]).includes(".spec-")) throw new Error("unexpected create rename fallback");
    original.renameSync(...args);
  },
}));
const { createSpec } = await import("../../src/spec-write.ts");
if (fault.startsWith("final-home-")) {
  const { addSpec, addVault } = await import("../../src/registry.ts");
  registerContainer = () => {
    if (fault === "final-home-spec") addSpec(home, { id: "container", path: dirname(home), write: "none", pii: "deny" }, process.env);
    else addVault(home, { id: "container", path: dirname(home), kind: "personal", write: "none", pii: "deny" });
  };
}
const request = { path: "new/deep/SPEC.md", id: "child", type: "module", title: "Attempted create", parent: "root" };
const { createSpecMcp } = await import("../../src/mcp-spec.ts");
const result = (mode.startsWith("mcp-") ? createSpecMcp(home, process.env).handlers.vmem_spec_create!(request) : createSpec(home, request, { env: process.env })) as SpecWriteResult;
if (fault === "umask-027" && result.ok) {
  const fileMode = original.statSync(target).mode & 0o777;
  const directoryModes = [join(root, "new"), join(root, "new/deep")].map(file => original.statSync(file).mode & 0o777);
  original.chmodSync(target, 0o664); updating = true;
  const { updateSpec } = await import("../../src/spec-write.ts");
  const update = updateSpec(home, { id: "child", set: { title: "Updated mode fixture" } }, { env: process.env });
  console.log(JSON.stringify({ result, fileMode, directoryModes, update, updateMode: original.statSync(target).mode & 0o777 }));
} else if (fault === "dir-fsync" || fault === "ancestor-sync" || fault === "lock-close") {
  const { renderSpecUpdate } = await import("../../src/spec-output.ts"), { PLAIN } = await import("../../src/text-output.ts");
  console.log(JSON.stringify({ result, text: renderSpecUpdate(result, PLAIN, "create"), syncPaths }));
} else if (fault === "sync-order") console.log(JSON.stringify({ result, syncPaths }));
else console.log(JSON.stringify(result));
