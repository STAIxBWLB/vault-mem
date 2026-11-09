import { localDate } from "../src/local-date.ts";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { serveMcp } from "../src/mcp.ts";
import { emitFrontmatter, parseFrontmatter } from "../src/frontmatter.ts";
import { addVault } from "../src/registry.ts";
import { planOperation } from "../src/write-operations.ts";
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
    { arxiv_id: "0704.0001" }, { arxiv_id: "0704.0001v2" }, { arxiv_id: "hep-th/9901001" }, { arxiv_id: "math.GT/0301001v12" }, { arxiv_id: "2612.12345" },
  ]) expect(errors(fields)).toEqual([]);
  // The fields are optional, so existing reference notes remain valid.
  expect(errors(Object.fromEntries(Object.keys(bibliographic).map(key => [key, undefined])))).toEqual([]);
});

test("each malformed bibliographic value returns a named V01; all keys are reference-only", () => {
  const invalid: Record<string, unknown[]> = {
    citekey: ["", "x".repeat(65), "a b", "key.", "valid\n", 2],
    doi: ["", "https://doi.org/10.1234/example", "10.123/example", "10.1234567890/example", "10.1234/", "10.1234/a b", "10.1234/a\nb", "10.1234/a\n", 42],
    arxiv_id: ["", "2600.12345", "2613.12345", "0704.000", "2601.123456", "2601.12345v0", "hep-th/9913001", "hep-th/990100", "2601.12345\n", 2],
    authors: ["Fixture", [], [""], [" "], Array(101).fill("Fixture"), [1], [null]],
    year: [999, 2101, 2026.5, "2026", null], venue: ["", "가".repeat(201), 2, null],
  };
  for (const [key, values] of Object.entries(invalid)) for (const value of values) {
    expect(errors({ [key]: value })).toContainEqual(expect.objectContaining({ code: "V01", message: expect.stringContaining(key) }));
  }
  for (const type of ["insight", "decision", "observation", "person", "project", "method", "moc"]) {
    const findings = errors({ type });
    for (const key of Object.keys(bibliographic)) expect(findings).toContainEqual(expect.objectContaining({ code: "V01", message: `${key} is only valid on reference notes; set type: reference or unset ${key}` }));
  }
});

test("writes lowercase new DOI assignments, preserve legacy bytes, and refuse duplicate citekeys on create and update", () => {
  const f = fixture();
  expect(f.request(create("first")).ok).toBe(true);
  const file = join(f.notes, "first.md"), first = readFileSync(file, "utf8");
  expect(parseFrontmatter(first).data.doi).toBe("10.1234/synthetic.paper");
  const duplicate = f.request(create("second"));
  expect(duplicate.ok).toBe(false); expect(duplicate.issues).toContainEqual(expect.objectContaining({ code: "V08", severity: "error", message: "citekey is already used by notes/first.md; choose another citekey" }));
  expect(f.request(create("second", { citekey: "Other2026" })).ok).toBe(true);
  const second = readFileSync(join(f.notes, "second.md"), "utf8");
  const duplicateUpdate = f.request({ op: "frontmatter", path: "second", set: { citekey: bibliographic.citekey } });
  expect(duplicateUpdate.ok).toBe(false);
  expect(duplicateUpdate.issues).toContainEqual(expect.objectContaining({ code: "V08", message: "citekey is already used by notes/first.md; choose another citekey" }));
  expect(readFileSync(join(f.notes, "second.md"), "utf8")).toBe(second);
  expect(f.request({ op: "frontmatter", path: "first", set: { doi: "10.1234/NEW.PAPER" } }).ok).toBe(true);
  expect(parseFrontmatter(readFileSync(file, "utf8")).data.doi).toBe("10.1234/new.paper");
  // Stored case is kept, while a case-only collision is refused.
  expect(parseFrontmatter(first).data.citekey).toBe(bibliographic.citekey);
  const caseOnly = f.request(create("third", { citekey: bibliographic.citekey.toLowerCase() }));
  expect(caseOnly.ok).toBe(false);
  expect(caseOnly.issues).toContainEqual(expect.objectContaining({ code: "V08", severity: "error", message: expect.stringContaining("notes/first.md") }));
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
  expect(validateWrite([change, { ...change, path: "notes/second.md", after: note({ title: "Second", citekey: bibliographic.citekey.toLowerCase() }).replace("# Synthetic Paper", "# Second") }], ctx)).toContainEqual(expect.objectContaining({ code: "V08", severity: "error" }));
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
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "vmem_set_frontmatter", arguments: { vault: "test", path: "paper", set: { authors: [""] } } } },
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
  expect(responses.find(row => row.id === 4).error).toEqual(expect.objectContaining({ code: -32602, message: expect.stringContaining("set.authors[0]") }));
  expect(parseFrontmatter(readFileSync(join(f.notes, "paper.md"), "utf8")).data.authors).toEqual([...authors].reverse());
});


test("the first schema3 scan finds an unchanged pre-existing reference DOI and preserves the older cache", () => {
  const f = fixture(), source = note({ doi: "10.1234/preexisting.paper" });
  const file = join(f.notes, "preexisting.md"); writeFileSync(file, source);
  const indexes = join(f.home, "indexes"); mkdirSync(indexes, { recursive: true });
  const digest = createHash("sha256").update(f.spec.path).digest("hex");
  const oldFile = join(indexes, `${digest}-links2-schema2.sqlite`), old = new Database(oldFile);
  // Previous FTS content has the body only, so the metadata DOI cannot match.
  old.run("CREATE VIRTUAL TABLE fts USING fts5(path UNINDEXED, title, description, body, tokenize='unicode61')");
  old.query("INSERT INTO fts VALUES (?,?,?,?)").run("preexisting.md", metadata.title, metadata.description, body);
  expect(old.query("SELECT path FROM fts WHERE fts MATCH ?").all('"10.1234/preexisting.paper"')).toEqual([]);
  old.close();
  const oldBytes = readFileSync(oldFile), index = new VaultIndex(f.home, f.spec);
  try {
    expect(index.file).toEndWith("-links2-schema3.sqlite");
    expect(index.scan()).toEqual({ notes: 2, changed: 2, removed: 0 });
    expect(index.search("10.1234/preexisting.paper", { type: "reference" }).map(hit => hit.path)).toEqual(["preexisting.md"]);
    expect(index.scan()).toEqual({ notes: 2, changed: 0, removed: 0 });
  } finally { index.close(); }
  expect(readFileSync(file, "utf8")).toBe(source);
  expect(readFileSync(oldFile)).toEqual(oldBytes);
});


test("confirmed moves preserve uppercase valid and invalid legacy DOI metadata byte for byte", () => {
  for (const doi of ["10.1234/UPPERCASE.PAPER", "https://doi.org/10.1234/EXAMPLE"]) {
    const f = fixture(), source = note({ doi }).replace(`doi: ${JSON.stringify(doi)}`, `doi: '${doi}' # preserve quoting and comment`);
    const oldFile = join(f.notes, "legacy.md"), nextFile = join(f.notes, "renamed.md");
    writeFileSync(oldFile, source);
    const operation: WriteOp = { op: "move", from: "legacy", to: "renamed" };
    const preview = f.request(operation);
    expect(preview.ok).toBe(true);
    expect(readFileSync(oldFile, "utf8")).toBe(source);
    expect(existsSync(nextFile)).toBe(false);
    const result = applyWrite(f.home, { vault: "test", operation, confirm: true, fingerprint: preview.fingerprint });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.issues.filter(issue => issue.severity === "error")).toEqual([]);
    if (doi.startsWith("https:")) expect(result.issues).toContainEqual(expect.objectContaining({ code: "V01", severity: "warning", message: expect.stringContaining("doi") }));
    expect(readFileSync(nextFile, "utf8")).toBe(source);
    expect(existsSync(oldFile)).toBe(false);
  }
});

test("legacy case-only and exact citekey pairs warn on unrelated edits but explicit assignments error (#134)", () => {
  for (const otherKey of ["sMiTh2020", "Smith2020"]) {
    const f = fixture();
    const first = note({ title: "First", citekey: "Smith2020" }).replace("# Synthetic Paper", "# First");
    const second = note({ title: "Second", citekey: otherKey }).replace("# Synthetic Paper", "# Second");
    const file = join(f.notes, "first.md"); writeFileSync(file, first); writeFileSync(join(f.notes, "second.md"), second);
    const patch = f.request({ op: "patch", path: "first", oldString: "Independent", newString: "Additional" });
    expect(patch.ok).toBe(true);
    expect(patch.issues).toContainEqual(expect.objectContaining({ code: "V08", severity: "warning", message: expect.stringContaining("notes/second.md") }));
    expect(parseFrontmatter(readFileSync(file, "utf8")).data.citekey).toBe("Smith2020");
    const before = readFileSync(file, "utf8");
    for (const citekey of ["Smith2020", "smith2020"]) {
      const explicit = f.request({ op: "frontmatter", path: "first", set: { citekey } });
      expect(explicit.ok).toBe(false);
      expect(explicit.issues).toContainEqual(expect.objectContaining({ code: "V08", severity: "error", message: expect.stringContaining("notes/second.md") }));
      expect(readFileSync(file, "utf8")).toBe(before);
    }
  }
});

test("arXiv new-form width depends on YY, including the 14/15 boundary (#134)", () => {
  for (const arxiv_id of ["0801.1234", "2601.12345", "1412.9999v2", "1501.00001v1"]) expect(errors({ arxiv_id })).toEqual([]);
  for (const arxiv_id of ["0801.12345", "2601.1234", "1412.99999", "1501.0001"]) {
    const found = errors({ arxiv_id });
    expect(found).toContainEqual(expect.objectContaining({ code: "V01", message: expect.stringContaining("4 digits after YYMM. for YY < 15, 5 digits for YY >= 15") }));
  }
});

test("move and tidy keep DOI-free note bytes, and explicit equal DOI assignment still lowercases (#134)", () => {
  const plain = note({ doi: undefined, citekey: undefined }).replace(/\n/g, "\r\n");
  const peer = plain.replace("# Synthetic Paper", "# Peer").replace("Independent synthetic prose.", "Links to [[plain]].");
  const notes = new Map([["notes/plain.md", plain], ["notes/peer.md", peer]]);
  expect(planOperation({ op: "tidy" }, notes)).toEqual([]);
  expect(planOperation({ op: "move", from: "plain", to: "renamed" }, notes)).toEqual([
    { path: "notes/peer.md", before: peer, after: peer.replace("[[plain]]", "[[renamed]]") },
    { path: "notes/plain.md", before: plain, after: null },
    { path: "notes/renamed.md", before: null, after: plain },
  ]);
  const f = fixture(), legacy = note({ doi: "10.1234/UPPERCASE" });
  const file = join(f.notes, "legacy.md"); writeFileSync(file, legacy);
  expect(f.request({ op: "frontmatter", path: "legacy", set: { doi: "10.1234/UPPERCASE" } }).ok).toBe(true);
  expect(readFileSync(file, "utf8")).toBe(emitFrontmatter(parseFrontmatter(legacy), { doi: "10.1234/uppercase", updated: localDate() }));
});
