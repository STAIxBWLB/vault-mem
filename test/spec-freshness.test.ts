import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { specGit } from "../src/spec-git.ts";
import { specFreshness, specsCoveringPath } from "../src/spec-freshness.ts";
import type { SpecCandidate, SpecDocument, SpecSnapshot } from "../src/spec-source.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-spec-freshness-"))); roots.push(root);
  const repo = join(root, "repo"); mkdirSync(repo);
  const git = (args: string[], worktree = repo) => specGit(worktree, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args]);
  const write = (path: string, value: string, worktree = repo) => { const file = join(worktree, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
  git(["-c", "init.templateDir=", "init", "--quiet"]);
  write("src/a.ts", "Synthetic first source.\n");
  write("src/private.ts", "Synthetic excluded source.\n");
  write("src/nested/b.ts", "Synthetic nested source.\n");
  write("docs/readme.txt", "Synthetic unrelated documentation.\n");
  write(".gitignore", "src/ignored*\n");
  const commit = (paths = ["."], worktree = repo) => {
    git(["add", "--", ...paths], worktree); git(["commit", "--quiet", "-m", "Synthetic fixture"], worktree);
    return git(["rev-parse", "HEAD"], worktree).stdout.toString().trim();
  };
  const stamp = commit();
  const snapshot = (specs: SpecDocument[], worktree = repo, candidates?: SpecCandidate[]): SpecSnapshot => ({ root: worktree, commonDir: join(repo, ".git"), specs, ...(candidates === undefined ? {} : { candidates }), diagnostics: [] });
  return { root, repo, git, write, commit, stamp, snapshot };
}
function document(id: string, metadata: Record<string, unknown> = {}): SpecDocument {
  return { id, path: `design/${id}.md`, hash: "synthetic-hash", source: "Synthetic spec source.\n", body: "Synthetic spec body.\n", frontmatter: { id, type: "module", title: `Synthetic ${id}`, ...metadata } };
}
function tree(root: string): unknown {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const file = join(root, entry.name);
    return [entry.name, entry.isSymbolicLink() ? { link: readlinkSync(file) } : entry.isDirectory() ? tree(file) : readFileSync(file).toString("base64")];
  });
}

test("freshness counts only scoped source commits and ignores unrelated history", () => {
  const f = fixture(), spec = document("scope", { paths: ["src/**"], "verified-against": f.stamp });
  expect(specFreshness(f.snapshot([spec]))).toEqual({ items: [{ path: spec.path, id: "scope", state: "fresh", commits: 0, dirty: false }], issues: [] });
  f.write("docs/readme.txt", "Unrelated change.\n"); f.commit(["docs/readme.txt"]);
  expect(specFreshness(f.snapshot([spec])).items[0]).toMatchObject({ state: "fresh", commits: 0, dirty: false });
  f.write("src/a.ts", "First source change.\n"); f.commit(["src/a.ts"]);
  f.write("src/private.ts", "Second source change.\n"); f.commit(["src/private.ts"]);
  f.write("docs/readme.txt", "Another unrelated change.\n"); f.commit(["docs/readme.txt"]);
  const excluded = document("excluding", { paths: ["src/**", ":(exclude)src/private.ts"], "verified-against": f.stamp });
  const report = specFreshness(f.snapshot([spec, excluded]));
  expect(report.issues).toEqual([]);
  expect(report.items.find(item => item.id === "scope")).toMatchObject({ state: "stale", commits: 2, dirty: false });
  expect(report.items.find(item => item.id === "excluding")).toMatchObject({ state: "stale", commits: 1, dirty: false });
});

test("dirty freshness includes unstaged, staged and untracked scope changes, but not unrelated or ignored files", () => {
  const f = fixture(), spec = document("scope", { paths: ["src/**"], "verified-against": f.stamp }), snapshot = f.snapshot([spec]);
  f.write("docs/untracked.txt", "Unrelated untracked file.\n");
  expect(specFreshness(snapshot).items[0]).toMatchObject({ state: "fresh", commits: 0, dirty: false });
  f.write("src/a.ts", "Unstaged source.\n");
  expect(specFreshness(snapshot).items[0]).toMatchObject({ state: "stale", commits: 0, dirty: true });
  f.git(["add", "--", "src/a.ts"]);
  expect(specFreshness(snapshot).items[0]).toMatchObject({ state: "stale", commits: 0, dirty: true });
  f.git(["reset", "--hard", "HEAD"]);
  f.write("src/new.ts", "Untracked source.\n");
  expect(specFreshness(snapshot).items[0]).toMatchObject({ state: "stale", commits: 0, dirty: true });
  rmSync(join(f.repo, "src/new.ts"));
  f.write("src/ignored-temp.ts", "Ignored source.\n");
  expect(specFreshness(snapshot).items[0]).toMatchObject({ state: "fresh", commits: 0, dirty: false });
});

test("stamps must be full commit identities and ancestors, even without paths", () => {
  const f = fixture(), treeHash = f.git(["write-tree"]).stdout.toString().trim();
  const foreign = f.git(["commit-tree", treeHash, "-m", "Synthetic unrelated root commit"]).stdout.toString().trim();
  const blob = f.git(["rev-parse", "HEAD:src/a.ts"]).stdout.toString().trim();
  f.git(["tag", "--annotate", "synthetic-tag", "--message", "Synthetic tag"]);
  const tag = f.git(["rev-parse", "refs/tags/synthetic-tag"]).stdout.toString().trim();
  const values: unknown[] = ["HEAD", f.stamp.slice(0, 10), "f".repeat(40), foreign, blob, tag, 123, null, "private-invalid-stamp"];
  for (const [index, value] of values.entries()) {
    const spec = document(`bad-${index}`, { "verified-against": value });
    const report = specFreshness(f.snapshot([spec]));
    expect(report.items).toEqual([]);
    expect(report.issues).toEqual([expect.objectContaining({ code: "invalid_verified_against", severity: "error", field: "verified-against", path: spec.path })]);
    expect(JSON.stringify(report.issues)).not.toContain("private-invalid-stamp");
  }
  const valid = document("valid-without-paths", { "verified-against": f.stamp });
  expect(specFreshness(f.snapshot([valid]))).toEqual({ items: [], issues: [] });
  expect(specFreshness(f.snapshot([document("unstamped", { paths: ["src/a.ts"] })]))).toEqual({ items: [], issues: [] });
});

test("paths keep their list shape and must be relative native pathspecs with tracked matches", () => {
  const f = fixture();
  for (const value of ["src/a.ts", [], null, [1], [""]]) {
    const report = specFreshness(f.snapshot([document("shape", { paths: value })]));
    expect(report.issues).toEqual([expect.objectContaining({ code: "wrong_shape", field: "paths" })]);
    expect(report.items).toEqual([]);
  }
  for (const paths of [["/synthetic/private"], ["../outside"], ["src/../a.ts"], [":(literal)../outside"], [":/../outside"], ["C:/outside"], ["missing/**"], ["src/**", "missing/**"], ["src/**", ":(exclude)src/**"]]) {
    const report = specFreshness(f.snapshot([document("invalid", { paths })]));
    expect(report.issues).toEqual([expect.objectContaining({ code: "invalid_paths", field: "paths" })]);
    expect(report.items).toEqual([]);
  }
  expect(specFreshness(f.snapshot([document("native", { paths: [":(glob)src/*.ts"] })])).issues).toEqual([]);
  const missingId: SpecCandidate = { path: "design/candidate.md", source: "Synthetic incomplete spec.\n", body: "", hash: "candidate", frontmatter: { type: "module", paths: "src/a.ts", "verified-against": "invalid" } };
  const report = specFreshness(f.snapshot([], f.repo, [missingId]));
  expect(report.issues.map(item => item.code)).toEqual(["wrong_shape", "invalid_verified_against"]);
  expect(report.issues.every(item => item.id === undefined)).toBe(true);
});

test("coversPath uses tracked-file membership with native glob/exclusion and ignores hostile Git flags", () => {
  const f = fixture();
  const specs = [
    document("all", { paths: ["src/**"] }),
    document("direct", { paths: [":(glob)src/*.ts"] }),
    document("excluding", { paths: ["src/**", ":(exclude)src/private.ts"] }),
    document("one", { paths: ["src/a.ts"], "verified-against": "invalid-but-ownership-still-applies" }),
    document("wrong", { paths: "src/a.ts" }),
    document("missing", { paths: ["unknown/**"] }),
  ];
  const snapshot = f.snapshot(specs);
  const hostile = { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_GLOB_PATHSPECS: "1", GIT_NOGLOB_PATHSPECS: "1", GIT_ICASE_PATHSPECS: "1", GIT_DIR: join(f.root, "not-the-repository"), GIT_WORK_TREE: f.root, GIT_INDEX_FILE: join(f.root, "foreign-index") };
  expect(specsCoveringPath(snapshot, "src/a.ts", { env: hostile }).map(spec => spec.id)).toEqual(["all", "direct", "excluding", "one"]);
  expect(specsCoveringPath(snapshot, "src/private.ts").map(spec => spec.id)).toEqual(["all", "direct"]);
  expect(specsCoveringPath(snapshot, "src/nested/b.ts").map(spec => spec.id)).toEqual(["all", "excluding"]);
  expect(specsCoveringPath(snapshot, "src")).toEqual([]);
  expect(specsCoveringPath(snapshot, ".")).toEqual([]);
  f.write("src/untracked.ts", "An untracked source.\n");
  expect(specsCoveringPath(snapshot, "src/untracked.ts")).toEqual([]);
  for (const path of ["/absolute", "../outside", "src/../a.ts", "C:/outside"]) expect(() => specsCoveringPath(snapshot, path)).toThrow("pass a file listed by git ls-files");
});

test("linked worktrees compute freshness from their own HEAD and dirty state", () => {
  const f = fixture(), linked = join(f.root, "linked");
  f.git(["worktree", "add", "--quiet", "--detach", linked]);
  const spec = document("scope", { paths: ["src/a.ts"], "verified-against": f.stamp });
  f.write("src/a.ts", "Linked worktree source.\n", linked);
  expect(specFreshness(f.snapshot([spec], linked)).items[0]).toMatchObject({ commits: 0, dirty: true });
  f.commit(["src/a.ts"], linked);
  expect(specFreshness(f.snapshot([spec], linked)).items[0]).toMatchObject({ commits: 1, dirty: false });
  expect(specFreshness(f.snapshot([spec])).items[0]).toMatchObject({ state: "fresh", commits: 0, dirty: false });
});

test("freshness and coversPath leave source, Git metadata, config and commits byte-identical", () => {
  const f = fixture(), spec = document("scope", { paths: ["src/**"], "verified-against": f.stamp });
  f.write("src/untracked.ts", "Synthetic untracked source.\n");
  const before = tree(f.root), snapshot = f.snapshot([spec]);
  expect(specFreshness(snapshot).items[0]).toMatchObject({ state: "stale", dirty: true });
  expect(specsCoveringPath(snapshot, "src/a.ts").map(spec => spec.id)).toEqual(["scope"]);
  expect(tree(f.root)).toEqual(before);
});

test("Git operational failures propagate without invented freshness or ownership", () => {
  const f = fixture(), snapshot = f.snapshot([document("scope", { paths: ["src/**"], "verified-against": f.stamp })]);
  const env = { ...process.env, PATH: join(f.root, "missing-bin") };
  expect(() => specFreshness(snapshot, { env })).toThrow("fix PATH");
  expect(() => specsCoveringPath(snapshot, "src/a.ts", { env })).toThrow("fix PATH");
});

test("malformed Git pathspec syntax is a metadata issue and does not suppress other freshness or ownership", () => {
  const f = fixture(), valid = document("valid", { paths: ["src/**", ":(exclude)src/private.ts"], "verified-against": f.stamp });
  for (const paths of [[":(unknown)src/**"], [":(glob,literal)src/**"]]) {
    const invalid = document("invalid", { paths, "verified-against": f.stamp }), snapshot = f.snapshot([invalid, valid]);
    const report = specFreshness(snapshot);
    expect(report.items).toEqual([{ path: valid.path, id: valid.id, state: "fresh", commits: 0, dirty: false }]);
    expect(report.issues).toEqual([expect.objectContaining({ code: "invalid_paths", field: "paths", path: invalid.path, message: expect.stringContaining("invalid Git pathspec syntax") })]);
    expect(JSON.stringify(report.issues)).not.toContain(paths[0]!);
    expect(specsCoveringPath(snapshot, "src/a.ts").map(spec => spec.id)).toEqual(["valid"]);
  }
});

test("a corrupt Git index remains an operational failure rather than an invalid_paths issue", () => {
  const f = fixture(), snapshot = f.snapshot([document("scope", { paths: ["src/**"], "verified-against": f.stamp })]);
  const index = join(f.repo, ".git/index"), original = readFileSync(index);
  writeFileSync(index, "Synthetic corrupt index.\n");
  try {
    expect(() => specFreshness(snapshot)).toThrow("git refused inspection");
    expect(() => specsCoveringPath(snapshot, "src/a.ts")).toThrow("git refused inspection");
  } finally { writeFileSync(index, original); }
});

test("staged scope changes remain dirty when unstaged content restores HEAD bytes", () => {
  const f = fixture(), input = f.snapshot([document("scope", { paths: ["src/a.ts"], "verified-against": f.stamp })]);
  f.write("src/a.ts", "Synthetic staged change.\n");
  f.git(["add", "--", "src/a.ts"]);
  f.write("src/a.ts", "Synthetic first source.\n");
  expect(specFreshness(input).items[0]).toMatchObject({ state: "stale", commits: 0, dirty: true });
});
