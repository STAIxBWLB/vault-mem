import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
  f.write(repo, "broken/SPEC.md", "---\nid: broken\ntype: [\n---\n");
  const source = f.source(repo), index = new SpecIndex(f.home, source);
  try {
    expect(index.scan()).toMatchObject({ notes: 1, changed: 1 });
    const snapshot = index.snapshot();
    expect(snapshot.specs[0]?.path).toBe("z.md");
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate_id", id: "same", path: "é.md", firstPath: "z.md" }),
      expect.objectContaining({ code: "invalid_frontmatter", path: "broken/SPEC.md" }),
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
    const kind: "personal" | "org" = vault.vault.kind;
    expect(kind).toBe("personal");
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
    writeFileSync(join(repo, "large.md"), spec("large", {}, "x".repeat(MAX_NOTE_BYTES + 1)));
    expect(() => discoverSpecs(source)).toThrow("large.md: Markdown exceeds");
    rmSync(join(repo, "large.md"));
    mkdirSync(join(repo, "invalid"));
    writeFileSync(join(repo, "invalid/SPEC.md"), Buffer.from([255]));
    expect(() => discoverSpecs(source)).toThrow("invalid/SPEC.md: Markdown is not valid UTF-8");
    rmSync(join(repo, "invalid"), { recursive: true });
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

test("shared-cache searches exclude paths and replacements outside the instance snapshot", () => {
  const f = fixture(), repo = f.repo("repo");
  f.write(repo, "a.md", spec("a", {}, "Existingquasar."));
  const source = f.source(repo), a = new SpecIndex(f.home, source), b = new SpecIndex(f.home, source);
  try {
    a.scan();
    f.write(repo, "b.md", spec("b", {}, "Addedquasar."));
    b.scan();
    expect(a.file).toBe(b.file);
    expect(b.search("Addedquasar")[0]?.id).toBe("b");
    expect(a.search("Addedquasar")).toEqual([]);
    expect(a.search("Existingquasar")[0]?.id).toBe("a");
    f.write(repo, "a.md", spec("replacement", {}, "Replacedquasar."));
    b.scan();
    expect(a.search("Replacedquasar")).toEqual([]);
    expect(b.search("Replacedquasar")[0]?.id).toBe("replacement");
    a.scan();
    expect(a.search("Addedquasar")[0]?.id).toBe("b");
    expect(a.search("Replacedquasar")[0]?.id).toBe("replacement");
  } finally { a.close(); b.close(); }
});

test("spec file failures name relative paths and keep spec wording during read drift", () => {
  const f = fixture(), repo = f.repo("repo"), path = "nested/changed-during.md";
  f.write(repo, path, spec("changed", {}, "Synthetic original."));
  const source = f.source(repo);
  for (const mode of ["read", "inspect", "unsafe"]) {
    const child = Bun.spawnSync([process.execPath, "-e", `
      import { mock } from "bun:test";
      const fs = await import("node:fs"), original = { ...fs };
      const cp = await import("node:child_process"), spawn = cp.spawnSync;
      const file = ${JSON.stringify(join(repo, path))}, mode = ${JSON.stringify(mode)};
      let target, changed = false;
      mock.module("node:fs", () => ({ ...original,
        openSync: (...args) => { const fd = original.openSync(...args); if (String(args[0]) === file) target = fd; return fd; },
        lstatSync: (...args) => { if (mode === "inspect" && String(args[0]) === file) throw Object.assign(new Error("synthetic denied"), { code: "EACCES" }); return original.lstatSync(...args); },
        readSync: (...args) => { const n = original.readSync(...args); if (mode === "read" && args[0] === target && !changed) { changed = true; original.appendFileSync(file, "Mutated by the synthetic race fixture."); } return n; }
      }));
      if (mode === "unsafe") mock.module("node:child_process", () => ({ ...cp, spawnSync: (exe, args, options) => args.includes("ls-files")
        ? { status: 0, stdout: Buffer.concat([Buffer.from("../outside.md"), Buffer.alloc(1)]), stderr: Buffer.alloc(0) }
        : spawn(exe, args, options) }));
      const { discoverSpecs } = await import("./src/spec-source.ts");
      try { discoverSpecs(${JSON.stringify(source)}); process.exit(2); }
      catch (error) { process.stdout.write(error.message); }
    `], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    const message = child.stdout.toString();
    expect(message).toContain(mode === "unsafe" ? "../outside.md" : path);
    expect(message).not.toContain("vault specs");
    expect(message).toContain(mode === "read" ? "file changed during scan" : mode === "inspect" ? "restore read access" : "repair the index");
  }
});

test("constructor Git and binding failures do not receive cache-directory advice", () => {
  const f = fixture(), repo = f.repo("repo"), other = f.repo("other"), source = f.source(repo);
  for (const mode of ["timeout", "binding"]) {
    const child = Bun.spawnSync([process.execPath, "-e", `
      import { mock } from "bun:test";
      const cp = await import("node:child_process"), spawn = cp.spawnSync; let calls = 0;
      mock.module("node:child_process", () => ({ ...cp, spawnSync: (...args) => {
        if (++calls === 2) return ${JSON.stringify(mode)} === "timeout"
          ? { status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" }) }
          : { status: 0, stdout: Buffer.from(${JSON.stringify(repo + "\n" + join(other, ".git") + "\n")}), stderr: Buffer.alloc(0) };
        return spawn(...args);
      } }));
      const { SpecIndex } = await import("./src/spec-source.ts");
      try { new SpecIndex(${JSON.stringify(f.home)}, ${JSON.stringify(source)}); process.exit(2); }
      catch (error) { process.stdout.write(error.message); }
    `], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toContain(mode === "timeout" ? "timed out" : "binding changed");
    expect(child.stdout.toString()).not.toContain("cache directory");
  }
  expect(() => new SpecIndex(join(repo, "cache"), source)).toThrow("choose VMEM_HOME outside every repository and vault");
});

test("NFD-named directories and files survive Git precomposition during discovery and indexing", () => {
  const f = fixture(), repo = f.repo("repo");
  const path = `${"é-한글".normalize("NFD")}/${"설계-é.md".normalize("NFD")}`;
  f.git(repo, ["config", "core.precomposeunicode", "true"]);
  f.write(repo, path, spec("normalized", {}, "Normalizedquasar."));
  f.commit(repo);
  const source = f.source(repo), snapshot = discoverSpecs(source);
  expect(snapshot.specs.map(document => document.id)).toEqual(["normalized"]);
  expect(snapshot.specs[0]?.path.normalize("NFC")).toBe("é-한글/설계-é.md");
  expect(snapshot.diagnostics.filter(item => item.code === "skipped_path")).toEqual([]);
  const index = new SpecIndex(f.home, source);
  try {
    index.scan();
    expect(index.search("Normalizedquasar")[0]?.id).toBe("normalized");
    expect(index.snapshot().specs[0]?.path.normalize("NFC")).toBe(path.normalize("NFC"));
  } finally { index.close(); }
});

test("case aliases resolve on case-insensitive filesystems and missing indexed spellings are diagnosed otherwise", () => {
  const f = fixture(), repo = f.repo("repo");
  f.git(repo, ["config", "core.ignorecase", "true"]);
  f.write(repo, "Case.md", spec("case", {}, "Casequasar.")); f.commit(repo);
  renameSync(join(repo, "Case.md"), join(repo, "temporary.md"));
  renameSync(join(repo, "temporary.md"), join(repo, "case.md"));
  const snapshot = discoverSpecs(f.source(repo));
  if (existsSync(join(repo, "Case.md"))) {
    expect(snapshot.specs.map(document => document.id)).toEqual(["case"]);
    expect(snapshot.diagnostics.filter(item => item.code === "skipped_path")).toEqual([]);
  } else {
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: "skipped_path", path: "Case.md", message: expect.stringContaining("missing") }));
  }
});

test("every listed path excluded by file guards has a diagnostic", () => {
  const f = fixture(), repo = f.repo("repo"), outside = join(f.root, "outside");
  f.write(repo, "SPEC.md", spec("root"));
  for (const path of ["gone.md", "nonfile.md", "blocked/file.md"]) f.write(repo, path, spec(path));
  f.commit(repo);
  f.write(outside, "file.md", spec("external"));
  rmSync(join(repo, "gone.md")); rmSync(join(repo, "nonfile.md")); mkdirSync(join(repo, "nonfile.md"));
  renameSync(join(repo, "blocked"), join(f.root, "original-blocked"));
  symlinkSync(outside, join(repo, "blocked"));
  symlinkSync(join(outside, "file.md"), join(repo, "linked.md"));
  const source = f.source(repo), before = tree(f.root), snapshot = discoverSpecs(source);
  const skipped = snapshot.diagnostics.filter(item => item.code === "skipped_path");
  expect(skipped.map(item => item.path)).toEqual(["blocked/file.md", "gone.md", "linked.md", "nonfile.md"]);
  for (const item of skipped) expect(item.message).toContain(item.path);
  expect(snapshot.specs.map(document => document.id)).toEqual(["root"]);
  expect(tree(f.root)).toEqual(before);
});

test("cache messages have one prefix and one applicable hint, and scan keeps Git cause and advice", () => {
  const f = fixture(), repo = f.repo("repo"); f.write(repo, "SPEC.md", spec("root"));
  const source = f.source(repo);
  const failure = (operation: () => unknown): Error => {
    try { operation(); } catch (error) { expect(error).toBeInstanceOf(Error); return error as Error; }
    throw new Error("expected synthetic operation to fail");
  };
  const protectedError = failure(() => new SpecIndex(join(repo, "cache"), source));
  expect(protectedError.message.match(/spec index:/g)).toHaveLength(1);
  expect(protectedError.message.match(/choose/g)).toHaveLength(1);
  expect(protectedError.message).toContain("choose VMEM_HOME");
  expect(protectedError.cause).toBeInstanceOf(Error);
  const target = join(f.root, "external-cache"); mkdirSync(target);
  symlinkSync(target, join(f.home, "indexes"));
  const cacheError = failure(() => new SpecIndex(f.home, source));
  expect(cacheError.message.match(/spec index:/g)).toHaveLength(1);
  expect(cacheError.message).toContain("choose a readable plain cache directory");
  expect(cacheError.cause).toBeInstanceOf(Error);
  rmSync(join(f.home, "indexes"));
  const env = { ...process.env }, index = new SpecIndex(f.home, source, { env });
  try {
    index.scan(); env.PATH = join(f.root, "no-git");
    const gitError = failure(() => index.scan());
    expect(gitError.message).toContain("install git or fix PATH");
    expect(gitError.message).not.toContain("restore a stable, readable worktree");
    expect((gitError.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
  } finally { index.close(); }
});

test("temporary root or ancestor rebinding cannot introduce outside Markdown into a source", () => {
  for (const ancestor of [false, true]) for (const link of [false, true]) {
    const f = fixture();
    if (ancestor) mkdirSync(join(f.root, "container"));
    const repo = f.repo(ancestor ? "container/repo" : "repo"), entry = ancestor ? dirname(repo) : repo;
    const backup = join(f.root, "original"), outside = join(f.root, "outside");
    f.write(repo, "SPEC.md", spec("inside", {}, "Insidequasar."));
    f.write(outside, ancestor ? "repo/SPEC.md" : "SPEC.md", spec("outside", {}, "Outsidequasar."));
    const source = f.source(repo);
    const child = Bun.spawnSync([process.execPath, "-e", `
      import { mock } from "bun:test";
      const fs = await import("node:fs"), original = { ...fs };
      const cp = await import("node:child_process"), spawn = cp.spawnSync;
      const root = ${JSON.stringify(repo)}, entry = ${JSON.stringify(entry)}, backup = ${JSON.stringify(backup)}, outside = ${JSON.stringify(outside)};
      let swapped = false, link = ${JSON.stringify(link)};
      const restore = () => { if (swapped) { if (link) original.unlinkSync(entry); else original.renameSync(entry, outside); original.renameSync(backup, entry); swapped = false; } };
      mock.module("node:fs", () => ({ ...original, realpathSync: (...args) => {
        if (swapped && String(args[0]) === root) restore();
        return original.realpathSync(...args);
      } }));
      mock.module("node:child_process", () => ({ ...cp, spawnSync: (...args) => {
        const result = spawn(...args);
        if (args[1].includes("ls-files")) { original.renameSync(entry, backup); if (link) original.symlinkSync(outside, entry); else original.renameSync(outside, entry); swapped = true; }
        return result;
      } }));
      const { SpecIndex } = await import("./src/spec-source.ts");
      let index;
      try {
        index = new SpecIndex(${JSON.stringify(f.home)}, ${JSON.stringify(source)});
        index.scan();
        console.log(JSON.stringify({ ids: index.snapshot().specs.map(spec => spec.id), outsideHits: index.search("Outsidequasar").length, skipped: index.snapshot().diagnostics.some(item => item.code === "skipped_path") }));
      } finally { index?.close(); restore(); }
    `], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.ids).not.toContain("outside");
    expect(result.outsideHits).toBe(0);
    expect(result.skipped).toBe(true);
    expect(readFileSync(join(repo, "SPEC.md"), "utf8")).toContain("Insidequasar");
  }
});

test.skipIf(process.getuid?.() === 0)("unreadable plain Markdown names its relative file and repair step", () => {
  const f = fixture(), repo = f.repo("repo"), path = "nested/unreadable.md";
  f.write(repo, path, spec("unreadable"));
  const source = f.source(repo), file = join(repo, path);
  chmodSync(file, 0);
  try {
    let failure: unknown;
    try { discoverSpecs(source); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("expected a synthetic read refusal");
    expect(failure.message).toContain(path);
    expect(failure.message).toContain("restore read access");
    expect((failure.cause as NodeJS.ErrnoException).code).toBe("EACCES");
  } finally { chmodSync(file, 0o600); }
});

test("spec descriptor open and read errors retain file-specific repair guidance and causes", () => {
  const f = fixture(), repo = f.repo("repo"), path = "nested/descriptor.md";
  f.write(repo, path, spec("descriptor"));
  const source = f.source(repo);
  for (const mode of ["open", "read"]) {
    const child = Bun.spawnSync([process.execPath, "-e", `
      import { mock } from "bun:test";
      const fs = await import("node:fs"), original = { ...fs };
      const file = ${JSON.stringify(join(repo, path))}, mode = ${JSON.stringify(mode)}; let target;
      mock.module("node:fs", () => ({ ...original,
        openSync: (...args) => { if (mode === "open" && String(args[0]) === file) throw Object.assign(new Error("synthetic denied"), { code: "EACCES" }); const fd = original.openSync(...args); if (String(args[0]) === file) target = fd; return fd; },
        readSync: (...args) => { if (mode === "read" && args[0] === target) throw Object.assign(new Error("synthetic read failed"), { code: "EIO" }); return original.readSync(...args); }
      }));
      const { discoverSpecs } = await import("./src/spec-source.ts");
      try { discoverSpecs(${JSON.stringify(source)}); process.exit(2); }
      catch (error) { console.log(JSON.stringify({ message: error.message, code: error.cause?.code })); }
    `], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.message).toContain(path);
    expect(result.message).toContain(`cannot ${mode} Markdown`);
    expect(result.message).toContain("restore read access");
    expect(result.code).toBe(mode === "open" ? "EACCES" : "EIO");
  }
});
