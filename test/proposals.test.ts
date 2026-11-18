import { expect, test } from "bun:test";
import { checkProposalRpcSize, decodeProposalRecord, encodeProposalRecord, MAX_PROPOSAL_RPC_BYTES, parseProposalOperation, proposalDecisionFingerprint, proposalPayloadDigest, proposalRecordDigest, proposalRpcBytes, type ProposalRecord } from "../src/proposals.ts";
import { checkStoredBinding, createStoredEvidence, createStoredProposal, readStoredProposal, replaceStoredProposal } from "../src/proposal-storage.ts";
import { applyProposal, confirmProposalReconciliation, listProposals, previewProposalApply, previewProposalReject, proposalReplyBytes, reconcileProposal, rejectProposal, showProposal, submitProposal } from "../src/proposal-provider.ts";
import { addVault, loadRegistry, LOCK_FILE, removeVault, setVaultPii } from "../src/registry.ts";
import { CONFIG_FILE } from "../src/config.ts";
import { logBinding } from "../src/vault-log.ts";
import { applyProposalWrite, applyWrite, sha256 } from "../src/writer.ts";
import { chmodSync, closeSync, constants, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
function withFixtureLock<T>(home: string, run: (fd: number) => T): T {
  const lock = join(home, LOCK_FILE), fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { return run(fd); } finally { closeSync(fd); rmSync(lock); }
}

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
    withFixtureLock(home, fd => createStoredProposal(home, record, [], fd));
    const dir = join(home, "proposals", record.bindingDigest), file = join(dir, `${record.id}.json`);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readStoredProposal(home, record.bindingDigest, record.id)).toEqual(record);
    expect(checkStoredBinding(home, record.vault, record.bindingDigest)).toBe(true);
    const bindingIssues: import("../src/write-types.ts").WriteIssue[] = [];
    expect(checkStoredBinding(home, record.vault, "b".repeat(64), [], bindingIssues)).toBe(false);
    expect(bindingIssues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PROPOSAL_ORPHANED_BINDING" })]));
    const replacement = { ...record, id: "12345678-1234-4123-8123-123456789abd", bindingDigest: "b".repeat(64) };
    withFixtureLock(home, fd => createStoredProposal(home, replacement, [], fd));
    expect(readStoredProposal(home, replacement.bindingDigest, replacement.id)).toEqual(replacement);
    expect(() => withFixtureLock(home, fd => createStoredProposal(home, record, [], fd))).toThrow();
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
    withFixtureLock(home, fd => createStoredProposal(home, pending, [], fd));
    const before = proposalRecordDigest(pending);
    withFixtureLock(home, fd => replaceStoredProposal(home, pending.bindingDigest, pending.id, before, rejected, [], fd));
    expect(readStoredProposal(home, pending.bindingDigest, pending.id)).toEqual(rejected);
    expect(() => withFixtureLock(home, fd => replaceStoredProposal(home, pending.bindingDigest, pending.id, before, rejected, [], fd))).toThrow("changed since preview");
    const altered = parseProposalOperation({ op: "create", path: "other", frontmatter: {}, body: "safe" });
    expect(() => withFixtureLock(home, fd => replaceStoredProposal(home, pending.bindingDigest, pending.id, proposalRecordDigest(rejected), { ...rejected, operation: altered, payloadDigest: proposalPayloadDigest(altered) }, [], fd))).toThrow("immutable");
    expect(readStoredProposal(home, pending.bindingDigest, pending.id)).toEqual(rejected);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("listing skips corrupt records and reports retained store leftovers", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-leftovers-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
    const op = (path: string) => ({ op: "create", path, frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: `# ${path}\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n` });
    const first = submitProposal(home, { vault: "test", operation: op("first") }, { channel: "mcp" });
    const broken = submitProposal(home, { vault: "test", operation: op("broken") }, { channel: "mcp" });
    const store = join(home, "proposals"), binding = readdirSync(store).find(name => /^[a-f0-9]{64}$/.test(name))!, dir = join(store, binding);
    writeFileSync(join(dir, `${broken.id}.json`), "{", { mode: 0o600 });
    writeFileSync(join(store, ".binding.lock"), "stale fixture", { mode: 0o600 });
    writeFileSync(join(dir, ".DS_Store"), "fixture", { mode: 0o600 });
    const temp = ".proposal-12345678-1234-4123-8123-123456789abc.tmp"; writeFileSync(join(dir, temp), "fixture", { mode: 0o600 });
    const page = listProposals(home, { vault: "test" }, { channel: "mcp" });
    expect(page.items.map(item => item.id)).toEqual([first.id]);
    expect(page.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PROPOSAL_SKIPPED", message: expect.stringContaining(broken.id) }), expect.objectContaining({ code: "PROPOSAL_LEFTOVER", message: expect.stringContaining(temp) }), expect.objectContaining({ code: "PROPOSAL_LEFTOVER", message: expect.stringContaining(".binding.lock") })]));
    expect(existsSync(join(dir, temp))).toBe(true);
    expect(submitProposal(home, { vault: "test", operation: op("third") }, { channel: "mcp" }).stored).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("definite submission failure preserves its cause and does not claim an unknown write", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-store-failure-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
    const fixture = join(import.meta.dir, "fixtures", "proposal-store-failure.ts"), child = Bun.spawnSync([process.execPath, fixture, home], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result).toMatchObject({ ok: false, stored: false, state: null });
    expect(result.issues[0].message).toContain("storage is full");
    expect(existsSync(join(notes, "proposed.md"))).toBe(false);
    const page = listProposals(home, { vault: "test" }, { channel: "mcp" });
    expect(page.items).toEqual([]);
    expect(page.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PROPOSAL_BINDING_UNREADABLE" })]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a configured home with a symlinked component uses its canonical private store", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-home-link-"))), home = join(root, "home"), alias = join(root, "home-link"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
    symlinkSync(home, alias);
    const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const submitted = submitProposal(alias, { vault: "test", operation }, { channel: "mcp" });
    expect(submitted).toMatchObject({ ok: true, stored: true });
    expect(listProposals(alias, { vault: "test" }, { channel: "mcp" }).items.map(item => item.id)).toEqual([submitted.id]);
    expect(showProposal(alias, { vault: "test", id: submitted.id }, { channel: "mcp" }).id).toBe(submitted.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a restored vault at the same path gets a new binding without selecting the old store", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-rebind-"))), home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    const research = "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n";
    writeFileSync(join(notes, "research.md"), research);
    addVault(home, { id: "test", path: vault, kind: "personal", write: "mcp" });
    const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const old = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    renameSync(vault, join(root, "previous-vault")); mkdirSync(notes, { recursive: true }); writeFileSync(join(notes, "research.md"), research);
    const before = listProposals(home, { vault: "test" }, { channel: "mcp" });
    expect(before.items).toEqual([]);
    expect(before.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PROPOSAL_ORPHANED_BINDING" })]));
    const fresh = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    expect(fresh).toMatchObject({ ok: true, stored: true });
    expect(listProposals(home, { vault: "test" }, { channel: "mcp" }).items.map(item => item.id)).toEqual([fresh.id]);
    expect(() => showProposal(home, { vault: "test", id: old.id }, { channel: "mcp" })).toThrow("id not found");
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    const registryLock = join(home, LOCK_FILE); writeFileSync(registryLock, "synthetic lock", { mode: 0o600 });
    expect(() => submitProposal(home, { vault: "test", operation }, { channel: "mcp" })).toThrow("registry lock is unavailable");
    expect(readFileSync(registryLock, "utf8")).toBe("synthetic lock"); rmSync(registryLock);
    expect(() => submitProposal(home, { vault: "test", operation: { ...operation, body: "password: syntheticsecret" } }, { channel: "mcp" })).toThrow("screening refused");
    expect(readdirSync(join(store, bucket))).toEqual(stored);
    const listed = listProposals(home, { vault: "test" }, { channel: "mcp" });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ id: result.id, state: "pending" });
    expect(JSON.stringify(listed)).not.toContain("Synthetic body");
    const longBody = operation.body.replace("Synthetic body.", `Contact synthetic@example.invalid. 한글 ${'"'.repeat(14500)}`);
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
    expect(previewProposalReject(home, { vault: "test", id: second.id, reason: "x".repeat(4096) }, { channel: "mcp" }).fingerprint).toHaveLength(64);
    setVaultPii(home, "test", { email: "warn" }, true);
    expect(listProposals(home, { vault: "test" }, { channel: "mcp" }).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "V07", severity: "warning" })]));
    expect(showProposal(home, { vault: "test", id: second.id }, { channel: "mcp" }).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "V07", severity: "warning" })]));
    expect(previewProposalReject(home, { vault: "test", id: second.id, reason: "not needed" }, { channel: "mcp" }).issues).toEqual([]);
    setVaultPii(home, "test", "deny", true);
    const screenedList = listProposals(home, { vault: "test" }, { channel: "mcp" });
    expect(screenedList.items.map(item => item.id)).toEqual([result.id]);
    expect(screenedList.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PROPOSAL_SKIPPED", message: expect.stringContaining(second.id) })]));
    expect(() => showProposal(home, { vault: "test", id: second.id }, { channel: "mcp" })).toThrow("disclosure policy");
    const rejectHidden = previewProposalReject(home, { vault: "test", id: second.id, reason: "not needed" }, { channel: "mcp" });
    expect(rejectProposal(home, { vault: "test", id: second.id, reason: "not needed", fingerprint: rejectHidden.fingerprint }, { channel: "mcp" }).rejected).toBe(true);
    expect(listProposals(home, { vault: "test" }, { channel: "mcp" }).issues.some(issue => issue.code === "PROPOSAL_SKIPPED")).toBe(false);
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
    const rebound = listProposals(home, { vault: "test" }, { channel: "mcp" });
    expect(rebound.items).toEqual([]);
    expect(rebound.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PROPOSAL_ORPHANED_BINDING" })]));
    expect(() => showProposal(home, { vault: "test", id: result.id }, { channel: "mcp" })).toThrow("root identity changed");
    const newRecord = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    expect(newRecord).toMatchObject({ ok: true, stored: true });
    expect(newRecord.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PROPOSAL_ORPHANED_BINDING" })]));
    expect(() => showProposal(home, { vault: "test", id: result.id }, { channel: "mcp" })).toThrow("id not found");
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
    const registryLock = join(home, LOCK_FILE); writeFileSync(registryLock, "synthetic lock", { mode: 0o600 });
    expect(applyProposalWrite(home, request, { binding, proposal: decision }).applied).toBe(false);
    expect(readFileSync(registryLock, "utf8")).toBe("synthetic lock");
    expect(readStoredProposal(home, bindingDigest, record.id).state).toBe("pending");
    rmSync(registryLock);
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
    expect(after.state).toBe("applied");
    expect(after.intent).toMatchObject({ fingerprint, beforeSha: null, afterSha: applied.changes[0]!.sha256 });
    expect(after.receipt).toMatchObject({ applied: true, afterSha: applied.changes[0]!.sha256 });
    expect(readStoredProposal(home, bindingDigest, record.id)).toEqual(after);
    expect(applyProposalWrite(home, request, { binding, proposal: decision }).applied).toBe(false);
    expect(() => previewProposalApply(home, { vault: "test", id: record.id }, { channel: "mcp" })).toThrow("no longer pending");
    const second = submitProposal(home, { vault: "test", operation: { ...input, path: "precrash", body: input.body.replace("Proposed", "Precrash") } }, { channel: "mcp" });
    const pending = readStoredProposal(home, bindingDigest, second.id);
    withFixtureLock(home, fd => replaceStoredProposal(home, bindingDigest, second.id, proposalRecordDigest(pending), { ...pending, state: "apply_unknown", intent: { fingerprint: "a".repeat(64), beforeSha: null, afterSha: "b".repeat(64) } }, [], fd));
    expect(reconcileProposal(home, { vault: "test", id: second.id }, { channel: "mcp" })).toMatchObject({ state: "apply_unknown", observedSha: null, matchesBefore: true, matchesAfter: false, receiptEvidence: "unavailable" });
    withFixtureLock(home, fd => createStoredEvidence(home, { schemaVersion: 1, id: second.id, bindingDigest, fingerprint: "a".repeat(64), beforeSha: null, afterSha: "b".repeat(64), applied: false, publicationStarted: true, logged: null }, [], fd));
    expect(reconcileProposal(home, { vault: "test", id: second.id }, { channel: "mcp" })).toMatchObject({ state: "apply_unknown", matchesBefore: true, receiptEvidence: "available", proposedState: null, fingerprint: null });
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

test("applied receipt is saved without a second registry lock acquisition", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-finalize-lock-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
    const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    const preview = previewProposalApply(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
    const fixture = join(import.meta.dir, "fixtures", "proposal-finish-lock.ts"), child = Bun.spawnSync([process.execPath, fixture, home, submitted.id, preview.fingerprint], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toMatchObject({ ok: true, applied: true, state: "applied" });
    expect(existsSync(join(notes, "proposed.md"))).toBe(true);
    expect(() => applyProposal(home, { vault: "test", id: submitted.id, fingerprint: preview.fingerprint }, { channel: "mcp" })).toThrow("no longer pending");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("policy drift after publication does not reopen a newly denied record", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-finish-policy-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
    const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    const preview = previewProposalApply(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
    const binding = readdirSync(join(home, "proposals")).find(name => /^[a-f0-9]{64}$/.test(name))!, recordFile = join(home, "proposals", binding, `${submitted.id}.json`);
    const fixture = join(import.meta.dir, "fixtures", "proposal-finish-policy.ts"), child = Bun.spawnSync([process.execPath, fixture, home, submitted.id, preview.fingerprint, recordFile], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toMatchObject({ result: { ok: false, applied: true, state: "applied" }, deniedOpens: 0 });
    expect(existsSync(join(notes, "proposed.md"))).toBe(true);
    expect(() => reconcileProposal(home, { vault: "test", id: submitted.id }, { channel: "mcp" })).toThrow("storage path is denied");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejection binds the reason and target without changing notes or log", () => {
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
    const registryLock = join(home, LOCK_FILE); writeFileSync(registryLock, "synthetic lock", { mode: 0o600 });
    expect(rejectProposal(home, { vault: "test", id: submitted.id, reason: "not needed", fingerprint: preview.fingerprint }, { channel: "mcp" }).rejected).toBe(false);
    expect(readFileSync(registryLock, "utf8")).toBe("synthetic lock"); rmSync(registryLock);
    const wrongReason = rejectProposal(home, { vault: "test", id: submitted.id, reason: "different", fingerprint: preview.fingerprint }, { channel: "mcp" });
    expect(wrongReason.rejected).toBe(false);
    writeFileSync(research, `${original}\nchanged\n`);
    const rejected = rejectProposal(home, { vault: "test", id: submitted.id, reason: "not needed", fingerprint: preview.fingerprint }, { channel: "mcp" });
    expect(rejected).toMatchObject({ ok: true, rejected: true });
    expect(readFileSync(research, "utf8")).toBe(`${original}\nchanged\n`);
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
    const noOp = { op: "patch", path: "research", expectedSha: sha256(original), edits: [{ oldString: "# Research", newString: "# Research" }] };
    expect(() => submitProposal(home, { vault: "test", operation: noOp }, { channel: "mcp" })).toThrow("no note change");
    expect(existsSync(join(home, "proposals"))).toBe(false);
    const operation = { op: "patch", path: "research", expectedSha: sha256(original), edits: [{ oldString: "# Research", newString: "# Research revised" }] };
    const submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    const changed = `${original}\nexternal edit\n`; writeFileSync(research, changed);
    expect(() => previewProposalApply(home, { vault: "test", id: submitted.id }, { channel: "mcp" })).toThrow("preview refused");
    const preview = previewProposalReject(home, { vault: "test", id: submitted.id, reason: "superseded" }, { channel: "mcp" });
    const changedAgain = `${changed}second edit\n`; writeFileSync(research, changedAgain);
    expect(rejectProposal(home, { vault: "test", id: submitted.id, reason: "superseded", fingerprint: preview.fingerprint }, { channel: "mcp" }).rejected).toBe(false);
    const fresh = previewProposalReject(home, { vault: "test", id: submitted.id, reason: "superseded" }, { channel: "mcp" });
    expect(rejectProposal(home, { vault: "test", id: submitted.id, reason: "superseded", fingerprint: fresh.fingerprint }, { channel: "mcp" })).toMatchObject({ ok: true, rejected: true });
    expect(readFileSync(research, "utf8")).toBe(changedAgain);
    expect(existsSync(join(vaultPath, "log"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejection confirmation returns current PII warning for the reason", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-reject-warn-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp", pii: { email: "warn" } });
    const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" }), reason = "Contact synthetic@example.invalid";
    const preview = previewProposalReject(home, { vault: "test", id: submitted.id, reason }, { channel: "mcp" });
    expect(preview.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "V07", severity: "warning" })]));
    const result = rejectProposal(home, { vault: "test", id: submitted.id, reason, fingerprint: preview.fingerprint }, { channel: "mcp" });
    expect(result).toMatchObject({ ok: true, rejected: true });
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "V07", severity: "warning" })]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("near-limit proposals preserve a maximum-length rejection reason", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-reason-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp", pii: { email: "warn" } });
    const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: `# Proposed\n\n${'"'.repeat(14500)}\n\n## Topics\n\n- [[research]]\n` };
    const address = "synthetic@example.invalid", submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" }), reason = `${address} ${'"'.repeat(4096 - Buffer.byteLength(address) - 1)}`;
    const preview = previewProposalReject(home, { vault: "test", id: submitted.id, reason }, { channel: "mcp" });
    expect(preview.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "V07", severity: "warning" })]));
    const result = rejectProposal(home, { vault: "test", id: submitted.id, reason, fingerprint: preview.fingerprint }, { channel: "mcp" });
    expect(result).toMatchObject({ ok: true, rejected: true });
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "V07", severity: "warning" })]));
    const binding = readdirSync(join(home, "proposals")).find(name => /^[a-f0-9]{64}$/.test(name))!, record = readStoredProposal(home, binding, submitted.id);
    expect(record.decisionReasonRef).toHaveLength(64);
    expect(Buffer.byteLength(encodeProposalRecord(record))).toBeLessThanOrEqual(32 * 1024);
    const shown = showProposal(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
    expect(shown.decisionReason).toBe(reason);
    expect(shown.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "V07", severity: "warning" })]));
    expect(proposalReplyBytes(shown)).toBeLessThanOrEqual(48 * 1024);
    expect(listProposals(home, { vault: "test", state: "rejected" }, { channel: "mcp" }).items.map(item => item.id)).toEqual([submitted.id]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("changed evidence source or vault policy invalidates an apply preview", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-evidence-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(root, "workspace.config.yaml"), "name: synthetic\n");
    const registry = join(root, "projects.yaml"); writeFileSync(registry, "projects: []\n");
    const source = join(notes, "research.md"), original = "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n";
    writeFileSync(source, original);
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp", registry });
    const reference = "vault/notes/research.md", operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"], source: [reference], evidence: [{ source: reference, sha256: sha256(original), quote: "# Research" }] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    expect(submitted.issues.some(issue => issue.code === "EVIDENCE")).toBe(false);
    const incorrect = { ...operation, path: "incorrect", frontmatter: { ...operation.frontmatter, evidence: [{ source: reference, sha256: "0".repeat(64), quote: "# Research" }] }, body: operation.body.replace("Proposed", "Incorrect") };
    const wrongHash = submitProposal(home, { vault: "test", operation: incorrect }, { channel: "mcp" });
    expect(wrongHash.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "EVIDENCE", message: expect.stringContaining("stale") })]));
    expect(previewProposalApply(home, { vault: "test", id: wrongHash.id }, { channel: "mcp" }).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "EVIDENCE", message: expect.stringContaining("stale") })]));
    const missingQuote = { ...incorrect, path: "missing-quote", frontmatter: { ...operation.frontmatter, evidence: [{ source: reference, sha256: sha256(original), quote: "not in the source" }] }, body: operation.body.replace("Proposed", "Missing Quote") };
    expect(submitProposal(home, { vault: "test", operation: missingQuote }, { channel: "mcp" }).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "EVIDENCE", message: expect.stringContaining("missing") })]));
    const preview = previewProposalApply(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
    writeFileSync(source, `${original}\nchanged source\n`);
    expect(applyProposal(home, { vault: "test", id: submitted.id, fingerprint: preview.fingerprint }, { channel: "mcp" }).applied).toBe(false);
    expect(existsSync(join(notes, "proposed.md"))).toBe(false);
    writeFileSync(source, original);
    const fresh = previewProposalApply(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
    setVaultPii(home, "test", "deny", true);
    expect(applyProposal(home, { vault: "test", id: submitted.id, fingerprint: fresh.fingerprint }, { channel: "mcp" }).applied).toBe(false);
    expect(existsSync(join(notes, "proposed.md"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("patch proposals verify the target note's existing evidence at submit and preview", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-patch-evidence-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(root, "workspace.config.yaml"), "name: synthetic\n");
    const registry = join(root, "projects.yaml"); writeFileSync(registry, "projects: []\n");
    const source = "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n";
    writeFileSync(join(notes, "research.md"), source);
    const reference = "vault/notes/research.md", evidence = [{ source: reference, sha256: "0".repeat(64), quote: "# Research" }];
    const note = `---\ntype: insight\ndomain: research\ndescription: Synthetic citation.\ntopics: ["[[research]]"]\nsource: ${JSON.stringify([reference])}\nevidence: ${JSON.stringify(evidence)}\n---\n# Citation\n\nOriginal body.\n\n## Topics\n\n- [[research]]\n`;
    writeFileSync(join(notes, "citation.md"), note);
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp", registry });
    const operation = { op: "patch", path: "citation", expectedSha: sha256(note), edits: [{ oldString: "Original body.", newString: "Revised body." }] };
    const submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    expect(submitted.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "EVIDENCE", message: expect.stringContaining("stale") })]));
    const preview = previewProposalApply(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
    expect(preview.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "EVIDENCE", message: expect.stringContaining("stale") })]));
    expect(JSON.stringify(preview.issues)).not.toContain("# Research");
    expect(readFileSync(join(notes, "citation.md"), "utf8")).toBe(note);
    expect(existsSync(join(vaultPath, "log"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("newly denied store metadata is refused before the file is opened", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-deny-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
    const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    const binding = readdirSync(join(home, "proposals")).find(name => /^[a-f0-9]{64}$/.test(name))!;
    const config = loadRegistry(home); config.denyPaths = [join(home, "proposals", binding, "binding.json")];
    writeFileSync(join(home, CONFIG_FILE), JSON.stringify(config));
    const fixture = join(import.meta.dir, "fixtures", "proposal-denied.ts"), child = Bun.spawnSync([process.execPath, fixture, home], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({ refused: true, opens: 0 });
    expect(() => showProposal(home, { vault: "test", id: submitted.id }, { channel: "mcp" })).toThrow("storage path is denied");
    config.denyPaths = [join(home, "proposals", binding, `${submitted.id}.json`)];
    writeFileSync(join(home, CONFIG_FILE), JSON.stringify(config));
    const recordChild = Bun.spawnSync([process.execPath, fixture, home, `${submitted.id}.json`], { stdout: "pipe", stderr: "pipe" });
    expect(recordChild.exitCode).toBe(0);
    expect(JSON.parse(recordChild.stdout.toString())).toEqual({ refused: false, opens: 0 });
    expect(listProposals(home, { vault: "test" }, { channel: "mcp" }).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PROPOSAL_SKIPPED", message: expect.stringContaining(submitted.id) })]));
    expect(() => showProposal(home, { vault: "test", id: submitted.id }, { channel: "mcp" })).toThrow("storage path is denied");
    expect(existsSync(join(notes, "proposed.md"))).toBe(false);
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
      expect(review).toMatchObject({ state: "apply_unknown", receiptEvidence: mode === "before-receipt" ? "available" : "unavailable", matchesBefore: mode === "before", matchesAfter: mode !== "before" });
      if (mode === "before-receipt") {
        expect(review.proposedState).toBe("applied"); expect(review.fingerprint).not.toBeNull();
        // The killed fixture owns these fake locks; simulate an operator's recovery in the isolated home.
        rmSync(join(home, LOCK_FILE)); rmSync(join(vaultPath, "mutation.lock"));
        const target = join(notes, "proposed.md"), original = readFileSync(target, "utf8");
        writeFileSync(target, `${original}\nexternal edit\n`);
        expect(() => confirmProposalReconciliation(home, { vault: "test", id: submitted.id, fingerprint: review.fingerprint! }, { channel: "mcp" })).toThrow("evidence is unavailable or changed");
        writeFileSync(target, original);
        const fresh = reconcileProposal(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
        expect(confirmProposalReconciliation(home, { vault: "test", id: submitted.id, fingerprint: fresh.fingerprint! }, { channel: "mcp" })).toMatchObject({ ok: true, resolved: true, state: "applied" });
      } else expect(review.fingerprint).toBeNull();
    }
    const finalState = persisted || mode === "before-receipt" ? "applied" : "apply_unknown";
    expect(() => applyProposal(home, { vault: "test", id: submitted.id, fingerprint: preview.fingerprint }, { channel: "mcp" })).toThrow(finalState === "applied" ? "no longer pending" : "outcome is unknown");
    expect(readStoredProposal(home, bindingDigest, submitted.id).state).toBe(finalState);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("receipt-backed pre-publication failure can be explicitly returned to pending", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-prepublication-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
    const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    const preview = previewProposalApply(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures", "proposal-fail-before.ts"), home, vaultPath, submitted.id, preview.fingerprint], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toMatchObject({ ok: false, applied: false, state: "apply_unknown" });
    const review = reconcileProposal(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
    expect(review).toMatchObject({ receiptEvidence: "available", proposedState: "pending", matchesBefore: true });
    expect(confirmProposalReconciliation(home, { vault: "test", id: submitted.id, fingerprint: review.fingerprint! }, { channel: "mcp" })).toMatchObject({ ok: true, resolved: true, state: "pending" });
    expect(existsSync(join(notes, "proposed.md"))).toBe(false);
    expect(previewProposalApply(home, { vault: "test", id: submitted.id }, { channel: "mcp" }).state).toBe("pending");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an ambiguous publication error remains unknown even when the after hash matches", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-ambiguous-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
    const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    const preview = previewProposalApply(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures", "proposal-fail-after-rename.ts"), home, vaultPath, submitted.id, preview.fingerprint], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toMatchObject({ ok: false, applied: null, state: "apply_unknown" });
    expect(existsSync(join(notes, "proposed.md"))).toBe(true);
    const review = reconcileProposal(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
    expect(review).toMatchObject({ receiptEvidence: "available", matchesAfter: true, proposedState: null, fingerprint: null });
    expect(() => confirmProposalReconciliation(home, { vault: "test", id: submitted.id, fingerprint: "a".repeat(64) }, { channel: "mcp" })).toThrow("evidence is unavailable or changed");
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
    const successes = results.filter(result => result.applied).length;
    expect(successes).toBeLessThanOrEqual(1);
    expect(existsSync(join(notes, "proposed.md"))).toBe(successes === 1);
    if (successes) expect(readFileSync(join(vaultPath, "log"), "utf8").trim().split("\n")).toHaveLength(1);
    else expect(existsSync(join(vaultPath, "log"))).toBe(false);
    const bindingDigest = readdirSync(join(home, "proposals")).find(name => /^[a-f0-9]{64}$/.test(name))!;
    const state = readStoredProposal(home, bindingDigest, submitted.id).state;
    expect(successes ? ["applied", "apply_unknown"] : ["pending", "apply_unknown"]).toContain(state);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("concurrent apply and rejection cannot both succeed", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-decision-race-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
  try {
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
    const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
    const submitted = submitProposal(home, { vault: "test", operation }, { channel: "mcp" });
    const applied = previewProposalApply(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
    const rejected = previewProposalReject(home, { vault: "test", id: submitted.id, reason: "not needed" }, { channel: "mcp" });
    const a = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "proposal-apply.ts"), home, submitted.id, applied.fingerprint], { stdout: "pipe", stderr: "pipe" });
    const b = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "proposal-reject.ts"), home, submitted.id, "not needed", rejected.fingerprint], { stdout: "pipe", stderr: "pipe" });
    const outputs = await Promise.all([a, b].map(async child => ({ code: await child.exited, text: await new Response(child.stdout).text(), error: await new Response(child.stderr).text() })));
    for (const output of outputs) expect(output.code).toBe(0);
    const applyResult = JSON.parse(outputs[0]!.text) as { applied: boolean }, rejectResult = JSON.parse(outputs[1]!.text) as { rejected: boolean };
    const successes = Number(applyResult.applied) + Number(rejectResult.rejected);
    expect(successes).toBeLessThanOrEqual(1);
    expect(existsSync(join(notes, "proposed.md"))).toBe(applyResult.applied);
    expect(existsSync(join(vaultPath, "log"))).toBe(applyResult.applied);
    const bindingDigest = readdirSync(join(home, "proposals")).find(name => /^[a-f0-9]{64}$/.test(name))!;
    const state = readStoredProposal(home, bindingDigest, submitted.id).state;
    expect(applyResult.applied ? ["applied", "apply_unknown"] : rejectResult.rejected ? ["rejected"] : ["pending", "apply_unknown"]).toContain(state);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a concurrent submit cannot strand an applied proposal after publication", async () => {
  for (let round = 0; round < 10; round++) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-proposal-submit-race-"))), home = join(root, "home"), vaultPath = join(root, "vault"), notes = join(vaultPath, "notes");
    try {
      mkdirSync(notes, { recursive: true });
      writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
      addVault(home, { id: "test", path: vaultPath, kind: "personal", write: "mcp" });
      const op = (path: string) => ({ op: "create", path, frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: `# ${path}\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n` });
      const submitted = submitProposal(home, { vault: "test", operation: op("first") }, { channel: "mcp" });
      const preview = previewProposalApply(home, { vault: "test", id: submitted.id }, { channel: "mcp" });
      const apply = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "proposal-apply.ts"), home, submitted.id, preview.fingerprint], { stdout: "pipe", stderr: "pipe" });
      const submit = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "proposal-submit.ts"), home, JSON.stringify(op("second"))], { stdout: "pipe", stderr: "pipe" });
      const outputs = await Promise.all([apply, submit].map(async child => ({ code: await child.exited, text: await new Response(child.stdout).text(), error: await new Response(child.stderr).text() })));
      for (const output of outputs) expect(output.code).toBe(0);
      const applied = JSON.parse(outputs[0]!.text) as { applied: boolean; state?: string };
      const binding = readdirSync(join(home, "proposals")).find(name => /^[a-f0-9]{64}$/.test(name))!, record = readStoredProposal(home, binding, submitted.id);
      if (applied.applied) { expect(record.state).toBe("applied"); expect(applied.state).toBe("applied"); }
      else expect(existsSync(join(notes, "first.md"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
