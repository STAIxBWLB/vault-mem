import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { addSpec } from "../src/registry.ts";
import { specGit } from "../src/spec-git.ts";
import { deleteSpec, type SpecWriteResult } from "../src/spec-write.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const target = "new/deep/created.md";
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-markdown-drift-"))); roots.push(root);
  const repo = join(root, "repo"), home = join(root, "state"); mkdirSync(repo);
  const env = { HOME: root, PATH: process.env.PATH, VMEM_HOME: home };
  const git = (args: string[]) => specGit(repo, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { env }).stdout.toString().trim();
  git(["-c", "init.templateDir=", "init", "--quiet"]);
  const original = "---\nid: root\ntype: goal\ntitle: Root\n---\n# Root\n";
  const child = "---\nid: child\ntype: module\ntitle: Child\nparent: root\n---\n# Child\n";
  writeFileSync(join(repo, "SPEC.md"), original); writeFileSync(join(repo, "child.md"), child); writeFileSync(join(repo, "source.ts"), "Synthetic source.\n");
  git(["add", "."]); git(["commit", "-qm", "Synthetic Markdown drift fixture"]);
  // Untracked ordinary inputs disappear from Git discovery on remove or rename.
  writeFileSync(join(repo, "ordinary.md"), "# Ordinary documentation without spec metadata\n");
  addSpec(home, { id: "fixture", path: repo, write: "mcp", pii: "allow" }, env);
  return { root, repo, home, env, git, original, child };
}
interface Output {
  result: SpecWriteResult; injected: boolean; phase: string; injectionDiscovery: number; lockHeld: boolean;
  discoveries: { count: number; targetMember: boolean; ids: string[]; diagnosticPaths: string[] }[];
}
function run(f: ReturnType<typeof fixture>, operation: string, effect: string): Output {
  const fingerprint = operation === "delete" ? deleteSpec(f.home, { id: "root" }, { env: f.env }).fingerprint! : "";
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/spec-markdown-drift.ts"), f.home, operation, effect, fingerprint], { env: { ...process.env, ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const output = JSON.parse(child.stdout.toString()) as Output;
  expect(output).toMatchObject({ injected: true, injectionDiscovery: 2, lockHeld: true, phase: operation === "delete" ? "registry-close-before-final-discovery" : "staged-temp-fsync" });
  expect(output.discoveries).toHaveLength(3);
  expect(readdirSync(join(f.home, "spec-mutations"))).toEqual([]);
  expect(readdirSync(f.repo).some(file => file.startsWith(".spec-"))).toBe(false);
  return output;
}

for (const operation of ["update", "delete"]) for (const effect of ["ordinary-add", "ordinary-remove"]) test(`#180 ${operation} permits unrelated ${effect} after its locked snapshot`, () => {
  const f = fixture(), output = run(f, operation, effect);
  expect(output.result).toMatchObject({ ok: true, changed: true, path: "SPEC.md" });
  expect(output.discoveries[1]!.ids).toEqual(output.discoveries[2]!.ids);
  expect(output.discoveries[1]!.diagnosticPaths).toEqual([]); expect(output.discoveries[2]!.diagnosticPaths).toEqual([]);
  expect(output.discoveries[2]!.count).toBe(output.discoveries[1]!.count + (effect === "ordinary-add" ? 1 : -1));
  expect(readFileSync(join(f.repo, "child.md"), "utf8")).toBe(f.child);
  if (operation === "delete") expect(existsSync(join(f.repo, "SPEC.md"))).toBe(false);
  else expect(parseFrontmatter(readFileSync(join(f.repo, "SPEC.md"), "utf8")).data.title).toBe("Updated root");
  expect(existsSync(join(f.repo, effect === "ordinary-add" ? "added.md" : "ordinary.md"))).toBe(effect === "ordinary-add");
}, 30_000);

for (const operation of ["update", "delete", "create"]) test(`#180 ${operation} still refuses a real spec body change after locked discovery`, () => {
  const f = fixture(), output = run(f, operation, "spec-body");
  expect(output.result).toMatchObject({ ok: false, changed: false });
  expect(output.result.issues).toContainEqual(expect.objectContaining({ code: "DRIFT" }));
  expect(readFileSync(join(f.repo, "SPEC.md"), "utf8")).toBe(f.original);
  expect(readFileSync(join(f.repo, "child.md"), "utf8")).toBe(f.child + "Concurrent spec detail.\n");
  expect(existsSync(join(f.repo, "new"))).toBe(false);
}, 30_000);

test("#180 delete still refuses a changed reference/backlink set after locked discovery", () => {
  const f = fixture(), output = run(f, "delete", "spec-reference");
  expect(output.result).toMatchObject({ ok: false, changed: false });
  expect(output.result.issues).toContainEqual(expect.objectContaining({ code: "DRIFT" }));
  expect(readFileSync(join(f.repo, "SPEC.md"), "utf8")).toBe(f.original);
  expect(readFileSync(join(f.repo, "child.md"), "utf8")).toContain("references: [root]");
});

for (const effect of ["ordinary-add", "ordinary-remove"]) test(`#180 create refuses changed Markdown input count from ${effect}`, () => {
  const f = fixture(), output = run(f, "create", effect);
  expect(output.result).toMatchObject({ ok: false, changed: false, path: target });
  expect(output.result.issues).toContainEqual(expect.objectContaining({ code: "DRIFT" }));
  expect(output.discoveries[1]!.count).not.toBe(output.discoveries[2]!.count);
  expect(existsSync(join(f.repo, "new"))).toBe(false);
}, 30_000);

test("#180 create permits same-count ordinary Markdown rename without weakening spec drift", () => {
  const f = fixture(), output = run(f, "create", "ordinary-rename");
  expect(output.result).toMatchObject({ ok: true, changed: true, path: target });
  expect(output.discoveries[1]).toEqual(output.discoveries[2]);
  expect(existsSync(join(f.repo, "ordinary.md"))).toBe(false); expect(existsSync(join(f.repo, "renamed.md"))).toBe(true);
  expect(parseFrontmatter(readFileSync(join(f.repo, target), "utf8")).data.id).toBe("created");
});

test("#180 create refuses isolated same-count target membership drift and preserves the foreign file", () => {
  const f = fixture(), output = run(f, "create", "target-membership");
  expect(output.result).toMatchObject({ ok: false, changed: false, path: target });
  expect(output.result.issues).toContainEqual(expect.objectContaining({ code: "DRIFT" }));
  expect(output.discoveries[1]!.count).toBe(output.discoveries[2]!.count);
  expect(output.discoveries[1]!.targetMember).toBe(false); expect(output.discoveries[2]!.targetMember).toBe(true);
  expect(output.discoveries[1]!.ids).toEqual(output.discoveries[2]!.ids);
  expect(output.discoveries[1]!.diagnosticPaths).toEqual([]); expect(output.discoveries[2]!.diagnosticPaths).toEqual([]);
  expect(readFileSync(join(f.repo, target), "utf8")).toBe("# Foreign ordinary Markdown\n");
  expect(readdirSync(join(f.repo, "new/deep"))).toEqual(["created.md"]);
});
