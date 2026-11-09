import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import type { SpecWriteResult } from "../../src/spec-write.ts";
const [home, operation, effect, fingerprint] = process.argv.slice(2);
if (!home || !operation || !effect) throw new Error("synthetic Markdown drift fixture needs home, operation and effect");
const original = { ...fs }, configFile = join(home, "vmem.config.json"), config = JSON.parse(original.readFileSync(configFile, "utf8"));
const root = config.specs[0].path, target = "new/deep/created.md", temps = new Set<number>(), registryReads = new Set<number>();
const discoveries: { count: number; targetMember: boolean; ids: string[]; diagnosticPaths: string[] }[] = [];
let lock: string | undefined, injected = false, phase: string | undefined, injectionDiscovery = 0, lockHeld = false;
function inject(at: string): void {
  if (injected) return;
  if (discoveries.length !== 2 || !lock || !original.existsSync(lock)) throw new Error("synthetic drift injection requires the completed locked snapshot and owned mutation lock");
  phase = at; injectionDiscovery = discoveries.length; lockHeld = true;
  if (effect === "ordinary-add") original.writeFileSync(join(root, "added.md"), "# Ordinary added documentation\n");
  else if (effect === "ordinary-remove") original.unlinkSync(join(root, "ordinary.md"));
  else if (effect === "ordinary-rename") original.renameSync(join(root, "ordinary.md"), join(root, "renamed.md"));
  else if (effect === "spec-body") original.appendFileSync(join(root, "child.md"), "Concurrent spec detail.\n");
  else if (effect === "spec-reference") original.writeFileSync(join(root, "child.md"), original.readFileSync(join(root, "child.md"), "utf8").replace("parent: root\n", "parent: root\nreferences: [root]\n"));
  else if (effect === "target-membership") {
    original.writeFileSync(join(root, target), "# Foreign ordinary Markdown\n");
    original.unlinkSync(join(root, "ordinary.md"));
  } else throw new Error("unknown synthetic Markdown drift effect");
  injected = true;
}
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const fd = original.openSync(...args), file = String(args[0]);
    if (file.includes("/spec-mutations/") && file.endsWith(".lock")) lock = file;
    if (file.includes(".spec-") && file.endsWith(".tmp")) temps.add(fd);
    if (operation === "delete" && discoveries.length === 2 && file === configFile) registryReads.add(fd);
    return fd;
  },
  fsyncSync: (fd: number) => {
    original.fsyncSync(fd);
    if (operation !== "delete" && temps.has(fd) && !injected) inject("staged-temp-fsync");
  },
  closeSync: (fd: number) => {
    original.closeSync(fd);
    if (registryReads.delete(fd) && !injected) inject("registry-close-before-final-discovery");
  },
}));
const source = await import("../../src/spec-source.ts"), discover = source.discoverSpecs;
mock.module("../../src/spec-source.ts", () => ({ ...source,
  discoverSpecs: (...args: Parameters<typeof discover>) => {
    const snapshot = discover(...args);
    discoveries.push({ count: snapshot.markdownPaths?.length ?? -1, targetMember: snapshot.markdownPaths?.includes(target) ?? false,
      ids: snapshot.specs.map(spec => spec.id), diagnosticPaths: snapshot.diagnostics.map(issue => issue.path) });
    return snapshot;
  },
}));
const writes = await import("../../src/spec-write.ts");
let result: SpecWriteResult;
if (operation === "update") result = writes.updateSpec(home, { id: "root", set: { title: "Updated root" } }, { env: process.env });
else if (operation === "create") result = writes.createSpec(home, { path: target, id: "created", type: "module", title: "Created spec", parent: "root" }, { env: process.env });
else if (operation === "delete" && fingerprint) result = writes.deleteSpec(home, { id: "root", confirm: true, fingerprint }, { env: process.env });
else throw new Error("synthetic Markdown drift fixture needs update, create or delete with fingerprint");
console.log(JSON.stringify({ result, injected, phase, injectionDiscovery, lockHeld, discoveries }));
