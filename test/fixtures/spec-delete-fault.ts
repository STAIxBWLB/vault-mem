import { mock } from "bun:test";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import type { SpecDeleteResult } from "../../src/spec-write.ts";
const [home, mode, fingerprint] = process.argv.slice(2);
if (!home || !mode || !fingerprint) throw new Error("synthetic delete fault fixture needs home, mode and fingerprint");
const original = { ...fs }, configFile = join(home, "vmem.config.json"), config = JSON.parse(original.readFileSync(configFile, "utf8"));
const root = config.specs[0].path, target = join(root, "SPEC.md");
const fault = mode.replace(/^mcp-/, "");
let gatePassed = false, finalDiscoveryDone = false, removed = false, lockDescriptor: number | undefined;
let registerContainer: (() => void) | undefined;
const finalReads = new Set<number>();
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const file = String(args[0]);
    const lockErrors: Record<string, string> = { "lock-permission": "EACCES", "lock-space": "ENOSPC" };
    if (lockErrors[fault] && file.endsWith(".lock") && file.includes("/spec-mutations/")) throw Object.assign(new Error("synthetic delete lock directory failure"), { code: lockErrors[fault] });
    const fd = original.openSync(...args);
    if (finalDiscoveryDone && file === target) finalReads.add(fd);
    if (file.endsWith(".lock") && file.includes("/spec-mutations/")) {
      lockDescriptor = fd;
      if (mode === "child-after-lock") original.writeFileSync(join(root, "added.md"), '---\nid: added\ntype: module\ntitle: Added\nparent: root\n---\n');
      if (mode === "file-after-lock") original.appendFileSync(target, "External edit.\n");
      if (mode === "policy-after-lock") { config.specs[0].write = "none"; original.writeFileSync(configFile, JSON.stringify(config)); }
    }
    return fd;
  },
  unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
    if (mode === "unlink" && String(args[0]) === target) throw new Error("synthetic unlink failure");
    original.unlinkSync(...args);
    if (String(args[0]) === target) removed = true;
  },
  fsyncSync: (fd: number) => {
    if (fault === "dir-fsync" && removed && original.fstatSync(fd).isDirectory()) throw new Error("synthetic delete directory sync failure");
    original.fsyncSync(fd);
  },
  closeSync: (fd: number) => {
    if (finalReads.delete(fd)) {
      if (fault === "final-policy") { config.specs[0].write = "none"; original.writeFileSync(configFile, JSON.stringify(config)); }
      if (fault.startsWith("final-home-")) registerContainer!();
    }
    original.closeSync(fd);
    if (fault === "lock-close" && removed && fd === lockDescriptor) throw new Error("synthetic delete lock close failure");
  },
}));
const validation = await import("../../src/spec-validate.ts");
const introduced = validation.introducedSpecErrors;
mock.module("../../src/spec-validate.ts", () => ({ ...validation,
  introducedSpecErrors: (...args: Parameters<typeof introduced>) => {
    const result = introduced(...args);
    gatePassed = true;
    if (mode === "tree-after-gate") original.appendFileSync(join(root, "child.md"), "External tree edit.\n");
    return result;
  },
}));
const source = await import("../../src/spec-source.ts"), discover = source.discoverSpecs;
mock.module("../../src/spec-source.ts", () => ({ ...source,
  discoverSpecs: (...args: Parameters<typeof discover>) => {
    const result = discover(...args);
    if (gatePassed) finalDiscoveryDone = true;
    return result;
  },
}));
const { deleteSpec } = await import("../../src/spec-write.ts");
if (fault.startsWith("final-home-")) {
  const { addSpec, addVault } = await import("../../src/registry.ts");
  registerContainer = () => {
    if (fault === "final-home-spec") addSpec(home, { id: "container", path: dirname(home), write: "none", pii: "deny" }, process.env);
    else addVault(home, { id: "container", path: dirname(home), kind: "personal", write: "none", pii: "deny" });
  };
}
const request = { id: "root", confirm: true, fingerprint };
const { createSpecMcp } = await import("../../src/mcp-spec.ts");
const result = (mode.startsWith("mcp-") ? createSpecMcp(home, process.env).handlers.vmem_spec_delete!(request) : deleteSpec(home, request, { env: process.env })) as SpecDeleteResult;
if (fault === "dir-fsync" || fault === "lock-close") {
  const { renderSpecDelete } = await import("../../src/spec-output.ts"), { PLAIN } = await import("../../src/text-output.ts");
  console.log(JSON.stringify({ result, text: renderSpecDelete(result, PLAIN) }));
} else console.log(JSON.stringify(result));
