import { mock } from "bun:test";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import type { WriteReceipt } from "../../src/write-types.ts";
const [home, kind, fault] = process.argv.slice(2);
if (!home || !kind || !fault) throw new Error("synthetic publication fault needs home, kind and fault");
const original = { ...fs }, config = JSON.parse(original.readFileSync(join(home, "vmem.config.json"), "utf8"));
const root: string = kind.startsWith("note") ? config.vaults[0].path : config.specs[0].path;
const target = join(root, kind.startsWith("note") ? "notes/alpha.md" : "nested/SPEC.md"), parent = dirname(target);
const secondTarget = join(root, "notes/beta.md"), secondHeld = join(dirname(root), "held-beta.md"), renamedTarget = join(root, "notes/apricot.md");
const outside = join(dirname(root), "outside"), held = join(dirname(root), "held-parent");
original.mkdirSync(outside); original.writeFileSync(join(outside, "sentinel"), "foreign sentinel\n");
const descriptors = new Map<number, string>(), readonlyTargets = new Map<number, string>(), readonlyTemps = new Set<number>();
let stagedTemps = 0, stagedTargetReads = 0, directoryFailed = false, rollbackPublished = false, forwardPublications = 0;
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
    if ((Number(args[1]) & original.constants.O_WRONLY) && owned) {
      descriptors.set(fd, file);
      if (file.endsWith(".tmp")) stagedTemps++;
    }
    if ((Number(args[1]) & (original.constants.O_WRONLY | original.constants.O_RDWR)) === 0) {
      if (file === target || file === secondTarget) readonlyTargets.set(fd, file);
      if (file.includes("/.spec-") && file.endsWith(".tmp")) readonlyTemps.add(fd);
    }
    return fd;
  },
  lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    if (fault.startsWith("postcheck-io-") && published && !injected && String(args[0]) === parent) {
      injected = true;
      const code = fault.slice("postcheck-io-".length);
      throw Object.assign(new Error(`synthetic post-publication ${code} path probe unavailable`), { code });
    }
    return original.lstatSync(...args);
  },
  readSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    if (fault === "non-drift-partial-rollback" && !injected && forwardPublications >= 2 && readonlyTargets.get(fd) === secondTarget) {
      injected = true;
      // A torn final read is an ordinary V09, not a namespace PublicationDrift. The earlier deletion also
      // gains an external replacement, so only the new destination can be rolled back safely.
      original.appendFileSync(secondTarget, "External third-target edit.\n");
      original.writeFileSync(target, "External first-target replacement.\n");
    }
    return original.readSync(fd, buffer, offset, length, position);
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
    if (String(args[1]) === target) {
      if (fault === "rollback-parent-swap" && published && directoryFailed && !injected) {
        original.renameSync(...args); rollbackPublished = true; injected = true;
        original.writeFileSync(join(outside, basename(target)), "foreign rollback target\n");
        original.renameSync(parent, held); original.symlinkSync(outside, parent);
      } else {
        const restoring = published && injected && fault.startsWith("postcheck-io-");
        swap(String(args[0])); original.renameSync(...args); published = true;
        if (restoring) rollbackPublished = true;
        else forwardPublications++;
      }
    } else {
      original.renameSync(...args);
      if (String(args[1]) === renamedTarget && !injected) forwardPublications++;
    }
  },
  fsyncSync: (fd: number) => {
    if ((fault === "rollback-parent-swap" || fault === "created-rollback-parent-swap") && published && !directoryFailed && original.fstatSync(fd).isDirectory()) {
      directoryFailed = true; throw Object.assign(new Error("synthetic directory flush failure before rollback"), { code: "EIO" });
    }
    return original.fsyncSync(fd);
  },
  closeSync: (fd: number) => {
    const readTarget = readonlyTargets.get(fd); readonlyTargets.delete(fd);
    const readTemp = readonlyTemps.delete(fd);
    original.closeSync(fd);
    if (!injected && fault === "partial-prepublish" && published && readTarget === secondTarget) {
      injected = true; original.renameSync(secondTarget, secondHeld); original.symlinkSync(join(outside, "sentinel"), secondTarget);
    }
    if (!injected && fault === "prepublish-no-commits" && stagedTemps >= 2 && readTarget === target && ++stagedTargetReads === 2) {
      injected = true; original.renameSync(target, secondHeld); original.symlinkSync(join(outside, "sentinel"), target);
    }
    if (!injected && readTemp && (fault === "create-symlink-appears" || fault === "create-directory-appears")) {
      injected = true;
      if (fault === "create-symlink-appears") original.symlinkSync(join(outside, "sentinel"), target);
      else { original.mkdirSync(target); original.writeFileSync(join(target, "foreign-child"), "foreign directory contents\n"); }
    }
  },
  linkSync: (...args: Parameters<typeof fs.linkSync>) => {
    if (String(args[1]) === target) { swap(String(args[0])); original.linkSync(...args); published = true; }
    else original.linkSync(...args);
  },
  unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
    if (String(args[0]) === target) {
      if (fault === "created-rollback-parent-swap" && published && directoryFailed && !injected) {
        original.unlinkSync(...args); rollbackPublished = true; injected = true;
        original.writeFileSync(join(outside, basename(target)), "foreign rollback target\n");
        original.renameSync(parent, held); original.symlinkSync(outside, parent);
      } else { swap(); original.unlinkSync(...args); published = true; forwardPublications++; }
    } else {
      original.unlinkSync(...args);
      if (String(args[0]) === renamedTarget && fault === "non-drift-partial-rollback" && injected) rollbackPublished = true;
    }
  },
}));
let result: Record<string, unknown>;
if (kind.startsWith("note")) {
  const { createVaultMcp } = await import("../../src/mcp-vault.ts");
  const mcp = createVaultMcp(home, process.env);
  if (kind === "note-move") {
    const preview = await mcp.handlers.vmem_move!({ from: "alpha", to: "apricot" }) as Record<string, unknown>;
    result = await mcp.handlers.vmem_move!({ from: "alpha", to: "apricot", confirm: true, fingerprint: preview.fingerprint }) as Record<string, unknown>;
  } else if (kind === "note-create") result = await mcp.handlers.vmem_create!({ stem: "alpha", title: "Created synthetic note", type: "insight", description: "Synthetic created write safety evidence.", domain: "research", topics: ["research"] }) as Record<string, unknown>;
  else if (kind === "note-multi") result = await mcp.handlers.vmem_link!({ from: "alpha", to: "beta", relation: "supports" }) as Record<string, unknown>;
  else if (kind.endsWith("delete")) {
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
let text: string | undefined;
if (kind === "note-multi" || kind === "note-move") {
  const { renderWriteReceipt } = await import("../../src/write-output.ts"), { PLAIN } = await import("../../src/text-output.ts");
  const command = kind === "note-move" ? "move" : "link", to = kind === "note-move" ? "apricot" : "beta";
  text = renderWriteReceipt(result as unknown as WriteReceipt, PLAIN, { argv: [command], positional: [command, "alpha", to] });
}
console.log(JSON.stringify({ result, text, injected, descriptorOpen, published, rollbackPublished, forwardPublications, replacement, held, outside, secondTarget, secondHeld, renamedTarget }));
