import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnalysisCommand } from "../src/analysis-commands.ts";

const home = "/nonexistent/vmem-home-121";
test("lint and graph build name the option they refuse and where it applies (#121)", () => {
  for (const [option, value] of [["--hops", "2"], ["--limit", "5"], ["--relation", "supports"]] as const) {
    expect(() => runAnalysisCommand("lint", ["v", option, value], home)).toThrow(`lint: ${option} applies only to graph neighbors`);
    expect(() => runAnalysisCommand("graph", ["build", "v", option, value], home)).toThrow(`graph build: ${option} applies only to graph neighbors`);
  }
  expect(() => runAnalysisCommand("graph", ["build", "v", "--note", "a"], home)).toThrow("graph build: --note applies only to lint");
  expect(() => runAnalysisCommand("graph", ["build", "v", "--write"], home)).toThrow("graph build: --write applies only to lint");
  expect(() => runAnalysisCommand("lint", ["v", "--workspace"], home)).toThrow("lint: --workspace applies only to graph build");
  expect(() => runAnalysisCommand("graph", ["neighbors", "v", "a", "--workspace"], home)).toThrow("graph neighbors: --workspace applies only to graph build");
  // Wrong positional counts keep their messages.
  expect(() => runAnalysisCommand("lint", [], home)).toThrow("lint: requires one vault id");
  expect(() => runAnalysisCommand("graph", ["build"], home)).toThrow("graph build: requires one vault id");
  expect(() => runAnalysisCommand("graph", ["neighbors", "v"], home)).toThrow("graph: use build <vault> or neighbors <vault> <stem>");
});

test("a refused option exits 1 through the CLI with the named message (#121)", () => {
  const r = Bun.spawnSync(["bun", "bin/vmem.js", "graph", "build", "v", "--relation", "supports"], { env: { ...process.env, VMEM_HOME: home } });
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("graph build: --relation applies only to graph neighbors");
});

test("graph neighbors refuses --dry-run, exits 1 and writes nothing (#127)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-127-")));
  try {
    const vmemHome = join(root, "state"), vault = join(root, "v");
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(join(vault, "notes", "a.md"), "---\ntype: insight\n---\n[[b]]\n");
    writeFileSync(join(vault, "notes", "b.md"), "---\ntype: insight\n---\n");
    const env = { ...process.env, VMEM_HOME: vmemHome };
    expect(Bun.spawnSync(["bun", "bin/vmem.js", "vaults", "add", "v", vault, "--kind", "personal", "--write", "cli"], { env }).exitCode).toBe(0);
    const before = readdirSync(vault, { recursive: true }).map(String).sort();
    const r = Bun.spawnSync(["bun", "bin/vmem.js", "graph", "neighbors", "v", "a", "--dry-run"], { env });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("graph neighbors: --dry-run applies only to lint --write and graph build");
    expect(readdirSync(vault, { recursive: true }).map(String).sort()).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
