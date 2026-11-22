import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { addSpec } from "../src/registry.ts";
import { executeSpecCommand } from "../src/spec-commands.ts";
import { specGit } from "../src/spec-git.ts";
import { offsetCommand, renderSpecGet, renderSpecGraph, renderSpecGrep, renderSpecValidate, type SpecGetResult, type SpecValidateResult } from "../src/spec-output.ts";
import { validateSpecRepo } from "../src/spec-validate.ts";
import { PLAIN } from "../src/text-output.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const get: SpecGetResult = {
  source: "repo", worktree: "/w", id: "root", path: "SPEC.md", sha256: "0".repeat(64),
  frontmatter: { id: "root", type: "goal", title: "Synthetic root", status: "active", paths: ["src/a.ts", "src/b.ts"] },
  links: [], backlinks: [{ source: "api", target: "root", kind: "parent" }], children: [{ id: "api", path: "specs/api.md", title: "API", type: "module" }],
  freshness: { path: "SPEC.md", id: "root", state: "stale", commits: 2, dirty: true }, freshnessIssues: [],
  truncated: true, totals: { links: 0, backlinks: 1, children: 3 },
  body: "# Root\n\n## Scope\nLine \u001b[31mred\u001b[0m\n", bodyTruncated: true, nextOffset: 32, headings: ["Scope", "Other"], section: "Scope",
};
const report: SpecValidateResult = {
  source: "repo", worktree: "/w", ok: false, errors: 1, warnings: 1, truncated: false,
  items: [
    { code: "dangling_link", severity: "error", path: "specs/api.md", id: "api", field: "parent", target: "gone", message: "frontmatter link names no graph node" },
    { code: "orphan", severity: "warning", path: "specs/b.md", id: "b", field: "parent", message: "non-goal spec has no parent" },
  ],
  diagnostics: [{ code: "skipped_path", path: "specs/link.md", message: "symlink skipped" }],
  freshness: [{ path: "SPEC.md", id: "root", state: "stale", commits: 1, dirty: false }, { path: "specs/api.md", state: "fresh", commits: 0, dirty: false }],
};

test("spec get preserves body and gives a complete continuation", () => {
  const text = renderSpecGet(get, PLAIN, { args: ["get", "root", "--section", "Scope", "--max-bytes", "32"], values: {} });
  expect(text).toContain("Synthetic root"); expect(text).toContain("stale: 2 commits");
  expect(text).toContain("# Root\n\n## Scope\nLine red");
  expect(text).toContain("vmem spec get root --section Scope --max-bytes 32 --offset 32");
  expect(text).toContain("api (1 of 3)");
});

test("spec validate uses findings, discovery and freshness sections and one summary", () => {
  const text = renderSpecValidate(report, PLAIN, { args: ["validate"], values: {} });
  expect(text).toContain("▸ Findings"); expect(text).toContain("▸ Discovery"); expect(text).toContain("▸ Freshness");
  expect(text.indexOf("dangling_link")).toBeLessThan(text.indexOf("orphan"));
  expect(text.split("\n").at(-1)).toBe("✗ 1 failed  ⚠ 1 warning  ? 1 unknown");
  const clean = renderSpecValidate({ ...report, ok: true, errors: 0, warnings: 0, items: [], diagnostics: [], freshness: [] }, PLAIN, { args: ["validate", "--repo", "/r"], values: { requireFresh: true }, repo: "/r" });
  expect(clean).toEndWith("✓ 1 ok");
  expect(renderSpecValidate(report, PLAIN, { args: ["validate"], values: { requireFresh: true } })).not.toContain("Freshness");
});

test("spec graph keeps breadth-first depth and grep continuation preserves separator", () => {
  const nodes = [{ id: "root", path: "SPEC.md", title: "Root", type: "goal", status: "active" }, { id: "api", path: "a.md", title: "API", type: "module" }, { id: "db", path: "d.md", title: "DB", type: "module" }];
  const graph = renderSpecGraph({ source: "repo", worktree: "/w", nodes, truncated: true, edges: [{ source: "api", target: "root", kind: "parent" }, { source: "db", target: "api", kind: "parent" }, { source: "db", target: "root", kind: "depends-on" }] }, PLAIN, { args: ["graph", "root"], values: { direction: "neighbors" } });
  expect(graph).toContain("Nodes:"); expect(graph).toContain("depends-on"); expect(graph).toContain("truncated");
  const grep = renderSpecGrep({ source: "repo", worktree: "/w", offset: 0, truncated: true, nextOffset: 1, hits: [{ id: "root", path: "SPEC.md", title: "Root", type: "goal", status: "active", snippet: "line\none red" }] }, PLAIN, { args: ["grep", "--literal", "--", "red"], values: {} });
  expect(grep).toContain("line one red"); expect(grep).toContain("vmem spec grep --literal --offset 1 -- red");
  expect(renderSpecGrep({ source: "repo", worktree: "/w", offset: 0, truncated: false, hits: [] }, PLAIN, { args: ["grep"], values: {} })).toContain("no specs matched");
  expect(offsetCommand(["get", "my spec", "--offset", "5", "--body"], 9)).toBe("vmem spec get 'my spec' --body --offset 9");
});

test("#114 AC1: spec commands print text by default and the previous compact JSON with --json", () => {
  const root = mkdtempSync(join(tmpdir(), "vmem-spec-output-")); roots.push(root);
  const repo = join(root, "repo"), home = join(root, "home"); mkdirSync(join(repo, "specs"), { recursive: true });
  const git = (args: string[]) => specGit(repo, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args]);
  git(["-c", "init.templateDir=", "init", "--quiet"]);
  writeFileSync(join(repo, "SPEC.md"), "---\nid: root\ntype: goal\ntitle: Synthetic root\n---\n# Root\nSynthetic widget.\n");
  writeFileSync(join(repo, "specs/api.md"), "---\nid: api\ntype: module\ntitle: Synthetic API\nparent: root\n---\n# API\n[[gone]]\n");
  git(["add", "."]); git(["commit", "-qm", "Synthetic specs"]);
  const env = { ...process.env, VMEM_HOME: home, AGENTHUB_HOME: join(root, "unread-home") };
  addSpec(home, { id: "repo", path: repo });
  const cases: [string[], Record<string, unknown>, string][] = [
    [["get", "root", "--body"], { id: "root", body: true }, " vmem spec get"],
    [["graph", "root"], { id: "root" }, " vmem spec graph"],
    [["grep", "widget"], { query: "widget" }, " vmem spec grep"],
    [["validate"], {}, " vmem spec validate"],
  ];
  for (const [args, values, first] of cases) {
    const command = args[0] as "get" | "graph" | "grep" | "validate";
    expect(run(["spec", ...args, "--json"], env).text).toBe(JSON.stringify(executeSpecCommand(home, command, values, env)));
    const text = run(["spec", ...args], env);
    expect(text.text.split("\n")[0]).toBe(first);
    expect(text.code).toBe(0);
  }
  expect(run(["spec", "validate", "--repo", repo, "--json"], env).text).toBe(JSON.stringify(validateSpecRepo(repo, { env }).report));
  expect(run(["spec", "validate", "--repo", repo], env).text).toEndWith("⚠ 1 warning");
  expect(run(["spec", "get", "root", "--color=always"], env).text).toContain("\u001b[1;34m vmem spec get");
  expect(run(["spec", "get", "root", "--color=never"], env).text).not.toContain("\u001b");
});
