import { expect, test } from "bun:test";
import { checkProposalRpcSize, decodeProposalRecord, encodeProposalRecord, MAX_PROPOSAL_RPC_BYTES, parseProposalOperation, proposalPayloadDigest, proposalRpcBytes, type ProposalRecord } from "../src/proposals.ts";
import { createStoredProposal, readStoredProposal } from "../src/proposal-storage.ts";
import { chmodSync, linkSync, lstatSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
