import { mock } from "bun:test";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
const [home, kind, fault] = process.argv.slice(2);
if (!home || !kind || !fault) throw new Error("synthetic publication fault needs home, kind and fault");
const original = { ...fs }, config = JSON.parse(original.readFileSync(join(home, "vmem.config.json"), "utf8"));
const root: string = kind.startsWith("note") ? config.vaults[0].path : config.specs[0].path;
const target = join(root, kind.startsWith("note") ? "notes/alpha.md" : "nested/SPEC.md"), parent = dirname(target);
const outside = join(dirname(root), "outside"), held = join(dirname(root), "held-parent");
original.mkdirSync(outside); original.writeFileSync(join(outside, "sentinel"), "foreign sentinel\n");
const descriptors = new Map<number, string>();
let injected = false, published = false, stagingFailed = false, descriptorOpen = false, replacement: string | undefined;
function swap(temp?: string) {
  if (fault !== "parent-swap" || injected) return;
  injected = true;
  original.renameSync(parent, held);
  original.symlinkSync(outside, parent);
  // A same-user writer can supply the source name under the substituted directory too.
  if (temp) original.linkSync(join(held, basename(temp)), join(outside, basename(temp)));
  else original.writeFileSync(join(outside, basename(target)), "foreign deletion target\n");
}
mock.module("node:fs", () => ({ ...original,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const fd = original.openSync(...args), file = String(args[0]);
    const owned = file.includes("/.vmem-") || file.includes("/.spec-") || file === join(root, "mutation.lock") || file.includes("/spec-mutations/");
    if ((Number(args[1]) & original.constants.O_WRONLY) && owned) descriptors.set(fd, file);
    return fd;
  },
  writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (fault === "temp-replaced" && descriptors.get(Number(args[0]))?.endsWith(".tmp") && !stagingFailed) {
      stagingFailed = true; throw new Error("synthetic staging failure before cleanup");
    }
    return original.writeFileSync(...args);
  },
  fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
    const stat = original.fstatSync(...args), file = descriptors.get(Number(args[0]));
    if (!injected && file && (fault === "temp-replaced" && stagingFailed && file.endsWith(".tmp") || fault === "lock-replaced" && published && file.endsWith(".lock"))) {
      descriptorOpen = true; injected = true; replacement = file;
      original.unlinkSync(file); original.writeFileSync(file, "foreign replacement\n");
    }
    return stat;
  },
  renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[1]) === target) { swap(String(args[0])); original.renameSync(...args); published = true; }
    else original.renameSync(...args);
  },
  linkSync: (...args: Parameters<typeof fs.linkSync>) => {
    if (String(args[1]) === target) { swap(String(args[0])); original.linkSync(...args); published = true; }
    else original.linkSync(...args);
  },
  unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
    if (String(args[0]) === target) { swap(); original.unlinkSync(...args); published = true; }
    else original.unlinkSync(...args);
  },
}));
let result: Record<string, unknown>;
if (kind.startsWith("note")) {
  const { createVaultMcp } = await import("../../src/mcp-vault.ts");
  const mcp = createVaultMcp(home, process.env);
  if (kind.endsWith("delete")) {
    const preview = await mcp.handlers.vmem_delete!({ path: "alpha" }) as Record<string, unknown>;
    result = await mcp.handlers.vmem_delete!({ path: "alpha", confirm: true, fingerprint: preview.fingerprint }) as Record<string, unknown>;
  } else result = await mcp.handlers.vmem_set_frontmatter!({ path: "alpha", set: { title: "Changed synthetic note" } }) as Record<string, unknown>;
} else {
  const { createSpecMcp } = await import("../../src/mcp-spec.ts");
  const mcp = createSpecMcp(home, process.env);
  if (kind.endsWith("create")) result = await mcp.handlers.vmem_spec_create!({ path: "nested/SPEC.md", id: "child", type: "module", title: "Created synthetic spec", parent: "root" }) as Record<string, unknown>;
  else if (kind.endsWith("delete")) {
    const preview = await mcp.handlers.vmem_spec_delete!({ id: "child" }) as Record<string, unknown>;
    result = await mcp.handlers.vmem_spec_delete!({ id: "child", confirm: true, fingerprint: preview.fingerprint }) as Record<string, unknown>;
  } else result = await mcp.handlers.vmem_spec_update!({ id: "child", set: { title: "Changed synthetic spec" } }) as Record<string, unknown>;
}
console.log(JSON.stringify({ result, injected, descriptorOpen, published, replacement, held, outside }));
