import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SpecSourceSpec } from "../src/config.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { AGENT_MARKERS } from "../src/log-format.ts";
import { addSpec } from "../src/registry.ts";
import { specGit } from "../src/spec-git.ts";
import { createSpec, type SpecCreateRequest, type SpecWriteResult } from "../src/spec-write.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(write: SpecSourceSpec["write"] = "mcp", pii: SpecSourceSpec["pii"] = "allow") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-spec-create-"))); roots.push(root);
  const repo = join(root, "repo"), home = join(root, "state"); mkdirSync(repo);
  const env = { HOME: root, PATH: process.env.PATH, VMEM_HOME: home };
  const git = (args: string[], cwd = repo) => specGit(cwd, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { env }).stdout.toString().trim();
  git(["-c", "init.templateDir=", "init", "--quiet"]);
  writeFileSync(join(repo, "SPEC.md"), '---\nid: root\ntype: goal\ntitle: Root\n---\n# Root\n');
  writeFileSync(join(repo, "source.ts"), "synthetic source\n");
  writeFileSync(join(repo, ".gitignore"), "ignored/\n");
  git(["add", "."]); git(["commit", "-qm", "Synthetic create fixture"]);
  addSpec(home, { id: "fixture", path: repo, write, pii }, env);
  const create = (request: Partial<SpecCreateRequest> = {}, channel: "cli" | "mcp" = "cli") => createSpec(home, { path: "new/deep/SPEC.md", id: "child", type: "module", title: "새 설계", parent: "root", ...request }, { env, channel });
  return { root, repo, home, env, git, create };
}
function refused(f: ReturnType<typeof fixture>, result: SpecWriteResult, code: string, path = "new/deep/SPEC.md") {
  expect(result).toMatchObject({ ok: false, changed: false, path });
  expect(result.issues).toContainEqual(expect.objectContaining({ code, path, severity: "error" }));
  expect(existsSync(join(f.repo, path))).toBe(false);
  expect(existsSync(join(f.repo, "new"))).toBe(false);
}

test("AC8: create orders metadata, defaults draft, writes LF headings only and leaves an untracked file", () => {
  const f = fixture(), head = f.git(["rev-parse", "HEAD"]), refs = f.git(["for-each-ref"]);
  const result = f.create({ "verified-against": head, paths: ["source.ts"], tags: ["synthetic"], covers: ["token"], implements: ["root"], references: ["root"], "depends-on": ["root"] });
  expect(result).toMatchObject({ ok: true, changed: true, actor: "person", path: "new/deep/SPEC.md" });
  const bytes = readFileSync(join(f.repo, result.path!)), text = bytes.toString();
  expect(bytes[0]).toBe(45); expect(text).not.toContain("\r");
  const parsed = parseFrontmatter(text);
  expect(Object.keys(parsed.data)).toEqual(["id", "type", "title", "status", "parent", "depends-on", "references", "implements", "covers", "tags", "paths", "verified-against"]);
  expect(parsed.data.status).toBe("draft");
  expect(parsed.body).toBe("# 새 설계\n\n## Responsibility\n\n## Interfaces\n\n## Decisions\n\n");
  expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(f.git(["status", "--porcelain=v1", "--untracked-files=all"])).toBe("?? new/deep/SPEC.md");
  expect(f.git(["rev-parse", "HEAD"])).toBe(head); expect(f.git(["for-each-ref"])).toBe(refs);
  expect(readdirSync(join(f.home, "spec-mutations"))).toEqual([]);
  expect(readdirSync(join(f.repo, "new/deep"))).toEqual(["SPEC.md"]);
}, 30_000);

for (const [type, headings] of [
  ["goal", ["Scope", "Decisions", "Success and evidence"]], ["architecture", ["Boundaries", "Decisions"]],
  ["module", ["Responsibility", "Interfaces", "Decisions"]], ["submodule", ["Responsibility", "Interfaces", "Decisions"]],
] as const) test(`create ${type} headings and explicit deprecated replacement field order`, () => {
  const f = fixture(), result = f.create({ type, parent: undefined, status: "deprecated", "superseded-by": "root" });
  expect(result.ok).toBe(true);
  const parsed = parseFrontmatter(readFileSync(join(f.repo, result.path!), "utf8"));
  expect(parsed.body).toBe("# 새 설계\n\n" + headings.map(heading => `## ${heading}\n\n`).join(""));
  expect(Object.keys(parsed.data)).toEqual(["id", "type", "title", "status", "superseded-by"]);
}, 30_000);

for (const [request, code] of [
  [{ "depends-on": ["missing"] }, "dangling_link"], [{ parent: "child" }, "parent_cycle"],
  [{ type: "goal" }, "type_rank"], [{ id: "root", path: "A.md" }, "duplicate_id"],
] as [Partial<SpecCreateRequest>, string][]) test(`AC5: create refuses ${code} without leaving a file or directories`, () => {
  const f = fixture(), result = f.create(request), path = request.path ?? "new/deep/SPEC.md";
  refused(f, result, code, path);
  if (code === "duplicate_id") expect(result.issues).toContainEqual(expect.objectContaining({ path: "A.md", target: "SPEC.md" }));
  expect(f.git(["status", "--porcelain=v1"])).toBe("");
}, 30_000);

for (const [pii, title, code] of [
  ["allow", "password: synthetic-value", "V06"], ["deny", "fixture@example.invalid", "V07"], ["deny", "+1 (415) 555-0123", "V07"],
] as const) test(`AC7: create ${code} refusal before creating directories or revealing matched content`, () => {
  const f = fixture("mcp", pii), result = f.create({ title });
  refused(f, result, code); expect(JSON.stringify(result)).not.toContain(title);
}, 30_000);

test("AC7: allow permits PII, policies gate both channels, and agent markers determine actor", () => {
  const allow = fixture(); expect(allow.create({ title: "fixture@example.invalid +1 (415) 555-0123" }).ok).toBe(true);
  const none = fixture("none");
  for (const channel of ["cli", "mcp"] as const) refused(none, none.create({}, channel), "POLICY");
  const cli = fixture("cli"); refused(cli, cli.create({}, "mcp"), "POLICY"); expect(cli.create().ok).toBe(true);
  const f = fixture(); expect(f.create({}, "mcp").actor).toBe("agent");
  for (const [index, key] of AGENT_MARKERS.entries()) expect(createSpec(f.home, { path: `marker-${index}.md`, id: `marker-${index}`, type: "module", title: "Marker" }, { env: { ...f.env, [key]: "set" } })).toMatchObject({ ok: true, actor: "agent" });
}, 30_000);

test("create refuses existing files, directories, symlink components, ignored and escaping paths", () => {
  const f = fixture(), before = readFileSync(join(f.repo, "SPEC.md"));
  expect(f.create({ path: "SPEC.md" }).ok).toBe(false); expect(readFileSync(join(f.repo, "SPEC.md"))).toEqual(before);
  mkdirSync(join(f.repo, "directory.md")); expect(f.create({ path: "directory.md" }).ok).toBe(false);
  const outside = join(f.root, "outside"); mkdirSync(outside); symlinkSync(outside, join(f.repo, "linked"));
  symlinkSync(join(outside, "absent.md"), join(f.repo, "dangling.md"));
  for (const path of ["linked/SPEC.md", "dangling.md", "ignored/SPEC.md", "../escape.md", "/tmp/escape.md", "a/../escape.md", "a.txt", ".git/SPEC.md", "a//SPEC.md", "a\\SPEC.md"]) expect(f.create({ path }).ok).toBe(false);
  expect(readdirSync(outside)).toEqual([]); expect(existsSync(join(f.repo, "ignored"))).toBe(false);
}, 30_000);

test("create refuses invalid metadata, preserves pre-existing errors and isolates linked worktrees", () => {
  const f = fixture();
  for (const request of [{ title: "" }, { title: "Heading\nInjected" }, { type: "task" }, { status: "done" }, { rogue: "field" }, { tags: [1] }, { body: "not accepted" }]) refused(f, f.create(request as Partial<SpecCreateRequest>), "INPUT");
  writeFileSync(join(f.repo, "broken.md"), '---\nid: broken\ntype: invalid\ntitle: Broken\n---\n');
  expect(f.create().ok).toBe(true);
  const linked = join(f.root, "linked"); f.git(["worktree", "add", "--detach", linked, "HEAD"]);
  expect(f.create({ worktree: linked, path: "linked.md" }).ok).toBe(true);
  expect(existsSync(join(f.repo, "linked.md"))).toBe(false); expect(existsSync(join(linked, "linked.md"))).toBe(true);
}, 30_000);

for (const mode of ["policy-drift", "target-appears", "temp-write", "tree-drift", "publish", "publish-race", "link-EPERM", "link-ENOTSUP", "link-EXDEV"]) test(`create ${mode} refusal cleans owned staging and preserves a concurrent writer's file`, () => {
  const f = fixture();
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/spec-create-fault.ts"), f.home, mode], { env: { ...process.env, ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString()) as SpecWriteResult;
  expect(result).toMatchObject({ ok: false, changed: false });
  if (mode.startsWith("link-")) {
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "LINK", path: "new/deep/SPEC.md", message: expect.stringContaining(mode.slice(5)) }));
    expect(result.issues[0]!.message).toContain("filesystem hard-link support and permissions");
    expect(result.issues[0]!.message).toContain("never falls back to rename");
  }
  const file = join(f.repo, "new/deep/SPEC.md");
  if (mode === "target-appears" || mode === "publish-race") {
    expect(readFileSync(file, "utf8")).toBe("foreign file\n");
    expect(readdirSync(join(f.repo, "new/deep"))).toEqual(["SPEC.md"]);
    if (mode === "publish-race") expect(result.issues[0]!.code).toBe("EEXIST");
  } else expect(existsSync(join(f.repo, "new"))).toBe(false);
  expect(readdirSync(join(f.home, "spec-mutations"))).toEqual([]);
}, 30_000);
