import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
// Test-only: the fixture authors entries through agent-mem's own store; src/ reaches the root only via the seam.
import { MemoryStore, migrate } from "@staix/agent-mem";
import { addVault } from "../src/registry.ts";
import { draftNote, promoteFromAmem, listPromotionCandidates, type SeamFactory } from "../src/promote.ts";
import { openAmem } from "../src/amem/seam.ts";
import { formatLogEvent } from "../src/log-format.ts";
import { readLog } from "../src/vault-log.ts";
import { runAsync } from "../src/cli.ts";
import { serveMcp } from "../src/mcp.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { CONFIG_FILE, type CanonTableSpec } from "../src/config.ts";
import { renderPromote } from "../src/write-output.ts";
import { PLAIN } from "../src/text-output.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const project = "github.com/synthetic/promo-lab";
const lesson = { op: "note" as const, project, scope: "project" as const, tier: "long" as const, kind: "decision" as const, peer: "person", title: "Prefer explicit generation witnesses", text: "Explicit generation witnesses keep immutable identity stable across rebuilds.", about: ["path:src/storage.ts"], source: "person" as const };
async function fixture(options: { generation?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-promote-"))); roots.push(root);
  const memoryDir = join(root, "memory"), home = join(root, "state"), vault = join(root, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "notes", "storage.md"), "---\ntype: moc\ndescription: Synthetic storage directory.\n---\n# Storage\n");
  addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp" });
  const store = new MemoryStore({ memoryDir, deferPromotions: true });
  const id = store.note(lesson), other = store.note({ ...lesson, title: "Second durable lesson", text: "Second durable lesson text that stays a candidate." });
  store.note({ ...lesson, title: "Task status", text: "Task #12 completed after CI passed." });
  store.close();
  if (options.generation !== false) await migrate({ memoryDir, mode: "apply", generation: "b".repeat(32), authorizedPerson: true, tty: true });
  const env = { AMEM_HOME: memoryDir, VMEM_HOME: home, CLAUDECODE: "1" };
  const meta = { type: "decision", domain: "research", topics: ["storage"], stem: "explicit-generation-witnesses" };
  return { root, memoryDir, home, vault, id, other, env, meta, run: (args: string[]) => runAsync(args, env) };
}

function configureCanonTables(home: string, tables: CanonTableSpec[] | undefined) {
  const file = join(home, CONFIG_FILE), config = JSON.parse(readFileSync(file, "utf8"));
  config.version = 4;
  if (tables === undefined) delete config.vaults[0].canonTables;
  else config.vaults[0].canonTables = tables;
  writeFileSync(file, JSON.stringify(config));
}
const canonTable = (rows: string[]) => `---\ntype: moc\ndescription: Synthetic canonical entity directory.\n---\n# Canonical directory\n\n| Key | Detail |\n| --- | --- |\n${rows.join("\n")}\n`;

test("#167 AC1/AC3/AC5 canonical acronym and person rows add advisory choices without changing confirmation", async () => {
  const f = await fixture(), now = new Date(2026, 0, 2, 1), options = { env: f.env, project, now };
  writeFileSync(join(f.vault, "notes/glossary.md"), canonTable(["| **ACME (Acme Labs)** | Synthetic organization. |"]));
  writeFileSync(join(f.vault, "notes/people.md"), canonTable(["| `Mira North` / Mira N | Synthetic researcher. |"]));
  const request = { vault: "mine", id: f.id, ...f.meta, title: "ACME navigation", body: "# ACME navigation\n\nAcme Labs works with mira north.\n\n## Topics\n\n- [[storage]]\n" };
  const baseline = await promoteFromAmem(f.home, request, options);
  configureCanonTables(f.home, [{ path: "notes/glossary.md" }, { path: "notes/people.md" }]);
  const preview = await promoteFromAmem(f.home, request, options);
  expect(preview).toMatchObject({ ok: true, preview: true, applied: false });
  expect(preview.canonRowMatches).toEqual([
    expect.objectContaining({ path: "notes/people.md", key: "Mira North", row: "| `Mira North` / Mira N | Synthetic researcher. |" }),
    expect.objectContaining({ path: "notes/glossary.md", key: "Acme Labs", row: "| **ACME (Acme Labs)** | Synthetic organization. |" }),
  ]);
  expect(preview.choices).toEqual(["create", "link-existing notes/people.md", "link-existing notes/glossary.md"]);
  expect(preview.fingerprint).toBe(baseline.fingerprint);
  expect(renderPromote(preview, PLAIN, { argv: ["promote-from-amem", "mine", f.id], positional: ["mine", f.id] })).toContain("canonical rows:");
  configureCanonTables(f.home, undefined);
  expect((await promoteFromAmem(f.home, request, options)).fingerprint).toBe(baseline.fingerprint);
  configureCanonTables(f.home, [{ path: "notes/glossary.md" }, { path: "notes/people.md" }]);
  const confirmed = await promoteFromAmem(f.home, { ...request, confirm: true, fingerprint: baseline.fingerprint }, options);
  expect(confirmed).toMatchObject({ ok: true, applied: true, canonRowMatches: preview.canonRowMatches });
  expect(readFileSync(join(f.vault, preview.path!), "utf8")).toBe(preview.text!);
}, 30_000);

test("#167 AC2 absent canonTables preserves the baseline JSON and text golden", async () => {
  const f = await fixture(), preview = await promoteFromAmem(f.home, { vault: "mine", id: f.id, ...f.meta }, { env: f.env, project, now: new Date(2026, 0, 2, 1) });
  const normalized = JSON.parse(JSON.stringify(preview).replaceAll(f.id, "entry-id").replace(preview.fingerprint!, "fingerprint"));
  const text = ["---", '"title": "Prefer explicit generation witnesses"', '"description": "Explicit generation witnesses keep immutable identity stable across rebuilds."', '"type": "decision"', '"domain": "research"', '"topics": ["[[storage]]"]', '"promoted_from": "mem:entry-id"', '"promoted_at": "2026-01-02"', '"updated": "2026-01-02"', '"created": "2026-01-02"', "---", "# Prefer explicit generation witnesses", "", "Explicit generation witnesses keep immutable identity stable across rebuilds.", "", "## Relevant Notes", "", "- path:src/storage.ts", "", "## Topics", "", "- [[storage]]", ""].join("\n");
  expect(JSON.stringify(normalized)).toBe(JSON.stringify({ ok: true, action: "create", applied: false, id: "entry-id", path: "notes/explicit-generation-witnesses.md", issues: [], text, fingerprint: "fingerprint", linked: null, preview: true }));
  expect(renderPromote(normalized, PLAIN, { argv: ["promote-from-amem", "mine", "entry-id"], positional: ["mine", "entry-id"] })).toBe([
    "dry run: would create notes/explicit-generation-witnesses.md from mem:entry-id", "", `draft: ${Buffer.byteLength(text)} bytes; --json shows the text, --edit opens it in $EDITOR`, "", "confirm: vmem promote-from-amem mine entry-id --confirm --fingerprint fingerprint",
  ].join("\n"));
});

test("#167 unavailable and denied absent canonical notes are nonblocking advisory inputs", async () => {
  const f = await fixture(), options = { env: f.env, project, now: new Date(2026, 0, 2, 1) };
  configureCanonTables(f.home, [{ path: "notes/absent.md" }, { path: "notes/denied.md" }]);
  const file = join(f.home, CONFIG_FILE), config = JSON.parse(readFileSync(file, "utf8"));
  config.denyPaths = [join(f.vault, "notes/denied.md")]; writeFileSync(file, JSON.stringify(config));
  const request = { vault: "mine", id: f.id, ...f.meta, body: "# Synthetic navigation\n\nACME context.\n\n## Topics\n\n- [[storage]]\n" };
  const result = await promoteFromAmem(f.home, request, options);
  expect(result).toMatchObject({ ok: true, preview: true, applied: false, canonRowMatches: [] });
  expect(result).not.toHaveProperty("choices");
  expect(result.canonTableWarnings).toHaveLength(2);
  expect(result.canonTableWarnings).toContainEqual(expect.stringMatching(/canonTables: notes\/absent\.md not read \([^)]*(?:missing|unavailable|absent)[^)]*\)/i));
  expect(result.canonTableWarnings).toContainEqual(expect.stringMatching(/canonTables: notes\/denied\.md not read \([^)]*denied[^)]*\)/i));
  for (const warning of result.canonTableWarnings!) expect(warning).toMatch(/restore|check|repair|remove|fix/i);
  expect(result.issues).toEqual([]);
  const done = await promoteFromAmem(f.home, { ...request, confirm: true, fingerprint: result.fingerprint }, options);
  expect(done).toMatchObject({ ok: true, applied: true, canonTableWarnings: result.canonTableWarnings });
  const linked = await promoteFromAmem(f.home, request, options);
  expect(linked).toMatchObject({ ok: true, action: "link", preview: true, alreadyLinked: true, canonTableWarnings: result.canonTableWarnings });
});

test("#167 AC6 promotion previews 2000 canonical rows within its existing test budget", async () => {
  const f = await fixture();
  writeFileSync(join(f.vault, "notes/glossary.md"), canonTable(Array.from({ length: 2000 }, (_, index) => `| TERM${String(index).padStart(4, "0")} | Synthetic entity ${index}. |`)));
  configureCanonTables(f.home, [{ path: "notes/glossary.md" }]);
  const result = await promoteFromAmem(f.home, { vault: "mine", id: f.id, ...f.meta, body: "# Synthetic navigation\n\nTERM1999 is relevant.\n\n## Topics\n\n- [[storage]]\n" }, { env: f.env, project, now: new Date(2026, 0, 2, 1) });
  expect(result).toMatchObject({ ok: true, preview: true, applied: false, canonRowMatches: [expect.objectContaining({ path: "notes/glossary.md", key: "TERM1999" })] });
}, 30_000);

test("AC1 promotion uses one local date and its preview text is exactly the written note", async () => {
  const f = await fixture(), now = new Date(2026, 0, 2, 1), options = { env: f.env, project, now };
  const request = { vault: "mine", id: f.id, ...f.meta };
  const preview = await promoteFromAmem(f.home, request, options);
  expect(preview).toMatchObject({ ok: true, preview: true, applied: false, action: "create" });
  expect(parseFrontmatter(preview.text!).data).toMatchObject({ created: "2026-01-02", updated: "2026-01-02", promoted_at: "2026-01-02" });
  const done = await promoteFromAmem(f.home, { ...request, confirm: true, fingerprint: preview.fingerprint }, options);
  expect(done).toMatchObject({ ok: true, applied: true });
  const text = readFileSync(join(f.vault, "notes", "explicit-generation-witnesses.md"), "utf8");
  expect(text).toBe(preview.text!);
  expect(parseFrontmatter(text).data).toMatchObject({ created: "2026-01-02", updated: "2026-01-02" });
});

test("AC1 reference promotion previews the normalized DOI and aliased source exactly as persisted", async () => {
  for (const source of [
    { yaml: 'source: &origin "work/research/synthetic.md"', expected: "research/synthetic.md" },
    { yaml: 'source: [&origin "work/research/first.md", *origin, "work/research/second.md"]', expected: ["research/first.md", "research/first.md", "research/second.md"] },
  ]) {
    const f = await fixture(), now = new Date(2026, 0, 2, 1), options = { env: f.env, project, now };
    const body = `---\ndoi: 10.1234/UPPER.CASE\n${source.yaml}\n---\n# Prefer explicit generation witnesses\n\nCustom reference body.\n\n## Topics\n\n- [[storage]]\n`;
    const request = { vault: "mine", id: f.id, ...f.meta, type: "reference", body };
    const preview = await promoteFromAmem(f.home, request, options);
    expect(preview).toMatchObject({ ok: true, preview: true, applied: false });
    const expected = parseFrontmatter(preview.text!).data;
    expect(expected).toMatchObject({ type: "reference", doi: "10.1234/upper.case", source: source.expected, created: "2026-01-02", updated: "2026-01-02" });
    expect(parseFrontmatter(preview.text!).body).toBe(parseFrontmatter(body).body);
    const done = await promoteFromAmem(f.home, { ...request, confirm: true, fingerprint: preview.fingerprint }, options);
    expect(done).toMatchObject({ ok: true, applied: true });
    expect(readFileSync(join(f.vault, "notes", "explicit-generation-witnesses.md"), "utf8")).toBe(preview.text!);
  }
});

test("candidates honor project, limit and policy; previews write nothing; confirm creates, logs LEARN and links", async () => {
  const f = await fixture();
  const list = await listPromotionCandidates({ env: f.env, project, limit: 1 });
  expect(list.projects[0]!.candidates).toHaveLength(1);
  const all = (await listPromotionCandidates({ env: f.env, project })).projects[0]!.candidates.map(c => c.id).sort();
  expect(all).toEqual([f.id, f.other].sort()); // task-status entries are not durable candidates
  expect((await listPromotionCandidates({ env: f.env, project, piiPatterns: ["witnesses"] })).projects[0]!.candidates.map(c => c.id)).toEqual([f.other]);
  await expect(listPromotionCandidates({ env: f.env, project, limit: 201 })).rejects.toThrow("limit");

  const preview = await promoteFromAmem(f.home, { vault: "mine", id: f.id, ...f.meta }, { env: f.env, project });
  expect(preview).toMatchObject({ ok: true, preview: true, applied: false, action: "create", path: "notes/explicit-generation-witnesses.md" });
  expect(preview.text).toContain("# Prefer explicit generation witnesses");
  expect(preview.text).toContain(`"promoted_from": "mem:${f.id}"`);
  expect(preview.text).toContain("Explicit generation witnesses keep immutable identity");
  expect(preview.text).toContain("- path:src/storage.ts");
  expect(existsSync(join(f.vault, "notes", "explicit-generation-witnesses.md"))).toBe(false);
  expect(existsSync(join(f.vault, "log"))).toBe(false);

  const stale = await promoteFromAmem(f.home, { vault: "mine", id: f.id, ...f.meta, confirm: true, fingerprint: "0".repeat(64) }, { env: f.env, project });
  expect(stale).toMatchObject({ ok: false, applied: false, issues: [{ code: "V09" }] });
  const done = await promoteFromAmem(f.home, { vault: "mine", id: f.id, ...f.meta, confirm: true, fingerprint: preview.fingerprint }, { env: f.env, project });
  expect(done).toMatchObject({ ok: true, applied: true, linked: "notes/explicit-generation-witnesses.md" });
  expect(readFileSync(join(f.vault, "notes", "explicit-generation-witnesses.md"), "utf8")).toBe(preview.text!);
  // Exactly one LEARN event, in the canonical format (L09 passes on re-read).
  const log = readLog(f.home, { vault: "mine" });
  expect(log.ok).toBe(true);
  expect(log.lines).toHaveLength(1);
  expect(log.lines[0]).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}  LEARN  promo-lab  mem:${f.id} → notes/explicit-generation-witnesses\\.md  — promoted: decision \\(vmem:agent\\)$`));
  // The source entry carries the vault path and leaves the candidate list.
  const seam = await openAmem({ env: f.env, project });
  try { expect(seam.linkedPath(f.id)).toBe("notes/explicit-generation-witnesses.md"); } finally { seam.close(); }
  expect((await listPromotionCandidates({ env: f.env, project })).projects[0]!.candidates.map(c => c.id)).toEqual([f.other]);
  // A rerun offers link-only, never a second note.
  const again = await promoteFromAmem(f.home, { vault: "mine", id: f.id, ...f.meta }, { env: f.env, project });
  expect(again).toMatchObject({ action: "link", alreadyLinked: true, path: "notes/explicit-generation-witnesses.md" });
  expect(formatLogEvent).toBeDefined();
});

test("a failed final link step is recoverable through promoted_from and link-only", async () => {
  const f = await fixture();
  let fail = true;
  const seam: SeamFactory = async options => {
    const real = await openAmem(options);
    return { ...real, project: real.project, entry: real.entry, linkedPath: real.linkedPath, close: real.close, candidates: real.candidates,
      recordLink: async (id, path) => { if (fail) throw new Error("injected link failure"); return real.recordLink(id, path); } };
  };
  const preview = await promoteFromAmem(f.home, { vault: "mine", id: f.id, ...f.meta }, { env: f.env, project, seam });
  const broken = await promoteFromAmem(f.home, { vault: "mine", id: f.id, ...f.meta, confirm: true, fingerprint: preview.fingerprint }, { env: f.env, project, seam });
  expect(broken).toMatchObject({ ok: false, applied: true, linked: null, issues: [{ code: "LINK" }], choices: ["link-only notes/explicit-generation-witnesses.md"] });
  expect(existsSync(join(f.vault, "notes", "explicit-generation-witnesses.md"))).toBe(true);
  expect((await listPromotionCandidates({ env: f.env, project })).projects[0]!.candidates.map(c => c.id)).toContain(f.id);
  fail = false;
  const rerun = await promoteFromAmem(f.home, { vault: "mine", id: f.id }, { env: f.env, project, seam });
  expect(rerun).toMatchObject({ ok: true, preview: true, action: "link", path: "notes/explicit-generation-witnesses.md", choices: ["link-only notes/explicit-generation-witnesses.md"] });
  const linked = await promoteFromAmem(f.home, { vault: "mine", id: f.id, confirm: true, fingerprint: rerun.fingerprint }, { env: f.env, project, seam });
  expect(linked).toMatchObject({ ok: true, applied: true, action: "link", linked: "notes/explicit-generation-witnesses.md" });
  expect((await listPromotionCandidates({ env: f.env, project })).projects[0]!.candidates.map(c => c.id)).toEqual([f.other]);
  expect(readLog(f.home, { vault: "mine" }).lines).toHaveLength(1); // link-only adds no second LEARN
});

test("duplicates offer link-existing; error paths refuse without writing", async () => {
  const f = await fixture();
  writeFileSync(join(f.vault, "notes", "generation-witnesses.md"), "---\ntitle: Prefer explicit generation witnesses\ndescription: Existing synthetic note.\ntype: decision\ndomain: research\ntopics: [\"[[storage]]\"]\n---\n# Prefer explicit generation witnesses\n\nExisting.\n\n## Topics\n\n- [[storage]]\n");
  const dup = await promoteFromAmem(f.home, { vault: "mine", id: f.id, ...f.meta }, { env: f.env, project });
  expect(dup).toMatchObject({ ok: false, issues: [{ code: "V08" }] });
  expect(dup.choices).toContain("link-existing notes/generation-witnesses.md");
  const link = await promoteFromAmem(f.home, { vault: "mine", id: f.id, linkTo: "generation-witnesses" }, { env: f.env, project });
  expect(link).toMatchObject({ ok: true, action: "link", path: "notes/generation-witnesses.md", preview: true });
  expect((await promoteFromAmem(f.home, { vault: "mine", id: "z".repeat(32) }, { env: f.env, project })).issues[0]!.code).toBe("AMEM");
  expect((await promoteFromAmem(f.home, { vault: "mine", id: "a".repeat(32) }, { env: f.env, project })).issues[0]!.code).toBe("AMEM");
  expect((await promoteFromAmem(f.home, { vault: "mine", id: f.id, stem: "Bad Stem" }, { env: f.env, project })).issues[0]!.code).toBe("V04");
});

test("shared-v1 (non-generation) memory refuses promotion and listing", async () => {
  const f = await fixture({ generation: false });
  await expect(listPromotionCandidates({ env: f.env, project })).rejects.toThrow("generation");
  await expect(promoteFromAmem(f.home, { vault: "mine", id: f.id }, { env: f.env, project })).rejects.toThrow("generation");
});

test("CLI is non-TTY and agent-runnable: list, preview, --body -, confirm", async () => {
  const f = await fixture();
  const list = await f.run(["promote-from-amem", "mine", "--project", project, "--json"]);
  expect(JSON.parse(list.text).projects[0].candidates.length).toBe(2);
  const bodyFile = join(f.root, "body.md");
  writeFileSync(bodyFile, "# Prefer explicit generation witnesses\n\nCustom body.\n\n## Topics\n\n- [[storage]]\n");
  const args = ["promote-from-amem", "mine", `mem:${f.id}`, "--project", project, "--type", "decision", "--domain", "research", "--topics", "storage", "--stem", "explicit-generation-witnesses", "--body", bodyFile, "--json"];
  const preview = JSON.parse((await f.run(args)).text);
  expect(preview).toMatchObject({ ok: true, preview: true });
  expect(preview.text).toContain("Custom body.");
  const done = await f.run([...args, "--confirm", "--fingerprint", preview.fingerprint]);
  expect(done.code).toBe(0);
  expect(readFileSync(join(f.vault, "notes", "explicit-generation-witnesses.md"), "utf8")).toContain("Custom body.");
  // --edit without a TTY is a no-op: never blocks, never opens an editor.
  const edit = await runAsync(["promote-from-amem", "mine", f.other, "--project", project, "--edit", "--type", "insight", "--domain", "research", "--topics", "storage", "--json"], { ...f.env, EDITOR: "false" }, { stdinIsTTY: false });
  expect(JSON.parse(edit.text)).toMatchObject({ preview: true });
  await expect(f.run(["promote-from-amem", "mine", f.id, "--all-projects"])).rejects.toThrow();
  const bin = Bun.spawnSync([process.execPath, "bin/vmem.js", "promote-from-amem", "mine", "--project", project, "--json"], { env: { ...process.env, ...f.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(bin.exitCode).toBe(0);
  expect(JSON.parse(bin.stdout.toString()).projects[0].candidates).toHaveLength(1);
});

test("MCP vmem_promote_from_amem is two-step with a current fingerprint and requires write=mcp", async () => {
  const f = await fixture();
  const server = createVaultMcp(f.home, f.env), input = new PassThrough(), output = new PassThrough(); let text = "";
  output.on("data", c => { text += c; });
  const done = serveMcp({ tools: server.tools, handlers: server.handlers, input, output });
  const send = (frame: object) => input.write(JSON.stringify(frame) + "\n");
  send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const args = { id: f.id, project, type: "decision", domain: "research", topics: ["storage"], stem: "explicit-generation-witnesses" };
  send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vmem_promote_from_amem", arguments: args } });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "vmem_promote_from_amem", arguments: { ...args, confirm: true } } });
  input.end(); await done;
  const [, first, second] = text.trim().split("\n").map(l => JSON.parse(l)), preview = JSON.parse(first.result.content[0].text);
  expect(preview).toMatchObject({ ok: true, preview: true });
  expect(JSON.parse(second.result.content[0].text)).toMatchObject({ refused: true, issues: [{ code: "V09" }] });
  const confirmed = await server.handlers.vmem_promote_from_amem!({ ...args, confirm: true, fingerprint: preview.fingerprint }) as any;
  expect(confirmed).toMatchObject({ ok: true, applied: true });
  expect(readLog(f.home, { vault: "mine" }).lines).toHaveLength(1);
});

test("the agent-mem root loads only through the seam and only when promotion runs", () => {
  const probe = (code: string) => Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  const loaded = `Object.keys(require.cache).filter(k => /@staix\\/agent-mem\\/src\\/(index|memory\\/store)\\.ts$/.test(k)).length`;
  expect(probe(`await import("./src/cli.ts"); await import("./src/mcp-vault.ts"); await import("./src/promote.ts"); console.log(${loaded})`)).toBe("0");
  expect(probe(`await import("./src/amem/seam.ts"); console.log(${loaded})`)).toBe("0");
  expect(probe(`const s = await import("./src/amem/seam.ts"); await s.openAmem({ env: { AMEM_HOME: "/nonexistent-vmem-probe" }, project: "x/y" }).catch(() => {}); console.log(${loaded} > 0 ? 1 : 0)`)).toBe("1");
});

const entry = (kind: string, title: string | null, text: string, about: string[] = []) => ({ id: "c".repeat(32), project, kind, title, text, about, at: "2026-11-13T00:00:00.000Z" });
const sections = (text: string) => [...text.matchAll(/^## (.+)$/gm)].map(match => match[1]);
test("#222 a fix-titled finding drafts as a method with Cause, Fix and Anchors", () => {
  const draft = draftNote(entry("finding", "fix: stale lock -> clear on open", "stale lock after crash -> clear the lock on open", ["path:src/lock.ts", "symbol:open@src/lock.ts", "path:src/cli.ts"]), {});
  expect(draft.frontmatter).toMatchObject({ type: "method", title: "fix: stale lock -> clear on open", description: "stale lock after crash" });
  expect(sections(draft.text)).toEqual(["Cause", "Fix", "Anchors", "Relevant Notes", "Topics"]);
  expect(draft.text).toContain("## Cause\n\nstale lock after crash\n\n## Fix\n\nclear the lock on open\n\n## Anchors\n\n- src/lock.ts#open\n- src/cli.ts\n\n## Relevant Notes\n\n\n## Topics");
});
test("#222 a Record-derived fail note drops empty fields and anchors its Evidence already lists", () => {
  const text = "Approach: \nSymptom: queue stalls under load\nCause: \nEvidence: src/queue.ts#drain\nRetry when: retry after the queue drains";
  const draft = draftNote(entry("fail", "queue stalls under load", text, ["path:src/queue.ts", "symbol:drain@src/queue.ts", "path:src/extra.ts"]), {});
  expect(draft.frontmatter).toMatchObject({ type: "method", description: "queue stalls under load" });
  expect(sections(draft.text)).toEqual(["Symptom", "Evidence", "Retry when", "Anchors", "Relevant Notes", "Topics"]);
  expect(draft.text).toContain("## Anchors\n\n- src/extra.ts\n\n");
  expect(draft.text).not.toContain("Approach");
});
test("#222 anchors keep paths and symbols that contain @", () => {
  const about = ["path:node_modules/@scope/pkg/index.ts", "symbol:load@v2@node_modules/@scope/pkg/index.ts", "path:docs/a@b.md", "symbol:orphan@nowhere.ts"];
  const draft = draftNote(entry("finding", "fix: scoped import", "wrong scoped import -> pin the scope", about), {});
  expect(draft.text).toContain("## Anchors\n\n- node_modules/@scope/pkg/index.ts#load@v2\n- docs/a@b.md\n- symbol:orphan@nowhere.ts\n\n");
});
test("#222 other entries draft as before and explicit metadata wins", () => {
  const plain = draftNote(entry("finding", "fix: no arrow here", "a finding without the record arrow", ["path:src/a.ts"]), {});
  expect(plain.frontmatter.type).toBe("insight");
  expect(plain.text).toContain("# fix: no arrow here\n\na finding without the record arrow\n\n## Relevant Notes\n\n- path:src/a.ts\n");
  for (const kind of ["decision", "contract", "finding"]) expect(sections(draftNote(entry(kind, "Plain", "a -> b"), {}).text)).toEqual(["Relevant Notes", "Topics"]);
  expect(draftNote(entry("fail", "free text", "a fail note that is not labelled"), {}).frontmatter.type).toBe("method");
  const fix = entry("finding", "fix: x", "cause text -> fix text");
  expect(draftNote(fix, { type: "insight" }).frontmatter.type).toBe("insight");
  expect(draftNote(fix, { body: "# Own\n\nOwn body.\n" }).text).toContain("# Own\n\nOwn body.\n");
});
test("#222 a promote preview on a fixture home shows the structured fix draft", async () => {
  const f = await fixture();
  const store = new MemoryStore({ memoryDir: f.memoryDir, deferPromotions: true });
  const id = store.note({ ...lesson, kind: "finding", title: "fix: lock left behind after crash", text: "lock left behind after crash -> clear stale locks on open", about: ["path:src/lock.ts", "symbol:open@src/lock.ts"] });
  store.close();
  const preview = await promoteFromAmem(f.home, { vault: "mine", id, domain: "research", topics: ["storage"], stem: "stale-lock-fix" }, { env: f.env, project });
  expect(preview).toMatchObject({ ok: true, preview: true, applied: false });
  expect(parseFrontmatter(preview.text!).data).toMatchObject({ type: "method" });
  expect(preview.text!).toContain("## Cause\n\nlock left behind after crash\n\n## Fix\n\nclear stale locks on open\n\n## Anchors\n\n- src/lock.ts#open\n");
});
