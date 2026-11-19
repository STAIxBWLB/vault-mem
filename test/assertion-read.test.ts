import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAssertions } from "../src/assertions.ts";
import { readAssertions } from "../src/assertion-read.ts";
import { addVault } from "../src/registry.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-assertion-read-"))); roots.push(root);
  const home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes"); mkdirSync(notes, { recursive: true });
  writeFileSync(join(root, "workspace.config.yaml"), "name: fixture\n");
  writeFileSync(join(notes, "subject.md"), "---\nstatus: active\n---\nSubject\n");
  addVault(home, { id: "test", path: vault, kind: "personal", write: "cli", registry: join(root, "projects.yaml") });
  const env = { HOME: root, VMEM_HOME: home, PATH: process.env.PATH };
  const append = (ops: unknown[], date: string) => appendAssertions(home, { vault: "test", ops, channel: "cli" }, { env, now: new Date(date) });
  return { root, home, vault, notes, env, append };
}

test("read evaluates the verified journal, paginates, and rechecks subject notes", () => {
  const f = fixture();
  const receipt = f.append([{ op: "declare", subject: "s:test", note: "notes/subject.md" },
    { op: "assert", subject: "s:test", relation: "role", value: "member", kind: "state", from: "2025-01-01", to: "open", source: ["mem:fixture"] },
    { op: "assert", subject: "s:test", relation: "team", value: "research", kind: "state", from: "2025-01-01", to: "open", source: ["mem:fixture"] }], "2026-01-01T12:00:00Z");
  expect(receipt.ok).toBe(true);
  const first = readAssertions(f.home, { vault: "test", at: "2026-01-01", asOf: "2026-01-01", limit: 1 }, { env: f.env });
  expect(first).toMatchObject({ basis: "assertion_journal", asOf: { cutoff: "2026-01-02T00:00:00Z", cutoffInclusive: false }, truncated: true, coverage: { unsynced: null } });
  expect(first.items[0]).toMatchObject({ value: "member", answer: "yes", subjectNote: { path: "notes/subject.md", status: "present" } });
  const next = readAssertions(f.home, { vault: "test", at: "2026-01-01", asOf: "2026-01-01", limit: 1, cursor: first.continuation }, { env: f.env });
  expect(next.items[0]?.value).toBe("research"); expect(next.truncated).toBe(false);
  writeFileSync(join(f.notes, "subject.md"), "---\nstatus: superseded\nsuperseded_by: replacement\n---\nSubject\n");
  expect(readAssertions(f.home, { vault: "test", limit: 1 }, { env: f.env }).items[0]?.subjectNote).toMatchObject({ status: "superseded", supersededBy: "replacement" });
  rmSync(join(f.notes, "subject.md"));
  expect(readAssertions(f.home, { vault: "test", limit: 1 }, { env: f.env }).items[0]?.subjectNote?.status).toBe("missing");
  expect(existsSync(join(f.vault, "assertions.lock"))).toBe(false);
  expect(readFileSync(join(f.vault, "assertions", `${receipt.segment}.jsonl`)).length).toBeGreaterThan(0);
});

test("a cursor cannot silently move to a different journal or query", () => {
  const f = fixture();
  expect(f.append([{ op: "declare", subject: "s:test" }, ...["a", "b"].map(relation => ({ op: "assert", subject: "s:test", relation, value: "x", kind: "state", from: "2025", to: "open", source: ["mem:fixture"] }))], "2026-01-01T00:00:00Z").ok).toBe(true);
  const page = readAssertions(f.home, { vault: "test", limit: 1 }, { env: f.env });
  expect(() => readAssertions(f.home, { vault: "test", subject: "s:other", cursor: page.continuation }, { env: f.env })).toThrow("restart without --cursor");
});

test("CLI and MCP expose the same read-only paged result within the full frame bound", async () => {
  const { run } = await import("../src/cli.ts"), { createVaultMcp } = await import("../src/mcp-vault.ts"), { serveMcp } = await import("../src/mcp.ts");
  const { PassThrough } = await import("node:stream");
  const f = fixture();
  expect(f.append([{ op: "declare", subject: "s:test" }, { op: "assert", subject: "s:test", relation: "role", value: "member", kind: "state", from: "2025", to: "open", source: ["mem:fixture"] }], "2026-01-01T00:00:00Z").ok).toBe(true);
  const cli = JSON.parse(run(["assertions", "test", "--at", "2026-01-01", "--json"], f.env).text);
  const server = createVaultMcp(f.home, f.env), input = new PassThrough(), output = new PassThrough();
  expect(server.tools.find(tool => tool.name === "vmem_assertions")?.annotations.readOnlyHint).toBe(true);
  let outputText = ""; output.on("data", chunk => { outputText += chunk.toString(); });
  const done = serveMcp({ tools: server.tools, handlers: server.handlers, input, output });
  for (const frame of [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: "\n".repeat(200), method: "tools/call", params: { name: "vmem_assertions", arguments: { vault: "test", at: "2026-01-01" } } },
  ]) input.write(JSON.stringify(frame) + "\n");
  input.end(); await done;
  const lines = outputText.trimEnd().split("\n"), frame = lines.at(-1)!;
  expect(Buffer.byteLength(frame) + 1).toBeLessThanOrEqual(48 * 1024);
  const result = JSON.parse(JSON.parse(frame).result.content[0].text);
  expect(result).toEqual(cli);
});

test("external journal corruption is reflected on the next read, never trusted from the cache", () => {
  const f = fixture();
  const receipt = f.append([{ op: "declare", subject: "s:test" }, { op: "assert", subject: "s:test", relation: "role", value: "member", kind: "state", from: "2025", to: "open", source: ["mem:fixture"] }], "2026-01-01T00:00:00Z");
  expect(receipt.ok).toBe(true);
  expect(readAssertions(f.home, { vault: "test" }, { env: f.env }).items).toHaveLength(1);
  const file = join(f.vault, "assertions", `${receipt.segment}.jsonl`), original = readFileSync(file, "utf8");
  writeFileSync(file, original.replace('"value":"member"', '"value":"altered"'));
  const after = readAssertions(f.home, { vault: "test" }, { env: f.env });
  expect(after.items).toEqual([]); expect(after.coverage.untrusted).toHaveLength(1);
});

test("large pages stay within the complete escaped frame and continue without losing items", () => {
  const f = fixture();
  expect(f.append([{ op: "declare", subject: "s:test" }], "2026-01-01T00:00:00Z").ok).toBe(true);
  for (let batch = 0; batch < 3; batch++) {
    const ops = Array.from({ length: 20 }, (_, i) => ({ op: "assert", subject: "s:test", relation: `r${batch * 20 + i}`, value: '"'.repeat(900), kind: "state", from: "2025", to: "open", source: ["mem:fixture"] }));
    expect(f.append(ops, `2026-01-0${batch + 2}T00:00:00Z`).ok).toBe(true);
  }
  const ids = new Set<string>(); let cursor: string | undefined;
  do {
    const page = readAssertions(f.home, { vault: "test", limit: 100, ...(cursor ? { cursor } : {}) }, { env: f.env });
    const frame = { jsonrpc: "2.0", id: "\n".repeat(200), result: { content: [{ type: "text", text: JSON.stringify(page) }] } };
    expect(Buffer.byteLength(JSON.stringify(frame)) + 1).toBeLessThanOrEqual(48 * 1024);
    for (const item of page.items) { expect(ids.has(item.id)).toBe(false); ids.add(item.id); }
    cursor = page.continuation;
  } while (cursor);
  expect(ids.size).toBe(60);
});

test("read-time policy changes withhold values and refuse a denied journal", () => {
  const f = fixture();
  expect(f.append([{ op: "declare", subject: "s:test" }, { op: "assert", subject: "s:test", relation: "email", value: "person@example.test", kind: "state", from: "2025", to: "open", source: ["mem:fixture"] }], "2026-01-01T00:00:00Z").ok).toBe(true);
  const configPath = join(f.home, "vmem.config.json"), config = JSON.parse(readFileSync(configPath, "utf8"));
  expect(readAssertions(f.home, { vault: "test" }, { env: f.env }).items[0]?.value).toBe("person@example.test");
  config.vaults[0].pii = "deny"; writeFileSync(configPath, JSON.stringify(config));
  expect(readAssertions(f.home, { vault: "test" }, { env: f.env }).items[0]?.value).toEqual({ withheld: "pii_policy" });
  config.denyPaths = [join(f.vault, "assertions")]; writeFileSync(configPath, JSON.stringify(config));
  expect(() => readAssertions(f.home, { vault: "test" }, { env: f.env })).toThrow("denied by denyPaths");
});

test("a newer segment schema reports unsupported and is never evaluated", () => {
  const f = fixture();
  const receipt = f.append([{ op: "declare", subject: "s:test" }], "2026-01-01T00:00:00Z");
  const file = join(f.vault, "assertions", `${receipt.segment}.jsonl`), original = readFileSync(file, "utf8");
  writeFileSync(file, original.replace('"v":1', '"v":2'));
  const result = readAssertions(f.home, { vault: "test" }, { env: f.env });
  expect(result.coverage.unsupported).toEqual([{ segment: receipt.segment!, seq: 1 }]);
  expect(result.items).toEqual([]);
});

test("unsynced counts journal segments only in a Git vault", async () => {
  const { spawnSync } = await import("node:child_process");
  const f = fixture();
  expect(spawnSync("git", ["init", "-q", f.vault], { env: f.env }).status).toBe(0);
  expect(f.append([{ op: "declare", subject: "s:test" }], "2026-01-01T00:00:00Z").ok).toBe(true);
  writeFileSync(join(f.vault, "assertions", "stray.txt"), "unrelated\n");
  writeFileSync(join(f.notes, "other.md"), "unrelated\n");
  expect(readAssertions(f.home, { vault: "test" }, { env: f.env }).coverage.unsynced).toBe(1);
});

test("T13 note reads, note index and lint are unchanged by the assertion journal", async () => {
  const { VaultIndex } = await import("../src/vault-index.ts"), { analysisInput } = await import("../src/analysis-input.ts"), { lintVault } = await import("../src/vault-lint.ts"), { loadRegistry } = await import("../src/registry.ts");
  const f = fixture(), spec = loadRegistry(f.home).vaults[0]!;
  const readNote = () => { const index = new VaultIndex(f.home, spec); try { index.scan(); return { note: index.show("subject"), list: index.list() }; } finally { index.close(); } };
  const beforeNote = readNote(), beforeLint = lintVault(analysisInput(f.home, "test").snapshot), beforeBytes = readFileSync(join(f.notes, "subject.md"));
  expect(f.append([{ op: "declare", subject: "s:test" }, { op: "assert", subject: "s:test", relation: "role", value: "member", kind: "state", from: "2025", to: "open", source: ["mem:fixture"] }], "2026-01-01T00:00:00Z").ok).toBe(true);
  readAssertions(f.home, { vault: "test" }, { env: f.env });
  expect(readNote()).toEqual(beforeNote); expect(lintVault(analysisInput(f.home, "test").snapshot)).toEqual(beforeLint);
  expect(readFileSync(join(f.notes, "subject.md"))).toEqual(beforeBytes);
  expect(existsSync(join(f.vault, "log"))).toBe(false); expect(existsSync(join(f.vault, "assertions.lock"))).toBe(false);
});

test("Q1 cutoff and verified source produce the documented assertion fields", async () => {
  const { createHash } = await import("node:crypto"), f = fixture();
  const sourceText = "joins as member\n", source = "vault/notes/onboarding-2025-09.md";
  writeFileSync(join(f.notes, "onboarding-2025-09.md"), sourceText);
  writeFileSync(join(f.notes, "person-a.md"), "---\nstatus: active\n---\nPerson A\n");
  const receipt = f.append([{ op: "declare", subject: "s:person-a", note: "notes/person-a.md" },
    { op: "assert", subject: "s:person-a", relation: "role", value: "member", kind: "state", from: "2025-09-01", to: "open", source: [source], evidence: [{ source, sha256: createHash("sha256").update(sourceText).digest("hex"), quote: "joins as member" }] }], "2025-09-02T09:00:00Z");
  expect(receipt.ok).toBe(true);
  const response = readAssertions(f.home, { vault: "test", subject: "s:person-a", relation: "role", at: "2026-04-05", asOf: "2026-04-06" }, { env: f.env });
  expect(response).toMatchObject({ schemaVersion: 1, basis: "assertion_journal", vault: "test", at: "2026-04-05", asOf: { requested: "2026-04-06", cutoff: "2026-04-07T00:00:00Z", cutoffInclusive: false }, truncated: false, overlaps: [],
    items: [{ id: receipt.entries[1]!.id, rev: 1, subject: "s:person-a", relation: "role", value: "member", kind: "state", from: "2025-09-01", to: "open", answer: "yes", recordedAt: "2025-09-02T09:00:00Z", evidence: [{ source, status: "verified", quote: "joins as member" }], subjectNote: { path: "notes/person-a.md", status: "present" } }] });
});
