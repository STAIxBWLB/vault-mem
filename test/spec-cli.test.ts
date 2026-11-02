import { CONFIG_FILE } from "../src/config.ts";
import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../src/cli.ts";
import { specGit } from "../src/spec-git.ts";
import { addSpec } from "../src/registry.ts";
import { SPEC_COMMANDS } from "../src/spec-command-table.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vmem-spec-cli-")); roots.push(root);
  const repo = join(root, "repo"), home = join(root, "home"); mkdirSync(repo);
  const git = (args: string[]) => specGit(repo, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args]);
  git(["-c", "init.templateDir=", "init", "--quiet"]);
  const env = { ...process.env, VMEM_HOME: home, AGENTHUB_HOME: join(root, "unread-home") };
  return { root, repo, home, git, env };
}
const fixtures = resolve(import.meta.dir, "fixtures/spec-graph");
const cases = JSON.parse(readFileSync(join(fixtures, "expected.json"), "utf8")) as Record<string, { errors: string[]; warnings: string[] }>;
for (const [name, expected] of Object.entries(cases)) test(`registry-free CLI: ${name} preserves config and source with the expected exit code`, () => {
    const f = fixture(); cpSync(join(fixtures, name), f.repo, { recursive: true });
    f.git(["add", "--", "."]); f.git(["commit", "-qm", "Synthetic schema"]);
    // A bad explicit home proves --repo never even consults its config.
    mkdirSync(f.home); writeFileSync(join(f.home, CONFIG_FILE), "not JSON");
    const before = f.git(["status", "--porcelain=v1", "-z"]).stdout;
    const result = run(["spec", "validate", "--repo", f.repo, "--json"], f.env);
    expect(result.code, name).toBe(expected.errors.length ? 1 : 0);
    const report = JSON.parse(result.text);
    expect([...new Set(report.items.filter((item: any) => item.severity === "error").map((item: any) => item.code))].sort(), name).toEqual([...expected.errors].sort());
    expect(readFileSync(join(f.home, CONFIG_FILE), "utf8")).toBe("not JSON");
    expect(existsSync(join(f.root, "unread-home"))).toBe(false);
    expect(f.git(["status", "--porcelain=v1", "-z"]).stdout).toEqual(before);
});
test("CLI freshness exit codes, command help, closed flags and manifest match the implemented spec tools", () => {
  const f = fixture(); mkdirSync(join(f.repo, "src")); writeFileSync(join(f.repo, "src/a.ts"), "Synthetic source.\n");
  f.git(["add", "."]); f.git(["commit", "-qm", "Synthetic source"]);
  const stamp = f.git(["rev-parse", "HEAD"]).stdout.toString().trim();
  writeFileSync(join(f.repo, "SPEC.md"), `---\nid: root\ntype: goal\ntitle: Synthetic root\npaths: [src/a.ts]\nverified-against: ${stamp}\n---\n# Synthetic root\n- [ ] Synthetic task\n`);
  f.git(["add", "."]); f.git(["commit", "-qm", "Synthetic spec"]);
  const args = ["spec", "validate", "--repo", f.repo, "--json"];
  expect(run([...args, "--require-fresh"], f.env).code).toBe(0);
  writeFileSync(join(f.repo, "src/a.ts"), "Synthetic dirty source.\n");
  expect(run(args, f.env).code).toBe(0);
  expect(run([...args, "--require-fresh"], f.env).code).toBe(1);
  expect(existsSync(f.home)).toBe(false);
  addSpec(f.home, { id: "repo", path: f.repo });
  expect(run(["spec", "validate", "--json"], f.env).code).toBe(0);
  expect(JSON.parse(run(["spec", "grep", "--literal", "--json", "--", "- [ ]"], f.env).text).hits.map((hit: any) => hit.id)).toEqual(["root"]);
  expect(() => run([...args, "--source", "repo"], f.env)).toThrow("cannot be combined");
  expect(() => run(["spec", "get", "root", "--max-bytes", "65537"], f.env)).toThrow("maxBytes");
  expect(() => run(["spec", "get", "root", "--max-bytes", "0"], f.env)).toThrow("vmem spec get --help");
  expect(() => run(["spec", "grep", "--typo", "x"], f.env)).toThrow("--typo");
  expect(() => run(["spec", "validate", "--require-fresh", "--require-fresh"], f.env)).toThrow("repeated option");
  for (const item of SPEC_COMMANDS) expect(run(["spec", item.command, "--help"], f.env)).toMatchObject({ code: 0, text: expect.stringContaining(item.usage) });
  expect(run(["completion", "bash"], f.env).text).toContain("get graph grep validate");
  const manifest = JSON.parse(run(["manifest", "--json"], f.env).text);
  for (const item of SPEC_COMMANDS) {
    expect(manifest.mcp.tools).toContain(item.name);
    expect(manifest.commands).toContain(`spec ${item.command}`);
  }
  expect(manifest.mcp.tools).not.toContain("vmem_spec_create");
});


test("fish completion keeps spec graph options out of graph build and log grep", () => {
  const script = run(["completion", "fish"]).text;
  const optionsFor = (words: string[]) => script.split("\n").flatMap(line => {
    const condition = /-n '([^']+)'/.exec(line)?.[1], option = /-l ([a-z-]+)$/.exec(line)?.[1];
    if (!condition || !option) return [];
    return condition.split("; and ").every(part => part.startsWith("__fish_seen_subcommand_from ") && words.includes(part.split(" ").at(-1)!)) ? [option] : [];
  });
  expect(optionsFor(["spec", "graph"])).toContain("direction");
  expect(optionsFor(["graph", "build"])).not.toContain("direction");
  expect(optionsFor(["log", "grep"])).not.toContain("source");
});
