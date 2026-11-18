import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { addVault, setVaultPii } from "../src/registry.ts";
import { run } from "../src/cli.ts";
import { argumentError, serveMcp } from "../src/mcp.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-transport-"))), home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
  addVault(home, { id: "test", path: vault, kind: "personal", write: "mcp" });
  return { root, home, vault, notes, env: { VMEM_HOME: home, LANG: "C" } };
}
function operation(path: string, bodyExtra = "") {
  return { op: "create", path, frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"], source: "https://example.invalid/source", evidence: [{ source: "https://example.invalid/source", sha256: "a".repeat(64), quote: "Synthetic quote" }] }, body: `# ${path}\n\nSynthetic ${bodyExtra}\n\n## Topics\n\n- [[research]]\n` };
}
async function session(home: string, frames: (string | object)[]) {
  const server = createVaultMcp(home, { VMEM_HOME: home });
  const input = new PassThrough(), output = new PassThrough(); let text = "";
  output.on("data", chunk => { text += chunk.toString(); });
  const done = serveMcp({ tools: server.tools, handlers: server.handlers, input, output });
  const init = [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, { jsonrpc: "2.0", method: "notifications/initialized" }];
  for (const frame of [...init, ...frames]) input.write((typeof frame === "string" ? frame : JSON.stringify(frame)) + "\n");
  input.end(); await done;
  return text.trim().split("\n").map(line => JSON.parse(line)).slice(1);
}
const call = (id: string | number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const payload = (response: any) => JSON.parse(response.result.content[0].text);

test("CLI submits, pages, applies and rejects through one provider", () => {
  const f = fixture();
  try {
    const file = join(f.root, "operation.json"), first = operation("candidate"); writeFileSync(file, JSON.stringify(first));
    const submitted = JSON.parse(run(["proposal", "submit", "test", file, "--agent-label", "test-agent", "--json"], f.env).text);
    expect(existsSync(join(f.notes, "candidate.md"))).toBe(false);
    const listed = JSON.parse(run(["proposal", "list", "test", "--json"], f.env).text);
    expect(listed.items.map((item: { id: string }) => item.id)).toEqual([submitted.id]);
    expect(run(["proposal", "list", "test"], f.env).text).toContain(submitted.id);
    const shown = JSON.parse(run(["proposal", "show", "test", submitted.id, "--json"], f.env).text);
    expect(JSON.parse(shown.content)).toMatchObject({ ...first, path: "notes/candidate.md" });
    expect(shown.agentLabelUnverified).toBe("test-agent");
    const preview = JSON.parse(run(["proposal", "apply", "test", submitted.id, "--json"], f.env).text);
    const applied = run(["proposal", "apply", "test", submitted.id, "--confirm", "--fingerprint", preview.fingerprint, "--json"], f.env);
    expect(JSON.parse(applied.text)).toMatchObject({ ok: true, applied: true, state: "applied" });
    expect(existsSync(join(f.notes, "candidate.md"))).toBe(true);
    writeFileSync(file, JSON.stringify(operation("discarded")));
    const next = JSON.parse(run(["proposal", "submit", "test", file, "--json"], f.env).text);
    const rejectPreview = JSON.parse(run(["proposal", "reject", "test", next.id, "--reason", "not needed", "--json"], f.env).text);
    expect(JSON.parse(run(["proposal", "reject", "test", next.id, "--reason", "not needed", "--confirm", "--fingerprint", rejectPreview.fingerprint, "--json"], f.env).text)).toMatchObject({ ok: true, rejected: true });
    expect(existsSync(join(f.notes, "discarded.md"))).toBe(false);
    const bin = join(import.meta.dir, "..", "bin", "vmem.js"), invalid = Bun.spawnSync([process.execPath, bin, "proposal", "list", "test", "--limit", "0"], { env: { ...process.env, ...f.env }, stdout: "pipe", stderr: "pipe" });
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr.toString()).toContain("proposal list");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("MCP shares the provider and refuses a changed startup binding", async () => {
  const f = fixture();
  try {
    const server = createVaultMcp(f.home, f.env), definition = server.tools.find(tool => tool.name === "vmem_proposal_submit")!, args = { vault: "test", operation: operation("candidate") };
    expect(argumentError(args, definition.inputSchema)).toBeUndefined();
    const submitted = await server.handlers.vmem_proposal_submit!(args) as { id: string };
    const preview = await server.handlers.vmem_proposal_apply!({ vault: "test", id: submitted.id }) as { fingerprint: string };
    const applied = await server.handlers.vmem_proposal_apply!({ vault: "test", id: submitted.id, confirm: true, fingerprint: preview.fingerprint });
    expect(applied).toMatchObject({ applied: true, state: "applied" });
    setVaultPii(f.home, "test", "deny", true);
    expect(await server.handlers.vmem_proposal_list!({ vault: "test" })).toMatchObject({ refused: true });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("MCP refuses a root replaced at the same registered path", async () => {
  const f = fixture();
  try {
    const server = createVaultMcp(f.home, f.env);
    renameSync(f.vault, `${f.vault}-old`);
    mkdirSync(join(f.vault, "notes"), { recursive: true });
    const result = await server.handlers.vmem_proposal_list!({ vault: "test" });
    expect(result).toMatchObject({ refused: true });
    expect(JSON.stringify(result)).toContain("MCP startup");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("MCP enforces the complete 48 KiB request and show response bounds", async () => {
  const f = fixture();
  try {
    const server = createVaultMcp(f.home, f.env), submitted = await server.handlers.vmem_proposal_submit!({ vault: "test", operation: operation("candidate", '"'.repeat(13000)) }) as { id: string };
    const id = "\n".repeat(200), small = call(1, "vmem_proposal_list", { vault: "test" }), line = JSON.stringify(small);
    const atLimit = line + " ".repeat(48 * 1024 - Buffer.byteLength(line) - 1);
    const overLimit = atLimit + " ";
    const [allowed, refused, shown] = await session(f.home, [atLimit, overLimit, call(id, "vmem_proposal_show", { vault: "test", id: submitted.id })]);
    expect(payload(allowed).items).toHaveLength(1);
    expect(refused.error).toMatchObject({ code: -32600 });
    expect(refused.error.message).toContain("48 KiB");
    expect(Buffer.byteLength(JSON.stringify(shown)) + 1).toBeLessThanOrEqual(48 * 1024);
    expect(payload(shown)).toMatchObject({ id: submitted.id, truncated: true });
    const oversized = call(2, "vmem_proposal_submit", { vault: "test", operation: operation("oversized", '"'.repeat(25000)) });
    expect(Buffer.byteLength(JSON.stringify(oversized)) + 1).toBeGreaterThan(48 * 1024);
    expect(Buffer.byteLength(JSON.stringify(oversized)) + 1).toBeLessThan(65536);
    const [rejected] = await session(f.home, [oversized]);
    expect(rejected.error).toMatchObject({ code: -32600 });
    expect(existsSync(join(f.notes, "oversized.md"))).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
