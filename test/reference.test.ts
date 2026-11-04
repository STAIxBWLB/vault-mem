import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { serveMcp } from "../src/mcp.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { addVault } from "../src/registry.ts";
import { validateWrite } from "../src/write-validation.ts";
import { applyWrite } from "../src/writer.ts";
import { VaultIndex } from "../src/vault-index.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";
import { lintVault } from "../src/vault-lint.ts";
import type { ValidationContext, WriteOp } from "../src/write-types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const bibliographic = { citekey: "Fixture2026:paper", doi: "10.1234/SYNTHETIC.PAPER", arxiv_id: "2601.12345v2", authors: ["Synthetic Author"], year: 2026, venue: "Synthetic Proceedings" };
const metadata = { title: "Synthetic Paper", description: "Synthetic evidence for bibliographic validation.", type: "reference", domain: "research", topics: ["[[research]]"] };
const moc = "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n";
const body = "# Synthetic Paper\n\nIndependent synthetic prose.\n\n## Topics\n\n- [[research]]\n";
function note(extra: Record<string, unknown> = {}) {
  return "---\n" + Object.entries({ ...metadata, ...bibliographic, ...extra }).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") + "\n---\n" + body;
}
function errors(extra: Record<string, unknown> = {}) {
  const vault = { id: "test", path: "/synthetic/vault", kind: "personal" as const, write: "mcp" as const };
  const ctx: ValidationContext = { vault, config: { vaults: [vault] }, notes: new Map([["notes/research.md", moc]]), operation: { op: "create", path: "paper", frontmatter: {} } };
  return validateWrite([{ path: "notes/paper.md", before: null, after: note(extra) }], ctx).filter(issue => issue.severity === "error");
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-reference-"))); roots.push(root);
  const home = join(root, "state"), vault = join(root, "vault"), notes = join(vault, "notes"); mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "research.md"), moc);
  const spec = { id: "test", path: vault, kind: "personal" as const, write: "mcp" as const }; addVault(home, spec);
  return { home, notes, spec, request: (operation: WriteOp) => applyWrite(home, { vault: "test", operation }) };
}
const create = (path: string, fields: Record<string, unknown> = {}): WriteOp => ({ op: "create", path, frontmatter: { ...metadata, ...bibliographic, title: path, ...fields }, body: body.replace("# Synthetic Paper", `# ${path}`) });

test("reference metadata accepts all keys, boundaries and old/new arXiv identifiers", () => {
  expect(errors()).toEqual([]);
  for (const fields of [
    { citekey: "a".repeat(64), authors: Array(100).fill("Fixture"), year: 1000, venue: "가".repeat(200) },
    { citekey: "A_0:-", authors: ["Fixture"], year: 2100, venue: "X" },
    { arxiv_id: "hep-th/9901001" }, { arxiv_id: "math.GT/0301001v12" }, { arxiv_id: "2612.12345" },
  ]) expect(errors(fields)).toEqual([]);
  // The fields are optional, so existing reference notes remain valid.
  expect(errors(Object.fromEntries(Object.keys(bibliographic).map(key => [key, undefined])))).toEqual([]);
});

test("each malformed bibliographic value returns a named V01; all keys are reference-only", () => {
  const invalid: Record<string, unknown[]> = {
    citekey: ["", "x".repeat(65), "a b", "key.", "valid\n", 2],
    doi: ["", "https://doi.org/10.1234/example", "10.123/example", "10.1234567890/example", "10.1234/", "10.1234/a b", "10.1234/a\nb", "10.1234/a\n", 42],
    arxiv_id: ["", "2600.12345", "2613.12345", "2601.1234", "2601.123456", "2601.12345v0", "hep-th/9913001", "hep-th/990100", "2601.12345\n", 2],
    authors: ["Fixture", [], Array(101).fill("Fixture"), [1], [null]],
    year: [999, 2101, 2026.5, "2026", null], venue: ["", "가".repeat(201), 2, null],
  };
  for (const [key, values] of Object.entries(invalid)) for (const value of values) {
    expect(errors({ [key]: value })).toContainEqual(expect.objectContaining({ code: "V01", message: expect.stringContaining(key) }));
  }
  for (const type of ["insight", "decision", "observation", "person", "project", "method", "moc"]) {
    const findings = errors({ type });
    for (const key of Object.keys(bibliographic)) expect(findings).toContainEqual(expect.objectContaining({ code: "V01", message: `${key} is only valid on reference notes` }));
  }
});

test("writes lowercase new DOI assignments, preserve legacy bytes, and refuse duplicate citekeys on create and update", () => {
  const f = fixture();
  expect(f.request(create("first")).ok).toBe(true);
  const file = join(f.notes, "first.md"), first = readFileSync(file, "utf8");
  expect(parseFrontmatter(first).data.doi).toBe("10.1234/synthetic.paper");
  const duplicate = f.request(create("second"));
  expect(duplicate.ok).toBe(false); expect(duplicate.issues).toContainEqual(expect.objectContaining({ code: "V08", severity: "error", message: "citekey already exists in the vault" }));
  expect(f.request(create("second", { citekey: "Other2026" })).ok).toBe(true);
  const second = readFileSync(join(f.notes, "second.md"), "utf8");
  expect(f.request({ op: "frontmatter", path: "second", set: { citekey: bibliographic.citekey } }).ok).toBe(false);
  expect(readFileSync(join(f.notes, "second.md"), "utf8")).toBe(second);
  expect(f.request({ op: "frontmatter", path: "first", set: { doi: "10.1234/NEW.PAPER" } }).ok).toBe(true);
  expect(parseFrontmatter(readFileSync(file, "utf8")).data.doi).toBe("10.1234/new.paper");
  // Case-sensitive BibTeX keys can coexist.
  expect(f.request(create("third", { citekey: bibliographic.citekey.toLowerCase() })).ok).toBe(true);
  const legacy = first.replace("10.1234/synthetic.paper", "10.1234/LEGACY.PAPER"); writeFileSync(file, legacy);
  expect(f.request({ op: "patch", path: "first", oldString: "Independent", newString: "Additional" }).ok).toBe(true);
  expect(readFileSync(file, "utf8")).toBe(legacy.replace("Independent", "Additional"));
  const move = f.request({ op: "move", from: "first", to: "renamed" });
  expect(move.ok).toBe(true);
  expect(applyWrite(f.home, { vault: "test", operation: { op: "move", from: "first", to: "renamed" }, confirm: true, fingerprint: move.fingerprint }).ok).toBe(true);
});

test("final-snapshot uniqueness includes batch changes and citekeys on legacy non-reference notes", () => {
  const vault = { id: "test", path: "/synthetic/vault", kind: "personal" as const, write: "mcp" as const };
  const ctx: ValidationContext = { vault, config: { vaults: [vault] }, notes: new Map([["notes/research.md", moc], ["notes/legacy.md", note({ type: "insight" })]]), operation: { op: "create", path: "paper", frontmatter: {} } };
  const change = { path: "notes/paper.md", before: null, after: note() };
  expect(validateWrite([change], ctx)).toContainEqual(expect.objectContaining({ code: "V08", severity: "error" }));
  ctx.notes.delete("notes/legacy.md");
  expect(validateWrite([change, { ...change, path: "notes/second.md", after: note({ title: "Second" }).replace("# Synthetic Paper", "# Second") }], ctx)).toContainEqual(expect.objectContaining({ code: "V08", severity: "error" }));
});

test("MCP type-filtered search finds DOI and citekey after incremental, memory and clean scans; lint stays unchanged", async () => {
  const f = fixture(); expect(f.request(create("paper")).ok).toBe(true);
  const source = readFileSync(join(f.notes, "paper.md"), "utf8");
  expect(parseFrontmatter(source).body).toBe(body.replace("# Synthetic Paper", "# paper"));
  const mcp = createVaultMcp(f.home);
  for (const query of ["10.1234/synthetic.paper", bibliographic.citekey]) {
    const result = await mcp.handlers.vmem_search!({ vault: "test", query, type: "reference" }) as { hits: { path: string }[] };
    expect(result.hits.map(hit => hit.path)).toEqual(["paper.md"]);
  }
  for (const options of [{}, { memory: true }, { memory: true, reuseCache: false }]) {
    const index = new VaultIndex(f.home, f.spec, [f.spec.path], options);
    try {
      index.scan(); expect(index.search(bibliographic.citekey, { type: "reference" }).map(hit => hit.path)).toEqual(["paper.md"]);
      expect(index.search(bibliographic.citekey, { type: "insight" })).toEqual([]);
      index.scan(true); expect(index.search("10.1234/synthetic.paper", { type: "reference" })).toHaveLength(1);
    } finally { index.close(); }
  }
  const base = { today: "2026-11-04", logPath: "/synthetic/log", log: "", registryIds: [], reports: {} };
  const withMetadata = lintVault({ ...base, notes: [{ path: "paper.md", source }, { path: "research.md", source: moc }] });
  const plain = source.replace(/^(?:citekey|doi|arxiv_id|authors|year|venue):.*\n/gm, "");
  expect(withMetadata).toEqual(lintVault({ ...base, notes: [{ path: "paper.md", source: plain }, { path: "research.md", source: moc }] }));
});


test("JSON-RPC create and frontmatter accept 100 authors without raising other array bounds", async () => {
  const f = fixture(), server = createVaultMcp(f.home), input = new PassThrough(), output = new PassThrough();
  let result = ""; output.on("data", chunk => { result += chunk.toString(); });
  const done = serveMcp({ tools: server.tools, handlers: server.handlers, input, output });
  const authors = Array.from({ length: 100 }, (_, i) => `Fixture Author ${i}`);
  const frames = [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vmem_create", arguments: { vault: "test", stem: "paper", ...metadata, body, extra: { ...bibliographic, authors } } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "vmem_set_frontmatter", arguments: { vault: "test", path: "paper", set: { authors: [...authors].reverse() } } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "vmem_set_frontmatter", arguments: { vault: "test", path: "paper", set: { tags: Array(65).fill("fixture") } } } },
  ];
  for (const frame of frames) input.write(JSON.stringify(frame) + "\n");
  input.end(); await done;
  const responses = result.trim().split("\n").map(line => JSON.parse(line));
  for (const id of [1, 2]) {
    const response = responses.find(row => row.id === id);
    expect(response.error).toBeUndefined();
    expect(JSON.parse(response.result.content[0].text).ok).toBe(true);
  }
  expect(responses.find(row => row.id === 3).error.code).toBe(-32602);
  expect(parseFrontmatter(readFileSync(join(f.notes, "paper.md"), "utf8")).data.authors).toEqual([...authors].reverse());
});
