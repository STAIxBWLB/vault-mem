import { agentMemInfo } from "../src/platform.ts";
import { effectiveDomains } from "../src/config.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { renderDoctor, renderManifest, renderRecover, renderRemove, renderSetup, renderSpecAdd, renderSpecsList, renderStats, renderStatus, renderVaultAdd, renderVaultPii, renderVaultsList, type StatusResult } from "../src/cli-output.ts";
import { COMMANDS, commandUsage, HELP_SECTIONS, help } from "../src/commands-table.ts";
import { resolveHome } from "../src/home.ts";
import { piiPolicy } from "../src/pii.ts";
import { addVault, effectivePii, loadRegistry, registryStatus } from "../src/registry.ts";
import { PLAIN, textOptions } from "../src/text-output.ts";
import { vaultStats } from "../src/vault-stats.ts";
import { version } from "../package.json";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-cli-output-"))); roots.push(root);
  const home = join(root, "home"), vault = join(root, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  addVault(home, { id: "mine", path: vault, kind: "personal", write: "none" });
  return { home, vault, env: { VMEM_HOME: home } };
}
const ANSI = /\u001b\[/;

const STATUS: StatusResult = {
  home: "/h", source: "VMEM_HOME", version: "9.9.9", healthy: false,
  vaults: [
    { id: "personal", path: "/v/p", kind: "personal", write: "mcp", pii: "allow", healthy: true, remote: "git@example.com:o/p.git",
      checks: { remote: { ok: false, issue: "origin differs" } }, tidy: { pending: { keys: 2, topics: 0 }, notes: 2, unparsable: ["notes/bad.md"], hint: "Run vmem tidy personal --all" } },
    { id: "team", path: "/v/t", kind: "org", write: "none", pii: "deny", healthy: false, issue: "vault path or notes directory unavailable or changed" },
  ],
  specs: [{ id: "repo", path: "/r", write: "none", pii: "deny", healthy: true }],
};

test("status and doctor report findings and sections", () => {
  const status = renderStatus(STATUS, PLAIN);
  expect(status).toContain("vmem status");
  expect(status).toContain("▸ Vaults");
  expect(status).toContain("▸ Spec sources");
  expect(status.indexOf("▸ Problems")).toBeLessThan(status.indexOf("▸ Home"));
  expect(status).toContain("team: vault path or notes directory unavailable or changed");
  const doctor = renderDoctor(STATUS, PLAIN);
  expect(doctor).toContain("vmem doctor");
  expect(doctor).toContain("git -C /v/p remote -v");
  expect(doctor).toContain("vmem tidy personal --all");
  expect(doctor.indexOf("team path:")).toBeLessThan(doctor.indexOf("personal path:"));
  expect(doctor).toContain("2 failed");
});

test("#114 AC3: help has the tagline, every section and every command with its description; per-command help prints its entries", () => {
  for (const command of COMMANDS) {
    expect(HELP_SECTIONS).toContain(command.section);
    expect(command.description.length).toBeGreaterThan(0);
  }
  const text = help();
  expect(text.split("\n").slice(0, 4)).toEqual([
    `vmem ${version}: validated knowledge vaults for agents and people`,
    "",
    "Registry",
    "  vmem status [--json]            show the home, registered vaults and spec sources, and vault health",
  ]);
  for (const section of HELP_SECTIONS) expect(text).toContain(`\n${section}\n`);
  for (const command of COMMANDS) expect(text).toContain(command.description);
  expect(text).toContain("--color=auto|always|never");
  expect(commandUsage("status")).toBe("Registry\n  vmem status [--json]            show the home, registered vaults and spec sources, and vault health");
  expect(commandUsage("recover", { color: false, columns: 80 })).toBe([
    "Registry",
    "  vmem recover [--confirm] [--json]",
    "                                  preview, then remove with --confirm, a stale",
    "                                  registry lock and leftover temporary files",
  ].join("\n"));
  expect(commandUsage("vaults")!.split("\n").filter(line => line.startsWith("  vmem "))).toHaveLength(4);
  expect(commandUsage("nope")).toBeUndefined();
  const o = textOptions(undefined, {});
  expect(run(["help", "vaults", "pii"], {})).toEqual({ code: 0, text: commandUsage("vaults pii", o)! });
  expect(run(["vaults", "pii", "--help"], {})).toEqual({ code: 0, text: commandUsage("vaults pii", o)! });
  expect(() => run(["help", "nope"], {})).toThrow("help: unknown command nope; run vmem help");
  expect(run(["--version"]).text).toBe(version);
  expect(help({ color: true })).toMatch(ANSI);
});

test("registry reports retain their information and complete confirmation commands", () => {
  const vault = { id: "mine", path: "/v/m", kind: "personal" as const, write: "mcp" as const, pii: "allow" as const };
  expect(renderVaultsList([vault], PLAIN)).toContain("/v/m");
  expect(renderVaultsList([], PLAIN)).toContain("vmem help vaults add");
  expect(renderVaultAdd({ vault }, PLAIN)).toContain("registered mine");
  expect(renderRemove("vaults", { applied: false, vault: { id: "mine", path: "/v/m" } }, PLAIN)).toContain("vmem vaults remove mine --confirm");
  expect(renderRemove("specs", { applied: true, spec: { id: "repo", path: "/r" } }, PLAIN)).toContain("the repository stays on disk");
  expect(renderSpecsList([{ id: "repo", path: "/r", write: "none", pii: "deny" }], PLAIN)).toContain("repo");
  expect(renderSpecsList([], PLAIN)).toContain("vmem help specs add");
  expect(renderSpecAdd({ spec: { id: "repo", path: "/r", write: "none", pii: "deny" } }, PLAIN)).toContain("registered repo");
});

test("PII previews show loosened cells and the confirmation command", () => {
  const policy = piiPolicy({ id: "mine", path: "/v", kind: "personal", write: "mcp", pii: { email: "deny", allow: ["x@example.com"] } });
  const preview = renderVaultPii({ vault: "mine", pii: "custom", piiPolicy: policy, applied: false, changed: true, loosened: ["phone.notes: deny -> allow"], preview: true }, PLAIN, "vmem vaults pii mine --set allow --confirm");
  expect(preview).toContain("loosens phone.notes: deny -> allow");
  expect(preview).toContain("vmem vaults pii mine --set allow --confirm");
  expect(preview).not.toContain("x@example.com");
});

test("recovery reports the state and confirmation", () => {
  const lock = { path: "/h/.lock", state: "stale" as const, owner: { pid: 7, host: "box", created: "2026-11-04T00:00:00Z" }, removed: false };
  const preview = renderRecover({ applied: false, lock, temporaryFiles: [".config-1.tmp"], removedTemporaryFiles: [] }, PLAIN);
  expect(preview).toContain(".config-1.tmp");
  expect(preview).toContain("vmem recover --confirm");
  expect(renderRecover({ applied: false, lock: { ...lock, state: "live" }, temporaryFiles: [], removedTemporaryFiles: [], blocked: "a live writer holds the lock" }, PLAIN)).toContain("recovery blocked");
});

test("#114 AC1: stats prints field blocks, manifest marks read-only tools and setup prints HOST/CHANGE/PATH and the apply command", () => {
  const stats = renderStats({ vault: "mine", asOf: "2026-11-04", notes: { total: 3, byType: { concept: 1, finding: 2 }, byDomain: { ai: 3 }, byStatus: {} }, modified: { last7Days: 1, last30Days: 3 },
    size: { total: { notes: 3, bytes: 2048, words: 300 }, byType: {}, byDomain: {} },
    ratio: { notes: 2, sources: 3, skipped: 1, skippedNonFile: 1, emptySourceNotes: 0, truncatedNotes: 4, median: 0.5, p90: 1.2, overOne: 1, largest: [{ path: "notes/a.md", ratio: 1.2 }] },
    log: { days: 30, since: "2026-10-06", total: 2, byType: { INGEST: 0, LEARN: 2 }, warnings: ["skipped 1 line"], issues: [] } }, PLAIN);
  expect(stats).toContain("▸ Note-to-source ratio");
  expect(stats).toContain("notes/a.md: 1.2");
  expect(stats).toContain("skipped 1 line");
  const empty = renderStats({ vault: "mine", asOf: "2026-11-04", notes: { total: 0, byType: {}, byDomain: {}, byStatus: {} }, modified: { last7Days: 0, last30Days: 0 },
    size: { total: { notes: 0, bytes: 0, words: 0 }, byType: {}, byDomain: {} },
    ratio: { notes: 0, sources: 0, skipped: 2, skippedNonFile: 2, emptySourceNotes: 0, truncatedNotes: 0, median: null, p90: null, overOne: 0, largest: [] },
    log: { days: 30, since: "2026-10-06", total: 0, byType: { INGEST: 0, LEARN: 0 }, warnings: [], issues: [] } }, PLAIN);
  expect(empty).toContain("no note cites a readable workspace file");
  expect(empty).toMatch(/Skipped references:\s+2/);
  // The truncation line appears only when the index cut sourced notes, so the common output keeps its shape.
  expect(empty).not.toContain("Note size");
  const manifest = renderManifest({ name: "@staix/vault-mem", version: "9.9.9", configVersion: 2, mcp: { server: "vmem", tools: [{ name: "vmem_status", readOnly: true }, "vmem_create"] }, commands: ["status", "doctor"] }, PLAIN);
  expect(manifest).toContain("read-only");
  expect(manifest).toContain("vmem_create");
  expect(manifest).toContain("-  status");
  expect(manifest).not.toContain("?  status");
  const report = { mode: "dry-run" as const, applied: false, entry: { command: "/opt/bun", args: ["mcp"] }, notes: [], actions: [{ target: "claude" as const, file: "/fixture/claude", change: "add" as const }, { target: "codex" as const, file: "/fixture/codex", change: "refused" as const, reason: "unparsable TOML" }] };
  const setup = renderSetup(report, PLAIN, "vmem setup all --apply");
  expect(setup).toContain("unparsable TOML");
  expect(setup).toContain("vmem setup all --apply");
  expect(setup).toContain("1 failed");
});

test("#114 AC1: --json keeps the previous compact JSON, default output is text, and --color=always adds ANSI codes", () => {
  const f = fixture();
  const status = run(["status", "--json"], f.env).text;
  expect(status).toBe(JSON.stringify({ ...resolveHome(f.env), version, agentMem: agentMemInfo, healthy: true, vaults: registryStatus(f.home).map(v => ({ ...v, checks: undefined })) }));
  const vaults = loadRegistry(f.home).vaults.map(v => ({ ...v, domains: effectiveDomains(v), pii: effectivePii(v), piiPolicy: piiPolicy(v) }));
  expect(run(["vaults", "list", "--json"], f.env).text).toBe(JSON.stringify(vaults));
  expect(run(["vaults", "remove", "mine", "--json"], f.env).text).toBe(JSON.stringify({ applied: false, vault: loadRegistry(f.home).vaults[0] }));
  expect(run(["specs", "list", "--json"], f.env).text).toBe("[]");
  expect(JSON.parse(run(["recover", "--json"], f.env).text)).toMatchObject({ applied: false, lock: { state: "absent" } });
  expect(JSON.parse(run(["stats", "mine", "--json"], f.env).text)).toEqual(JSON.parse(JSON.stringify(vaultStats(f.home, "mine"))));
  expect(JSON.parse(run(["doctor", "--json"], f.env).text)).toMatchObject({ healthy: true, vaults: [{ id: "mine", healthy: true }] });
  for (const args of [["status"], ["doctor"], ["vaults", "list"], ["specs", "list"], ["recover"], ["stats", "mine"], ["manifest"], ["vaults", "remove", "mine"]]) {
    const plain = run([...args, "--color=never"], f.env).text;
    expect(() => JSON.parse(plain)).toThrow();
    expect(plain).not.toMatch(ANSI);
  }
  expect(run(["status", "--color=always"], f.env).text).toMatch(ANSI);
  expect(run(["doctor", "--color=always"], f.env).text).toMatch(ANSI);
  expect(run(["status", "--color=never"], { ...f.env, NO_COLOR: "1" }).text).toBe(renderStatus(JSON.parse(status), textOptions("never", f.env)));
  const manifest = JSON.parse(run(["manifest", "--json"]).text);
  expect(manifest.commands).toEqual(COMMANDS.map(c => c.name));
});
