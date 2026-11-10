import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSpec, addVault } from "../src/registry.ts";
import { specGit } from "../src/spec-git.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(kind: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "vmem-write-files-"))); roots.push(base);
  const root = join(base, "root"), home = join(base, "state"), note = kind.startsWith("note"), parent = join(root, note ? "notes" : "nested");
  mkdirSync(parent, { recursive: true });
  const env = { HOME: base, PATH: process.env.PATH, VMEM_HOME: home, AMEM_HOME: join(base, "memory"), AGENTHUB_HOME: join(base, "family") };
  const target = join(parent, note ? "alpha.md" : "SPEC.md");
  const original = note ? "---\ntitle: Synthetic note\ntype: insight\ndescription: Synthetic write safety evidence.\ndomain: research\ntopics: ["[[research]]"]\n---\n# Synthetic note\n\n## Topics\n\n- [[research]]\n" : "---\nid: child\ntype: module\ntitle: Synthetic spec\nparent: root\n---\n# Synthetic spec\n";
  if (!kind.endsWith("create")) writeFileSync(target, original);
  if (note) {
    writeFileSync(join(parent, "research.md"), "---\ntype: moc\ndescription: Synthetic directory.\n---\n# Research\n");
    addVault(home, { id: "mine", path: root, kind: "personal", write: "mcp" });
  }
  else {
    specGit(root, ["-c", "init.templateDir=", "init", "--quiet"], { env });
    writeFileSync(join(root, "SPEC.md"), "---\nid: root\ntype: goal\ntitle: Synthetic root\n---\n# Synthetic root\n");
    addSpec(home, { id: "specs", path: root, write: "mcp", pii: "allow" }, env);
  }
  return { base, root, parent, home, target, original, env };
}
function run(f: ReturnType<typeof fixture>, kind: string, fault: string) {
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/write-files-fault.ts"), f.home, kind, fault], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return JSON.parse(child.stdout.toString()) as { result: { ok: boolean; applied?: boolean; changed?: boolean; refused?: boolean; issues: { code: string; message: string }[] }; injected: boolean; descriptorOpen: boolean; published: boolean; replacement?: string; held: string; outside: string };
}
for (const kind of ["note-update", "note-delete", "spec-update", "spec-create", "spec-delete"]) test(`${kind}: a last-moment parent symlink swap is reported after publication`, () => {
  const f = fixture(kind), output = run(f, kind, "parent-swap");
  expect(output.injected, JSON.stringify(output.result)).toBe(true); expect(output.published).toBe(true);
  expect(output.result.ok).toBe(false);
  expect(kind.startsWith("note") ? output.result.applied : output.result.changed).toBe(true);
  expect(output.result.refused).toBeUndefined();
  expect(output.result.issues.some(issue => issue.message.includes("containment changed") && issue.message.includes("recover"))).toBe(true);
  expect(readFileSync(join(output.outside, "sentinel"), "utf8")).toBe("foreign sentinel\n");
  if (!kind.endsWith("create")) expect(readFileSync(join(output.held, kind.startsWith("note") ? "alpha.md" : "SPEC.md"), "utf8")).toBe(f.original);
  if (kind.endsWith("delete")) expect(existsSync(f.target)).toBe(false);
  else expect(readFileSync(f.target, "utf8")).toContain("synthetic");
  if (kind.startsWith("note")) expect(readdirSync(output.held).some(name => name.endsWith(".tmp"))).toBe(true);
}, 30_000);
for (const kind of ["note-update", "spec-update"]) for (const fault of ["temp-replaced", "lock-replaced"]) test(`${kind}: ${fault} during cleanup preserves the replacement while its owned descriptor stays open`, () => {
  const f = fixture(kind), output = run(f, kind, fault);
  expect(output.injected, JSON.stringify(output.result)).toBe(true); expect(output.descriptorOpen).toBe(true);
  expect(readFileSync(output.replacement!, "utf8")).toBe("foreign replacement\n");
  expect(output.result.ok).toBe(false);
  expect(output.result.issues.some(issue => issue.code === "CLEANUP" && issue.message.includes("ownership") || issue.code === "CLEANUP" && issue.message.includes("identity changed"))).toBe(true);
  if (fault === "temp-replaced") {
    expect(kind.startsWith("note") ? output.result.applied : output.result.changed).toBe(false);
    expect(output.result.refused).toBe(true); expect(readFileSync(f.target, "utf8")).toBe(f.original);
  } else {
    expect(kind.startsWith("note") ? output.result.applied : output.result.changed).toBe(true);
    expect(output.result.refused).toBeUndefined(); expect(readFileSync(f.target, "utf8")).not.toBe(f.original);
  }
}, 30_000);
