import { specGit } from "../src/spec-git.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { addSpec, addVault } from "../src/registry.ts";
import { serveMcp, FRAME_BYTES, validArguments, argumentError } from "../src/mcp.ts";
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
    if (!t.name.startsWith("vmem_spec_") && !["vmem_status", "vmem_promote"].includes(t.name)) expect(t.inputSchema.properties.vault.enum).toEqual(["team", "mine"]);
    for (const [key, schema] of Object.entries<any>(t.inputSchema.properties)) {
      if (schema.type === "string" && !schema.enum) expect(schema.maxLength, `${t.name}.${key}`).toBeLessThanOrEqual(262144);
      if (schema.type === "array") expect(schema.maxItems).toBeLessThanOrEqual(64);
    }
  }
  expect(tools.filter(t => t.annotations.destructiveHint).map(t => t.name)).toEqual(["vmem_move", "vmem_delete", "vmem_promote_from_amem", "vmem_promote"]);
  // Graph, agent-mem and org-promotion providers are implemented; the org target is an enum of registered org vaults.
  expect(tools.filter(t => /graph/.test(t.name)).map(t => t.name)).toEqual(["vmem_graph_build", "vmem_graph_neighbors", "vmem_spec_graph"]);
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

test("MCP names the first rejected argument or tool without echoing argument values", async () => {
  const f = fixture(), secret = "sk-" + "Z".repeat(25);
  const base = { vault: "mine", stem: "named-errors", type: "insight", domain: "research", topics: ["research"], description: "Evidence supporting a synthetic test." };
  const responses = await session(f.home, [
    call("vmem_create", { ...base, bogus: secret, alsoBogus: "second failure" }),
    call("vmem_create", { type: "insight", domain: "research", description: "Synthetic detail." }),
    call("vmem_read_many", { vault: "mine", paths: ["alpha", 42] }),
    call("vmem_create", { ...base, extra: { field: { hidden: secret } } }),
    call("vmem_unknown", { body: secret }),
    call("vmem_create", { ...base, body: "x".repeat(65537) }),
  ]);
  // The final body exceeds the transport frame too; its frame refusal remains independent.
  expect(responses[0].error).toEqual({ code: -32602, message: "unknown argument: bogus" });
  expect(responses[1].error.message).toBe("stem: required");
  expect(responses[2].error.message).toBe("paths[1]: expected string");
  expect(responses[3].error.message).toContain("extra.field: expected");
  expect(responses[4].error).toEqual({ code: -32602, message: "unknown tool: vmem_unknown" });
  expect(responses[5].error.code).toBe(-32600);
  expect(JSON.stringify(responses)).not.toContain(secret);
  expect(JSON.stringify(responses)).not.toContain("second failure");
  expect(argumentError({ body: "sensitive".repeat(10000) }, { type: "object", properties: { body: { type: "string", maxLength: 65536 } }, additionalProperties: false })).toBe("body: longer than 65536");
});

test("argument diagnostics retain object, property, string, array and numeric bounds", () => {
  const schema = { type: "object", properties: {}, additionalProperties: { type: "string" }, maxProperties: 2 };
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const args = JSON.parse(`{"${key}":"private-value"}`);
    expect(argumentError(args, schema)).toBe(`${key}: forbidden property name`);
    expect(validArguments(args, schema)).toBe(false);
  }
  expect(argumentError({ ["x".repeat(201)]: "private-value" }, schema)).toBe("arguments: property name longer than 200");
  expect(argumentError({ a: "one", b: "two", c: "three" }, schema)).toBe("arguments: more than 2 properties");
  expect(argumentError({ q: "a\0b" }, { type: "object", properties: { q: { type: "string" } } })).toBe("q: NUL is not allowed");
  expect(argumentError([1, 2], { type: "array", maxItems: 1, items: { type: "integer" } })).toBe("arguments: more than 1 items");
  expect(argumentError({ extra: { "a.b": {} } }, { type: "object", properties: { extra: { type: "object", additionalProperties: { type: "string" } } } })).toBe('extra["a.b"]: expected string');
  expect(argumentError(1.5, { type: "integer" })).toBe("arguments: expected integer");
  expect(argumentError(0, { type: "integer", minimum: 1 })).toBe("arguments: less than 1");
});

test("vmem_create accepts a top-level created date and refuses invalid calendar dates without writing", async () => {
  const f = fixture(), base = { vault: "mine", type: "insight", domain: "research", topics: ["research"], description: "A dated synthetic observation." };
  const [created] = await session(f.home, [call("vmem_create", { ...base, stem: "dated", created: "2024-02-29", extra: { created: "legacy" } })]);
  expect(payload(created)).toMatchObject({ ok: true, applied: true });
  expect(parseFrontmatter(readFileSync(join(f.mine, "notes/dated.md"), "utf8")).data.created).toBe("2024-02-29");
  for (const date of ["2023-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-01-00", "26-01-01", "", "private-date-value"]) {
    const [response] = await session(f.home, [call("vmem_create", { ...base, stem: "bad-date", created: date })]);
    expect(payload(response)).toMatchObject({ refused: true, issues: [{ message: "created: expected YYYY-MM-DD" }] });
    expect(existsSync(join(f.mine, "notes/bad-date.md"))).toBe(false);
    expect(JSON.stringify(response)).not.toContain("private-date-value");
  }
  const [extra] = await session(f.home, [call("vmem_create", { ...base, stem: "legacy-date", extra: { created: "legacy date" } })]);
  expect(payload(extra).ok).toBe(true); // No writer-level date rule was added.
});


test("spec MCP tools expose bounded reads, named argument failures and startup registry binding", async () => {
  const f = fixture(), repo = join(f.root, "spec-repo"); mkdirSync(repo);
  specGit(repo, ["-c", "init.templateDir=", "init", "--quiet"]);
  writeFileSync(join(repo, "SPEC.md"), "---\nid: root\ntype: goal\ntitle: Synthetic root\n---\n# Root\n\nLantern body.\n");
  addSpec(f.home, { id: "specs", path: repo });
  const [get, grep, graph, validate, bad] = await session(f.home, [
    call("vmem_spec_get", { id: "root", body: true }), call("vmem_spec_grep", { query: "Lantern" }),
    call("vmem_spec_graph", { id: "root" }), call("vmem_spec_validate"), call("vmem_spec_get", { id: "root", unexpected: "never-echo-this" }),
  ]);
  expect(payload(get)).toMatchObject({ id: "root", path: "SPEC.md", sha256: expect.any(String) });
  expect(payload(grep).hits.map((hit: any) => hit.id)).toEqual(["root"]);
  expect(payload(graph).nodes.map((node: any) => node.id)).toEqual(["root"]);
  expect(payload(validate)).toMatchObject({ ok: true, errors: 0 });
  expect(bad.error).toMatchObject({ code: -32602, message: expect.stringContaining("unexpected") });
  expect(JSON.stringify(bad)).not.toContain("never-echo-this");
  const server = createVaultMcp(f.home);
  writeFileSync(join(f.home, "config.json"), JSON.stringify({ specs: [] }));
  expect(await server.handlers.vmem_spec_get!({ id: "root" })).toMatchObject({ refused: true, issues: [expect.objectContaining({ message: expect.stringContaining("registry changed") })] });
});


test("spec tools find nested designs, isolate linked worktrees, refuse foreign roots and match coversPath", async () => {
  const f = fixture(), repo = join(f.root, "tool-repo"), linked = join(f.root, "tool-linked"), foreign = join(f.root, "foreign"); mkdirSync(repo); mkdirSync(foreign);
  const git = (args: string[]) => specGit(repo, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args]);
  git(["-c", "init.templateDir=", "init", "--quiet"]);
  specGit(foreign, ["-c", "init.templateDir=", "init", "--quiet"]);
  mkdirSync(join(repo, "nested")); mkdirSync(join(repo, "src")); mkdirSync(join(repo, "ignored"));
  writeFileSync(join(repo, ".gitignore"), "ignored/\n"); writeFileSync(join(repo, "src/a.ts"), "Synthetic source.\n");
  const design = (id: string, extra = "") => `---\nid: ${id}\ntype: ${id === "root" ? "goal" : "module"}\ntitle: Synthetic ${id}\n${extra}---\n# Synthetic toolmarker\n`;
  writeFileSync(join(repo, "design.md"), design("root"));
  writeFileSync(join(repo, "nested/SPEC.md"), design("child", 'parent: "[[root|Goal]]"\npaths: [src/**]\ntags: [storage]\n'));
  writeFileSync(join(repo, "ignored/SPEC.md"), design("ignored"));
  symlinkSync(join(repo, "design.md"), join(repo, "alias.md"));
  git(["add", "."]); git(["commit", "-qm", "Synthetic designs"]); git(["worktree", "add", "-qb", "synthetic-feature", linked]);
  writeFileSync(join(linked, "design.md"), design("root") + "Featureonlymarker.\n");
  addSpec(f.home, { id: "toolrepo", path: repo });
  const [get, graph, grep, covered, feature, main, refused] = await session(f.home, [
    call("vmem_spec_get", { id: "child" }), call("vmem_spec_graph", { id: "root", direction: "subtree" }),
    call("vmem_spec_grep", { query: "toolmarker" }), call("vmem_spec_grep", { coversPath: "src/a.ts" }),
    call("vmem_spec_grep", { query: "Featureonlymarker", worktree: linked }), call("vmem_spec_grep", { query: "Featureonlymarker" }),
    call("vmem_spec_get", { id: "root", worktree: foreign }),
  ]);
  expect(payload(get).links).toContainEqual(expect.objectContaining({ source: "child", target: "root", kind: "parent" }));
  expect(payload(graph).nodes.map((node: any) => node.id).sort()).toEqual(["child", "root"]);
  expect(payload(grep).hits.map((hit: any) => hit.id).sort()).toEqual(["child", "root"]);
  expect(payload(covered).hits.map((hit: any) => hit.id)).toEqual(["child"]);
  expect(payload(feature).hits.map((hit: any) => hit.id)).toEqual(["root"]);
  expect(payload(main).hits).toEqual([]);
  expect(payload(refused)).toMatchObject({ refused: true });
  expect(git(["status", "--porcelain=v1", "-z"]).stdout).toHaveLength(0);
});
