import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { analysisInput } from "../src/analysis-input.ts";
import { lintVault } from "../src/vault-lint.ts";
import { sourceAgeFindings } from "../src/source-age.ts";
import { run } from "../src/cli.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const gitEnv = { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(cwd: string, date: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...gitEnv, GIT_AUTHOR_NAME: "F", GIT_AUTHOR_EMAIL: "f@example.invalid", GIT_COMMITTER_NAME: "F", GIT_COMMITTER_EMAIL: "f@example.invalid", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}
const note = (stem: string, source: unknown, updated?: string) =>
  `---\ndescription: Synthetic note.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\nsource: ${JSON.stringify(source)}\n${updated ? `updated: ${updated}\n` : ""}---\n# ${stem}\n`;

/** Isolated git workspace: tracked-changed, tracked-unchanged and untracked-modified sources. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-l17-"))); roots.push(root);
  const home = join(root, "state"), vault = join(root, "vault"), notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true }); mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "workspace.config.yaml"), "name: fixture\n");
  writeFileSync(join(root, "projects.yaml"), "projects: []\n");
  writeFileSync(join(root, "docs", "changed.md"), "v1\n");
  writeFileSync(join(root, "docs", "same.md"), "v1\n");
  writeFileSync(join(root, ".gitignore"), "vault/\nstate/\ndocs/untracked.md\ndocs/old.md\n");
  git(root, "2026-01-01T12:00:00", "init", "-q", "-b", "main");
  git(root, "2026-01-01T12:00:00", "add", ".");
  git(root, "2026-01-01T12:00:00", "commit", "-qm", "init");
  writeFileSync(join(root, "docs", "changed.md"), "v2\n");
  git(root, "2026-03-01T12:00:00", "commit", "-qam", "edit 1");
  writeFileSync(join(root, "docs", "changed.md"), "v3\n");
  git(root, "2026-03-02T12:00:00", "commit", "-qam", "edit 2");
  writeFileSync(join(root, "docs", "untracked.md"), "u\n");
  writeFileSync(join(root, "docs", "old.md"), "o\n");
  utimesSync(join(root, "docs", "old.md"), new Date("2025-12-01T00:00:00"), new Date("2025-12-01T00:00:00"));
  writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic directory.\n---\n# Research\n");
  addVault(home, { id: "mine", path: vault, kind: "personal", write: "none", registry: join(root, "projects.yaml") });
  const env = { ...gitEnv, VMEM_HOME: home, AGENTHUB_HOME: join(root, "family"), AMEM_HOME: join(root, "memory") };
  return { root, home, vault, notes, env };
}

test("A1 tracked-changed is flagged with its count, unchanged is not, untracked-modified is `modified`", () => {
  const f = fixture();
  writeFileSync(join(f.notes, "a.md"), note("a", ["docs/changed.md", "docs/same.md"], "2026-02-01"));
  writeFileSync(join(f.notes, "b.md"), note("b", "docs/changed.md", "2026-03-01"));
  writeFileSync(join(f.notes, "c.md"), note("c", ["docs/untracked.md", "docs/old.md"], "2026-02-01"));
  writeFileSync(join(f.notes, "d.md"), note("d", "docs/changed.md", "2026-03-05"));
  const report = lintVault(analysisInput(f.home, "mine", { hints: true }).snapshot);
  expect(report.findings.L17).toEqual([
    "`notes/a.md`: source `docs/changed.md` has 2 commits after updated; re-check the note against it, then save it to refresh updated",
    "`notes/b.md`: source `docs/changed.md` has 1 commit after updated; re-check the note against it, then save it to refresh updated",
    "`notes/c.md`: source `docs/untracked.md` modified after updated (not tracked by the workspace repository, judged by mtime); re-check the note against it, then save it to refresh updated",
  ]);
  expect(report.markdown).toContain("## L17 — source changed after updated (warn, 3건)");
});

test("A2 no updated is unknown age; URL, memory id, denied, missing and outside paths are skipped without duplicating L14", () => {
  const f = fixture();
  writeFileSync(join(f.root, "outside.md"), "x\n");
  writeFileSync(join(f.notes, "old.md"), note("old", "docs/changed.md"));
  writeFileSync(join(f.notes, "mixed.md"), note("mixed", ["https://example.invalid/a", "mem:abc", "docs/missing.md", "docs/changed.md"], "2026-02-01"));
  const snapshot = analysisInput(f.home, "mine", { hints: true }).snapshot, report = lintVault(snapshot);
  expect(report.findings.L17).toEqual(["`notes/mixed.md`: source `docs/changed.md` has 2 commits after updated; re-check the note against it, then save it to refresh updated"]);
  expect(report.findings.L14.some(line => line.includes("docs/missing.md"))).toBe(true);
  expect(report.findings.L17.some(line => line.includes("missing"))).toBe(false);
  expect(snapshot.sourceAge!.unknownAge).toBe(1);
  expect(report.markdown).toContain("unknown age 1건");
  const denied = sourceAgeFindings(snapshot.notes, f.root, [join(f.root, "docs", "changed.md")]);
  expect(denied.findings).toEqual({});
});

test("A2 the per-run path cap counts skipped sources instead of checking them", () => {
  const f = fixture();
  writeFileSync(join(f.notes, "a.md"), note("a", ["docs/changed.md", "docs/same.md", "docs/untracked.md"], "2026-02-01"));
  const snapshot = analysisInput(f.home, "mine").snapshot;
  const capped = sourceAgeFindings(snapshot.notes, f.root, [], { maxPaths: 1 });
  expect(capped.skipped).toBe(2);
  expect(capped.findings["a.md"]).toHaveLength(1);
});

test("A3 metadata only: no source file is opened for reading and nothing is written; CLI JSON and MCP carry L17", async () => {
  const f = fixture();
  writeFileSync(join(f.notes, "a.md"), note("a", "docs/changed.md", "2026-02-01"));
  const before = readdirSync(f.root, { recursive: true }).sort();
  const opened: string[] = [], openSpy = spyOn(fs, "openSync"), readSpy = spyOn(fs, "readFileSync");
  try {
    const snapshot = analysisInput(f.home, "mine").snapshot;
    openSpy.mockClear(); readSpy.mockClear();
    sourceAgeFindings(snapshot.notes, f.root, []);
    for (const call of [...openSpy.mock.calls, ...readSpy.mock.calls]) opened.push(String(call[0]));
  } finally { openSpy.mockRestore(); readSpy.mockRestore(); }
  expect(opened.filter(path => path.includes("docs"))).toEqual([]);
  const cli = run(["lint", "mine", "--json"], f.env);
  const json = JSON.parse(cli.text) as { findings: { L17: string[] } };
  expect(json.findings.L17).toHaveLength(1);
  const mcp = createVaultMcp(f.home, f.env);
  expect(((await mcp.handlers.vmem_lint!({ vault: "mine" })) as { findings: { L17: string[] } }).findings.L17).toEqual(json.findings.L17);
  expect(readdirSync(f.root, { recursive: true }).sort()).toEqual(before);
});

test("control characters and pathspec magic never reach git as expressions", () => {
  const f = fixture();
  writeFileSync(join(f.root, "docs", ":(glob)*"), "x\n");
  writeFileSync(join(f.notes, "a.md"), note("a", ["docs/:(glob)*", "docs/same.md"], "2026-02-01"));
  const snapshot = analysisInput(f.home, "mine").snapshot;
  const result = sourceAgeFindings(snapshot.notes, f.root, []);
  // The literal untracked file is judged by its own mtime, and the glob does not expand to docs/changed.md.
  expect(result.findings["a.md"]).toEqual(["source `docs/:(glob)*` modified after updated (not tracked by the workspace repository, judged by mtime); re-check the note against it, then save it to refresh updated"]);
});

test("A1 a merge after updated counts once even when the merged branch commits predate updated", () => {
  const f = fixture();
  git(f.root, "2026-01-05T12:00:00", "checkout", "-q", "-b", "side");
  writeFileSync(join(f.root, "docs", "same.md"), "side\n");
  git(f.root, "2026-01-05T12:00:00", "commit", "-qam", "side edit");
  git(f.root, "2026-01-05T12:00:00", "checkout", "-q", "main");
  git(f.root, "2026-04-01T12:00:00", "merge", "-q", "--no-ff", "-m", "merge side", "side");
  writeFileSync(join(f.notes, "a.md"), note("a", "docs/same.md", "2026-02-01"));
  const report = lintVault(analysisInput(f.home, "mine", { hints: true }).snapshot);
  expect(report.findings.L17).toEqual(["`notes/a.md`: source `docs/same.md` has 1 commit after updated; re-check the note against it, then save it to refresh updated"]);
});

test("the pathspec byte cap counts the rest as skipped instead of risking E2BIG", () => {
  const f = fixture();
  writeFileSync(join(f.notes, "a.md"), note("a", ["docs/changed.md", "docs/same.md"], "2026-02-01"));
  const snapshot = analysisInput(f.home, "mine").snapshot;
  const capped = sourceAgeFindings(snapshot.notes, f.root, [], { maxArgvBytes: 30 });
  expect(capped.skipped).toBe(1);
  expect(capped.findings["a.md"]).toHaveLength(1);
});

test("a directory source is credited by the commits of the files under it", () => {
  const f = fixture();
  writeFileSync(join(f.notes, "a.md"), note("a", "docs", "2026-02-01"));
  const snapshot = analysisInput(f.home, "mine").snapshot;
  expect(sourceAgeFindings(snapshot.notes, f.root, []).findings["a.md"]).toEqual(["source `docs` has 2 commits after updated; re-check the note against it, then save it to refresh updated"]);
});
