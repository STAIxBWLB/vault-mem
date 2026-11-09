import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, type SpecSourceSpec } from "../src/config.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { AGENT_MARKERS } from "../src/log-format.ts";
import { memoryGitArgv, memoryGitEnv } from "../src/platform.ts";
import { addSpec } from "../src/registry.ts";
import { specGit } from "../src/spec-git.ts";
import { executeSpecCommand } from "../src/spec-commands.ts";
import { discoverSpecs, MAX_SPEC_MARKDOWN_PATHS } from "../src/spec-source.ts";
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
  const source = addSpec(home, { id: "fixture", path: repo, write, pii }, env);
  const create = (request: Partial<SpecCreateRequest> = {}, channel: "cli" | "mcp" = "cli") => createSpec(home, { path: "new/deep/SPEC.md", id: "child", type: "module", title: "새 설계", parent: "root", ...request }, { env, channel });
  return { root, repo, home, env, git, source, create };
}
function refused(f: ReturnType<typeof fixture>, result: SpecWriteResult, code: string, path = "new/deep/SPEC.md") {
  expect(result).toMatchObject({ ok: false, changed: false, path });
  expect(result.issues).toContainEqual(expect.objectContaining({ code, path, severity: "error" }));
  expect(existsSync(join(f.repo, path))).toBe(false);
  expect(existsSync(join(f.repo, "new"))).toBe(false);
}
function stageAncestorIndex(f: ReturnType<typeof fixture>, input: string): void {
  const argv = memoryGitArgv(["-C", f.repo, "update-index", "--index-info"]);
  const child = spawnSync(argv[0]!, argv.slice(1), { input, env: memoryGitEnv(f.env, { repositoryIsolation: true }), timeout: 10000, maxBuffer: 65536 });
  expect(child.error).toBeUndefined(); expect(child.status, child.stderr.toString()).toBe(0);
}
interface AncestorLookupResult {
  result: SpecWriteResult;
  stageQueries: { args: string[]; maxBuffer: number; bytes: number; records: number; phase: string }[];
  rootChecks: number; ignoreChecks: number; injected: boolean;
}
function ancestorLookup(f: ReturnType<typeof fixture>, mode: string, path: string): AncestorLookupResult {
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/spec-create-ancestor-lookup.ts"), f.home, mode, path], { env: { ...process.env, ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return JSON.parse(child.stdout.toString()) as AncestorLookupResult;
}

for (const path of ["src/new/deep/SPEC.md", "src/[branch]*?/new/SPEC.md"]) test(`create ${path} bounds native index lookups to its own ancestors once per write stage`, () => {
  const f = fixture(), blob = f.git(["rev-parse", "HEAD:source.ts"]);
  // A native sparse index supplies many siblings without creating working files.
  // Unescaped glob selectors would also select the branch-* sibling paths.
  stageAncestorIndex(f, Array.from({ length: 2000 }, (_, index) => `100644 ${blob}\tsrc/branch-${String(index).padStart(4, "0")}.ts\n`).join(""));
  const output = ancestorLookup(f, "observe", path);
  expect(output.result).toMatchObject({ ok: true, changed: true, path });
  expect(output.stageQueries).toHaveLength(3);
  expect(output.stageQueries.map(query => query.phase)).toEqual(["initial", "locked", "publication"]);
  for (const query of output.stageQueries) {
    expect(query.maxBuffer).toBe(64 * 1024);
    expect(query.bytes).toBe(0); expect(query.records).toBe(0);
  }
  expect(output.rootChecks).toBe(3); expect(output.ignoreChecks).toBe(3);
  expect(existsSync(join(f.repo, path))).toBe(true);
  expect(readdirSync(join(f.home, "spec-mutations"))).toEqual([]);
}, 30_000);

for (const mode of ["late-gitlink", "late-nested-repo"]) test(`create rechecks ${mode} only after staging and preserves external metadata on refusal`, () => {
  const f = fixture(), path = "src/new/deep/SPEC.md", before = readFileSync(join(f.repo, "SPEC.md"));
  const output = ancestorLookup(f, mode, path);
  expect(output.injected).toBe(true);
  expect(output.stageQueries.map(query => query.phase)).toEqual(["initial", "locked", "publication"]);
  expect(output.result).toMatchObject({ ok: false, changed: false, path });
  expect(output.result.issues).toContainEqual(expect.objectContaining({ code: "PATH", message: expect.stringMatching(/nested repository|gitlink/) }));
  expect(existsSync(join(f.repo, path))).toBe(false);
  expect(existsSync(join(f.repo, "src/new/deep"))).toBe(false);
  expect(readFileSync(join(f.repo, "SPEC.md"))).toEqual(before);
  expect(readdirSync(join(f.home, "spec-mutations"))).toEqual([]);
  if (mode === "late-gitlink") expect(f.git(["ls-files", "--stage", "--", "src/new"])).toMatch(/^160000 /);
  else {
    expect(existsSync(join(f.repo, "src/new/.git"))).toBe(true);
    expect(f.git(["rev-parse", "--show-toplevel"], join(f.repo, "src/new"))).toBe(join(f.repo, "src/new"));
  }
}, 30_000);

test("ambiguous Unicode ancestor expansion refuses within the request spelling budget", () => {
  const f = fixture(), ancestor = "É".repeat(11), path = `${ancestor}/SPEC.md`;
  const output = ancestorLookup(f, "observe", path);
  expect(output.result).toMatchObject({ ok: false, changed: false, path });
  expect(output.result.issues).toContainEqual(expect.objectContaining({ code: "LIMIT", message: expect.stringContaining("1024") }));
  expect(output.result.issues[0]!.message).toContain("request budget");
  expect(output.result.issues[0]!.message).toMatch(/inspect.*ancestor|shallower|unambiguous/);
  expect(output.stageQueries).toEqual([]);
  expect(existsSync(join(f.repo, ancestor))).toBe(false);
  expect(existsSync(join(f.home, "spec-mutations"))).toBe(false);
}, 30_000);

test("wrapped Git index output overflow identifies the bounded gitlink check and a practical next step", () => {
  const f = fixture(), path = "src/new/deep/SPEC.md", output = ancestorLookup(f, "overflow", path);
  expect(output.result).toMatchObject({ ok: false, changed: false, path });
  const message = output.result.issues[0]!.message;
  expect(message).toContain("gitlink"); expect(message).toMatch(/ENOBUFS|index.*too large/i);
  expect(message).toMatch(/inspect.*index|shallower|unambiguous/i);
  expect(message).not.toContain("SPEC.md paths more specific");
  expect(existsSync(join(f.repo, "src"))).toBe(false);
  expect(existsSync(join(f.home, "spec-mutations"))).toBe(false);
}, 30_000);

for (const [indexed, requested] of [["Vendor/Café", "vendor/café/new/SPEC.md"], ["Vendor/Café", "vendor/CAFÉ/new/SPEC.md"]] as const) test(`create refuses missing gitlink ${indexed} through canonical Unicode and case alias ${requested}`, () => {
  const f = fixture(), commit = f.git(["rev-parse", "HEAD"]);
  stageAncestorIndex(f, `160000 ${commit}\t${indexed}\n`);
  expect(existsSync(join(f.repo, indexed))).toBe(false);
  const output = ancestorLookup(f, "observe", requested);
  expect(output.result).toMatchObject({ ok: false, changed: false, path: requested });
  expect(output.result.issues).toContainEqual(expect.objectContaining({ code: "PATH", message: expect.stringContaining("gitlink") }));
  expect(output.stageQueries).toHaveLength(1);
  expect(output.stageQueries[0]!).toMatchObject({ maxBuffer: 64 * 1024, records: 1 });
  expect(existsSync(join(f.repo, "vendor"))).toBe(false);
  expect(existsSync(join(f.home, "spec-mutations"))).toBe(false);
}, 30_000);

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

test("create counts skipped Git-listed Markdown at the discovery cap and preserves readable sources", () => {
  const f = fixture(), blob = f.git(["rev-parse", "HEAD:source.ts"]);
  // Native Git lists 10,000 Markdown inputs; only SPEC.md exists on disk.
  // The absent entries reuse one existing blob, avoiding 10,000 fixture files.
  stageAncestorIndex(f, Array.from({ length: MAX_SPEC_MARKDOWN_PATHS - 1 }, (_, index) => `100644 ${blob}\tordinary-${String(index).padStart(4, "0")}.md\n`).join(""));
  const before = discoverSpecs(f.source, { env: f.env });
  expect(before.markdownPaths).toHaveLength(MAX_SPEC_MARKDOWN_PATHS);
  expect(before.specs.map(spec => spec.id)).toEqual(["root"]);
  expect(before.candidates).toHaveLength(1);
  const result = f.create();
  refused(f, result, "LIMIT");
  expect(result.issues[0]!.message).toContain("10000");
  expect(result.issues[0]!.message).toContain("remove or ignore");
  expect(existsSync(join(f.home, "spec-mutations"))).toBe(false);
  expect(executeSpecCommand(f.home, "get", { id: "root" }, f.env)).toMatchObject({ path: "SPEC.md", frontmatter: { id: "root" } });
  // Replacing an already-counted absent input consumes no additional slot.
  stageAncestorIndex(f, `0 ${"0".repeat(blob.length)}\tordinary-0000.md\n100644 ${blob}\tnew/deep/SPEC.md\n`);
  expect(f.create()).toMatchObject({ ok: true, changed: true, path: "new/deep/SPEC.md" });
  const after = discoverSpecs(f.source, { env: f.env });
  expect(after.markdownPaths).toHaveLength(MAX_SPEC_MARKDOWN_PATHS);
  expect(new Set(after.specs.map(spec => spec.id))).toEqual(new Set(["root", "child"]));
}, 60_000);

for (const [name, separator] of [["NEL", ""], ["LS", " "], ["PS", " "], ["tab", "\t"], ["NUL", Buffer.alloc(1).toString()]] as const) test(`create rejects ${name} in a title before changing source bytes`, () => {
  const f = fixture(), before = readFileSync(join(f.repo, "SPEC.md"));
  const result = f.create({ title: `Title${separator}injection` });
  refused(f, result, "INPUT");
  expect(result.issues[0]!.message).toContain("control");
  expect(result.issues[0]!.message).toContain("plain single-line text");
  expect(readFileSync(join(f.repo, "SPEC.md"))).toEqual(before);
  expect(existsSync(join(f.home, "spec-mutations"))).toBe(false);
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

test("create checks a leading-colon directory as a literal ignored path before taking a lock", () => {
  const f = fixture(); writeFileSync(join(f.repo, ".gitignore"), "ignored/\n/:/\n");
  const before = f.git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const result = f.create({ path: ":/x.md" });
  expect(result).toMatchObject({ ok: false, changed: false, path: ":/x.md" });
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "PATH" }));
  expect(existsSync(join(f.repo, ":"))).toBe(false);
  expect(existsSync(join(f.home, "spec-mutations"))).toBe(false);
  expect(f.git(["status", "--porcelain=v1", "--untracked-files=all"])).toBe(before);
}, 30_000);

for (const path of [":!x.md", ":(literal)x.md"]) test(`create treats unignored ${path} as a literal filename`, () => {
  const f = fixture(), result = f.create({ path, id: "literal-child" });
  expect(result).toMatchObject({ ok: true, changed: true, path });
  expect(parseFrontmatter(readFileSync(join(f.repo, path), "utf8")).data.id).toBe("literal-child");
  expect(f.git(["status", "--porcelain=v1", "--untracked-files=all"])).toContain(path);
  expect(readdirSync(join(f.home, "spec-mutations"))).toEqual([]);
}, 30_000);

test("create refuses an untracked nested Git repository before adding a file or directories", () => {
  const f = fixture(), embedded = join(f.repo, "embedded"); mkdirSync(embedded);
  f.git(["-c", "init.templateDir=", "init", "--quiet"], embedded);
  const before = f.git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const result = f.create({ path: "embedded/new/SPEC.md" });
  expect(result).toMatchObject({ ok: false, changed: false, path: "embedded/new/SPEC.md" });
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "PATH", message: expect.stringMatching(/nested repository|submodule/) }));
  expect(result.issues[0]!.message).toContain("own"); expect(result.issues[0]!.message).toContain("source");
  expect(existsSync(join(embedded, "new"))).toBe(false);
  expect(existsSync(join(f.home, "spec-mutations"))).toBe(false);
  expect(f.git(["status", "--porcelain=v1", "--untracked-files=all"])).toBe(before);
}, 30_000);

for (const initialized of [true, false]) test(`create refuses a real indexed Git submodule with ${initialized ? "an initialized" : "a missing"} workdir`, () => {
  const f = fixture(), child = join(f.root, "child-source"); mkdirSync(child);
  f.git(["-c", "init.templateDir=", "init", "--quiet"], child);
  writeFileSync(join(child, "README.md"), "Synthetic child repository.\n");
  f.git(["add", "."], child); f.git(["commit", "-qm", "Synthetic child fixture"], child);
  f.git(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", child, "vendor/child"]);
  if (!initialized) {
    f.git(["submodule", "deinit", "--force", "--", "vendor/child"]);
    rmSync(join(f.repo, "vendor/child"), { recursive: true, force: true });
  }
  expect(f.git(["ls-files", "--stage", "--", "vendor/child"])).toMatch(/^160000 /);
  const before = f.git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const result = f.create({ path: "vendor/child/new/SPEC.md" });
  expect(result).toMatchObject({ ok: false, changed: false, path: "vendor/child/new/SPEC.md" });
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "PATH", message: expect.stringMatching(/nested repository|submodule/) }));
  expect(result.issues[0]!.message).toContain("own"); expect(result.issues[0]!.message).toContain("source");
  expect(existsSync(join(f.repo, "vendor/child/new"))).toBe(false);
  if (!initialized) expect(existsSync(join(f.repo, "vendor/child"))).toBe(false);
  expect(existsSync(join(f.home, "spec-mutations"))).toBe(false);
  expect(f.git(["status", "--porcelain=v1", "--untracked-files=all"])).toBe(before);
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

for (const mode of ["policy-drift", "final-policy", "final-home-spec", "final-home-vault", "lock-permission", "target-appears", "temp-write", "tree-drift", "publish", "publish-race", "link-EPERM", "link-ENOTSUP", "link-EXDEV"]) test(`create ${mode} refusal cleans owned staging and preserves a concurrent writer's file`, () => {
  const f = fixture();
  if (mode === "final-home-spec") f.git(["-c", "init.templateDir=", "init", "--quiet"], f.root);
  if (mode === "final-home-vault") mkdirSync(join(f.root, "notes"));
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/spec-create-fault.ts"), f.home, mode], { env: { ...process.env, ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString()) as SpecWriteResult;
  expect(result).toMatchObject({ ok: false, changed: false });
  expect(result.issues[0]!.message).toContain("create");
  if (mode === "tree-drift" || mode === "publish") {
    expect(result.issues[0]!.message).toMatch(/create|source tree/);
    expect(result.issues[0]!.message).not.toContain("expectedSha");
    expect(result.issues[0]!.message).not.toContain("retry the update");
    expect(result.issues[0]!.message).not.toContain("correct the update");
  }
  if (mode === "final-policy") expect(result.issues[0]!.code).toBe("REGISTRY_DRIFT");
  if (mode.startsWith("final-home-")) {
    expect(result.issues[0]!.code).toBe("HOME");
    const registered = JSON.parse(readFileSync(join(f.home, CONFIG_FILE), "utf8"));
    expect([...registered.vaults, ...registered.specs]).toContainEqual(expect.objectContaining({ id: "container", path: f.root }));
  }
  if (mode === "lock-permission") {
    expect(result.issues[0]!.code).toBe("IO");
    expect(result.issues[0]!.message).toContain("EACCES");
    expect(result.issues[0]!.message).toContain("permissions and free space");
    expect(result.issues[0]!.message).not.toContain("wait for the other mutation");
  }
  if (mode.startsWith("link-")) {
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "LINK", path: "new/deep/SPEC.md", message: expect.stringContaining(mode.slice(5)) }));
    expect(result.issues[0]!.message).toContain("filesystem hard-link support and permissions");
    expect(result.issues[0]!.message).toContain("never falls back to rename");
  }
  const file = join(f.repo, "new/deep/SPEC.md");
  if (mode === "target-appears" || mode === "publish-race") {
    expect(readFileSync(file, "utf8")).toBe("foreign file\n");
    expect(readdirSync(join(f.repo, "new/deep"))).toEqual(["SPEC.md"]);
    if (mode === "publish-race") {
      expect(result.issues[0]!).toMatchObject({ code: "EEXIST", severity: "error" });
      const cleanup = result.issues.filter(issue => issue.code === "CLEANUP");
      expect(cleanup.length).toBeGreaterThan(0);
      for (const issue of cleanup) {
        expect(issue.severity).toBe("warning");
        expect(issue.message).toContain("ENOTEMPTY");
        expect(issue.message).toContain("kept");
        expect(issue.message).not.toContain("cleanup failed");
      }
    }
  } else expect(existsSync(join(f.repo, "new"))).toBe(false);
  expect(readdirSync(join(f.home, "spec-mutations"))).toEqual([]);
}, 30_000);

for (const mode of ["dir-fsync", "ancestor-sync", "lock-close", "mcp-dir-fsync", "mcp-ancestor-sync", "mcp-lock-close"]) test(`post-link ${mode} retains created bytes, SHA and applied-with-errors receipt`, () => {
  const f = fixture();
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/spec-create-fault.ts"), f.home, mode], { env: { ...process.env, ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const output = JSON.parse(child.stdout.toString()) as { result: SpecWriteResult; text: string; syncPaths: string[] };
  expect(output.result).toMatchObject({ ok: false, changed: true, path: "new/deep/SPEC.md" });
  expect(output.text).toContain("created with errors"); expect(output.text).not.toContain(": refused");
  const bytes = readFileSync(join(f.repo, "new/deep/SPEC.md"));
  expect(parseFrontmatter(bytes.toString()).data.title).toBe("Attempted create");
  expect(output.result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(readdirSync(join(f.repo, "new/deep"))).toEqual(["SPEC.md"]);
  expect(readdirSync(join(f.home, "spec-mutations"))).toEqual([]);
  if (mode.endsWith("ancestor-sync")) {
    expect(output.syncPaths).toEqual([join(f.repo, "new/deep"), join(f.repo, "new")]);
    expect(output.result.issues).toContainEqual(expect.objectContaining({ code: "IO", message: expect.stringContaining("created ancestor sync failure") }));
  }
  if (mode.endsWith("lock-close")) expect(output.result.issues).toContainEqual(expect.objectContaining({ code: "CLEANUP", message: expect.stringContaining("descriptor close") }));
  if (mode.startsWith("mcp-")) {
    expect(output.result.actor).toBe("agent");
    expect(output.result).not.toHaveProperty("refused");
  }
}, 30_000);

test("created-parent cleanup failures name the directory, errno and ownership/access recovery", () => {
  const f = fixture();
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/spec-create-fault.ts"), f.home, "cleanup-permission"], { env: { ...process.env, ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const result = JSON.parse(child.stdout.toString()) as SpecWriteResult;
  expect(result).toMatchObject({ ok: false, changed: false, path: "new/deep/SPEC.md" });
  const cleanup = result.issues.find(issue => issue.code === "CLEANUP" && issue.message.includes("EACCES"));
  expect(cleanup).toMatchObject({ severity: "error", path: "new/deep/SPEC.md" });
  expect(cleanup!.message).toContain(join(f.repo, "new/deep"));
  expect(cleanup!.message).toContain("ownership and access");
  expect(cleanup!.message).toContain("repair the reported cause");
  expect(existsSync(join(f.repo, "new/deep/SPEC.md"))).toBe(false);
  expect(readdirSync(join(f.repo, "new/deep"))).toEqual([]);
  expect(readdirSync(join(f.home, "spec-mutations"))).toEqual([]);
}, 30_000);

test("create honors umask 027 for files and new parents while update preserves its original mode", () => {
  const f = fixture();
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/spec-create-fault.ts"), f.home, "umask-027"], { env: { ...process.env, ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const output = JSON.parse(child.stdout.toString()) as { result: SpecWriteResult; fileMode: number; directoryModes: number[]; update: SpecWriteResult; updateMode: number };
  expect(output.result).toMatchObject({ ok: true, changed: true });
  expect(output.fileMode).toBe(0o640); expect(output.directoryModes).toEqual([0o750, 0o750]);
  expect(output.update).toMatchObject({ ok: true, changed: true }); expect(output.updateMode).toBe(0o664);
  expect(parseFrontmatter(readFileSync(join(f.repo, "new/deep/SPEC.md"), "utf8")).data.title).toBe("Updated mode fixture");
  expect(readdirSync(join(f.home, "spec-mutations"))).toEqual([]);
}, 30_000);

test("create syncs the published file's directory and each newly created directory entry deepest first", () => {
  const f = fixture();
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/spec-create-fault.ts"), f.home, "sync-order"], { env: { ...process.env, ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const output = JSON.parse(child.stdout.toString()) as { result: SpecWriteResult; syncPaths: string[] };
  expect(output.result).toMatchObject({ ok: true, changed: true });
  expect(output.syncPaths).toEqual([join(f.repo, "new/deep"), join(f.repo, "new"), f.repo]);
  expect(existsSync(join(f.repo, "new/deep/SPEC.md"))).toBe(true);
  expect(readdirSync(join(f.home, "spec-mutations"))).toEqual([]);
}, 30_000);

test("create refuses a case-alias parent when only its canonical target matches denyPaths", () => {
  const f = fixture(); mkdirSync(join(f.repo, "case"));
  const configFile = join(f.home, CONFIG_FILE), config = JSON.parse(readFileSync(configFile, "utf8"));
  config.denyPaths = [join(f.repo, "case/new/SPEC.md")]; writeFileSync(configFile, JSON.stringify(config));
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/spec-create-deny-alias.ts"), f.home], { env: { ...process.env, ...f.env }, stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const output = JSON.parse(child.stdout.toString()) as { result: SpecWriteResult; lexicalDenied: boolean; canonicalDenied: boolean; canonical: string };
  expect(output.lexicalDenied).toBe(false); expect(output.canonicalDenied).toBe(true);
  expect(output.canonical).toBe(join(f.repo, "case/new/SPEC.md"));
  expect(output.result).toMatchObject({ ok: false, changed: false, path: "Case/new/SPEC.md" });
  expect(output.result.issues).toContainEqual(expect.objectContaining({ code: "PATH" }));
  expect(readdirSync(join(f.repo, "case"))).toEqual([]);
  expect(existsSync(join(f.home, "spec-mutations"))).toBe(false);
}, 30_000);
