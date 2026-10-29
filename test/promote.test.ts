import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
// Test-only: the fixture authors entries through agent-mem's own store; src/ reaches the root only via the seam.
import { MemoryStore, migrate } from "@staix/agent-mem";
import { addVault } from "../src/registry.ts";
import { promoteFromAmem, listPromotionCandidates, type SeamFactory } from "../src/promote.ts";
import { openAmem } from "../src/amem/seam.ts";
import { formatLogEvent } from "../src/log-format.ts";
import { readLog } from "../src/vault-log.ts";
import { runAsync } from "../src/cli.ts";
import { serveMcp } from "../src/mcp.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";

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
