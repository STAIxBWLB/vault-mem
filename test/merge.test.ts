import { afterEach, expect, test, setSystemTime } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { addVault } from "../src/registry.ts";
import { applyWrite, MAX_WRITE_BYTES } from "../src/writer.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";
import { serveMcp, validArguments } from "../src/mcp.ts";
import { run } from "../src/cli.ts";
import { VaultIndex } from "../src/vault-index.ts";
import { readLog } from "../src/vault-log.ts";
import type { WriteReceipt, WriteRequest } from "../src/write-types.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const now = new Date(2026, 0, 2, 1);
const operation = { op: "merge" as const, keep: "keep", absorb: "absorb" };
function note(title: string, body: string, extra: Record<string, unknown> = {}) {
  const data = { title, description: `Synthetic supporting evidence for ${title}.`, type: "insight", domain: "research", topics: ["[[research]]"], updated: "2026-01-01", ...extra };
  return "---\n# metadata comment\n" + Object.entries(data).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join("") + `---\n# ${title}\n\n${body}\n\n## Topics\n\n` + (data.topics as string[]).map(topic => `- ${topic}\n`).join("");
}
function fixture(write: "mcp" | "cli" | "none" = "mcp") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-merge-"))); roots.push(root);
  const vault = join(root, "vault"), home = join(root, "home"), notes = join(vault, "notes"); mkdirSync(notes, { recursive: true });
  for (const stem of ["research", "projects"]) writeFileSync(join(notes, `${stem}.md`), `---\ntype: moc\ndescription: Synthetic ${stem} directory.\n---\n# ${stem}\n`);
  writeFileSync(join(notes, "keep.md"), note("Keep Finding", "Keep prose exactly.\n\n## Keep Evidence\n\nKeep block. ^keep-block", { source: ["mem:shared", "work/src/keep.ts"], created: "2020-01-01" }));
  writeFileSync(join(notes, "absorb.md"), note("Absorb Finding", "Absorb prose exactly.\n\n## Absorb Evidence\n\nAbsorb block. ^absorb-block\n\n### Nested\n\nNested evidence.\n\n###### Deep\n\nDeep evidence.\n\n```md\n# Code heading\n[[absorb]]\n```", { source: ["mem:shared", "mem:extra"], topics: ["[[projects]]", "[[research]]"], aliases: ["Absorb Alias"], created: "2021-01-01" }));
  writeFileSync(join(notes, "peer.md"), note("Peer Finding", "Uses [[absorb|explicit label]], ![[absorb#Absorb Evidence]] and [[absorb#^absorb-block]].", { source_ref: "[[absorb]]", methodology: { nested: ["[[absorb]]"] }, updated: "2025-12-31" }));
  addVault(home, { id: "test", path: vault, kind: "personal", write });
  const env = { VMEM_HOME: home };
  const merge = (extra: Partial<WriteRequest> = {}) => applyWrite(home, { vault: "test", operation, ...extra }, { env: {}, now });
  return { root, home, vault, notes, env, merge };
}
function disk(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    const file = join(root, name);
    try { result[name] = readFileSync(file).toString("base64"); } catch { /* Directories are not content. */ }
  }
  return result;
}

test("AC1 merge preview writes nothing, returns the complete deterministic plan and refuses stale fingerprints", () => {
  const f = fixture(), before = disk(f.root), preview = f.merge();
  expect(preview).toMatchObject({ ok: true, applied: false, preview: true });
  expect(disk(f.root)).toEqual(before);
  expect(preview.merge).toMatchObject({ keep: "notes/keep.md", absorb: "notes/absorb.md", source: ["mem:shared", "src/keep.ts", "mem:extra"], topics: ["[[research]]", "[[projects]]"] });
  const body = preview.merge!.body;
  expect(body.startsWith("# Keep Finding\n\nKeep prose exactly.")).toBe(true);
  expect(body).toContain("## Merged from [[absorb]]"); expect(body).not.toContain("# Absorb Finding");
  expect(body).toContain("### Absorb Evidence"); expect(body).toContain("#### Nested"); expect(body).toContain("###### Deep");
  expect(body).toContain("```md\n# Code heading\n[[absorb]]\n```");
  expect(body.endsWith("## Topics\n\n- [[research]]\n- [[projects]]\n")).toBe(true);
  expect(body.match(/^## Topics$/gm)).toHaveLength(1);
  expect(preview.merge!.inboundLinks).toContainEqual(expect.objectContaining({ path: "notes/peer.md", field: "body", target: "absorb", replacement: "keep", line: 3 }));
  expect(preview.merge!.inboundLinks).toContainEqual(expect.objectContaining({ path: "notes/peer.md", field: "source_ref", target: "absorb", replacement: "keep" }));
  const stale = f.merge({ confirm: true, fingerprint: "0".repeat(64) });
  expect(stale).toMatchObject({ ok: false, applied: false }); expect(stale.issues[0]!.message).toMatch(/fresh merge preview/);
  expect(disk(f.root)).toEqual(before);
  writeFileSync(join(f.notes, "peer.md"), readFileSync(join(f.notes, "peer.md"), "utf8").replace("Uses ", "Changed peer. Uses "));
  const changed = disk(f.root), drift = f.merge({ confirm: true, fingerprint: preview.fingerprint });
  expect(drift).toMatchObject({ ok: false, applied: false }); expect(disk(f.root)).toEqual(changed);
});

test("AC2 confirmed merge keeps all prose, unions provenance, repoints inbound links, supersedes absorb and logs once", () => {
  const f = fixture(), preview = f.merge(), done = f.merge({ confirm: true, fingerprint: preview.fingerprint });
  expect(done).toMatchObject({ ok: true, applied: true, logged: true, indexUpdated: true });
  const keep = parseFrontmatter(readFileSync(join(f.notes, "keep.md"), "utf8")), absorb = parseFrontmatter(readFileSync(join(f.notes, "absorb.md"), "utf8")), peer = parseFrontmatter(readFileSync(join(f.notes, "peer.md"), "utf8"));
  for (const prose of ["Keep prose exactly.", "Keep block.", "Absorb prose exactly.", "Absorb block.", "Nested evidence.", "Deep evidence."]) expect(keep.body).toContain(prose);
  expect(keep.body).toBe(preview.merge!.body); expect(keep.data.source).toEqual(preview.merge!.source); expect(keep.data.topics).toEqual(preview.merge!.topics);
  expect(keep.data).toMatchObject({ created: "2020-01-01", updated: "2026-01-02" });
  expect(absorb.data).toMatchObject({ status: "superseded", superseded_by: "[[keep]]", created: "2021-01-01", updated: "2026-01-02" });
  expect(absorb.body).toContain("Absorb prose exactly."); expect(peer.data.updated).toBe("2025-12-31");
  expect(peer.body).toContain("[[keep|explicit label]]"); expect(peer.body).toContain("![[keep#Absorb Evidence]]"); expect(peer.body).toContain("[[keep#^absorb-block]]");
  expect(peer.data.source_ref).toBe("[[keep]]"); expect(peer.data.methodology).toEqual({ nested: ["[[keep]]"] });
  const index = new VaultIndex(f.home, { id: "test", path: f.vault, kind: "personal", write: "mcp" });
  try {
    index.scan(); const links = index.links("peer"), repointed = links.filter(link => link.target === "keep");
    expect(repointed.length).toBeGreaterThanOrEqual(3); expect(repointed.every(link => link.resolved === "keep.md")).toBe(true);
    expect(links.every(link => link.reason === null)).toBe(true); expect(index.links("keep").filter(link => link.target === "absorb")).toHaveLength(1);
  }
  finally { index.close(); }
  const log = readLog(f.home, { vault: "test" }); expect(log.lines).toHaveLength(1); expect(log.lines[0]).toContain("RETHINK  -  notes/absorb.md → notes/keep.md  — merge");
  expect(existsSync(join(f.vault, "mutation.lock"))).toBe(false); expect(readdirSync(f.notes).some(name => name.startsWith(".vmem-"))).toBe(false);
});

for (const [keepType, absorbType] of [["insight", "decision"], ["person", "person"], ["moc", "moc"]]) test(`merge refuses incompatible or prohibited types ${keepType}/${absorbType} without writing`, () => {
  const f = fixture();
  for (const [path, type] of [["keep", keepType], ["absorb", absorbType]]) writeFileSync(join(f.notes, `${path}.md`), readFileSync(join(f.notes, `${path}.md`), "utf8").replace('type: "insight"', `type: "${type}"`));
  const before = disk(f.root), result = f.merge(); expect(result).toMatchObject({ ok: false, applied: false }); expect(result.issues[0]!.message).toMatch(/matching types other than person or moc/); expect(disk(f.root)).toEqual(before);
});

test("merge refuses identical endpoints, oversized body, provenance overflow and unsafe Topics without dropping data", () => {
  const f = fixture(), before = disk(f.root);
  expect(applyWrite(f.home, { vault: "test", operation: { op: "merge", keep: "keep", absorb: "keep" } })).toMatchObject({ ok: false, applied: false });
  expect(disk(f.root)).toEqual(before);
  writeFileSync(join(f.notes, "keep.md"), note("Keep Finding", "K".repeat(MAX_WRITE_BYTES / 2)));
  writeFileSync(join(f.notes, "absorb.md"), note("Absorb Finding", "A".repeat(MAX_WRITE_BYTES / 2)));
  expect(f.merge().issues).toContainEqual(expect.objectContaining({ code: "V09", message: expect.stringContaining("merged body exceeds") }));
  writeFileSync(join(f.notes, "keep.md"), note("Keep Finding", "Keep.", { source: Array.from({ length: 32 }, (_, i) => `mem:source-${i}`) }));
  writeFileSync(join(f.notes, "absorb.md"), note("Absorb Finding", "Absorb.", { source: "mem:source-32" }));
  expect(f.merge().issues[0]!.message).toMatch(/union exceeds 32.*trim sources/);
  writeFileSync(join(f.notes, "keep.md"), note("Keep Finding", "Keep."));
  writeFileSync(join(f.notes, "absorb.md"), note("Absorb Finding", "Absorb.").replace("- [[research]]", "Do not discard this authored text."));
  const unusual = disk(f.root); expect(f.merge().issues[0]!.message).toMatch(/cannot discard prose/); expect(disk(f.root)).toEqual(unusual);
});

for (const mode of ["stage", "rename-1", "rename-2", "rename-3", "directory-sync", "index-refresh"]) test(`AC3 merge ${mode} failure rolls all note bytes back and leaves no event`, () => {
  const f = fixture(), preview = f.merge(), before = disk(f.vault);
  expect(preview.ok).toBe(true);
  const [kind, nth] = mode.startsWith("rename-") ? ["rename", mode.slice(7)] : [mode, "1"];
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/merge-fault.ts"), f.home, kind!, preview.fingerprint!, nth!], { stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const result = JSON.parse(child.stdout.toString()); expect(result.injected).toBe(true); expect(result.receipt).toMatchObject({ ok: false, applied: false });
  expect(disk(f.vault)).toEqual(before);
});

test("merge keeps policy/screens and bounds the complete MCP acknowledgement before publication", () => {
  const none = fixture("none"), before = disk(none.root); expect(none.merge().issues).toContainEqual(expect.objectContaining({ code: "POLICY" })); expect(disk(none.root)).toEqual(before);
  const secret = fixture(); writeFileSync(join(secret.notes, "absorb.md"), note("Absorb Finding", "password: synthetic-value"));
  const refused = secret.merge(); expect(refused.issues).toContainEqual(expect.objectContaining({ code: "V06", severity: "error" })); expect(refused).not.toHaveProperty("merge"); expect(JSON.stringify(refused)).not.toContain("synthetic-value");
  const large = fixture(); writeFileSync(join(large.notes, "keep.md"), note("Keep Finding", "K".repeat(120000))); writeFileSync(join(large.notes, "absorb.md"), note("Absorb Finding", "A".repeat(120000)));
  writeFileSync(join(large.notes, "peer.md"), note("Peer Finding", "Uses [[absorb]]."));
  const original = disk(large.root), mcp = large.merge({ channel: "mcp" }); expect(mcp).toMatchObject({ ok: false, applied: false, changes: [] }); expect(mcp.issues[0]!.message).toContain("CLI --json"); expect(disk(large.root)).toEqual(original); expect(large.merge().ok).toBe(true);
});

async function session(home: string, args: Record<string, unknown>) {
  const server = createVaultMcp(home, {}), input = new PassThrough(), output = new PassThrough(); let data = "";
  output.on("data", chunk => { data += chunk.toString(); });
  const done = serveMcp({ tools: server.tools, handlers: server.handlers, input, output });
  for (const frame of [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vmem_merge", arguments: args } }]) input.write(JSON.stringify(frame) + "\n");
  input.end(); await done; return JSON.parse(data.trim().split("\n")[1]!);
}
test("AC4 CLI and MCP expose the same closed two-step merge and deterministic preview content", async () => {
  setSystemTime(now);
  try {
  const f = fixture(), command = ["merge", "test", "keep", "absorb"], json = run([...command, "--json"], f.env), preview = JSON.parse(json.text) as WriteReceipt;
  expect(json.code).toBe(0); expect(preview.merge!.body).toContain("Merged from [[absorb]]");
  const human = run(command, f.env); expect(human.text).toContain("merged body:"); expect(human.text).toContain("INBOUND LINKS"); expect(human.text).toContain("--confirm --fingerprint");
  expect(() => run([...command, "--unknown"], f.env)).toThrow(/unknown.*--unknown/);
  expect(() => run(["merge", "test", "keep"], f.env)).toThrow(/merge: takes/);
  const tools = createVaultMcp(f.home, {}).tools, tool = tools.find(tool => tool.name === "vmem_merge")!;
  expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  expect(validArguments({ keep: "keep", absorb: "absorb", vault: "test" }, tool.inputSchema)).toBe(true);
  expect(validArguments({ keep: "keep", absorb: "absorb", extra: true }, tool.inputSchema)).toBe(false);
  const bad = await session(f.home, { keep: "keep", absorb: "absorb", unexpected: true }); expect(bad.error.code).toBe(-32602);
  const mcpPreview = JSON.parse((await session(f.home, { keep: "keep", absorb: "absorb" })).result.content[0].text) as WriteReceipt;
  expect(mcpPreview).toMatchObject({ ok: true, applied: false, preview: true }); expect(mcpPreview.merge!.body).toBe(preview.merge!.body);
  const confirmed = JSON.parse((await session(f.home, { keep: "keep", absorb: "absorb", confirm: true, fingerprint: mcpPreview.fingerprint })).result.content[0].text) as WriteReceipt;
  expect(confirmed).toMatchObject({ ok: true, applied: true }); expect(readLog(f.home, { vault: "test" }).lines).toHaveLength(1);
  const cli = fixture(), argv = [process.execPath, "--preload", join(import.meta.dir, "fixtures/fixed-write-clock.ts"), "bin/vmem.js", ...command, "--json"];
  const first = Bun.spawnSync(argv, { env: { ...process.env, ...cli.env }, stdout: "pipe", stderr: "pipe" });
  expect(first.exitCode, first.stderr.toString()).toBe(0);
  const cliPreview = JSON.parse(first.stdout.toString()) as WriteReceipt;
  const second = Bun.spawnSync([...argv, "--confirm", "--fingerprint", cliPreview.fingerprint!], { env: { ...process.env, ...cli.env }, stdout: "pipe", stderr: "pipe" });
  expect(second.exitCode, second.stderr.toString()).toBe(0); expect(JSON.parse(second.stdout.toString())).toMatchObject({ ok: true, applied: true });
  expect(readLog(cli.home, { vault: "test" }).lines).toHaveLength(1);
  } finally { setSystemTime(); }
});

test("merge keeps legacy inbound names/dates and projects existing broken fragments without hiding new ones", () => {
  const f = fixture(), legacy = join(f.notes, "Legacy Name.md");
  writeFileSync(legacy, note("Legacy Peer", "Legacy [[absorb]].", { updated: "2020-01-01" }));
  const peer = join(f.notes, "peer.md"); writeFileSync(peer, note("Peer Finding", "Pre-existing [[absorb#Missing Section]]."));
  const preview = f.merge(); expect(preview).toMatchObject({ ok: true, preview: true });
  expect(preview.issues).toContainEqual(expect.objectContaining({ code: "V03", severity: "warning", path: "notes/peer.md" }));
  const done = f.merge({ confirm: true, fingerprint: preview.fingerprint }); expect(done).toMatchObject({ ok: true, applied: true });
  expect(readFileSync(legacy, "utf8")).toContain("[[keep]]"); expect(parseFrontmatter(readFileSync(legacy, "utf8")).data.updated).toBe("2020-01-01");
  const fresh = fixture(); writeFileSync(join(fresh.notes, "peer.md"), note("Peer Finding", "Heading [[absorb#Absorb Finding]]."));
  const before = disk(fresh.root), refused = fresh.merge(); expect(refused).toMatchObject({ ok: false, applied: false });
  expect(refused.issues).toContainEqual(expect.objectContaining({ code: "V03", severity: "error" })); expect(disk(fresh.root)).toEqual(before);
});

test("merge drops a Setext absorb H1 and demotes other Setext headings without changing prose", () => {
  const f = fixture(), file = join(f.notes, "absorb.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("# Absorb Finding", "Absorb Finding\n==============").replace("## Absorb Evidence", "Absorb Evidence\n---------------"));
  const preview = f.merge(); expect(preview).toMatchObject({ ok: true, preview: true });
  expect(preview.merge!.body).not.toContain("Absorb Finding\n=============="); expect(preview.merge!.body).toContain("### Absorb Evidence"); expect(preview.merge!.body).toContain("Absorb prose exactly.");
});

test("merge preserves multiline inline-code headings and links byte for byte", () => {
  const f = fixture(), file = join(f.notes, "absorb.md");
  const code = "`example\n## literal snippet\n# literal H1\n## Topics\n[[absorb]]\nend`";
  writeFileSync(file, note("Absorb Finding", `Absorb prose.\n\n${code}\n\n## Absorb Evidence\n\nBlock. ^absorb-block`));
  const preview = f.merge(); expect(preview).toMatchObject({ ok: true, preview: true }); expect(preview.merge!.body).toContain(code);
  expect(preview.merge!.body).toContain("### Absorb Evidence");
  const done = f.merge({ confirm: true, fingerprint: preview.fingerprint }); expect(done).toMatchObject({ ok: true, applied: true });
  expect(parseFrontmatter(readFileSync(join(f.notes, "keep.md"), "utf8")).body).toContain(code);
});

for (const kind of ["block", "heading"] as const) test(`merge refuses a referenced ${kind} collision instead of silently retargeting content`, () => {
  const f = fixture(), anchor = kind === "block" ? "^result" : "Shared Evidence";
  const first = kind === "block" ? "Keep result. ^result" : "## Shared Evidence\n\nKeep result.";
  const second = kind === "block" ? "Absorb result. ^result" : "## Shared Evidence\n\nAbsorb result.";
  writeFileSync(join(f.notes, "keep.md"), note("Keep Finding", first));
  writeFileSync(join(f.notes, "absorb.md"), note("Absorb Finding", second));
  writeFileSync(join(f.notes, "peer.md"), note("Peer Finding", `Original target [[absorb#${anchor}]].`));
  const before = disk(f.root), result = f.merge(); expect(result).toMatchObject({ ok: false, applied: false });
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "V03", message: expect.stringContaining(`fragment "${anchor}" from notes/absorb.md collides with notes/keep.md; rename`) }));
  expect(disk(f.root)).toEqual(before);
  writeFileSync(join(f.notes, "peer.md"), note("Peer Finding", "No fragment reference."));
  expect(f.merge()).toMatchObject({ ok: true, preview: true });
});

test("merge collision diagnostics do not echo a refused secret fragment", () => {
  const f = fixture(), fragment = "password: synthetic-value";
  writeFileSync(join(f.notes, "keep.md"), note("Keep Finding", `## ${fragment}\n\nKeep evidence.`));
  writeFileSync(join(f.notes, "absorb.md"), note("Absorb Finding", `## ${fragment}\n\nAbsorb evidence.`));
  writeFileSync(join(f.notes, "peer.md"), note("Peer Finding", `[[absorb#${fragment}]]`));
  const result = f.merge(); expect(result).toMatchObject({ ok: false, applied: false });
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "V06" })); expect(JSON.stringify(result)).not.toContain("synthetic-value");
});

test("merge refuses an older keeper superseded by absorb and tells the caller to swap endpoints", () => {
  const f = fixture(), file = join(f.notes, "keep.md");
  writeFileSync(file, note("Keep Finding", "Keep evidence.", { status: "superseded", superseded_by: "[[absorb]]" }));
  const before = disk(f.root), result = f.merge(); expect(result).toMatchObject({ ok: false, applied: false });
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "V10", message: expect.stringMatching(/superseded by.*swap keep and absorb.*fresh merge preview/) }));
  expect(disk(f.root)).toEqual(before);
});

test("merge retains keeper supersedes provenance while repointing ordinary keeper references", () => {
  const f = fixture(), file = join(f.notes, "keep.md");
  writeFileSync(file, note("Keep Finding", "Keep refers to [[absorb]].", { supersedes: ["[[absorb]]"], source_ref: "[[absorb]]" }));
  const preview = f.merge(); expect(preview).toMatchObject({ ok: true, preview: true });
  expect(preview.merge!.inboundLinks.some(link => link.path === "notes/keep.md" && link.field.startsWith("supersedes"))).toBe(false);
  const done = f.merge({ confirm: true, fingerprint: preview.fingerprint }); expect(done).toMatchObject({ ok: true, applied: true });
  const keep = parseFrontmatter(readFileSync(file, "utf8"));
  expect(keep.data.supersedes).toEqual(["[[absorb]]"]); expect(keep.data.source_ref).toBe("[[keep]]"); expect(keep.body).toContain("Keep refers to [[keep]].");
});

test("merge post-publication log failure preserves applied notes and a failing log receipt", () => {
  const f = fixture(), preview = f.merge();
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/merge-fault.ts"), f.home, "log-append", preview.fingerprint!], { stdout: "pipe", stderr: "pipe", timeout: 20000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const result = JSON.parse(child.stdout.toString()); expect(result.injected).toBe(true);
  expect(result.receipt).toMatchObject({ ok: true, applied: true, logged: false, log: { ok: false } });
  expect(parseFrontmatter(readFileSync(join(f.notes, "keep.md"), "utf8")).body).toBe(preview.merge!.body);
  expect(parseFrontmatter(readFileSync(join(f.notes, "absorb.md"), "utf8")).data.superseded_by).toBe("[[keep]]");
});

test("merge diagnostic handling preserves receipts for malformed writer requests", () => {
  const f = fixture(), before = disk(f.root);
  for (const request of [null, {}, { vault: "test", operation: null }]) {
    const result = applyWrite(f.home, request as unknown as WriteRequest);
    expect(result).toMatchObject({ ok: false, applied: false });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "V01" }));
  }
  expect(disk(f.root)).toEqual(before);
});
