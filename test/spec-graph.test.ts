import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { addSpec } from "../src/registry.ts";
import type { SpecSourceSpec } from "../src/config.ts";
import { memoryGitArgv, memoryGitEnv } from "../src/platform.ts";
import { discoverSpecs, resolveSpecWorktree, SpecIndex } from "../src/spec-source.ts";
import { buildSpecGraph, specSlice } from "../src/spec-graph.ts";
import { LINK_RESOLUTION, MAX_NOTE_BYTES, VaultIndex } from "../src/vault-index.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-spec-graph-"))); roots.push(root);
  const home = join(root, "state");
  const git = (repo: string, args: string[]) => {
    const result = Bun.spawnSync(memoryGitArgv(["-C", repo, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", ...args]), { env: memoryGitEnv(process.env, { repositoryIsolation: true }), stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  const repo = (name: string) => {
    const dir = join(root, name); mkdirSync(dir);
    git(dir, ["-c", "init.templateDir=", "init", "--quiet"]);
    return dir;
  };
  const write = (repo: string, path: string, text: string) => { const file = join(repo, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  const commit = (repo: string) => { git(repo, ["add", "--all"]); git(repo, ["commit", "--quiet", "-m", "Synthetic fixture"]); };
  const source = (repo: string): SpecSourceSpec => addSpec(home, { id: "specs", path: repo });
  return { root, home, git, repo, write, commit, source };
}
const spec = (id: string, data: Record<string, unknown> = {}, body = "Synthetic content.") => `---\n${Object.entries({ id, type: "module", title: `Design ${id}`, ...data }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n# Design\n\n${body}\n`;
function tree(root: string): unknown {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const file = join(root, entry.name);
    return [entry.name, entry.isSymbolicLink() ? { link: readlinkSync(file) } : entry.isDirectory() ? tree(file) : readFileSync(file).toString("base64")];
  });
}

test("registered source discovery finds nested/root/untracked specs, ignores symlinks and builds exact id links", () => {
  const f = fixture(), repo = f.repo("repo"), outside = join(f.root, "outside"); mkdirSync(outside);
  f.write(repo, ".gitignore", "ignored/\nvendor/\n");
  f.write(repo, "design.md", spec("goal", { type: "goal" }, "Rootdesign."));
  f.write(repo, "packages/engine/SPEC.md", spec("engine", { parent: "[[goal]]", "depends-on": ["goal"], type: "future-type", status: "future-status" }, "Nestedengine [[goal]]\n```md\n[[hidden]]\n```"));
  f.write(repo, "README.md", "# Ordinary Markdown\n");
  f.write(repo, "ignored/SPEC.md", spec("ignored"));
  f.write(repo, "vendor/SPEC.md", spec("vendored"));
  f.write(repo, "rebound/SPEC.md", spec("rebound"));
  f.commit(repo);
  renameSync(join(repo, "rebound"), join(f.root, "old-directory"));
  f.write(outside, "SPEC.md", spec("escaped"));
  symlinkSync(outside, join(repo, "rebound"));
  symlinkSync(join(outside, "SPEC.md"), join(repo, "linked.md"));
  f.write(repo, "new.md", spec("untracked", { references: ["engine"], implements: ["[[goal]]"], "superseded-by": "engine" }, "[[engine]]"));
  f.write(repo, "odd\nname.md", spec("odd-path"));
  const source = f.source(repo), before = tree(f.root), snapshot = discoverSpecs(source), graph = buildSpecGraph(snapshot);
  expect(snapshot.specs.map(document => document.id).sort()).toEqual(["engine", "goal", "odd-path", "untracked"]);
  expect(snapshot.specs.find(document => document.id === "odd-path")?.path).toBe("odd\nname.md");
  const document = snapshot.specs.find(document => document.id === "engine")!;
  expect(document.path).toBe("packages/engine/SPEC.md");
  expect(document.frontmatter.type).toBe("future-type");
  expect(document.source).toBe(readFileSync(join(repo, document.path), "utf8"));
  expect(document.hash).toBe(createHash("sha256").update(document.source).digest("hex"));
  expect(graph.edges).toEqual(expect.arrayContaining([
    { source: "engine", target: "goal", kind: "parent" },
    { source: "engine", target: "goal", kind: "depends-on" },
    { source: "engine", target: "goal", kind: "body_link" },
    { source: "untracked", target: "engine", kind: "references" },
    { source: "untracked", target: "goal", kind: "implements" },
    { source: "untracked", target: "engine", kind: "superseded-by" },
  ]));
  expect(graph.unresolved).toEqual([]);
  expect(specSlice(graph, "goal", { depth: 3 }).nodes.map(node => node.id)).toEqual(["engine", "goal"]);
  expect(tree(f.root)).toEqual(before); // No index, Git metadata or config writes during discovery.
});

test("duplicates select the first NFC-ordered path in discovery, graph and FTS, including after deletion", () => {
  const f = fixture(), repo = f.repo("repo");
  f.write(repo, "z.md", spec("same", {}, "Winnerquasar."));
  f.write(repo, "é.md", spec("same", {}, "Shadowzircon."));
  f.write(repo, "broken.md", "---\nid: broken\ntype: [\n---\n");
  const source = f.source(repo), index = new SpecIndex(f.home, source);
  try {
    expect(index.scan()).toMatchObject({ notes: 1, changed: 1 });
    const snapshot = index.snapshot();
    expect(snapshot.specs[0]?.path).toBe("z.md");
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate_id", id: "same", path: "é.md", firstPath: "z.md" }),
      expect.objectContaining({ code: "invalid_frontmatter", path: "broken.md" }),
    ]));
    expect(buildSpecGraph(snapshot).nodes).toHaveLength(1);
    expect(index.search("Winnerquasar").map(hit => hit.id)).toEqual(["same"]);
    expect(index.search("Shadowzircon")).toEqual([]);
    expect(index.scan()).toMatchObject({ changed: 0, removed: 0 });
    rmSync(join(repo, "z.md"));
    expect(index.scan()).toMatchObject({ notes: 1, changed: 1, removed: 1 });
    expect(index.snapshot().diagnostics.some(item => item.code === "duplicate_id")).toBe(false);
    expect(index.search("Shadowzircon")[0]).toMatchObject({ id: "same", path: "é.md" });
  } finally { index.close(); }
});

test("spec indexing reuses incremental metadata/hash/BM25 and matches a rebuild after edit/rename/removal", () => {
  const f = fixture(), repo = f.repo("repo");
  f.write(repo, "a.md", spec("a", {}, "Initialquasar."));
  f.write(repo, "b.md", spec("b", {}, "Another body."));
  const index = new SpecIndex(f.home, f.source(repo));
  try {
    expect(index.scan()).toMatchObject({ notes: 2, changed: 2, removed: 0 });
    expect(index.scan()).toMatchObject({ notes: 2, changed: 0, removed: 0 });
    const file = join(repo, "a.md"), before = statSync(file);
    f.write(repo, "a.md", spec("a", {}, "Updatedquasar."));
    utimesSync(file, before.atime, before.mtime);
    expect(index.scan()).toMatchObject({ changed: 1, removed: 0 });
    expect(index.search("Initialquasar")).toEqual([]);
    expect(index.search("Updatedquasar")[0]?.id).toBe("a");
    renameSync(file, join(repo, "renamed.md"));
    f.write(repo, "b.md", "# No longer a spec\n");
    expect(index.scan()).toMatchObject({ notes: 1, changed: 1, removed: 2 });
    const incremental = index.search("Updatedquasar");
    index.scan(true);
    expect(index.search("Updatedquasar")).toEqual(incremental);
    expect(index.snapshot().specs[0]).toMatchObject({ id: "a", path: "renamed.md" });
  } finally { index.close(); }
});

test("linked worktrees share only repository identity and keep independent source indexes", () => {
  const f = fixture(), repo = f.repo("repo"), linked = join(f.root, "linked"), other = f.repo("other");
  f.write(repo, "SPEC.md", spec("root", { type: "goal" }, "Mainword.")); f.commit(repo);
  f.git(repo, ["worktree", "add", "--quiet", "--detach", linked]);
  f.write(linked, "SPEC.md", spec("root", { type: "goal" }, "Branchword."));
  const source = f.source(repo), before = [tree(repo), tree(linked)];
  expect(resolveSpecWorktree(source, linked)).toBe(linked);
  expect(() => resolveSpecWorktree(source, other)).toThrow("another repository");
  expect(() => resolveSpecWorktree(source, join(repo, "subdir"))).toThrow();
  const main = new SpecIndex(f.home, source), branch = new SpecIndex(f.home, source, { worktree: linked });
  try {
    main.scan(); branch.scan();
    expect(main.file).not.toBe(branch.file);
    expect(basename(main.file)).toStartWith("spec-");
    expect(main.search("Mainword")[0]?.id).toBe("root");
    expect(main.search("Branchword")).toEqual([]);
    expect(branch.search("Branchword")[0]?.id).toBe("root");
    expect(branch.search("Mainword")).toEqual([]);
    expect(discoverSpecs(source, { worktree: linked }).commonDir).toBe(discoverSpecs(source).commonDir);
    expect([tree(repo), tree(linked)]).toEqual(before);
  } finally { main.close(); branch.close(); }
});

test("spec adapter cache cannot collide with a vault cache at the same root and stays outside sources", () => {
  const f = fixture(), repo = f.repo("repo");
  f.write(repo, "notes/example.md", spec("example", {}, "Searchword."));
  const source = f.source(repo), vault = new VaultIndex(f.home, { id: "vault", path: repo, kind: "personal", write: "cli" }), specs = new SpecIndex(f.home, source);
  try {
    vault.scan(); specs.scan();
    const digest = createHash("sha256").update(repo).digest("hex");
    expect(basename(vault.file)).toBe(`${digest}-links${LINK_RESOLUTION}.sqlite`);
    expect(basename(specs.file)).toBe(`spec-${digest}-links${LINK_RESOLUTION}.sqlite`);
    expect(vault.search("Searchword")[0]?.path).toBe("example.md");
    expect(specs.search("Searchword")[0]).toMatchObject({ id: "example", path: "notes/example.md" });
    const internal = join(repo, "internal-cache");
    expect(() => new SpecIndex(internal, source)).toThrow("outside every repository");
    expect(() => new SpecIndex(internal, source, { protectedRoots: [] })).toThrow("outside every repository");
    expect(() => new SpecIndex(internal, source, { protectedRoots: [f.root] })).toThrow("outside every repository");
    expect(existsSync(internal)).toBe(false);
  } finally { vault.close(); specs.close(); }
});

test("spec discovery rejects oversized and invalid-UTF8 Markdown and stale worktree bindings", () => {
  const f = fixture(), repo = f.repo("repo");
  f.write(repo, "SPEC.md", spec("root"));
  const source = f.source(repo), index = new SpecIndex(f.home, source);
  try {
    index.scan();
    writeFileSync(join(repo, "large.md"), "x".repeat(MAX_NOTE_BYTES + 1));
    expect(() => discoverSpecs(source)).toThrow("split the file");
    rmSync(join(repo, "large.md"));
    writeFileSync(join(repo, "invalid.md"), Buffer.from([255]));
    expect(() => discoverSpecs(source)).toThrow("UTF-8");
    rmSync(join(repo, "invalid.md"));
    renameSync(join(repo, ".git"), join(repo, "old-git"));
    expect(() => index.scan()).toThrow("git refused inspection");
  } finally { index.close(); }
});

test("unchanged spec scans read cached sources without rereading Markdown descriptors", () => {
  const f = fixture(), repo = f.repo("repo");
  f.write(repo, "SPEC.md", spec("root", {}, "Cachedquasar."));
  const source = f.source(repo), cache = join(f.root, "separate-cache");
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { mock } from "bun:test";
    const fs = await import("node:fs"), originalRead = fs.readSync; let reads = 0;
    mock.module("node:fs", () => ({ ...fs, readSync: (...args) => { reads++; return originalRead(...args); } }));
    const { SpecIndex } = await import("./src/spec-source.ts");
    const index = new SpecIndex(${JSON.stringify(cache)}, ${JSON.stringify(source)});
    try {
      index.scan(); const first = reads; reads = 0;
      const result = index.scan();
      console.log(JSON.stringify({ first, second: reads, changed: result.changed, id: index.search("Cachedquasar")[0].id }));
    } finally { index.close(); }
  `], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.first).toBeGreaterThan(0);
  expect(result).toMatchObject({ second: 0, changed: 0, id: "root" });
});

test("spec discovery and cache scanning accept backslash repository roots", () => {
  const f = fixture(), repo = f.repo("repo\\backslash");
  f.write(repo, "SPEC.md", spec("backslash", {}, "Backslashquasar."));
  const source = { id: "source", path: repo, write: "none", pii: "deny" } as const;
  expect(discoverSpecs(source).specs[0]?.id).toBe("backslash");
  const index = new SpecIndex(f.home, source);
  try { index.scan(); expect(index.search("Backslashquasar")[0]?.id).toBe("backslash"); } finally { index.close(); }
});
