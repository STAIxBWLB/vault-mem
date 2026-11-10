import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  const original = note ? "---\ntitle: Synthetic note\ntype: insight\ndescription: Synthetic write safety evidence.\ndomain: research\ntopics: ['[[research]]']\n---\n# Synthetic note\n\n## Topics\n\n- [[research]]\n" : "---\nid: child\ntype: module\ntitle: Synthetic spec\nparent: root\n---\n# Synthetic spec\n";
  if (!kind.endsWith("create")) writeFileSync(target, original);
  if (note) {
    if (kind === "note-multi") writeFileSync(join(parent, "beta.md"), original.replaceAll("Synthetic note", "Synthetic beta"));
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
  return JSON.parse(child.stdout.toString()) as { result: { ok: boolean; applied?: boolean; changed?: boolean; refused?: boolean; issues: { code: string; message: string; path?: string }[]; changes?: { path: string; applied?: boolean }[]; retainedBackups?: string[] }; injected: boolean; descriptorOpen: boolean; published: boolean; rollbackPublished: boolean; text?: string; replacement?: string; held: string; outside: string; secondTarget: string; secondHeld: string };
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


test("a second-target prepublication drift reports the partial write and only its retained recovery backup", () => {
  const f = fixture("note-multi"), originalBeta = readFileSync(join(f.parent, "beta.md"), "utf8");
  const output = run(f, "note-multi", "partial-prepublish"), receipt = output.result;
  expect(output.injected, JSON.stringify(receipt)).toBe(true); expect(output.published).toBe(true);
  expect(receipt).toMatchObject({ ok: false, applied: true }); expect(receipt.refused).toBeUndefined();
  expect(receipt.changes).toHaveLength(2);
  expect(receipt.changes).toEqual([expect.objectContaining({ path: "notes/alpha.md", applied: true }), expect.objectContaining({ path: "notes/beta.md", applied: false })]);
  expect(receipt.issues).toContainEqual(expect.objectContaining({ code: "V09", path: "notes/beta.md" }));
  expect(readFileSync(f.target, "utf8")).toContain("[[beta]]");
  expect(lstatSync(output.secondTarget).isSymbolicLink()).toBe(true);
  expect(readFileSync(output.secondHeld, "utf8")).toBe(originalBeta);
  expect(receipt.retainedBackups).toHaveLength(1);
  const retained = receipt.retainedBackups![0]!;
  expect(retained.startsWith("notes/.vmem-")).toBe(true);
  expect(readFileSync(join(f.root, retained), "utf8")).toBe(f.original);
  expect(readdirSync(f.parent).filter(name => name.endsWith(".tmp"))).toEqual([retained.slice("notes/".length)]);
  expect(output.text).toContain("STATE"); expect(output.text).toContain("not applied");
  expect(output.text).toContain("retained backups"); expect(output.text).toContain(retained);
  const header = output.text!.split("\n")[0]!;
  expect(header).toContain("alpha"); expect(header).not.toContain("beta");
}, 30_000);

test("a rollback publication followed by a parent swap reports restored state without a consumed backup path", () => {
  const f = fixture("note-update"), output = run(f, "note-update", "rollback-parent-swap"), receipt = output.result;
  expect(output.injected, JSON.stringify(receipt)).toBe(true); expect(output.rollbackPublished).toBe(true);
  expect(receipt).toMatchObject({ ok: false, applied: false, refused: true });
  expect(readFileSync(join(output.held, "alpha.md"), "utf8")).toBe(f.original);
  expect(readFileSync(join(output.outside, "alpha.md"), "utf8")).toBe("foreign rollback target\n");
  const rollback = receipt.issues.find(issue => issue.code === "ROLLBACK");
  expect(rollback).toBeDefined(); expect(rollback!.path).toBe("notes/alpha.md");
  expect(rollback!.message).toContain("backup name was consumed");
  expect(rollback!.message).toContain("containment changed");
  expect(rollback!.message).toMatch(/inspect|restore|recover/);
  expect(receipt.retainedBackups ?? []).toEqual([]);
  expect(readdirSync(output.held).filter(name => name.endsWith(".tmp"))).toEqual([]);
}, 30_000);

test("a prepublication drift before any note commit does not intentionally retain backups or claim a recorded write", () => {
  const f = fixture("note-update"), output = run(f, "note-update", "prepublish-no-commits"), receipt = output.result;
  expect(output.injected, JSON.stringify(receipt)).toBe(true); expect(output.published).toBe(false);
  expect(receipt).toMatchObject({ ok: false, applied: false, refused: true });
  const drift = receipt.issues.find(issue => issue.code === "V09");
  expect(drift).toBeDefined(); expect(drift!.path).toBe("notes/alpha.md");
  expect(drift!.message).toContain("this step was not published");
  expect(drift!.message).not.toContain("recover the recorded write");
  expect(receipt.retainedBackups ?? []).toEqual([]);
  expect(readdirSync(f.parent).filter(name => name.endsWith(".tmp"))).toEqual([]);
  expect(readFileSync(output.secondHeld, "utf8")).toBe(f.original);
  expect(readFileSync(join(output.outside, "sentinel"), "utf8")).toBe("foreign sentinel\n");
}, 30_000);

for (const fault of ["create-symlink-appears", "create-directory-appears"]) test(`spec-create: ${fault} immediately before the helper precheck is EEXIST and preserves the foreign target`, () => {
  const f = fixture("spec-create"), output = run(f, "spec-create", fault), receipt = output.result;
  expect(output.injected, JSON.stringify(receipt)).toBe(true); expect(output.published).toBe(false);
  expect(receipt).toMatchObject({ ok: false, changed: false, refused: true });
  expect(receipt.issues).toContainEqual(expect.objectContaining({ code: "EEXIST", path: "nested/SPEC.md" }));
  if (fault === "create-symlink-appears") {
    expect(lstatSync(f.target).isSymbolicLink()).toBe(true);
    expect(readFileSync(f.target, "utf8")).toBe("foreign sentinel\n");
  } else {
    expect(lstatSync(f.target).isDirectory()).toBe(true);
    expect(readFileSync(join(f.target, "foreign-child"), "utf8")).toBe("foreign directory contents\n");
  }
  expect(readdirSync(f.parent)).toEqual(["SPEC.md"]);
  expect(readFileSync(join(output.outside, "sentinel"), "utf8")).toBe("foreign sentinel\n");
}, 30_000);
