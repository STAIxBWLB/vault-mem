import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, type SpecSourceSpec } from "../src/config.ts";
import { AGENT_MARKERS } from "../src/log-format.ts";
import { addSpec } from "../src/registry.ts";
import { specGit } from "../src/spec-git.ts";
import { type SpecDocument, type SpecSnapshot } from "../src/spec-source.ts";
import { introducedSpecErrors } from "../src/spec-validate.ts";
import { deleteSpec, type SpecDeleteRequest, type SpecDeleteResult } from "../src/spec-write.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fixture(write: SpecSourceSpec["write"] = "mcp") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-spec-delete-"))); roots.push(root);
  const repo = join(root, "repo"), home = join(root, "state"); mkdirSync(repo);
  const env = { HOME: root, PATH: process.env.PATH, VMEM_HOME: home };
  const git = (args: string[], cwd = repo) => specGit(cwd, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { env }).stdout.toString().trim();
  git(["-c", "init.templateDir=", "init", "--quiet"]);
  writeFileSync(join(repo, "SPEC.md"), '---\nid: root\ntype: goal\ntitle: Root\n---\n# Root\n');
  writeFileSync(join(repo, "child.md"), '---\nid: child\ntype: module\ntitle: Child\nparent: root\ndepends-on: [root]\nreferences: [root]\nimplements: [root]\n---\n# Child\n\n[[root]]\n');
  writeFileSync(join(repo, "old.md"), '---\nid: old\ntype: architecture\ntitle: Old\nstatus: deprecated\nsuperseded-by: root\n---\n# Old\n');
  git(["add", "."]); git(["commit", "-qm", "Synthetic delete fixture"]);
  addSpec(home, { id: "fixture", path: repo, write, pii: "deny" }, env);
  const remove = (request: Partial<SpecDeleteRequest> = {}, channel: "cli" | "mcp" = "cli") => deleteSpec(home, { id: "root", ...request }, { env, channel });
  return { root, repo, home, env, git, remove };
}
function tree(root: string): unknown {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const file = join(root, entry.name);
    return [entry.name, entry.isDirectory() ? tree(file) : readFileSync(file).toString("base64")];
  });
}

test("AC6: preview returns sorted complete six-kind backlinks, children and a stable fingerprint without any writes", () => {
  const f = fixture(), before = tree(f.root), first = f.remove(), second = f.remove();
  expect(first).toMatchObject({ ok: true, changed: false, preview: true, path: "SPEC.md", actor: "person", sha256: hash(readFileSync(join(f.repo, "SPEC.md"))) });
  expect(first).toEqual(second);
  expect(new Set(first.backlinks!.map(edge => edge.kind))).toEqual(new Set(["parent", "depends-on", "references", "implements", "superseded-by", "body_link"]));
  expect(first.children).toEqual([expect.objectContaining({ id: "child", path: "child.md" })]);
  expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(tree(f.root)).toEqual(before); expect(existsSync(join(f.home, "spec-mutations"))).toBe(false);
}, 30_000);

test("AC6/AC8: confirm acknowledges listed children/backlinks and changes only Git's deletion", () => {
  const f = fixture(), head = f.git(["rev-parse", "HEAD"]), refs = f.git(["for-each-ref"]), preview = f.remove();
  const siblings = [readFileSync(join(f.repo, "child.md")), readFileSync(join(f.repo, "old.md"))];
  const result = f.remove({ confirm: true, fingerprint: preview.fingerprint });
  expect(result).toMatchObject({ ok: true, changed: true, preview: false, sha256: preview.sha256, fingerprint: preview.fingerprint });
  expect(existsSync(join(f.repo, "SPEC.md"))).toBe(false);
  expect([readFileSync(join(f.repo, "child.md")), readFileSync(join(f.repo, "old.md"))]).toEqual(siblings);
  expect(f.git(["status", "--porcelain=v1"])).toBe("D SPEC.md");
  expect(f.git(["rev-parse", "HEAD"])).toBe(head); expect(f.git(["for-each-ref"])).toBe(refs);
  expect(readdirSync(join(f.home, "spec-mutations"))).toEqual([]);
}, 30_000);

for (const extra of [0, 1]) test(`delete acknowledgement budget is preview-invariant at 229376 + ${extra} bytes`, () => {
  const f = fixture(), initial = f.remove();
  const acknowledgement = ({ fingerprint, sha256, backlinks, children }: SpecDeleteResult) => ({ fingerprint, sha256, backlinks, children });
  const initialBytes = Buffer.byteLength(JSON.stringify(acknowledgement(initial)));
  const childFile = join(f.repo, "child.md"), before = readFileSync(childFile, "utf8");
  writeFileSync(childFile, before.replace("title: Child", `title: ${"C".repeat(5 + 229376 + extra - initialBytes)}`));
  const preview = f.remove();
  if (extra) {
    for (const result of [preview, f.remove({ confirm: true, fingerprint: initial.fingerprint })]) {
      expect(result).toMatchObject({ ok: false, changed: false, issues: [expect.objectContaining({ code: "LIMIT" })] });
    }
    expect(existsSync(join(f.repo, "SPEC.md"))).toBe(true);
    expect(existsSync(join(f.home, "spec-mutations"))).toBe(false);
  } else {
    expect(preview).toMatchObject({ ok: true, changed: false, preview: true });
    expect(Buffer.byteLength(JSON.stringify(acknowledgement(preview)))).toBe(229376);
    const result = f.remove({ confirm: true, fingerprint: preview.fingerprint });
    expect(result).toMatchObject({ ok: true, changed: true, preview: false, sha256: preview.sha256 });
    expect(Buffer.byteLength(JSON.stringify(acknowledgement(result)))).toBe(229376);
    expect(existsSync(join(f.repo, "SPEC.md"))).toBe(false);
  }
}, 30_000);

for (const mode of ["file", "child", "backlink", "child-title", "parent-removal"]) test(`AC6: stale ${mode} fingerprint refuses and preserves current files`, () => {
  const f = fixture(), preview = f.remove();
  if (mode === "file") writeFileSync(join(f.repo, "SPEC.md"), readFileSync(join(f.repo, "SPEC.md"), "utf8") + "Changed.\n");
  if (mode === "child") writeFileSync(join(f.repo, "added.md"), '---\nid: added\ntype: module\ntitle: Added\nparent: root\n---\n');
  if (mode === "backlink") writeFileSync(join(f.repo, "added.md"), '---\nid: added\ntype: module\ntitle: Added\n---\n[[root]]\n');
  if (mode === "child-title") writeFileSync(join(f.repo, "child.md"), readFileSync(join(f.repo, "child.md"), "utf8").replace("title: Child", "title: Updated"));
  if (mode === "parent-removal") writeFileSync(join(f.repo, "child.md"), readFileSync(join(f.repo, "child.md"), "utf8").replace("parent: root\n", ""));
  const before = tree(f.root), result = f.remove({ confirm: true, fingerprint: preview.fingerprint });
  expect(result).toMatchObject({ ok: false, changed: false, path: "SPEC.md" });
  expect(result.issues[0]!.code).toBe("FINGERPRINT"); expect(tree(f.root)).toEqual(before);
}, 30_000);

test("delete policy applies to previews and confirms, markers and MCP determine actor, held lock blocks only confirm", () => {
  const none = fixture("none");
  for (const channel of ["cli", "mcp"] as const) expect(none.remove({}, channel)).toMatchObject({ ok: false, changed: false, issues: [expect.objectContaining({ code: "POLICY" })] });
  const cli = fixture("cli"); expect(cli.remove({}, "mcp").ok).toBe(false); expect(cli.remove().ok).toBe(true);
  const f = fixture(), preview = f.remove({}, "mcp"); expect(preview.actor).toBe("agent");
  for (const key of AGENT_MARKERS) expect(deleteSpec(f.home, { id: "root" }, { env: { ...f.env, [key]: "set" } }).actor).toBe("agent");
  mkdirSync(join(f.home, "spec-mutations")); const lock = join(f.home, "spec-mutations", `${hash(f.repo)}.lock`); writeFileSync(lock, "foreign-owner\n");
  expect(f.remove().ok).toBe(true);
  const result = f.remove({ confirm: true, fingerprint: preview.fingerprint });
  expect(result.issues[0]!.code).toBe("LOCKED"); expect(readFileSync(lock, "utf8")).toBe("foreign-owner\n"); expect(existsSync(join(f.repo, "SPEC.md"))).toBe(true);
}, 30_000);

test("missing and malformed confirmations refuse; symlink target and foreign worktree refuse", () => {
  const f = fixture();
  for (const request of [{ confirm: true }, { confirm: true, fingerprint: "a".repeat(64) }, { fingerprint: "short" }, { id: "missing" }]) expect(f.remove(request).ok).toBe(false);
  const foreign = fixture(); expect(f.remove({ worktree: foreign.repo }).ok).toBe(false);
  const outside = join(f.root, "outside.md"); writeFileSync(outside, readFileSync(join(f.repo, "SPEC.md"))); rmSync(join(f.repo, "SPEC.md")); symlinkSync(outside, join(f.repo, "SPEC.md"));
  expect(f.remove().ok).toBe(false); expect(existsSync(outside)).toBe(true);
}, 30_000);

test("deletion refuses a different introduced error when a duplicate id becomes the surviving node", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "Z.md"), '---\nid: root\ntype: submodule\ntitle: Duplicate\n---\n');
  const preview = f.remove(), before = tree(f.root), result = f.remove({ confirm: true, fingerprint: preview.fingerprint });
  expect(result).toMatchObject({ ok: false, changed: false, path: "SPEC.md" });
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "type_rank", path: "SPEC.md", target: "child.md" }));
  // Confirm may create its private lock directory, but no repository byte may change.
  expect(tree(f.repo)).toEqual((before as unknown[][]).find(entry => entry[0] === "repo")![1]);
}, 30_000);

for (const mode of ["child-after-lock", "file-after-lock", "policy-after-lock", "tree-after-gate", "final-policy", "final-home-spec", "final-home-vault", "lock-permission", "lock-space", "unlink", "plain-root", "plain-symlink"]) test(`delete ${mode} refuses safely and removes its owned lock`, () => {
  const f = fixture(), preview = f.remove(), before = readFileSync(join(f.repo, "SPEC.md"));
  if (mode === "final-home-spec") f.git(["-c", "init.templateDir=", "init", "--quiet"], f.root);
  if (mode === "final-home-vault") mkdirSync(join(f.root, "notes"));
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/spec-delete-fault.ts"), f.home, mode, preview.fingerprint!], { env: { ...process.env, ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const result = JSON.parse(child.stdout.toString()) as SpecDeleteResult;
  expect(result).toMatchObject({ ok: false, changed: false }); expect(existsSync(join(f.repo, "SPEC.md"))).toBe(true);
  expect(existsSync(join(f.home, "spec-mutations")) ? readdirSync(join(f.home, "spec-mutations")) : []).toEqual([]);
  if (mode.startsWith("plain-")) {
    expect(result.issues[0]!.code).toBe("PATH");
    expect(result.issues[0]!.message).toContain("request a fresh preview");
  }
  if (mode === "child-after-lock" || mode === "file-after-lock") expect(result.issues[0]!.code).toBe("FINGERPRINT");
  if (mode === "final-policy") expect(result.issues[0]!.code).toBe("REGISTRY_DRIFT");
  if (mode.startsWith("final-home-")) {
    expect(result.issues[0]!.code).toBe("HOME");
    const registered = JSON.parse(readFileSync(join(f.home, CONFIG_FILE), "utf8"));
    expect([...registered.vaults, ...registered.specs]).toContainEqual(expect.objectContaining({ id: "container", path: f.root }));
  }
  if (mode !== "file-after-lock") expect(readFileSync(join(f.repo, "SPEC.md"))).toEqual(before);
  if (mode === "lock-permission" || mode === "lock-space") {
    expect(result.issues[0]!.code).toBe("IO");
    expect(result.issues[0]!.message).toContain(mode === "lock-permission" ? "EACCES" : "ENOSPC");
    expect(result.issues[0]!.message).toContain("permissions and free space");
    expect(result.issues[0]!.message).not.toContain("wait for the other mutation");
  }
  expect(result.issues[0]!.message).not.toContain("expectedSha");
  expect(result.issues[0]!.message).not.toContain("spec get");
  expect(result.issues[0]!.message).not.toContain("retry the update");
  expect(result.issues[0]!.message).not.toContain("correct the update");
}, 30_000);

for (const mode of ["dir-fsync", "lock-close", "lock-unlink", "mcp-dir-fsync", "mcp-lock-close", "mcp-lock-unlink"]) test(`post-unlink ${mode} retains deletion and SHA, with applied-with-errors receipt and owned-lock cleanup`, () => {
  const f = fixture(), preview = f.remove();
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/spec-delete-fault.ts"), f.home, mode, preview.fingerprint!], { env: { ...process.env, ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const output = JSON.parse(child.stdout.toString()) as { result: SpecDeleteResult; text: string };
  expect(output.result).toMatchObject({ ok: false, changed: true, path: "SPEC.md", sha256: preview.sha256 });
  expect(existsSync(join(f.repo, "SPEC.md"))).toBe(false);
  expect(output.text).toContain("deleted with errors"); expect(output.text).not.toContain(": refused");
  for (const issue of output.result.issues) {
    expect(issue.message).toContain("deleted file's parent directory");
    expect(issue.message).toContain("lock state under VMEM_HOME");
    expect(issue.message).not.toMatch(/fresh preview|confirm|retry/i);
  }
  expect(readdirSync(join(f.home, "spec-mutations"))).toEqual(mode.endsWith("lock-unlink") ? [`${hash(f.repo)}.lock`] : []);
  if (mode.endsWith("lock-close")) expect(output.result.issues).toContainEqual(expect.objectContaining({ code: "CLEANUP", message: expect.stringContaining("descriptor close") }));
  if (mode.startsWith("mcp-")) {
    expect(output.result.actor).toBe("agent"); expect(output.result).not.toHaveProperty("refused");
  }
}, 30_000);

test("delete preview and confirm refuse a case alias when only its canonical target matches denyPaths", () => {
  const f = fixture(), source = '---\nid: case\ntype: module\ntitle: Case fixture\nparent: root\n---\n';
  f.git(["config", "core.ignorecase", "true"]); writeFileSync(join(f.repo, "Case.md"), source);
  f.git(["add", "Case.md"]); f.git(["commit", "-qm", "Synthetic delete case alias"]);
  const preview = f.remove({ id: "case" }); expect(preview.ok).toBe(true);
  renameSync(join(f.repo, "Case.md"), join(f.repo, "case-temp.md")); renameSync(join(f.repo, "case-temp.md"), join(f.repo, "case.md"));
  const configFile = join(f.home, CONFIG_FILE), config = JSON.parse(readFileSync(configFile, "utf8"));
  config.denyPaths = [join(f.repo, "case.md")]; writeFileSync(configFile, JSON.stringify(config));
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/spec-delete-deny-alias.ts"), f.home, preview.fingerprint!], { env: { ...process.env, ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const output = JSON.parse(child.stdout.toString()) as { preview: SpecDeleteResult; confirm: SpecDeleteResult; lexicalDenied: boolean; canonicalDenied: boolean; canonical: string };
  expect(output.lexicalDenied).toBe(false); expect(output.canonicalDenied).toBe(true);
  expect(output.canonical).toBe(join(f.repo, "case.md"));
  for (const result of [output.preview, output.confirm]) {
    expect(result).toMatchObject({ ok: false, changed: false, path: "Case.md" });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "PATH", message: expect.stringContaining("request a fresh preview") }));
  }
  expect(readFileSync(join(f.repo, "case.md"), "utf8")).toBe(source);
  expect(existsSync(join(f.home, "spec-mutations"))).toBe(false);
}, 30_000);

test("acknowledged dangling links are excluded before result limits; unrelated introduced errors cannot hide", () => {
  const document = (id: string, fields: Record<string, unknown> = {}): SpecDocument => ({ id, path: `${id}.md`, hash: "synthetic", source: "Synthetic", body: "", frontmatter: { id, type: id === "root" ? "goal" : "module", title: id, ...(id === "root" ? {} : { parent: "root" }), ...fields } });
  const children = Array.from({ length: 600 }, (_, index) => document(`child-${String(index).padStart(3, "0")}`));
  const snapshot = (specs: SpecDocument[]): SpecSnapshot => ({ root: "/synthetic", commonDir: "/synthetic/.git", specs, diagnostics: [] });
  const current = snapshot([document("root"), ...children]), prospective = snapshot(children.map((item, index) => index === 599 ? { ...item, frontmatter: { ...item.frontmatter, status: "done" } } : item));
  const allowed = children.map(item => ({ path: item.path, field: "parent", target: "root" }));
  expect(introducedSpecErrors(current, prospective, { git: false, limit: 1 }, allowed)).toEqual([expect.objectContaining({ code: "unknown_status", path: "child-599.md" })]);
  expect(introducedSpecErrors(current, snapshot(children), { git: false }, allowed)).toEqual([]);
  expect(introducedSpecErrors(current, snapshot(children), { git: false, limit: 1 }, allowed.slice(1))).toEqual([expect.objectContaining({ code: "dangling_link", path: "child-000.md" })]);
});
