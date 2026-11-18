import { expect, test } from "bun:test";
import { checkProposalRpcSize, decodeProposalRecord, encodeProposalRecord, MAX_PROPOSAL_RPC_BYTES, parseProposalOperation, proposalDecisionFingerprint, proposalPayloadDigest, proposalRecordDigest, proposalRpcBytes, type ProposalRecord } from "../src/proposals.ts";
import { checkStoredBinding, createStoredProposal, readStoredProposal, replaceStoredProposal } from "../src/proposal-storage.ts";
import { applyProposal, listProposals, previewProposalApply, previewProposalReject, proposalReplyBytes, reconcileProposal, rejectProposal, showProposal, submitProposal } from "../src/proposal-provider.ts";
import { addVault, loadRegistry, removeVault, setVaultPii } from "../src/registry.ts";
import { logBinding } from "../src/vault-log.ts";
import { applyProposalWrite, applyWrite, sha256, snapshot } from "../src/writer.ts";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("record replacement binds the exact prior bytes and immutable payload", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-cas-")));
  const operation = parseProposalOperation({ op: "create", path: "synthetic", frontmatter: {}, body: "safe" });
  const pending: ProposalRecord = { schemaVersion: 1, id: "12345678-1234-4123-8123-123456789abc", vault: "test", bindingDigest: "a".repeat(64), state: "pending", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", operation, payloadDigest: proposalPayloadDigest(operation) };
  const rejected: ProposalRecord = { ...pending, state: "rejected", decisionReason: "not needed", updatedAt: "2026-01-02T00:00:00.000Z" };
  try {
    createStoredProposal(home, pending);
    const before = proposalRecordDigest(pending);
    replaceStoredProposal(home, pending.bindingDigest, pending.id, before, rejected);
    expect(readStoredProposal(home, pending.bindingDigest, pending.id)).toEqual(rejected);
    expect(() => replaceStoredProposal(home, pending.bindingDigest, pending.id, before, rejected)).toThrow("changed since preview");
    const altered = parseProposalOperation({ op: "create", path: "other", frontmatter: {}, body: "safe" });
    expect(() => replaceStoredProposal(home, pending.bindingDigest, pending.id, proposalRecordDigest(rejected), { ...rejected, operation: altered, payloadDigest: proposalPayloadDigest(altered) })).toThrow("immutable");
    expect(readStoredProposal(home, pending.bindingDigest, pending.id)).toEqual(rejected);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("decision fingerprint binds prior record, writer plan, action and rejection reason", () => {
  const record = "a".repeat(64), plan = "b".repeat(64);
  const apply = proposalDecisionFingerprint(record, plan, "apply");
  expect(apply).not.toBe(proposalDecisionFingerprint("c".repeat(64), plan, "apply"));
  expect(apply).not.toBe(proposalDecisionFingerprint(record, "d".repeat(64), "apply"));
  expect(apply).not.toBe(proposalDecisionFingerprint(record, plan, "reject", "not useful"));
  expect(proposalDecisionFingerprint(record, plan, "reject", "not useful")).not.toBe(proposalDecisionFingerprint(record, plan, "reject", "different reason"));
  expect(() => proposalDecisionFingerprint(record, plan, "reject", " ")).toThrow("rejection needs");
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

test("writer guard records intent under the mutation lock and refuses a stale decision", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-writer-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
    const input = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const submitted = submitProposal(home, { vault: "test", operation: input }, { channel: "mcp" });
    const bindingDigest = readdirSync(join(home, "proposals"))[0]!, record = readStoredProposal(home, bindingDigest, submitted.id);
    const config = loadRegistry(home), binding = logBinding(config.vaults[0]!, config), request = { vault: "test", operation: record.operation, channel: "mcp" as const };
    const preview = applyWrite(home, { ...request, dryRun: true }, { binding });
    expect(preview.ok).toBe(true);
    const recordDigest = proposalRecordDigest(record), fingerprint = proposalDecisionFingerprint(recordDigest, preview.fingerprint!, "apply");
    expect(previewProposalApply(home, { vault: "test", id: record.id }, { channel: "mcp" }).fingerprint).toBe(fingerprint);
    expect(existsSync(join(vaultPath, "mutation.lock"))).toBe(false);
    const decision = { id: record.id, bindingDigest, recordDigest, fingerprint };
    const missing = applyProposalWrite(home, request, { binding } as Parameters<typeof applyProposalWrite>[2]);
    expect(missing.applied).toBe(false);
    expect(existsSync(join(notes, "proposed.md"))).toBe(false);
    const stale = applyProposalWrite(home, request, { binding, proposal: { ...decision, fingerprint: "0".repeat(64) } });
    expect(stale.ok).toBe(false);
    expect(existsSync(join(notes, "proposed.md"))).toBe(false);
    expect(readStoredProposal(home, bindingDigest, record.id).state).toBe("pending");
    const researchFile = join(notes, "research.md"), original = readFileSync(researchFile, "utf8");
    writeFileSync(researchFile, `${original}\nchanged\n`);
    expect(applyProposalWrite(home, request, { binding, proposal: decision }).applied).toBe(false);
    expect(readStoredProposal(home, bindingDigest, record.id).state).toBe("pending");
    writeFileSync(researchFile, original);
    const applied = applyProposalWrite(home, request, { binding, proposal: decision });
    expect(applied.applied).toBe(true);
    expect(existsSync(join(notes, "proposed.md"))).toBe(true);
    const after = readStoredProposal(home, bindingDigest, record.id);
    expect(after.state).toBe("apply_unknown");
    expect(after.intent).toMatchObject({ fingerprint, beforeSha: null, afterSha: applied.changes[0]!.sha256 });
    const observed = reconcileProposal(home, { vault: "test", id: record.id }, { channel: "mcp" });
    expect(observed).toMatchObject({ state: "apply_unknown", matchesBefore: false, matchesAfter: true, receiptEvidence: "unavailable" });
    expect(readStoredProposal(home, bindingDigest, record.id)).toEqual(after);
    expect(applyProposalWrite(home, request, { binding, proposal: decision }).applied).toBe(false);
    expect(() => previewProposalApply(home, { vault: "test", id: record.id }, { channel: "mcp" })).toThrow("outcome is unknown");
    const second = submitProposal(home, { vault: "test", operation: { ...input, path: "precrash", body: input.body.replace("Proposed", "Precrash") } }, { channel: "mcp" });
    const pending = readStoredProposal(home, bindingDigest, second.id);
    replaceStoredProposal(home, bindingDigest, second.id, proposalRecordDigest(pending), { ...pending, state: "apply_unknown", intent: { fingerprint: "a".repeat(64), beforeSha: null, afterSha: "b".repeat(64) } });
    expect(reconcileProposal(home, { vault: "test", id: second.id }, { channel: "mcp" })).toMatchObject({ state: "apply_unknown", observedSha: null, matchesBefore: true, matchesAfter: false, receiptEvidence: "unavailable" });
    expect(existsSync(join(notes, "precrash.md"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("applied notes stay applied when logging fails and cannot be replayed", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-log-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
    const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    const preview = previewProposalApply(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
    mkdirSync(join(vaultPath, "log"));
    const result = applyProposal(home, { vault: "test", id: submitted.id, fingerprint: preview.fingerprint }, { channel: "mcp" });
    expect(result).toMatchObject({ ok: false, applied: true, state: "applied", logged: false });
    expect(existsSync(join(notes, "proposed.md"))).toBe(true);
    const bindingDigest = readdirSync(join(home, "proposals"))[0]!;
    const stored = readStoredProposal(home, bindingDigest, submitted.id);
    expect(stored.state).toBe("applied");
    expect(stored.receipt).toMatchObject({ applied: true, logged: false });
    expect(() => applyProposal(home, { vault: "test", id: submitted.id, fingerprint: preview.fingerprint }, { channel: "mcp" })).toThrow("no longer pending");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejection binds the reason and current vault snapshot without changing notes or log", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-reject-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    const research = join(notes, "research.md"), original = "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n";
    writeFileSync(research, original);
    mkdirSync(join(vaultPath, "reports"));
    const graphFile = join(vaultPath, "reports", "vault-graph.json"); writeFileSync(graphFile, "{\"synthetic\":true}\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
    const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    const preview = previewProposalReject(home, { vault: "test", id: submitted.id, reason: "not needed" }, { channel: "mcp" });
    expect(existsSync(join(vaultPath, "mutation.lock"))).toBe(false);
    expect(() => snapshot(vaultPath, [], 1)).toThrow("read bound");
    const budget = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures", "proposal-budget.ts"), vaultPath], { stdout: "pipe", stderr: "pipe" });
    expect(budget.exitCode).toBe(0);
    expect(JSON.parse(budget.stdout.toString())).toEqual({ refused: true, reads: 0 });
    const wrongReason = rejectProposal(home, { vault: "test", id: submitted.id, reason: "different", fingerprint: preview.fingerprint }, { channel: "mcp" });
    expect(wrongReason.rejected).toBe(false);
    writeFileSync(research, `${original}\nchanged\n`);
    const changed = rejectProposal(home, { vault: "test", id: submitted.id, reason: "not needed", fingerprint: preview.fingerprint }, { channel: "mcp" });
    expect(changed.rejected).toBe(false);
    writeFileSync(research, original);
    const rejected = rejectProposal(home, { vault: "test", id: submitted.id, reason: "not needed", fingerprint: preview.fingerprint }, { channel: "mcp" });
    expect(rejected).toMatchObject({ ok: true, rejected: true });
    expect(readFileSync(research, "utf8")).toBe(original);
    expect(existsSync(join(notes, "proposed.md"))).toBe(false);
    expect(existsSync(join(vaultPath, "log"))).toBe(false);
    expect(readFileSync(graphFile, "utf8")).toBe("{\"synthetic\":true}\n");
    expect(existsSync(join(vaultPath, "mutation.lock"))).toBe(false);
    const bindingDigest = readdirSync(join(home, "proposals")).find(name => /^[a-f0-9]{64}$/.test(name))!;
    expect(readStoredProposal(home, bindingDigest, submitted.id)).toMatchObject({ state: "rejected", decisionReason: "not needed" });
    expect(() => rejectProposal(home, { vault: "test", id: submitted.id, reason: "not needed", fingerprint: preview.fingerprint }, { channel: "mcp" })).toThrow("no longer pending");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a stale patch can still be rejected against a fresh rejection preview", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-stale-reject-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    const research = join(notes, "research.md"), original = "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n";
    writeFileSync(research, original);
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
    const operation = { op: "patch", path: "research", expectedSha: sha256(original), edits: [{ oldString: "# Research", newString: "# Research revised" }] };
    const submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    const changed = `${original}\nexternal edit\n`; writeFileSync(research, changed);
    expect(() => previewProposalApply(home, { vault: "test", id: submitted.id }, { channel: "mcp" })).toThrow("preview refused");
    const preview = previewProposalReject(home, { vault: "test", id: submitted.id, reason: "superseded" }, { channel: "mcp" });
    expect(rejectProposal(home, { vault: "test", id: submitted.id, reason: "superseded", fingerprint: preview.fingerprint }, { channel: "mcp" })).toMatchObject({ ok: true, rejected: true });
    expect(readFileSync(research, "utf8")).toBe(changed);
    expect(existsSync(join(vaultPath, "log"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ["before", "after", "before-receipt", "after-receipt"] as const) test(`interrupted ${mode} publication retains an honest state and cannot replay`, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-crash-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
    const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    const preview = previewProposalApply(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
    const fixture = join(import.meta.dir, "fixtures", "proposal-crash.ts");
    const child = Bun.spawnSync([process.execPath, fixture, home, vaultPath, submitted.id, preview.fingerprint, mode], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).not.toBe(0);
    const bindingDigest = readdirSync(join(home, "proposals")).find(name => /^[a-f0-9]{64}$/.test(name))!, stored = readStoredProposal(home, bindingDigest, submitted.id);
    const persisted = mode === "after-receipt";
    expect(stored.state).toBe(persisted ? "applied" : "apply_unknown");
    expect(existsSync(join(notes, "proposed.md"))).toBe(mode !== "before");
    expect(existsSync(join(vaultPath, "log"))).toBe(mode === "before-receipt" || persisted);
    if (persisted) {
      expect(stored.receipt).toMatchObject({ applied: true, logged: true });
      expect(() => reconcileProposal(home, { vault: "test", id: submitted.id }, { channel: "mcp" })).toThrow("needs an uncertain apply");
    } else {
      const review = reconcileProposal(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
      expect(review).toMatchObject({ state: "apply_unknown", receiptEvidence: "unavailable", matchesBefore: mode === "before", matchesAfter: mode !== "before" });
    }
    expect(() => applyProposal(home, { vault: "test", id: submitted.id, fingerprint: preview.fingerprint }, { channel: "mcp" })).toThrow(persisted ? "no longer pending" : "outcome is unknown");
    expect(readStoredProposal(home, bindingDigest, submitted.id).state).toBe(persisted ? "applied" : "apply_unknown");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two concurrent confirmations publish the note at most once", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-race-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
    const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    const preview = previewProposalApply(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
    const fixture = join(import.meta.dir, "fixtures", "proposal-apply.ts"), args = [process.execPath, fixture, home, submitted.id, preview.fingerprint];
    const children = [Bun.spawn(args, { stdout: "pipe", stderr: "pipe" }), Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })];
    const outputs = await Promise.all(children.map(async child => ({ code: await child.exited, text: await new Response(child.stdout).text(), error: await new Response(child.stderr).text() })));
    for (const output of outputs) expect(output.code).toBe(0);
    const results = outputs.map(output => JSON.parse(output.text) as { applied: boolean });
    expect(results.filter(result => result.applied)).toHaveLength(1);
    expect(existsSync(join(notes, "proposed.md"))).toBe(true);
    expect(readFileSync(join(vaultPath, "log"), "utf8").trim().split("\n")).toHaveLength(1);
    const bindingDigest = readdirSync(join(home, "proposals")).find(name => /^[a-f0-9]{64}$/.test(name))!;
    expect(readStoredProposal(home, bindingDigest, submitted.id).state).toBe("applied");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
