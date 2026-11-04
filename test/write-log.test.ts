import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { addVault } from "../src/registry.ts";
import { serveMcp } from "../src/mcp.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";
import { run } from "../src/cli.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const note = (title: string, body: string) => `---\ntitle: ${JSON.stringify(title)}\ndescription: Synthetic evidence for navigation.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\n---\n# ${title}\n\n${body}\n\n## Topics\n\n- [[research]]\n`;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-write-log-"))); roots.push(root);
  const home = join(root, "state"), vault = join(root, "vault"), notes = join(vault, "notes"), registry = join(root, "registry.yaml");
  mkdirSync(notes, { recursive: true }); writeFileSync(registry, "projects:\n  - id: synthetic\n");
  writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
  writeFileSync(join(notes, "old.md"), note("Old Finding", "Original text."));
  writeFileSync(join(notes, "next.md"), note("Next Finding", "Replacement text."));
  writeFileSync(join(notes, "lone.md"), note("Lone Finding", "Unlinked text."));
  addVault(home, { id: "test", path: vault, kind: "personal", write: "mcp", registry });
  return { home, vault, log: join(vault, "log"), env: { VMEM_HOME: home } };
}
function disk(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) if (lstatSync(join(dir, name)).isFile()) result[name] = readFileSync(join(dir, name), "utf8");
  return result;
}
/** Log lines without the local timestamp. */
const lines = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n").map(line => line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}  /, "")) : [];
async function mcp(home: string, name: string, args: Record<string, unknown>) {
  const server = createVaultMcp(home, { VMEM_HOME: home }), input = new PassThrough(), output = new PassThrough(); let text = "";
  output.on("data", chunk => { text += chunk.toString(); });
  const done = serveMcp({ tools: server.tools, handlers: server.handlers, input, output });
  for (const frame of [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }]) input.write(JSON.stringify(frame) + "\n");
  input.end(); await done;
  const response = JSON.parse(text.trim().split("\n")[1]!);
  return response.error ? { protocolError: response.error.code } : JSON.parse(response.result.content[0].text);
}
const given = { type: "LEARN", project: "synthetic", source: "synthetic:input", dest: "notes/x.md", note: "given event" };
const givenLine = "LEARN  synthetic  synthetic:input → notes/x.md  — given event";
const givenFlags = ["--log", JSON.stringify(given)];
const invalid = [{ ...given, project: "unknown-project" }, { ...given, note: `sk-${"x".repeat(24)}` }];
/** Refused by the --log schema before the writer runs: malformed JSON, an unknown key, a bad type, a missing field. */
const malformed = ["{not json", JSON.stringify({ ...given, extra: "x" }), JSON.stringify({ ...given, type: "BOGUS" }), JSON.stringify({ type: "LEARN", project: "-", source: "x" }), "[]"];
const OPS = [
  { tool: "vmem_create", args: { stem: "new-finding", type: "insight", domain: "research", topics: ["research"], description: "A separate synthetic result." }, cli: ["new", "test", "new-finding", "--type", "insight", "--domain", "research", "--topics", "research", "--description", "A separate synthetic result."], line: "EXTRACT  -  vmem:create → notes/new-finding.md  — create" },
  { tool: "vmem_patch", args: { path: "old", oldString: "Original text.", newString: "Changed text." }, cli: ["patch", "test", "old", "--old", "Original text.", "--new", "Changed text."], line: "EXTRACT  -  vmem:patch → notes/old.md  — patch" },
  { tool: "vmem_append", args: { path: "old", section: "Evidence", markdown: "More evidence." }, cli: ["append", "test", "old", "--section", "Evidence", "--markdown", "More evidence."], line: "EXTRACT  -  vmem:append → notes/old.md  — append" },
  { tool: "vmem_set_frontmatter", args: { path: "old", set: { confidence: "likely" } }, cli: ["frontmatter", "test", "old", "--set", '{"confidence":"likely"}'], line: "EXTRACT  -  vmem:frontmatter → notes/old.md  — frontmatter" },
  { tool: "vmem_link", args: { from: "old", to: "next", relation: "supports" }, cli: ["link", "test", "old", "next", "--relation", "supports"], line: "CONNECT  -  notes/old.md → notes/next.md  — link" },
  { tool: "vmem_supersede", args: { old: "old", next: "next" }, cli: ["supersede", "test", "old", "next"], line: "RETHINK  -  notes/old.md → notes/next.md  — supersede" },
  { tool: "vmem_move", args: { from: "lone", to: "lone-renamed" }, cli: ["move", "test", "lone", "lone-renamed"], line: "ROUTE  -  notes/lone.md → notes/lone-renamed.md  — move", twoStep: true },
  { tool: "vmem_delete", args: { path: "lone" }, cli: ["delete", "test", "lone"], line: "EXTRACT  -  notes/lone.md  — delete", twoStep: true },
];
/** One write through MCP; a two-step tool previews without the event and confirms with it. */
async function mcpWrite(f: ReturnType<typeof fixture>, op: typeof OPS[number], log?: object) {
  const confirm = op.twoStep ? { confirm: true, fingerprint: (await mcp(f.home, op.tool, op.args)).fingerprint } : {};
  return mcp(f.home, op.tool, { ...op.args, ...confirm, ...(log ? { log } : {}) });
}
function cliWrite(f: ReturnType<typeof fixture>, op: typeof OPS[number], extra: string[] = []) {
  const confirm = op.twoStep ? ["--confirm", "--fingerprint", JSON.parse(run([...op.cli, "--json"], f.env).text).fingerprint] : [];
  return run([...op.cli, ...confirm, ...extra, "--json"], f.env);
}

for (const op of OPS) {
  test(`${op.tool}: a given event is logged exactly, an invalid one refuses with no change, an omitted one gives the default`, async () => {
    const withEvent = fixture();
    expect(await mcpWrite(withEvent, op, given)).toMatchObject({ ok: true, applied: true, logged: true });
    expect(lines(withEvent.log)).toEqual([`${givenLine} (vmem:agent)`]);
    const refused = fixture(), before = disk(refused.vault);
    for (const event of invalid) {
      const result = await mcpWrite(refused, op, event);
      expect(result).toMatchObject({ refused: true, applied: false }); expect(result.issues[0].message).toContain("log event refused, nothing written");
    }
    expect(await mcpWrite(refused, op, { ...given, type: "BOGUS" })).toEqual({ protocolError: -32602 });
    expect(disk(refused.vault)).toEqual(before);
    const omitted = fixture();
    expect(await mcpWrite(omitted, op)).toMatchObject({ ok: true, applied: true, logged: true });
    expect(lines(omitted.log)).toEqual([`${op.line} (vmem:agent)`]);
  });
  test(`vmem ${op.cli[0]}: --log JSON logs exactly, an invalid event refuses with no change, no --log gives the default`, () => {
    const withEvent = fixture(), result = cliWrite(withEvent, op, givenFlags);
    expect(result.code).toBe(0); expect(JSON.parse(result.text)).toMatchObject({ ok: true, applied: true, logged: true });
    expect(lines(withEvent.log)).toEqual([givenLine]);
    const refused = fixture(), before = disk(refused.vault);
    for (const event of invalid) {
      const output = cliWrite(refused, op, ["--log", JSON.stringify(event)]);
      expect(output.code).toBe(1); expect(JSON.parse(output.text)).toMatchObject({ ok: false, applied: false });
    }
    for (const text of malformed) expect(() => cliWrite(refused, op, ["--log", text])).toThrow("--log");
    expect(disk(refused.vault)).toEqual(before);
    const omitted = fixture();
    expect(cliWrite(omitted, op).code).toBe(0); expect(lines(omitted.log)).toEqual([op.line]);
  });
}

test("--log JSON errors name the cause and the expected shape, and check takes no event", () => {
  const f = fixture(), before = disk(f.vault), patch = OPS[1]!.cli;
  expect(() => run([...patch, "--log", "{not json"], f.env)).toThrow('--log: invalid JSON; expected {"type", "project", "source", "note"[, "dest"]}');
  expect(() => run([...patch, "--log", JSON.stringify({ ...given, extra: "x" })], f.env)).toThrow("--log: unknown argument: extra; expected");
  expect(() => run([...patch, "--log", JSON.stringify({ type: "LEARN", project: "-", source: "x" })], f.env)).toThrow("--log.note: required; expected");
  const refused = JSON.parse(run([...patch, "--log", JSON.stringify(invalid[0]), "--json"], f.env).text);
  expect(refused.issues[0].message).toContain("log event refused, nothing written: project is absent from the configured registry");
  expect(() => run(["check", "test", "-", "--log", JSON.stringify(given)], f.env)).toThrow("check: unknown or repeated option: --log");
  expect(disk(f.vault)).toEqual(before);
});

test("non-TTY CLI accepts an event and MCP write schemas stay closed apart from the shared log field", async () => {
  const f = fixture();
  const child = Bun.spawnSync([process.execPath, "bin/vmem.js", ...OPS[1]!.cli, ...givenFlags, "--json"], { env: { ...process.env, ...f.env, CODEX_THREAD_ID: "synthetic" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0); expect(lines(f.log)).toEqual([`${givenLine} (vmem:agent)`]);
  const tools = createVaultMcp(f.home).tools, schema = (name: string) => tools.find(t => t.name === name)!.inputSchema as { properties: Record<string, unknown>; additionalProperties: boolean };
  for (const op of OPS) { expect(schema(op.tool).additionalProperties).toBe(false); expect(schema(op.tool).properties.log).toEqual(schema("vmem_create").properties.log); }
  expect(await mcp(f.home, "vmem_patch", { path: "old", oldString: "Changed text.", newString: "Again.", extra: 1 })).toEqual({ protocolError: -32602 });
});
