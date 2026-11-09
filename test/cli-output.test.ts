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

test("#114 AC1: status prints a title verdict, a vault table, issues and spec sources", () => {
  expect(renderStatus(STATUS, PLAIN)).toBe([
    "vmem 9.9.9  home /h (VMEM_HOME)  unhealthy",
    "",
    "VAULT     KIND      WRITE  PII    HEALTH  PATH",
    "personal  personal  mcp    allow  ok      /v/p",
    "team      org       none   deny   fail    /v/t",
    "team: vault path or notes directory unavailable or changed",
    "",
    "SOURCE  WRITE  PII   PATH",
    "repo    none   deny  /r",
  ].join("\n"));
  expect(renderStatus({ ...STATUS, healthy: true, vaults: [] }, PLAIN)).toContain("no vaults registered; add one with vmem vaults add");
});

test("#114 AC1: doctor prints LEVEL/CHECK/FINDING per vault and spec source, the tidy command and a verdict", () => {
  expect(renderDoctor(STATUS, PLAIN)).toBe([
    "vmem 9.9.9  home /h (VMEM_HOME)",
    "",
    "Vault personal",
    "LEVEL  CHECK   FINDING",
    "ok     path    /v/p",
    "fail   remote  origin differs",
    "warn   tidy    2 notes to migrate (keys 2); 1 unparsable note skipped",
    "next: vmem tidy personal --all, then confirm its fingerprint to apply the migration",
    "",
    "Vault team",
    "LEVEL  CHECK  FINDING",
    "fail   path   /v/t: vault path or notes directory unavailable or changed",
    "",
    "Spec source repo",
    "LEVEL  CHECK  FINDING",
    "ok     root   /r",
    "",
    "unhealthy: 2 failed checks; fix the findings above, then run vmem doctor again",
  ].join("\n"));
  const healthy = renderDoctor({ ...STATUS, healthy: true, vaults: [{ ...STATUS.vaults[0]!, checks: { remote: { ok: true } }, tidy: undefined }] }, PLAIN);
  expect(healthy).toContain("ok     remote  git@example.com:o/p.git");
  expect(healthy.endsWith("healthy: 1 vault and 1 spec source checked")).toBe(true);
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

test("#114 AC1/AC4: registry lists, adds and remove previews print their result and the confirm command", () => {
  const vault = { id: "mine", path: "/v/m", kind: "personal" as const, write: "mcp" as const, pii: "allow" };
  const listed = renderVaultsList([vault], PLAIN);
  expect(listed).toContain("DOMAINS");
  expect(listed).toContain("research, projects, teaching, operations, people, ai-practice");
  expect(listed).toContain("/v/m");
  expect(renderVaultsList([], PLAIN)).toContain("no vaults registered");
  expect(renderVaultAdd({ vault: { id: "mine", path: "/v/m", kind: "org", write: "cli" } }, PLAIN)).toBe("registered vault mine: org, write cli, PII deny, at /v/m");
  expect(renderRemove("vaults", { applied: false, vault: { id: "it's", path: "/v/m" } }, PLAIN))
    .toBe(`dry run: would unregister vault it's at /v/m; its files stay on disk\n\nconfirm: vmem vaults remove 'it'"'"'s' --confirm`);
  expect(renderRemove("specs", { applied: true, spec: { id: "repo", path: "/r" } }, PLAIN)).toBe("unregistered spec source repo at /r; the repository stays on disk");
  expect(renderSpecsList([{ id: "repo", path: "/r", write: "none", pii: "deny" }], PLAIN)).toBe("SOURCE  WRITE  PII   PATH\nrepo    none   deny  /r");
  expect(renderSpecsList([], PLAIN)).toContain("no spec sources registered");
  expect(renderSpecAdd({ spec: { id: "repo", path: "/r", write: "none", pii: "deny" } }, PLAIN)).toBe("registered spec source repo: write none, PII deny, at /r");
});

test("#114 AC1/AC4: vaults pii shows the matrix, loosened cells and the confirm command of a preview", () => {
  const policy = piiPolicy({ id: "mine", path: "/v", kind: "personal", write: "mcp", pii: { email: "deny", allow: ["x@example.com"] } });
  const preview = renderVaultPii({ vault: "mine", pii: "custom", piiPolicy: policy, applied: false, changed: true, loosened: ["phone.notes: deny -> allow"], preview: true }, PLAIN, "vmem vaults pii mine --set allow --confirm");
  expect(preview).toBe([
    "dry run: would set the PII policy of vault mine to custom",
    "",
    "CATEGORY  NOTES  LOG    PROMOTION",
    "email     deny   deny   deny",
    "phone     allow  allow  allow",
    "custom    allow  allow  allow",
    "",
    "allow list: 1 entry (shown with --json)",
    "",
    "loosens phone.notes: deny -> allow",
    "",
    "confirm: vmem vaults pii mine --set allow --confirm",
  ].join("\n"));
  expect(preview).not.toContain("x@example.com");
  expect(renderVaultPii({ vault: "mine", pii: "allow", piiPolicy: policy }, PLAIN)).toStartWith("Vault mine PII policy: allow\n\nCATEGORY");
  expect(renderVaultPii({ vault: "mine", pii: "allow", piiPolicy: policy, applied: false, changed: false, loosened: [], preview: true }, PLAIN, "c")).not.toContain("Confirm");
});

test("#114 AC1/AC4: recover says what it would remove and prints the confirm command; blocked and applied runs say so", () => {
  const lock = { path: "/h/.lock", state: "stale" as const, owner: { pid: 7, host: "box", created: "2026-11-04T00:00:00Z" }, removed: false };
  expect(renderRecover({ applied: false, lock, temporaryFiles: [".config-1.tmp"], removedTemporaryFiles: [] }, PLAIN)).toBe([
    "dry run: would remove the stale registry lock and 1 temporary config file",
    "",
    "  lock             /h/.lock",
    "  state            stale",
    "  owner            pid 7 on box since 2026-11-04T00:00:00Z",
    "  temporary files  .config-1.tmp",
    "",
    "confirm: vmem recover --confirm",
  ].join("\n"));
  expect(renderRecover({ applied: true, lock: { ...lock, removed: true }, temporaryFiles: [".config-1.tmp"], removedTemporaryFiles: [".config-1.tmp"] }, PLAIN))
    .toBe("recovered: removed the stale registry lock and 1 temporary config file");
  expect(renderRecover({ applied: false, lock: { ...lock, state: "live" }, temporaryFiles: [], removedTemporaryFiles: [], blocked: "a live writer holds the lock" }, PLAIN))
    .toStartWith("recovery blocked: a live writer holds the lock\n\n  lock");
  expect(renderRecover({ applied: false, lock: { path: "/h/.lock", state: "absent", removed: false }, temporaryFiles: [], removedTemporaryFiles: [] }, PLAIN)).toStartWith("nothing to recover");
});

test("#114 AC1: stats prints field blocks, manifest marks read-only tools and setup prints HOST/CHANGE/PATH and the apply command", () => {
  const stats = renderStats({ vault: "mine", asOf: "2026-11-04", notes: { total: 3, byType: { concept: 1, finding: 2 }, byDomain: { ai: 3 }, byStatus: {} }, modified: { last7Days: 1, last30Days: 3 },
    size: { total: { notes: 3, bytes: 2048, words: 300 }, byType: {}, byDomain: {} },
    ratio: { notes: 2, sources: 3, skipped: 1, skippedNonFile: 1, emptySourceNotes: 0, truncatedNotes: 4, median: 0.5, p90: 1.2, overOne: 1, largest: [{ path: "notes/a.md", ratio: 1.2 }] },
    log: { days: 30, since: "2026-10-06", total: 2, byType: { INGEST: 0, LEARN: 2 }, warnings: ["skipped 1 line"], issues: [] } }, PLAIN);
  expect(stats).toBe([
    "mine  3 notes as of 2026-11-04", "",
    "Notes by type", "  finding  2", "  concept  1", "",
    "Notes by domain", "  ai  3", "",
    "Note size", "  total  2048 bytes, 300 words", "",
    "Note-to-source ratio", "  notes      2 notes", "  sources    3 files", "  median     0.5", "  p90        1.2", "  over 1     1 note",
    "  skipped    1 source reference, 1 not a file", "  truncated  4 notes past the 10000-note cap", "  largest    notes/a.md 1.2", "",
    "Modified", "  last 7 days   1", "  last 30 days  3", "",
    "Log since 2026-10-06 (30 days)", "  total  2", "  LEARN  2", "",
    "warning: skipped 1 line",
  ].join("\n"));
  const empty = renderStats({ vault: "mine", asOf: "2026-11-04", notes: { total: 0, byType: {}, byDomain: {}, byStatus: {} }, modified: { last7Days: 0, last30Days: 0 },
    size: { total: { notes: 0, bytes: 0, words: 0 }, byType: {}, byDomain: {} },
    ratio: { notes: 0, sources: 0, skipped: 2, skippedNonFile: 2, emptySourceNotes: 0, truncatedNotes: 0, median: null, p90: null, overOne: 0, largest: [] },
    log: { days: 30, since: "2026-10-06", total: 0, byType: { INGEST: 0, LEARN: 0 }, warnings: [], issues: [] } }, PLAIN);
  expect(empty).toContain("Note-to-source ratio\nno note cites a readable workspace file; 2 source references skipped");
  // The truncation line appears only when the index cut sourced notes, so the common output keeps its shape.
  expect(empty).not.toContain("Note size");
  expect(renderManifest({ name: "@staix/vault-mem", version: "9.9.9", configVersion: 2, mcp: { server: "vmem", tools: [{ name: "vmem_status", readOnly: true }, "vmem_create"] }, commands: ["status", "doctor"] }, PLAIN)).toBe([
    "@staix/vault-mem 9.9.9  config format 2", "",
    "MCP server vmem: 2 tools", "TOOL         ACCESS", "vmem_status  read-only", "vmem_create  may write", "",
    "Commands: 2", "  status, doctor",
  ].join("\n"));
  const report = { mode: "dry-run" as const, applied: false, entry: { command: "/opt/bun", args: ["--smol", "/opt/vmem/bin/vmem.js", "mcp"] }, notes: ["restart the host session"],
    actions: [{ target: "claude" as const, file: "/u/.claude.json", change: "add" as const }, { target: "codex" as const, file: "/u/.codex/config.toml", change: "refused" as const, reason: "unparsable TOML" }] };
  expect(renderSetup(report, PLAIN, "vmem setup all --apply")).toBe([
    "dry run: nothing written", "",
    "  server  /opt/bun --smol /opt/vmem/bin/vmem.js mcp", "",
    "HOST    CHANGE   PATH                   REASON", "claude  add      /u/.claude.json", "codex   refused  /u/.codex/config.toml  unparsable TOML", "",
    "restart the host session", "",
    "1 host refused; see REASON.", "",
    "apply: vmem setup all --apply",
  ].join("\n"));
  expect(renderSetup({ ...report, mode: "apply", applied: true, actions: [report.actions[0]!] }, PLAIN, "x")).not.toContain("REASON");
});

test("#114 AC1: --json keeps the previous compact JSON, default output is text, and --color=always adds ANSI codes", () => {
  const f = fixture();
  const status = run(["status", "--json"], f.env).text;
  expect(status).toBe(JSON.stringify({ ...resolveHome(f.env), version, healthy: true, vaults: registryStatus(f.home).map(v => ({ ...v, checks: undefined })) }));
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
