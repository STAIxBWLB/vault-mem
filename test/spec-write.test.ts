import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_FILE, type SpecSourceSpec } from "../src/config.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { AGENT_MARKERS } from "../src/log-format.ts";
import { addSpec } from "../src/registry.ts";
import { specGit } from "../src/spec-git.ts";
import { discoverSpecs } from "../src/spec-source.ts";
import { introducedSpecErrors } from "../src/spec-validate.ts";
import { attributeSpecErrors, prospectiveSpecSnapshot, updateSpec, type SpecUpdateRequest, type SpecWriteResult } from "../src/spec-write.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (source: string | Buffer) => createHash("sha256").update(source).digest("hex");
function fixture(write: SpecSourceSpec["write"] = "mcp", pii: SpecSourceSpec["pii"] = "allow") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-spec-write-"))); roots.push(root);
  const repo = join(root, "repo"), home = join(root, "state"); mkdirSync(repo);
  const env = { HOME: root, PATH: process.env.PATH, VMEM_HOME: home };
  const git = (args: string[], cwd = repo) => specGit(cwd, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { env }).stdout.toString().trim();
  const put = (path: string, source: string, cwd = repo) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), source); };
  git(["-c", "init.templateDir=", "init", "--quiet"]);
  put("design.md", '---\nid: root\ntype: goal\ntitle: Root\nstatus: draft\n---\n# Root\n');
  const original = "﻿---\r\nid: child\r\ntype: module\r\ntitle: 'Child' # keep title syntax on no-op\r\nparent: root\r\nstatus: draft\r\ntags: [old, keep]\r\ncustom: {answer: 42} # untouched\r\n---\r\n# 본문\r\n\r\nKeep **all bytes**, including 한국어 and trailing spaces.  \r\n";
  put("nested/SPEC.md", original); put("src/a.ts", "synthetic source\n");
  git(["add", "."]); git(["commit", "-qm", "Synthetic spec tree"]);
  const source = addSpec(home, { id: "test", path: repo, write, pii }, env);
  const read = (path = "nested/SPEC.md", cwd = repo) => readFileSync(join(cwd, path), "utf8");
  const update = (request: Partial<SpecUpdateRequest> = {}, channel: "cli" | "mcp" = "cli") => updateSpec(home, { id: "child", ...request }, { env, channel });
  return { root, repo, home, env, source, original, git, put, read, update };
}
function assertRefused(result: SpecWriteResult, code: string, path = "nested/SPEC.md") {
  expect(result).toMatchObject({ ok: false, changed: false, path });
  expect(result.issues.some(issue => issue.code === code && issue.path === path)).toBe(true);
}

test("AC4/AC8: update preserves BOM, CRLF/body bytes, unrelated frontmatter and ordinary Git state", () => {
  const f = fixture(), head = f.git(["rev-parse", "HEAD"]), refs = f.git(["for-each-ref"]), before = f.read();
  const result = f.update({ expectedSha: sha(before), set: { title: "Edited" }, unset: ["status"], add: { tags: ["new", "new"] }, remove: { tags: ["old"] } });
  expect(result).toMatchObject({ ok: true, changed: true, actor: "person", path: "nested/SPEC.md", sha256: sha(f.read()) });
  expect(Buffer.from(f.read()).subarray(0, 3)).toEqual(Buffer.from(before).subarray(0, 3));
  expect(Buffer.from(parseFrontmatter(f.read()).body)).toEqual(Buffer.from(parseFrontmatter(before).body));
  expect(f.read()).toContain("custom: {answer: 42} # untouched\r\n");
  expect(f.read().replaceAll("\r\n", "")).not.toContain("\n");
  expect(parseFrontmatter(f.read()).data).toMatchObject({ id: "child", type: "module", title: "Edited", tags: ["keep", "new"] });
  expect(parseFrontmatter(f.read()).data.status).toBeUndefined();
  expect(f.git(["status", "--porcelain=v1"])).toBe("M nested/SPEC.md");
  expect(f.git(["rev-parse", "HEAD"])).toBe(head); expect(f.git(["for-each-ref"])).toBe(refs);
  expect(readdirSync(join(f.home, "spec-mutations"))).toEqual([]);
  const stale = f.update({ expectedSha: sha(before), set: { title: "Lost update" } });
  assertRefused(stale, "EXPECTED_SHA"); expect(sha(f.read())).toBe(result.sha256!);
}, 30_000);

test("no-op leaves source metadata and the home unchanged, including no lock directory", () => {
  const f = fixture(), file = join(f.repo, "nested/SPEC.md"), before = statSync(file).mtimeMs;
  const result = f.update({ expectedSha: sha(f.original), set: { title: "Child" }, unset: ["verified-against"], add: { tags: ["old"] }, remove: { references: ["absent"] } });
  expect(result).toMatchObject({ ok: true, changed: false, sha256: sha(f.original), actor: "person" });
  expect(f.read()).toBe(f.original); expect(statSync(file).mtimeMs).toBe(before);
  expect(existsSync(join(f.home, "spec-mutations"))).toBe(false); expect(f.git(["status", "--porcelain=v1"])).toBe("");
}, 30_000);

for (const [name, request, code] of [
  ["dangling link", { add: { "depends-on": ["missing"] } }, "dangling_link"],
  ["cycle", { id: "root", set: { parent: "child" } }, "parent_cycle"],
  ["rank", { set: { type: "goal" } }, "type_rank"],
] as [string, Partial<SpecUpdateRequest>, string][]) test(`AC5: ${name} refuses introduced errors without changing files`, () => {
  const f = fixture(), before = [f.read(), f.read("design.md")];
  const result = f.update(request);
  assertRefused(result, code, request.id === "root" ? "design.md" : "nested/SPEC.md");
  expect([f.read(), f.read("design.md")]).toEqual(before); expect(f.git(["status", "--porcelain=v1"])).toBe("");
}, 30_000);

test("the gate permits old errors and attributes related-file errors to the file being updated", () => {
  const f = fixture();
  f.put("broken/SPEC.md", '---\nid: broken\ntype: unknown\ntitle: Broken\n---\n');
  expect(f.update({ set: { title: "Unrelated fix" } }).ok).toBe(true);
  const before = f.read("design.md"), result = f.update({ id: "root", set: { type: "submodule" } });
  assertRefused(result, "type_rank", "design.md");
  expect(result.issues).toContainEqual(expect.objectContaining({ path: "design.md", target: "nested/SPEC.md", code: "type_rank" }));
  expect(f.read("design.md")).toBe(before);
}, 30_000);

test("prospective replacement/add/remove stays in memory, including duplicate path attribution", () => {
  const f = fixture(), current = discoverSpecs(f.source, { env: f.env });
  const next = prospectiveSpecSnapshot(current, new Map([["A.md", f.read("design.md")]]));
  const errors = introducedSpecErrors(current, next, { env: f.env });
  expect(errors).toContainEqual(expect.objectContaining({ code: "duplicate_id", path: "design.md", target: "A.md" }));
  expect(attributeSpecErrors(errors, "A.md")).toContainEqual(expect.objectContaining({ code: "duplicate_id", path: "A.md", target: "design.md" }));
  expect(existsSync(join(f.repo, "A.md"))).toBe(false);
  const removed = prospectiveSpecSnapshot(current, new Map([["nested/SPEC.md", null]]));
  expect(removed.candidates!.some(value => value.path === "nested/SPEC.md")).toBe(false);
  expect(f.read()).toBe(f.original);
}, 30_000);

for (const [name, title, pii, code] of [
  ["secret under allow", "Synthetic ghp_" + "a".repeat(36), "allow", "V06"],
  ["email under deny", "fixture@example.invalid", "deny", "V07"],
  ["phone under deny", "+1 (415) 555-0123", "deny", "V07"],
] as const) test(`AC7: ${name} is screened using the shared rules`, () => {
  const f = fixture("mcp", pii), result = f.update({ set: { title } });
  assertRefused(result, code); expect(f.read()).toBe(f.original); expect(JSON.stringify(result)).not.toContain(title);
}, 30_000);

test("AC7: a pre-existing quoted secret key refuses an unrelated title update", () => {
  const f = fixture(), before = f.original.replace("custom: {answer: 42}", '"password": "synthetic-value"\r\ncustom: {answer: 42}');
  f.put("nested/SPEC.md", before);
  const result = f.update({ set: { title: "Unrelated edit" } });
  assertRefused(result, "V06");
  expect(f.read()).toBe(before);
  expect(JSON.stringify(result)).not.toContain("synthetic-value");
}, 30_000);

test("PII allow permits email/phone, policies refuse channels, actors match MCP and marker attribution", () => {
  const allow = fixture(); expect(allow.update({ set: { title: "fixture@example.invalid +1 (415) 555-0123" } }).ok).toBe(true);
  for (const write of ["cli", "none"] as const) {
    const f = fixture(write), before = f.read(), denied = f.update({ set: { title: "Denied" } }, "mcp");
    expect(denied).toMatchObject({ ok: false, changed: false, path: "nested/SPEC.md" }); expect(denied.issues[0]!.message).toContain(write); expect(f.read()).toBe(before);
    if (write === "none") expect(f.update({ set: { title: "Denied" } }).ok).toBe(false);
    else expect(f.update({ set: { title: "CLI" } }).ok).toBe(true);
  }
  const f = fixture();
  for (const key of AGENT_MARKERS) expect(updateSpec(f.home, { id: "child" }, { env: { ...f.env, [key]: "set" } }).actor).toBe("agent");
  expect(f.update({}, "mcp").actor).toBe("agent"); expect(f.update().actor).toBe("person");
}, 30_000);

test("unknown keys, immutable id, required unsets and invalid update shapes refuse", () => {
  const f = fixture();
  for (const request of ([{ set: { id: "renamed" } }, { set: { rogue: "value" } }, { unset: ["id"] }, { unset: ["type"] }, { unset: ["title"] }, { add: { parent: ["root"] } }, { set: { status: "done" } }, { unset: ["tags"], add: { tags: ["new"] } }, { add: { tags: ["x"] }, remove: { tags: ["x"] } }] as Partial<SpecUpdateRequest>[])) {
    assertRefused(f.update(request), "INPUT"); expect(f.read()).toBe(f.original);
  }
}, 30_000);

test("linked worktrees are updated in isolation; foreign worktrees and symlink targets refuse", () => {
  const f = fixture(), linked = join(f.root, "linked"); f.git(["worktree", "add", "--detach", linked, "HEAD"]);
  expect(f.update({ worktree: linked, set: { title: "Linked" } })).toMatchObject({ ok: true, changed: true, worktree: linked });
  expect(f.read()).toBe(f.original); expect(parseFrontmatter(f.read("nested/SPEC.md", linked)).data.title).toBe("Linked");
  const foreign = fixture(); expect(f.update({ worktree: foreign.repo, set: { title: "Foreign" } }).ok).toBe(false); expect(foreign.read()).toBe(foreign.original);
  const original = join(f.root, "outside.md"); writeFileSync(original, f.original); rmSync(join(f.repo, "nested/SPEC.md")); symlinkSync(original, join(f.repo, "nested/SPEC.md"));
  expect(f.update({ set: { title: "Follow link" } }).ok).toBe(false); expect(readFileSync(original, "utf8")).toBe(f.original);
}, 30_000);

test("a held canonical-worktree lock refuses and preserves its owner; home cannot be inside the worktree", () => {
  const f = fixture(), lockDir = join(f.home, "spec-mutations"); mkdirSync(lockDir);
  const lock = join(lockDir, `${sha(f.repo)}.lock`); writeFileSync(lock, "foreign-owner\n");
  assertRefused(f.update({ set: { title: "Locked" } }), "LOCKED"); expect(readFileSync(lock, "utf8")).toBe("foreign-owner\n");
  const inRepo = join(f.repo, "state"); mkdirSync(inRepo); writeFileSync(join(inRepo, CONFIG_FILE), readFileSync(join(f.home, CONFIG_FILE)));
  const result = updateSpec(inRepo, { id: "child", set: { title: "No lock here" } }, { env: f.env });
  expect(result.issues[0]!.code).toBe("HOME"); expect(existsSync(join(inRepo, "spec-mutations"))).toBe(false);
}, 30_000);

for (const mode of ["reread", "policy-drift", "tree-drift", "temp-write", "rename", "lock-replaced", "lock-open-replaced", "temp-corrupt", "temp-replaced"]) test(`interrupted/racing ${mode} keeps original spec bytes and cleans only owned temporaries`, () => {
  const f = fixture();
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/spec-write-fault.ts"), f.home, mode], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode).toBe(0); const result = JSON.parse(child.stdout.toString()) as SpecWriteResult;
  expect(result).toMatchObject({ ok: false, changed: false });
  expect(f.read()).toBe(mode === "reread" ? f.original + "External edit.\r\n" : f.original);
  const files = readdirSync(join(f.repo, "nested"));
  if (mode === "temp-replaced") {
    expect(files.filter(file => file.startsWith(".spec-"))).toHaveLength(1);
    expect(readFileSync(join(f.repo, "nested", files.find(file => file.startsWith(".spec-"))!), "utf8")).toBe("foreign staged replacement");
  } else expect(files).toEqual(["SPEC.md"]);
  const locks = readdirSync(join(f.home, "spec-mutations"));
  if (["lock-replaced", "lock-open-replaced"].includes(mode)) { expect(locks).toHaveLength(1); expect(readFileSync(join(f.home, "spec-mutations", locks[0]!), "utf8")).toBe("foreign replacement\n"); }
  else expect(locks).toEqual([]);
}, 30_000);
