import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
const home = process.argv[2];
if (!home) throw new Error("synthetic create case-alias fixture needs home");
const original = { ...fs }, config = JSON.parse(original.readFileSync(join(home, "vmem.config.json"), "utf8"));
const root = config.specs[0].path, lexicalParent = join(root, "Case"), physicalParent = join(root, "case");
const lexical = join(lexicalParent, "new/SPEC.md");
// A native case-insensitive volume exercises the real alias. Else emulate only
// the OS's path resolution; writer, registry, Git and deny predicates stay real.
const emulated = !original.existsSync(lexicalParent);
if (emulated) {
  const remap = <T extends [unknown, ...unknown[]]>(args: T): T => {
    const file = String(args[0]);
    if (file === lexicalParent || file.startsWith(lexicalParent + "/")) args[0] = physicalParent + file.slice(lexicalParent.length);
    return args;
  };
  mock.module("node:fs", () => ({ ...original,
    openSync: (...args: Parameters<typeof fs.openSync>) => original.openSync(...remap(args)),
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => original.lstatSync(...remap(args)),
    realpathSync: (...args: Parameters<typeof fs.realpathSync>) => original.realpathSync(...remap(args)),
    existsSync: (...args: Parameters<typeof fs.existsSync>) => original.existsSync(...remap(args)),
  }));
}
const { canonicalPath, isDenied } = await import("../../src/platform.ts");
const { createSpec } = await import("../../src/spec-write.ts");
const canonical = canonicalPath(lexical);
const result = createSpec(home, { path: "Case/new/SPEC.md", id: "child", type: "module", title: "Refused create", parent: "root" }, { env: process.env });
console.log(JSON.stringify({ result, emulated, canonical, lexicalDenied: isDenied(lexical, config.denyPaths), canonicalDenied: isDenied(canonical, config.denyPaths) }));
