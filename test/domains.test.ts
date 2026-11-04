import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_DOMAINS, CONFIG_FILE, CONFIG_VERSION, MAX_CONFIG_BYTES, effectiveDomains, parseConfig, parseVault, readConfig } from "../src/config.ts";
import { addVault, loadRegistry, registryStatus, removeVault } from "../src/registry.ts";
import { applyWrite } from "../src/writer.ts";
import { tidyVault } from "../src/tidy.ts";
import { analysisInput } from "../src/analysis-input.ts";
import { lintVault } from "../src/vault-lint.ts";
import { promoteToOrg } from "../src/org-promote.ts";
import { promoteFromAmem, type SeamFactory } from "../src/promote.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { run } from "../src/cli.ts";
import type { WriteOp, WriteRequest } from "../src/write-types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const moc = "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n";
const body = (title: string) => `# ${title}\n\nIndependent synthetic evidence.\n\n## Connections (fixture)\n\n- [[research]]\n\n## Topics\n\n- [[research]]\n`;
const fields = (title: string, domain: string) => ({ title, description: "Synthetic evidence for vault domain validation.", type: "insight", domain, topics: ["[[research]]"] });
const create = (path: string, domain: string): WriteOp => ({ op: "create", path, frontmatter: fields(path, domain), body: body(path) });
function fixture(domains: string[] | null = ["finance", "health"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-domains-"))); roots.push(root);
  const home = join(root, "state"), personal = join(root, "personal"), org = join(root, "org");
  for (const dir of [personal, org]) { mkdirSync(join(dir, "notes"), { recursive: true }); writeFileSync(join(dir, "notes", "research.md"), moc); }
  addVault(home, { id: "mine", path: personal, kind: "personal", write: "mcp", ...(domains ? { domains } : {}) });
  addVault(home, { id: "team", path: org, kind: "org", write: "mcp" });
  const env = { VMEM_HOME: home };
  return { root, home, personal, org, env, request: (vault: string, operation: WriteOp, options: Partial<WriteRequest> = {}) => applyWrite(home, { vault, operation, ...options }, { env }) };
}
function extendTeam(home: string) {
  const config = loadRegistry(home); config.vaults.find(v => v.id === "team")!.domains = ["finance"];
  writeFileSync(join(home, CONFIG_FILE), JSON.stringify(config));
}

test("config adds <=16 vault-pattern ids without replacing built-ins; malformed and unknown keys fail closed", () => {
  const vault = { id: "mine", path: "/synthetic/vault", kind: "personal", write: "mcp" };
  expect(parseVault(vault)).toEqual(vault);
  expect(effectiveDomains(parseVault(vault))).toEqual([...BUILTIN_DOMAINS]);
  expect(effectiveDomains(parseVault({ ...vault, domains: [] }))).toEqual([...BUILTIN_DOMAINS]);
  const sixteen = Array.from({ length: 16 }, (_, i) => `extra-${i}`);
  expect(parseVault({ ...vault, domains: sixteen }).domains).toEqual(sixteen);
  expect(effectiveDomains(parseVault({ ...vault, domains: ["finance", "research", "finance"] }))).toEqual([...BUILTIN_DOMAINS, "finance"]);
  for (const domains of [null, "finance", {}, [1], [""], ["Upper"], ["bad_id"], ["a".repeat(33)], ["finance\n"], Array(17).fill("finance")]) {
    for (const version of [1, CONFIG_VERSION + 1]) expect(() => parseConfig({ version, vaults: [{ ...vault, domains }] })).toThrow("vault.domains");
  }
  expect(() => parseConfig({ vaults: [{ ...vault, domain: ["finance"] }] })).toThrow("unknown key domain");
  expect(() => parseConfig({ vaults: [], futureKey: true })).toThrow("unknown key futureKey");
  expect(parseConfig({ version: CONFIG_VERSION + 1, vaults: [], futureKey: true })).toMatchObject({ futureKey: true });
});

test("format stamp, read bounds, status/list/MCP domains and human list remain consistent without mutating reads", async () => {
  const f = fixture(), file = join(f.home, CONFIG_FILE), before = readFileSync(file, "utf8");
  expect(JSON.parse(before).version).toBe(3);
  const expected = [...BUILTIN_DOMAINS, "finance", "health"];
  expect(registryStatus(f.home)[0]!.domains).toEqual(expected);
  const status = JSON.parse(run(["status", "--json"], f.env).text);
  const list = JSON.parse(run(["vaults", "list", "--json"], f.env).text);
  expect(status.vaults[0].domains).toEqual(expected); expect(list[0].domains).toEqual(expected);
  expect(list[1].domains).toEqual([...BUILTIN_DOMAINS]);
  const human = run(["vaults", "list", "--color=never"], f.env).text;
  expect(human).toContain("DOMAINS"); expect(human).toContain("finance");
  const mcp = createVaultMcp(f.home), result = await mcp.handlers.vmem_status!({}) as { vaults: { domains: string[] }[] };
  expect(result.vaults[0]!.domains).toEqual(expected);
  expect(readFileSync(file, "utf8")).toBe(before);
  removeVault(f.home, "team", true);
  expect(loadRegistry(f.home).vaults[0]!.domains).toEqual(["finance", "health"]);
  const old = fixture(null);
  expect(JSON.parse(readFileSync(join(old.home, CONFIG_FILE), "utf8")).version).toBeUndefined();
  writeFileSync(file, " ".repeat(MAX_CONFIG_BYTES + 1));
  expect(() => readConfig(f.home)).toThrow("expected plain file");
});

test("create, patch, frontmatter, move and both tidy paths use the selected vault domains", () => {
  const f = fixture();
  expect(f.request("mine", create("budget", "finance")).ok).toBe(true);
  expect(f.request("mine", { op: "patch", path: "budget", oldString: "Independent", newString: "Additional" }).issues).toEqual([]);
  expect(f.request("mine", { op: "frontmatter", path: "budget", set: { domain: "health" } }).ok).toBe(true);
  const bad = f.request("team", create("budget", "finance"));
  expect(bad.ok).toBe(false); expect(bad.issues).toContainEqual(expect.objectContaining({ code: "V01", message: expect.stringContaining("domain finance is not declared for vault team") }));
  expect(existsSync(join(f.org, "notes", "budget.md"))).toBe(false);
  expect(f.request("mine", { op: "frontmatter", path: "budget", set: { domain: "household" } }).ok).toBe(false);
  const move: WriteOp = { op: "move", from: "budget", to: "wellbeing" }, preview = f.request("mine", move);
  expect(preview.ok).toBe(true); expect(preview.issues).toEqual([]);
  expect(f.request("mine", move, { confirm: true, fingerprint: preview.fingerprint }).ok).toBe(true);
  const tidy: WriteOp = { op: "tidy" }, tidyPreview = f.request("mine", tidy);
  expect(tidyPreview.ok).toBe(true); expect(tidyPreview.issues).toEqual([]);
  expect(f.request("mine", tidy, { confirm: true, fingerprint: tidyPreview.fingerprint }).ok).toBe(true);
  // Migration tidy's sanitize route also validates the selected vault.
  writeFileSync(join(f.personal, "notes", "migration.md"), readFileSync(join(f.personal, "notes", "wellbeing.md"), "utf8").replace(/wellbeing|budget/g, "migration").replace("## Relevant Notes", "## Connections (migration)"));
  const migration = tidyVault(f.home, { vault: "mine", rules: ["connections"] }, { env: f.env });
  expect(migration.ok).toBe(true); expect(migration.notes.map(note => note.path)).toContain("notes/migration.md");
  const done = tidyVault(f.home, { vault: "mine", rules: ["connections"], confirm: true, fingerprint: migration.fingerprint }, { env: f.env });
  expect(done.ok).toBe(true); expect(done.written).toContain("notes/migration.md");
});

test("lint enforces present domain values from its selected snapshot and keeps missing-domain compatibility", () => {
  const f = fixture(); expect(f.request("mine", create("budget", "finance")).ok).toBe(true);
  const text = readFileSync(join(f.personal, "notes", "budget.md"), "utf8"); writeFileSync(join(f.org, "notes", "budget.md"), text);
  const mine = analysisInput(f.home, "mine").snapshot, team = analysisInput(f.home, "team").snapshot;
  expect(mine.domains).toEqual([...BUILTIN_DOMAINS, "finance", "health"]);
  expect(lintVault(mine).findings.L02).toEqual([]);
  expect(lintVault(team).findings.L02).toContainEqual(expect.stringContaining("domain finance"));
  expect(JSON.parse(run(["lint", "mine", "--json"], f.env).text).findings.L02).toEqual([]);
  const noDomain = { ...team, notes: [{ path: "budget.md", source: text.replace(/^"?domain"?:.*\n/m, "") }] };
  expect(lintVault(noDomain).findings.L02).toEqual([]);
});

test("personal-to-org promotion refuses personal-only domain by name, and accepts it only after target declaration", () => {
  const f = fixture(); expect(f.request("mine", create("budget", "finance")).ok).toBe(true);
  const request = { from: "mine", note: "budget", to: "team" }, file = join(f.org, "notes", "budget.md");
  for (const confirm of [false, true]) {
    const refused = promoteToOrg(f.home, { ...request, confirm }, { env: f.env });
    expect(refused.ok).toBe(false); expect(refused.issues).toContainEqual(expect.objectContaining({ code: "V01", message: expect.stringContaining("domain finance is not declared for vault team") }));
    expect(existsSync(file)).toBe(false);
  }
  extendTeam(f.home);
  const preview = promoteToOrg(f.home, request, { env: f.env }); expect(preview.ok).toBe(true);
  const done = promoteToOrg(f.home, { ...request, confirm: true, fingerprint: preview.fingerprint }, { env: f.env });
  expect(done.ok).toBe(true); expect(done.applied).toBe(true); expect(parseFrontmatter(readFileSync(file, "utf8")).data.domain).toBe("finance");
});

test("promote-from-amem uses target domains for preview and confirm, never links refused entries", async () => {
  const f = fixture(), id = "a".repeat(32), links: string[] = [];
  const seam: SeamFactory = async () => ({ project: "synthetic", async candidates() { return []; }, async entry() { return { id, project: "synthetic", kind: "decision", title: "Domain Evidence", text: "Synthetic domain evidence is checked against the selected target vault.", about: [], at: "2026-11-04" }; }, linkedPath() { return undefined; }, async recordLink(_id, path) { links.push(path); return path; }, close() {} });
  const request = { vault: "team", id, domain: "finance", topics: ["research"], stem: "domain-evidence" }, options = { env: f.env, seam };
  for (const confirm of [false, true]) {
    const refused = await promoteFromAmem(f.home, { ...request, confirm }, options);
    expect(refused.ok).toBe(false); expect(refused.issues).toContainEqual(expect.objectContaining({ code: "V01", message: expect.stringContaining("domain finance is not declared for vault team") }));
    expect(links).toEqual([]); expect(existsSync(join(f.org, "notes", "domain-evidence.md"))).toBe(false);
  }
  extendTeam(f.home);
  const preview = await promoteFromAmem(f.home, request, options); expect(preview.ok).toBe(true);
  const done = await promoteFromAmem(f.home, { ...request, confirm: true, fingerprint: preview.fingerprint }, options);
  expect(done.ok).toBe(true); expect(done.applied).toBe(true); expect(links).toEqual(["notes/domain-evidence.md"]);
});
