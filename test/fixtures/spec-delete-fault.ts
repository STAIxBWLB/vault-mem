import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
const [home, mode, fingerprint] = process.argv.slice(2);
if (!home || !mode || !fingerprint) throw new Error("synthetic delete fault fixture needs home, mode and fingerprint");
const original = { ...fs }, configFile = join(home, "vmem.config.json"), config = JSON.parse(original.readFileSync(configFile, "utf8"));
const root = config.specs[0].path, target = join(root, "SPEC.md");
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const fd = original.openSync(...args), file = String(args[0]);
    if (file.endsWith(".lock") && file.includes("/spec-mutations/")) {
      if (mode === "child-after-lock") original.writeFileSync(join(root, "added.md"), '---\nid: added\ntype: module\ntitle: Added\nparent: root\n---\n');
      if (mode === "file-after-lock") original.appendFileSync(target, "External edit.\n");
      if (mode === "policy-after-lock") { config.specs[0].write = "none"; original.writeFileSync(configFile, JSON.stringify(config)); }
    }
    return fd;
  },
  unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
    if (mode === "unlink" && String(args[0]) === target) throw new Error("synthetic unlink failure");
    return original.unlinkSync(...args);
  },
}));
const validation = await import("../../src/spec-validate.ts");
const introduced = validation.introducedSpecErrors;
mock.module("../../src/spec-validate.ts", () => ({ ...validation,
  introducedSpecErrors: (...args: Parameters<typeof introduced>) => {
    const result = introduced(...args);
    if (mode === "tree-after-gate") original.appendFileSync(join(root, "child.md"), "External tree edit.\n");
    return result;
  },
}));
const { deleteSpec } = await import("../../src/spec-write.ts");
console.log(JSON.stringify(deleteSpec(home, { id: "root", confirm: true, fingerprint }, { env: process.env })));
