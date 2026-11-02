import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { addVault } from "../src/registry.ts";
import { serveMcp, FRAME_BYTES, validArguments } from "../src/mcp.ts";
import { createVaultMcp, VMEM_TOOL_NAMES } from "../src/mcp-vault.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const note = (title: string, body: string, type = "insight") => `---\ntitle: ${JSON.stringify(title)}\ndescription: Synthetic evidence for navigation.\ntype: ${type}\ndomain: research\ntopics: ["[[research]]"]\n---\n# ${title}\n\n${body}\n\n## Topics\n\n- [[research]]\n`;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-mcp-"))); roots.push(root);
  const home = join(root, "state");
  const make = (name: string) => {
    const notes = join(root, name, "notes"); mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    writeFileSync(join(notes, "alpha.md"), note("Alpha Finding", "Alpha links to [[beta]]."));
    writeFileSync(join(notes, "beta.md"), note("Beta Finding", "Beta text about lanterns."));
    return join(root, name);
  };
  addVault(home, { id: "team", path: make("team"), kind: "org", write: "cli" });
  addVault(home, { id: "mine", path: make("mine"), kind: "personal", write: "mcp" });
  return { root, home, mine: join(root, "mine"), team: join(root, "team") };
}
async function session(home: string, frames: (string | object)[]) {
  const server = createVaultMcp(home, { VMEM_HOME: home });
  const input = new PassThrough(), output = new PassThrough(); let text = "";
  output.on("data", chunk => { text += chunk.toString(); });
  const done = serveMcp({ tools: server.tools, handlers: server.handlers, input, output });
  const init = [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, { jsonrpc: "2.0", method: "notifications/initialized" }];
  for (const frame of [...init, ...frames]) input.write((typeof frame === "string" ? frame : JSON.stringify(frame)) + "\n");
  input.end(); await done;
  return text.trim().split("\n").map(line => JSON.parse(line)).slice(1);
}
let id = 1;
const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } });
const payload = (response: any) => JSON.parse(response.result.content[0].text);

test("tools/list: vault enum is the registered ids, default is first personal, every tool bounded and closed", async () => {
  const f = fixture(), server = createVaultMcp(f.home);
  expect(server.defaultVault).toBe("mine");
  const [list] = await session(f.home, [{ jsonrpc: "2.0", id: 9, method: "tools/list" }]);
  const tools = list.result.tools as any[];
  expect(tools.map(t => t.name)).toEqual([...VMEM_TOOL_NAMES]);
  for (const t of tools) {
    expect(t.inputSchema.additionalProperties).toBe(false);
    if (!["vmem_status", "vmem_promote"].includes(t.name)) expect(t.inputSchema.properties.vault.enum).toEqual(["team", "mine"]);
    for (const [key, schema] of Object.entries<any>(t.inputSchema.properties)) {
      if (schema.type === "string" && !schema.enum) expect(schema.maxLength, `${t.name}.${key}`).toBeLessThanOrEqual(262144);
      if (schema.type === "array") expect(schema.maxItems).toBeLessThanOrEqual(64);
    }
  }
  expect(tools.filter(t => t.annotations.destructiveHint).map(t => t.name)).toEqual(["vmem_move", "vmem_delete", "vmem_promote_from_amem", "vmem_promote"]);
  // Graph, agent-mem and org-promotion providers are implemented; the org target is an enum of registered org vaults.
  expect(tools.filter(t => /graph/.test(t.name)).map(t => t.name)).toEqual(["vmem_graph_build", "vmem_graph_neighbors"]);
  expect(tools.find(t => t.name === "vmem_promote").inputSchema.properties.to.enum).toEqual(["team"]);
});

test("reads go through the index with defaults and bounds", async () => {
  const f = fixture();
  const [search, read, many, list, links, mocs, status] = await session(f.home, [
    call("vmem_search", { query: "lanterns" }), call("vmem_read", { path: "alpha", maxBytes: 65536 }), call("vmem_read_many", { paths: ["alpha", "missing"] }),
    call("vmem_list", { prefix: "a" }), call("vmem_links", { path: "beta" }), call("vmem_mocs", { vault: "team" }), call("vmem_status"),
  ]);
  expect(payload(search).hits.map((h: any) => h.path)).toEqual(["beta.md"]);
  expect(payload(read)).toMatchObject({ path: "alpha.md", truncated: false, frontmatter: { title: "Alpha Finding" } });
  expect(payload(read).sha256).toHaveLength(64);
  expect(payload(many).notes[1]).toMatchObject({ path: "missing", refused: true });
  expect(payload(list).notes.map((n: any) => n.path)).toEqual(["alpha.md"]);
  expect(payload(links).in.map((l: any) => l.source)).toEqual(["alpha.md"]);
  expect(payload(mocs).mocs[0]).toMatchObject({ path: "research.md", count: 2 });
  expect(payload(status)).toMatchObject({ defaultVault: "mine", vaults: [{ id: "team", pii: "deny" }, { id: "mine", pii: "allow" }] });
});

test("writes need write=mcp and return receipts or structured refusals", async () => {
  const f = fixture(), teamBefore = readFileSync(join(f.team, "notes", "beta.md"), "utf8");
  const [created, refused, patched, logged, logRefused, tail] = await session(f.home, [
    call("vmem_create", { stem: "gamma-finding", type: "insight", domain: "research", topics: ["research"], description: "A third synthetic result.", body: "# Gamma Finding\n\nGamma text.\n\n## Topics\n\n- [[research]]\n" }),
    call("vmem_patch", { vault: "team", path: "beta", oldString: "lanterns", newString: "lamps" }),
    call("vmem_patch", { path: "beta", oldString: "lanterns", newString: "lamps" }),
    call("vmem_log_append", { type: "LEARN", project: "-", source: "test", note: "synthetic event" }),
    call("vmem_log_append", { vault: "team", type: "LEARN", project: "-", source: "test", note: "synthetic event" }),
    call("vmem_log_tail", { n: 5 }),
  ]);
  expect(payload(created)).toMatchObject({ ok: true, applied: true });
  expect(existsSync(join(f.mine, "notes", "gamma-finding.md"))).toBe(true);
  expect(payload(refused)).toMatchObject({ refused: true, applied: false, issues: [{ code: "POLICY" }] });
  expect(readFileSync(join(f.team, "notes", "beta.md"), "utf8")).toBe(teamBefore);
  expect(payload(patched)).toMatchObject({ ok: true, applied: true });
  expect(readFileSync(join(f.mine, "notes", "beta.md"), "utf8")).toContain("lamps");
  expect(payload(logged)).toMatchObject({ ok: true, appended: true });
  expect(payload(logRefused)).toMatchObject({ refused: true, issues: [{ code: "POLICY" }] });
  expect(payload(tail).lines.at(-1)).toContain("(vmem:agent)");
});

test("move and delete preview with a fingerprint, then require a current fingerprint", async () => {
  const f = fixture(), file = join(f.mine, "notes", "beta.md");
  // Deleting a linked note is refused by the writer; the preview still lists its backlinks.
  const [linked] = await session(f.home, [call("vmem_delete", { path: "beta" })]);
  expect(payload(linked)).toMatchObject({ refused: true, applied: false, issues: [{ code: "V03" }] });
  expect(payload(linked).backlinks.map((b: any) => b.source)).toEqual(["alpha.md"]);
  expect(existsSync(file)).toBe(true);
  const target = join(f.mine, "notes", "alpha.md");
  const [preview, missing, stale] = await session(f.home, [call("vmem_delete", { path: "alpha" }), call("vmem_delete", { path: "alpha", confirm: true }), call("vmem_delete", { path: "alpha", confirm: true, fingerprint: "0".repeat(64) })]);
  expect(payload(preview)).toMatchObject({ ok: true, applied: false, preview: true, backlinks: [] });
  expect(payload(preview).fingerprint).toHaveLength(64);
  expect(payload(missing)).toMatchObject({ refused: true, issues: [{ code: "V09" }] });
  expect(payload(stale)).toMatchObject({ refused: true, issues: [{ code: "V09" }] });
  expect(existsSync(target)).toBe(true);
  const [movePreview] = await session(f.home, [call("vmem_move", { from: "alpha", to: "alpha-renamed" })]);
  expect(existsSync(join(f.mine, "notes", "alpha.md"))).toBe(true);
  const [moved] = await session(f.home, [call("vmem_move", { from: "alpha", to: "alpha-renamed", confirm: true, fingerprint: payload(movePreview).fingerprint })]);
  expect(payload(moved)).toMatchObject({ ok: true, applied: true });
  expect(existsSync(join(f.mine, "notes", "alpha-renamed.md"))).toBe(true);
});

test("protocol bounds: frame limit, invalid params, unknown tools, init order and oversized results", async () => {
  const f = fixture();
  const responses = await session(f.home, [
    "x".repeat(FRAME_BYTES + 10), "{not json", call("vmem_search", { query: "a", limit: 51 }), call("vmem_search", { query: "a", extra: 1 }),
    call("vmem_search", { query: "a", vault: "other" }), call("vmem_graph", { start: "a" }), call("vmem_read", { path: "alpha", maxBytes: 1.5 }),
    { jsonrpc: "2.0", id: "m", method: "resources/list" },
  ]);
  expect(responses.map(r => r.error?.code)).toEqual([-32600, -32700, -32602, -32602, -32602, -32602, -32602, -32601]);
  const server = createVaultMcp(f.home), input = new PassThrough(), output = new PassThrough(); let text = "";
  output.on("data", c => { text += c; });
  const done = serveMcp({ tools: [{ name: "big", description: "", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: {} }], handlers: { big: () => "x".repeat(300_000) }, input, output });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "big" } }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} } }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "big" } }) + "\n");
  input.end(); await done;
  const [early, , big] = text.trim().split("\n").map(l => JSON.parse(l));
  expect(early.error.code).toBe(-32002);
  expect(big.result.isError).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThan(1024);
  expect(server.tools.length).toBe(VMEM_TOOL_NAMES.length);
  expect(validArguments({ a: 1 }, { type: "object", properties: {}, additionalProperties: false })).toBe(false);
});

test("bin `vmem mcp` speaks only protocol on stdout without a TTY; importing the MCP modules never loads the agent-mem root", () => {
  const f = fixture();
  const frames = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, { jsonrpc: "2.0", method: "notifications/initialized" }, call("vmem_search", { query: "lanterns" })];
  const result = Bun.spawnSync([process.execPath, "bin/vmem.js", "mcp"], { env: { ...process.env, VMEM_HOME: f.home, CLAUDECODE: "1" }, stdin: Buffer.from(frames.map(x => JSON.stringify(x)).join("\n") + "\n"), stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  const lines = result.stdout.toString().trim().split("\n");
  expect(lines).toHaveLength(2);
  for (const line of lines) expect(JSON.parse(line).jsonrpc).toBe("2.0");
  expect(payload(JSON.parse(lines[1]!)).hits).toHaveLength(1);
  const probe = Bun.spawnSync([process.execPath, "-e", `await import("./src/mcp-vault.ts"); await import("./src/mcp.ts"); console.log(Object.keys(require.cache).filter(k => k.includes("agent-mem") && !k.includes("platform")).length)`], { stdout: "pipe", stderr: "pipe" });
  expect(probe.stdout.toString().trim()).toBe("0");
});

test("vmem_set_frontmatter synchronizes Topics with an existing different MOC", async () => {
  const f = fixture();
  const file = join(f.mine, "notes/alpha.md");
  writeFileSync(join(f.mine, "notes/other.md"), "---\ntype: moc\ndescription: Another synthetic directory.\n---\n# Other\n");
  const [response] = await session(f.home, [call("vmem_set_frontmatter", { vault: "mine", path: "alpha", set: { topics: ["[[other]]"] } })]);
  const result = payload(response);
  expect(result.ok).toBe(true);
  expect(result.applied).toBe(true);
  expect(result.issues.some((issue: { code: string }) => issue.code === "V05")).toBe(false);
  expect(readFileSync(file, "utf8")).toContain("## Topics\n\n- [[other]]");
});
