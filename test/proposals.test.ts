import { expect, test } from "bun:test";
import { checkProposalRpcSize, decodeProposalRecord, encodeProposalRecord, MAX_PROPOSAL_RPC_BYTES, parseProposalOperation, proposalPayloadDigest, proposalRpcBytes, type ProposalRecord } from "../src/proposals.ts";
import { checkStoredBinding, createStoredProposal, readStoredProposal } from "../src/proposal-storage.ts";
import { listProposals, proposalReplyBytes, showProposal, submitProposal } from "../src/proposal-provider.ts";
import { addVault, removeVault, setVaultPii } from "../src/registry.ts";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("proposal operations admit only one normalized note and bounded exact edits", () => {
  expect(parseProposalOperation({ op: "create", path: "synthetic", frontmatter: { type: "insight" }, body: "한글" })).toEqual({ op: "create", path: "notes/synthetic.md", frontmatter: { type: "insight" }, body: "한글" });
  const patch = { op: "patch" as const, path: "notes/synthetic.md", expectedSha: "a".repeat(64), edits: [{ oldString: "before", newString: "after" }] };
  expect(parseProposalOperation(patch)).toEqual(patch);
  expect(() => parseProposalOperation({ ...patch, expectedSha: "bad" })).toThrow("base SHA");
  expect(() => parseProposalOperation({ ...patch, edits: Array(33).fill(patch.edits[0]) })).toThrow("1..32");
  expect(() => parseProposalOperation({ ...patch, path: "../other" })).toThrow();
  expect(() => parseProposalOperation({ ...patch, arbitrary: true })).toThrow();
  expect(() => parseProposalOperation({ op: "delete", path: "synthetic" })).toThrow("unsupported operation");
  expect(() => parseProposalOperation({ op: "create", path: "synthetic", frontmatter: {}, body: "가".repeat(12000) })).toThrow("32 KiB");
});

test("record codec rejects corruption, payload drift and uncertain apply without intent", () => {
  const operation = parseProposalOperation({ op: "create", path: "synthetic", frontmatter: { type: "insight" }, body: "한글" });
  const record: ProposalRecord = { schemaVersion: 1, id: "12345678-1234-4123-8123-123456789abc", vault: "test", bindingDigest: "a".repeat(64), state: "pending", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", operation, payloadDigest: proposalPayloadDigest(operation) };
  expect(decodeProposalRecord(encodeProposalRecord(record))).toEqual(record);
  expect(() => encodeProposalRecord({ ...record, payloadDigest: "b".repeat(64) })).toThrow("digest differs");
  expect(() => encodeProposalRecord({ ...record, state: "apply_unknown" })).toThrow("no recorded intent");
  expect(() => decodeProposalRecord(Buffer.from([255]))).toThrow("not UTF-8");
  expect(() => decodeProposalRecord(Buffer.from("{"))).toThrow("not JSON");
  expect(() => decodeProposalRecord(Buffer.from('{"schemaVersion":1,"schemaVersion":1}'))).toThrow("canonical JSON");
});

test("request bound counts actual JSON escaping and UTF-8 envelope bytes", () => {
  const request = { jsonrpc: "2.0", id: 1, method: "vmem_proposal_submit", params: { body: '한글 " \\'.repeat(100) } };
  expect(proposalRpcBytes(request)).toBe(Buffer.byteLength(JSON.stringify(request), "utf8") + 1);
  expect(proposalRpcBytes(request)).toBeGreaterThan(Buffer.byteLength(request.params.body, "utf8"));
  expect(() => checkProposalRpcSize({ ...request, params: { body: '"'.repeat(MAX_PROPOSAL_RPC_BYTES / 2) } })).toThrow("48 KiB");
});

test("private record storage refuses overwrite, linked files and permissive directories", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposals-")));
  const operation = parseProposalOperation({ op: "create", path: "synthetic", frontmatter: {}, body: "safe" });
  const record: ProposalRecord = { schemaVersion: 1, id: "12345678-1234-4123-8123-123456789abc", vault: "test", bindingDigest: "a".repeat(64), state: "pending", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", operation, payloadDigest: proposalPayloadDigest(operation) };
  try {
    createStoredProposal(home, record);
    const dir = join(home, "proposals", record.bindingDigest), file = join(dir, `${record.id}.json`);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readStoredProposal(home, record.bindingDigest, record.id)).toEqual(record);
    expect(checkStoredBinding(home, record.vault, record.bindingDigest)).toBe(true);
    expect(() => checkStoredBinding(home, record.vault, "b".repeat(64))).toThrow("different root");
    expect(() => createStoredProposal(home, { ...record, id: "12345678-1234-4123-8123-123456789abd", bindingDigest: "b".repeat(64) })).toThrow("different root");
    expect(() => createStoredProposal(home, record)).toThrow();
    linkSync(file, join(dir, "linked"));
    expect(() => readStoredProposal(home, record.bindingDigest, record.id)).toThrow("linked");
    rmSync(join(dir, "linked"));
    chmodSync(dir, 0o755);
    expect(() => readStoredProposal(home, record.bindingDigest, record.id)).toThrow("not private");
    chmodSync(dir, 0o700);
    rmSync(file);
    writeFileSync(file, "x".repeat(32 * 1024 + 1), { mode: 0o600 });
    expect(() => readStoredProposal(home, record.bindingDigest, record.id)).toThrow("exceeds 32 KiB");
    rmSync(file);
    symlinkSync(join(home, "outside"), file);
    expect(() => readStoredProposal(home, record.bindingDigest, record.id)).toThrow();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("submission screens and validates before storing without changing the vault", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-submit-"))), home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vault, kind: "personal", write: "mcp" });
    const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const before = readdirSync(notes);
    const result = submitProposal(home, { vault: "test", operation, agentLabel: "test-agent" }, { channel: "mcp" });
    expect(result).toMatchObject({ vault: "test", state: "pending", path: "notes/proposed.md" });
    expect(result).not.toHaveProperty("operation");
    expect(readdirSync(notes)).toEqual(before);
    expect(existsSync(join(vault, "log"))).toBe(false);
    const store = join(home, "proposals"), bucket = readdirSync(store)[0]!;
    const stored = readdirSync(join(store, bucket));
    expect(() => submitProposal(home, { vault: "test", operation: { ...operation, body: "password: syntheticsecret" } }, { channel: "mcp" })).toThrow("screening refused");
    expect(readdirSync(join(store, bucket))).toEqual(stored);
    const listed = listProposals(home, { vault: "test" }, { channel: "mcp" });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ id: result.id, state: "pending" });
    expect(JSON.stringify(listed)).not.toContain("Synthetic body");
    const longBody = operation.body.replace("Synthetic body.", `Contact synthetic@example.invalid. 한글 ${'"'.repeat(13000)}`);
    const second = submitProposal(home, { vault: "test", operation: { ...operation, path: "proposed-two", body: longBody } }, { channel: "mcp" });
    const firstPage = listProposals(home, { vault: "test", limit: 1 }, { channel: "mcp" });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = listProposals(home, { vault: "test", limit: 1, after: firstPage.nextCursor! }, { channel: "mcp" });
    expect(new Set([firstPage.items[0]!.id, secondPage.items[0]!.id])).toEqual(new Set([result.id, second.id]));
    let offset = 0, assembled = "", pageCount = 0;
    for (;;) {
      const page = showProposal(home, { vault: "test", id: second.id, offset }, { channel: "mcp" });
      expect(Buffer.byteLength(page.content, "utf8")).toBeLessThanOrEqual(16 * 1024);
      expect(proposalReplyBytes(page)).toBeLessThanOrEqual(48 * 1024);
      assembled += page.content; pageCount++;
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
      expect(pageCount).toBeLessThan(20);
    }
    expect(pageCount).toBeGreaterThan(1);
    expect(JSON.parse(assembled).body).toBe(longBody);
    setVaultPii(home, "test", "deny", true);
    expect(() => listProposals(home, { vault: "test" }, { channel: "mcp" })).toThrow("disclosure policy");
    expect(() => showProposal(home, { vault: "test", id: second.id }, { channel: "mcp" })).toThrow("disclosure policy");
    expect(readdirSync(notes)).toEqual(before);
    expect(existsSync(join(notes, "proposed.md"))).toBe(false);
    const lockedVault = join(root, "locked"); mkdirSync(join(lockedVault, "notes"), { recursive: true });
    addVault(home, { id: "locked", path: lockedVault, kind: "personal", write: "none" });
    expect(() => submitProposal(home, { vault: "locked", operation }, { channel: "cli" })).toThrow("write policy");
    expect(readdirSync(store)).toEqual([bucket]);
    removeVault(home, "test", true);
    const replacement = join(root, "replacement"), replacementNotes = join(replacement, "notes");
    mkdirSync(replacementNotes, { recursive: true });
    writeFileSync(join(replacementNotes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: replacement, kind: "personal", write: "mcp" });
    expect(() => listProposals(home, { vault: "test" }, { channel: "mcp" })).toThrow("different root");
    expect(() => submitProposal(home, { vault: "test", operation }, { channel: "mcp" })).toThrow("different root");
    expect(readdirSync(store)).toEqual([bucket]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
