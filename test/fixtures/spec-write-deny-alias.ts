import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
const home = process.argv[2];
if (!home) throw new Error("synthetic case-alias fixture needs home");
const original = { ...fs }, config = JSON.parse(original.readFileSync(join(home, "vmem.config.json"), "utf8"));
const root = config.specs[0].path, lexical = join(root, "Case.md"), physical = join(root, "case.md");
// On case-sensitive hosts, emulate only the OS alias resolution. The real writer,
// registry, Git-spelled discovery paths and deny predicate still run unchanged.
const emulated = !original.existsSync(lexical);
if (emulated) {
  const remap = <T extends [unknown, ...unknown[]]>(args: T): T => {
    if (String(args[0]) === lexical) args[0] = physical;
    return args;
  };
  mock.module("node:fs", () => ({ ...original,
    openSync: (...args: Parameters<typeof fs.openSync>) => original.openSync(...remap(args)),
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => original.lstatSync(...remap(args)),
    realpathSync: (...args: Parameters<typeof fs.realpathSync>) => original.realpathSync(...remap(args)),
  }));
}
const { canonicalPath, isDenied } = await import("../../src/platform.ts");
const { updateSpec } = await import("../../src/spec-write.ts");
const canonical = canonicalPath(lexical);
const result = updateSpec(home, { id: "case", set: { title: "Refused edit" } }, { env: process.env });
console.log(JSON.stringify({ result, emulated, canonical, lexicalDenied: isDenied(lexical, config.denyPaths), canonicalDenied: isDenied(canonical, config.denyPaths) }));
