import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
const [home, fingerprint] = process.argv.slice(2);
if (!home || !fingerprint) throw new Error("synthetic delete case-alias fixture needs home and fingerprint");
const original = { ...fs }, config = JSON.parse(original.readFileSync(join(home, "vmem.config.json"), "utf8"));
const root = config.specs[0].path, lexical = join(root, "Case.md"), physical = join(root, "case.md");
// Native case-insensitive filesystems use the actual alias. On case-sensitive
// hosts only OS path resolution is emulated; writer, registry, discovery and policy stay real.
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
const { deleteSpec } = await import("../../src/spec-write.ts");
const canonical = canonicalPath(lexical);
const preview = deleteSpec(home, { id: "case" }, { env: process.env });
const confirm = deleteSpec(home, { id: "case", confirm: true, fingerprint }, { env: process.env });
console.log(JSON.stringify({ preview, confirm, emulated, canonical, lexicalDenied: isDenied(lexical, config.denyPaths), canonicalDenied: isDenied(canonical, config.denyPaths) }));
