import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_FILE } from "../src/config.ts";
import { addSpec } from "../src/registry.ts";
import { specGit } from "../src/spec-git.ts";
import { executeSpecCommand } from "../src/spec-commands.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const markdown = (data: Record<string, unknown>, body: string) => `---\n${Object.entries(data).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${body}`;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-spec-provider-"))); roots.push(root);
  const home = join(root, "state"), repo = join(root, "repo"), outside = join(root, "outside"); mkdirSync(repo); mkdirSync(outside);
  const git = (args: string[], worktree = repo) => specGit(worktree, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args]);
  const write = (path: string, value: string, worktree = repo) => { const file = join(worktree, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
  git(["-c", "init.templateDir=", "init", "--quiet"]);
  const rootData = { id: "root", type: "goal", title: "Synthetic root", status: "active", paths: ["src/**"] };
  const engineData = { id: "engine", type: "module", title: "Synthetic engine", status: "active", parent: "[[root|Root]]", "depends-on": ["[[support]]"], references: ["root"], tags: ["engine", "search"], paths: ["src/a.ts"] };
  const engineBody = "# Engine\n\nIntro engineword.\n\n```md\n## Hidden\nPreserved fenced example.\n```\n\n## Detail\n가나다\n### Nested\nKeep detail.\n\n## After\nTail.\n";
  write("src/a.ts", "Synthetic source.\n"); write(".gitignore", "ignored/\nvendor/\n");
  write("design.md", markdown(rootData, "# Root\n\nRootword.\n"));
  write("src/engine/SPEC.md", markdown(engineData, engineBody));
  write("architecture.md", markdown({ id: "support", type: "architecture", title: "Synthetic support", parent: "root", status: "draft", tags: ["legacy"] }, "# Support\n\nSupportword.\n"));
  write("ignored/SPEC.md", markdown({ id: "ignored", type: "module", title: "Ignored" }, "# Ignored\n"));
  write("private.md", markdown({ id: "outside", type: "module", title: "Outside" }, "Outsideword.\n"), outside);
  symlinkSync(join(outside, "private.md"), join(repo, "linked.md"));
  git(["add", "."]); git(["commit", "--quiet", "-m", "Synthetic provider fixture"]);
  const stamp = git(["rev-parse", "HEAD"]).stdout.toString().trim();
  write("design.md", markdown({ ...rootData, "verified-against": stamp }, "# Root\n\nRootword.\n"));
  addSpec(home, { id: "main", path: repo });
  const run = (command: "get" | "graph" | "grep" | "validate", args: Record<string, unknown> = {}, env = process.env): any => executeSpecCommand(home, command, args, env);
  return { root, home, repo, outside, git, write, run, rootData, engineData, engineBody, stamp };
}
function tree(root: string): unknown {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const file = join(root, entry.name);
    return [entry.name, entry.isSymbolicLink() ? { link: readlinkSync(file) } : entry.isDirectory() ? tree(file) : readFileSync(file).toString("base64")];
  });
}

test("shared get returns id metadata, resolved relations, freshness and optional body without repository writes", () => {
  const f = fixture(), before = tree(f.repo), root = f.run("get", { id: "root" }), engine = f.run("get", { id: "engine" });
  expect(root).toMatchObject({ source: "main", worktree: f.repo, id: "root", path: "design.md", frontmatter: { type: "goal" }, freshness: { state: "fresh", commits: 0, dirty: false } });
  expect(root.children.map((node: { id: string }) => node.id)).toEqual(["engine", "support"]);
  expect(root.backlinks).toContainEqual({ source: "engine", target: "root", kind: "parent" });
  expect(engine.links).toContainEqual({ source: "engine", target: "support", kind: "depends-on" });
  expect(engine.sha256).toBe(createHash("sha256").update(readFileSync(join(f.repo, "src/engine/SPEC.md"))).digest("hex"));
  expect(engine).not.toHaveProperty("body"); expect(engine.freshness).toBeNull();
  expect(f.run("get", { id: "engine", body: true }).body).toBe(f.engineBody);
  expect(f.run("get", { id: "engine", maxBytes: 5 }).body).toBe(f.engineBody.slice(0, 5));
  expect(f.run("get", { id: "engine", body: false, maxBytes: 5 })).toHaveProperty("body");
  expect(f.run("grep", {}).hits.map((hit: { id: string }) => hit.id).sort()).toEqual(["engine", "root", "support"]);
  expect(tree(f.repo)).toEqual(before);
});

test("body pages preserve UTF-8 boundaries and exact visible H2 section bounds", () => {
  const f = fixture(), offset = Buffer.from(f.engineBody).indexOf(Buffer.from("가"));
  const page = f.run("get", { id: "engine", offset, maxBytes: 3 });
  expect(page).toMatchObject({ body: "가", bodyTruncated: true, nextOffset: offset + 3, offset });
  expect(f.run("get", { id: "engine", section: "Detail", maxBytes: 65536 }).body).toBe("## Detail\n가나다\n### Nested\nKeep detail.\n\n");
  expect(() => f.run("get", { id: "engine", section: "Hidden" })).toThrow("exact H2");
  expect(() => f.run("get", { id: "engine", offset: offset + 1 })).toThrow("UTF-8 boundary");
  expect(() => f.run("get", { id: "engine", offset, maxBytes: 1 })).toThrow("increase --max-bytes");
  expect(() => f.run("get", { id: "engine", offset: 2000000 })).toThrow("offset exceeds");
  expect(() => f.run("get", { id: "engine", section: "   " })).toThrow("exact H2");
});

test("grep shares FTS/literal search, metadata filters, source scope and post-filter continuation", () => {
  const f = fixture();
  expect(f.run("grep", { query: "engineword", type: "module", status: "active", tag: "engine", parent: "root", dependsOn: "support", coversPath: "src/a.ts" }).hits.map((hit: { id: string }) => hit.id)).toEqual(["engine"]);
  expect(f.run("grep", { query: 'id: "engine"', literal: true }).hits.map((hit: { id: string }) => hit.id)).toEqual(["engine"]);
  expect(f.run("grep", { tag: "legacy" }).hits.map((hit: { id: string }) => hit.id)).toEqual(["support"]);
  const first = f.run("grep", { query: "", limit: 1 }), second = f.run("grep", { query: "", limit: 1, offset: first.nextOffset });
  expect(first.hits).toHaveLength(1); expect(first.truncated).toBe(true); expect(first.nextOffset).toBe(1);
  expect(second.hits).toHaveLength(1); expect(second.hits[0].id).not.toBe(first.hits[0].id);
  expect(f.run("grep", { offset: 10000 }).hits).toEqual([]);
});

test("FTS metadata filtering fills pages after more than 500 earlier nonmatching hits", () => {
  const f = fixture();
  for (let index = 0; index < 505; index++) {
    const key = String(index).padStart(3, "0");
    f.write(`bulk/${key}.md`, markdown({ id: `bulk-${key}`, type: "module", title: "Record", parent: "root", status: index < 502 ? "draft" : "active" }, "Commonquasar\n"));
  }
  const first = f.run("grep", { query: "Commonquasar", status: "active", limit: 2 });
  expect(first.hits.map((hit: { id: string }) => hit.id)).toEqual(["bulk-502", "bulk-503"]);
  expect(first.nextOffset).toBe(2);
  const second = f.run("grep", { query: "Commonquasar", status: "active", limit: 2, offset: first.nextOffset });
  expect(second.hits.map((hit: { id: string }) => hit.id)).toEqual(["bulk-504"]);
  expect(second).not.toHaveProperty("nextOffset"); expect(second.truncated).toBe(false);
  const root = f.run("get", { id: "root" });
  expect(root.children.length).toBeLessThanOrEqual(500); expect(root.totals.children).toBe(507); expect(root.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(root))).toBeLessThanOrEqual(240 * 1024);
}, 15000);

test("get/graph/results remain bounded and oversized required metadata refuses with repair guidance", () => {
  const f = fixture(), graph = f.run("graph", { id: "root", depth: 1, limit: 2 });
  expect(graph.nodes).toHaveLength(2); expect(graph.truncated).toBe(true);
  expect(graph.edges.every((edge: { source: string; target: string }) => graph.nodes.some((node: { id: string }) => node.id === edge.source) && graph.nodes.some((node: { id: string }) => node.id === edge.target))).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(graph))).toBeLessThanOrEqual(240 * 1024);
  f.write("src/engine/SPEC.md", markdown({ ...f.engineData, large: "x".repeat(250000) }, f.engineBody));
  expect(() => f.run("get", { id: "engine" })).toThrow("shorten oversized frontmatter");
  f.write("src/engine/SPEC.md", markdown(f.engineData, "\0".repeat(70000)));
  expect(() => f.run("get", { id: "engine", maxBytes: 65536 })).toThrow("reduce --max-bytes");
  const small = f.run("get", { id: "engine", maxBytes: 1000 });
  expect(small.body).toHaveLength(1000); expect(small.bodyTruncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThanOrEqual(240 * 1024);
});

test("source/worktree selection keeps linked branch results separate and refuses foreign roots", () => {
  const f = fixture(), linked = join(f.root, "linked"), foreign = join(f.root, "foreign");
  f.git(["worktree", "add", "--quiet", "--detach", linked]);
  f.write("src/engine/SPEC.md", markdown(f.engineData, "# Engine\nBranchquasar\n"), linked);
  mkdirSync(foreign); f.git(["-c", "init.templateDir=", "init", "--quiet"], foreign);
  f.write("design.md", markdown({ id: "foreign", type: "goal", title: "Foreign" }, "Foreignquasar\n"), foreign);
  addSpec(f.home, { id: "foreign", path: foreign });
  const before = [tree(f.repo), tree(linked), tree(foreign)];
  expect(f.run("grep", { query: "Branchquasar", worktree: linked }).hits.map((hit: { id: string }) => hit.id)).toEqual(["engine"]);
  expect(f.run("grep", { query: "Branchquasar" }).hits).toEqual([]);
  expect(f.run("get", { source: "foreign", id: "foreign", body: true }).body).toContain("Foreignquasar");
  expect(() => f.run("get", { id: "engine", worktree: foreign })).toThrow("another repository");
  expect([tree(f.repo), tree(linked), tree(foreign)]).toEqual(before);
});

test("validate returns the shared report and requireFresh makes only stale scopes fatal", () => {
  const f = fixture();
  expect(f.run("validate", {})).toMatchObject({ ok: true, errors: 0 });
  expect(f.run("validate", { requireFresh: true })).toMatchObject({ ok: true, errors: 0 });
  f.write("src/a.ts", "Synthetic changed source.\n");
  expect(f.run("validate", {})).toMatchObject({ ok: true, errors: 0 });
  expect(f.run("validate", { requireFresh: true }).items).toContainEqual(expect.objectContaining({ code: "stale", severity: "error" }));
});

test("direct provider schema errors happen before registry access and unknown sources/ids have next steps", () => {
  const f = fixture(), absent = join(f.root, "absent-home");
  expect(() => executeSpecCommand(absent, "get", { id: "engine", bogus: "private-value" })).toThrow("unknown argument: bogus");
  expect(existsSync(absent)).toBe(false);
  expect(() => f.run("get", { id: "engine", maxBytes: 0 })).toThrow("maxBytes");
  expect(() => f.run("graph", { id: "root", depth: 4 })).toThrow("depth");
  expect(() => f.run("grep", { offset: -1 })).toThrow("offset");
  expect(() => f.run("get", { id: "engine", source: "absent" })).toThrow("vmem specs list");
  expect(() => f.run("get", { id: "absent" })).toThrow("vmem spec grep");
});

test("registry rebinding during a read refuses the result instead of returning the old source", () => {
  const f = fixture(), replacement = join(f.root, "replacement"); mkdirSync(replacement);
  f.git(["-c", "init.templateDir=", "init", "--quiet"], replacement);
  f.write("design.md", markdown({ id: "replacement", type: "goal", title: "Replacement" }, "Replacement body.\n"), replacement);
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { mock } from "bun:test";
    import { readFileSync, writeFileSync } from "node:fs";
    const cp = await import("node:child_process"), spawn = cp.spawnSync; let changed = false;
    mock.module("node:child_process", () => ({ ...cp, spawnSync: (...args) => {
      const result = spawn(...args);
      if (!changed && args[1].includes("ls-files")) { changed = true; const config = JSON.parse(readFileSync(${JSON.stringify(join(f.home, CONFIG_FILE))}, "utf8")); config.specs[0].path = ${JSON.stringify(replacement)}; writeFileSync(${JSON.stringify(join(f.home, CONFIG_FILE))}, JSON.stringify(config)); }
      return result;
    } }));
    const { executeSpecCommand } = await import("./src/spec-commands.ts");
    try { executeSpecCommand(${JSON.stringify(f.home)}, "get", { id: "engine" }); process.exit(2); }
    catch (error) { console.log(JSON.stringify({ message: error.message })); }
  `], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString()).message).toContain("spec registry changed during the request");
});
