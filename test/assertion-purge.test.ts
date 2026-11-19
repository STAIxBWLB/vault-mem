import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { assertFrameBytes, appendAssertions, evaluateAssertions, purgeAssertions, readJournal, type PurgeReceipt } from "../src/assertions.ts";
import { assertionIndexPath } from "../src/assertion-index.ts";
import { readAssertions } from "../src/assertion-read.ts";
import { run } from "../src/cli.ts";
import { CONFIG_FILE } from "../src/config.ts";
import { serveMcp } from "../src/mcp.ts";
import { createVaultMcp, purgeReply } from "../src/mcp-vault.ts";
import { addVault, loadRegistry } from "../src/registry.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
/** A value that must not survive a purge in any file vmem writes for reads. */
const CANARY = "purge-canary-9c41ab7e";

function fixture(options: { write?: "mcp" | "cli" | "none" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-assertion-purge-"))); roots.push(root);
  const home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(root, "workspace.config.yaml"), "name: fixture\n");
  writeFileSync(join(notes, "subject.md"), "---\nstatus: active\ntype: note\n---\n# Subject\n");
  addVault(home, { id: "test", path: vault, kind: "personal", write: options.write ?? "cli", registry: join(root, "projects.yaml") });
  const env = { HOME: root, VMEM_HOME: home, PATH: process.env.PATH };
  const append = (ops: unknown[], date = "2026-01-01T12:00:00Z") => appendAssertions(home, { vault: "test", ops, channel: "cli" }, { env, now: new Date(date) });
  return { root, home, vault, notes, env, append, journal: () => readJournal(vault) };
}
type Fixture = ReturnType<typeof fixture>;

/** One declared subject with one assertion whose value carries the canary; returns the assertion id and its segment file. */
function seed(f: Fixture): { id: string; segment: string } {
  const receipt = f.append([{ op: "declare", subject: "s:test", note: "notes/subject.md" },
    { op: "assert", subject: "s:test", relation: "role", value: CANARY, kind: "state", from: "2025-01-01", to: "open", source: ["mem:fixture"] }]);
  expect(receipt.issues.filter(issue => issue.severity === "error")).toEqual([]);
  const id = receipt.entries[1]!.id!;
  return { id, segment: join(f.vault, "assertions", `${receipt.segment!}.jsonl`) };
}
const heads = (f: Fixture, id: string) => {
  const items = evaluateAssertions(f.journal()).items.filter(item => item.id === id);
  return items[0]?.heads ?? items.map(item => item.hash);
};
const purge = (f: Fixture, request: Record<string, unknown>): PurgeReceipt => purgeAssertions(f.home, { vault: "test", channel: "cli", ...request } as never, { env: f.env });
const preview = (f: Fixture, id: string) => JSON.parse(run(["assertions", "purge", "test", id, "--reason", "evidence_withdrawn", "--json"], f.env).text) as PurgeReceipt;
const confirm = (f: Fixture, id: string, fingerprint: string) => JSON.parse(run(["assertions", "purge", "test", id, "--reason", "evidence_withdrawn", "--confirm", "--fingerprint", fingerprint, "--json"], f.env).text) as PurgeReceipt;
const coldes = (receipt: PurgeReceipt) => receipt.issues.map(issue => issue.code);

test("T12: a preview writes nothing, and confirm removes the payload while the chain still verifies", () => {
  const f = fixture();
  const { id, segment } = seed(f);
  // Seed the derived index, so the preview and the confirm both run against a cache that holds the value.
  expect(readAssertions(f.home, { vault: "test" }, { env: f.env }).coverage.purged).toBe(0);
  const before = readFileSync(segment);

  const planned = preview(f, id);
  expect(planned).toMatchObject({ ok: true, preview: true, applied: false, vault: "test", assertion: id, reason: "evidence_withdrawn", alreadyPurged: 0, omitted: 0 });
  expect(planned.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(planned.entries.map(entry => entry.op)).toEqual(["assert"]);
  expect(planned.segments).toEqual([{ segment: planned.entries[0]!.segment, entries: 1, bytes: before.length, after: before.length }]);
  expect(readFileSync(segment).equals(before)).toBe(true);
  expect(existsSync(join(f.vault, "assertions.lock"))).toBe(false);

  const applied = confirm(f, id, planned.fingerprint);
  expect(applied).toMatchObject({ ok: true, preview: false, applied: true, assertion: id, reason: "evidence_withdrawn" });
  expect(applied.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(applied.segments[0]!.after).toBeLessThan(before.length);

  const after = readFileSync(segment, "utf8");
  expect(after).not.toContain(CANARY);
  expect(after).toContain('"purged":{"at":');
  const journal = readJournal(f.vault);
  expect(journal.segments.flatMap(segment => segment.untrusted ?? [])).toEqual([]);
  expect(journal.segments.flatMap(segment => segment.unsupported ?? [])).toEqual([]);
  const entry = journal.segments.flatMap(segment => segment.entries).find(item => item.hash === applied.entries[0]!.hash)!;
  expect(entry.payload).toBeUndefined();
  expect(entry.purged).toEqual({ at: applied.at!, reason: "evidence_withdrawn" });
  expect(entry.payload_sha256).toMatch(/^[0-9a-f]{64}$/);

  const answer = readAssertions(f.home, { vault: "test" }, { env: f.env });
  expect(answer.coverage.purged).toBe(1);
  expect(answer.items.map(item => item.id)).not.toContain(id);
  expect(readAssertions(f.home, { vault: "test", subject: "s:test" }, { env: f.env }).items).toEqual([]);
  expect(readAssertions(f.home, { vault: "test", relation: "role" }, { env: f.env }).items).toEqual([]);
  const history = readAssertions(f.home, { vault: "test", history: true }, { env: f.env }).items.find(item => item.id === id)!;
  expect(history).toMatchObject({ purged: true, availability: "unavailable" });
  expect(JSON.stringify(history)).not.toContain(CANARY);
  expect(existsSync(join(f.vault, "assertions.lock"))).toBe(false);
});

test("the derived index carries the payload before a purge and none of it afterwards", () => {
  const f = fixture();
  const { id } = seed(f);
  readAssertions(f.home, { vault: "test" }, { env: f.env });
  const index = assertionIndexPath(f.home, f.vault);
  expect(readFileSync(index, "utf8")).toContain(CANARY);

  const applied = confirm(f, id, preview(f, id).fingerprint);
  expect(applied.ok && applied.applied).toBe(true);
  expect(existsSync(index)).toBe(true);
  expect(readFileSync(index, "utf8")).not.toContain(CANARY);
  expect(readAssertions(f.home, { vault: "test" }, { env: f.env }).coverage.indexIssue).toBeUndefined();
});

test("U2: a purge that cannot write its temporary file leaves the segment intact and a retry finishes it", () => {
  const f = fixture();
  const { id, segment } = seed(f);
  const planned = preview(f, id), before = readFileSync(segment), dir = join(f.vault, "assertions");
  chmodSync(dir, 0o555);
  try {
    const refused = confirm(f, id, planned.fingerprint);
    expect(refused.ok).toBe(false);
    expect(refused.applied).toBe(false);
    expect(coldes(refused)).toEqual(["IO"]);
    expect(readFileSync(segment).equals(before)).toBe(true);
    expect(existsSync(join(f.vault, "assertions.lock"))).toBe(false);
  } finally { chmodSync(dir, 0o755); }
  // The journal never changed, so the fingerprint the interrupted attempt used still confirms.
  const retried = confirm(f, id, planned.fingerprint);
  expect(retried).toMatchObject({ ok: true, applied: true });
  expect(readFileSync(segment, "utf8")).not.toContain(CANARY);
  expect(readAssertions(f.home, { vault: "test" }, { env: f.env }).coverage.purged).toBe(1);
});

test("a stale fingerprint is refused, and the fresh preview confirms", () => {
  const f = fixture();
  const { id } = seed(f);
  const planned = preview(f, id);
  const revised = f.append([{ op: "revise", id, expected_heads: heads(f, id), value: "chair", kind: "state", from: "2025-06-01", to: "open", source: ["mem:fixture"] }], "2026-02-01T00:00:00Z");
  expect(revised.ok).toBe(true);

  const stale = confirm(f, id, planned.fingerprint);
  expect(stale.ok).toBe(false);
  expect(coldes(stale)).toEqual(["V09"]);
  expect(stale.issues[0]!.message).toContain("Run vmem assertions purge test");
  expect(readFileSync(join(f.vault, "assertions", `${planned.entries[0]!.segment}.jsonl`), "utf8")).toContain(CANARY);

  const fresh = preview(f, id);
  expect(fresh.entries.map(entry => entry.op)).toEqual(["assert", "revise"]);
  expect(confirm(f, id, fresh.fingerprint)).toMatchObject({ ok: true, applied: true });
});

test("purge refusals: already purged, a bad reason or id, unmatched two-step flags and an unverified segment", () => {
  const f = fixture();
  const { id } = seed(f);
  expect(confirm(f, id, preview(f, id).fingerprint)).toMatchObject({ ok: true, applied: true });
  const again = purge(f, { id, reason: "evidence_withdrawn" });
  expect(again.ok).toBe(false);
  expect(coldes(again)).toEqual(["V01"]);
  expect(again.issues[0]!.message).toContain("is already purged");

  const noReason = purge(f, { id, reason: "" });
  expect(noReason.ok).toBe(false);
  expect(noReason.issues[0]!.message).toContain("reason must be 1..200 characters");
  expect(purge(f, { id, reason: "x".repeat(201) }).issues[0]!.code).toBe("V01");
  expect(purge(f, { id: "a:nothex:1", reason: "evidence_withdrawn" }).issues[0]!.message).toContain("assertion id must look like");
  expect(purge(f, { id, reason: "evidence_withdrawn", confirm: true }).issues[0]!.message).toContain("confirm needs the fingerprint");
  expect(purge(f, { id, reason: "evidence_withdrawn", fingerprint: "0".repeat(64) }).issues[0]!.message).toContain("a fingerprint is only used with confirm");
  expect(purge(f, { id, reason: "evidence_withdrawn", confirm: true, fingerprint: "abc" }).issues[0]!.message).toContain("64-character");
  expect(purge(f, { id, reason: "evidence_withdrawn", extra: true }).issues[0]!.message).toContain("unknown purge option");
  expect(purge(f, { id: "a:0123456789abcdef:99", reason: "evidence_withdrawn" }).issues[0]!.message).toContain("no verified journal entry belongs to");

  const broken = fixture();
  const target = seed(broken);
  const path = target.segment, lines = readFileSync(path, "utf8").split("\n");
  lines[0] = lines[0]!.replace('"channel":"cli"', '"channel":"mcp"');
  writeFileSync(path, lines.join("\n"));
  const unverified = purge(broken, { id: target.id, reason: "evidence_withdrawn" });
  expect(unverified.ok).toBe(false);
  expect(coldes(unverified)).toEqual(["V09"]);
  expect(unverified.issues[0]!.message).toContain("fails verification");
});

test("the write policy and denyPaths refuse a purge before anything is read or written", () => {
  const closed = fixture();
  const { id } = seed(closed);
  const shut = loadRegistry(closed.home);
  shut.vaults[0]!.write = "none";
  writeFileSync(join(closed.home, CONFIG_FILE), JSON.stringify(shut));
  const policy = purge(closed, { id, reason: "evidence_withdrawn" });
  expect(policy.ok).toBe(false);
  expect(coldes(policy)).toEqual(["POLICY"]);
  expect(policy.issues[0]!.message).toContain("refuses assertion purges over cli");

  const cliOnly = fixture({ write: "cli" });
  const other = seed(cliOnly);
  const overMcp = purgeAssertions(cliOnly.home, { vault: "test", id: other.id, reason: "evidence_withdrawn", channel: "mcp" }, { env: cliOnly.env });
  expect(coldes(overMcp)).toEqual(["POLICY"]);
  expect(overMcp.issues[0]!.message).toContain("refuses assertion purges over mcp");
  expect(readFileSync(other.segment, "utf8")).toContain(CANARY);

  const denied = fixture();
  const hidden = seed(denied);
  const config = loadRegistry(denied.home);
  config.denyPaths = [join(denied.vault, "assertions")];
  writeFileSync(join(denied.home, CONFIG_FILE), JSON.stringify(config));
  const refused = purge(denied, { id: hidden.id, reason: "evidence_withdrawn" });
  expect(coldes(refused)).toEqual(["V06"]);
  expect(readFileSync(hidden.segment, "utf8")).toContain(CANARY);
});

test("MCP: vmem_assertions_purge previews and confirms inside the frame bound, with destructiveHint", async () => {
  const f = fixture({ write: "mcp" });
  const receipt = await (async () => {
    const { appendAssertions: append } = await import("../src/assertions.ts");
    return append(f.home, { vault: "test", channel: "mcp", ops: [{ op: "declare", subject: "s:test", note: "notes/subject.md" },
      { op: "assert", subject: "s:test", relation: "role", value: CANARY, kind: "state", from: "2025-01-01", to: "open", source: ["mem:fixture"] }] }, { env: f.env, now: new Date("2026-01-01T12:00:00Z") });
  })();
  expect(receipt.ok).toBe(true);
  const id = receipt.entries[1]!.id!;
  const server = createVaultMcp(f.home, f.env), input = new PassThrough(), output = new PassThrough();
  const tool = server.tools.find(value => value.name === "vmem_assertions_purge")!;
  expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  let text = ""; output.on("data", chunk => { text += chunk.toString(); });
  const done = serveMcp({ tools: server.tools, handlers: server.handlers, input, output });
  const call = (args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: "purge", method: "tools/call", params: { name: "vmem_assertions_purge", arguments: { vault: "test", id, reason: "evidence_withdrawn", ...args } } });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  input.write(JSON.stringify(call({})) + "\n");
  input.end(); await done;
  const reply = JSON.parse(text.trim().split("\n")[1]!) as { result: { content: { text: string }[] } };
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(48 * 1024);
  const planned = JSON.parse(reply.result.content[0]!.text) as PurgeReceipt & { refused?: true };
  expect(planned).toMatchObject({ ok: true, preview: true, assertion: id });
  expect(planned.refused).toBeUndefined();

  const second = createVaultMcp(f.home, f.env), nextInput = new PassThrough(), nextOutput = new PassThrough();
  let nextText = ""; nextOutput.on("data", chunk => { nextText += chunk.toString(); });
  const nextDone = serveMcp({ tools: second.tools, handlers: second.handlers, input: nextInput, output: nextOutput });
  for (const frame of [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    call({ confirm: true, fingerprint: planned.fingerprint })]) nextInput.write(JSON.stringify(frame) + "\n");
  nextInput.end(); await nextDone;
  const applied = JSON.parse(JSON.parse(nextText.trim().split("\n")[1]!).result.content[0]!.text) as PurgeReceipt;
  expect(applied).toMatchObject({ ok: true, applied: true, assertion: id, at: applied.at });
  expect(assertFrameBytes(applied, "result")).toBeLessThanOrEqual(48 * 1024);
  expect(readFileSync(join(f.vault, "assertions", `${planned.entries[0]!.segment}.jsonl`), "utf8")).not.toContain(CANARY);
});

test("a purge reason is length-checked by the verifier's rule and screened like any write", () => {
  const f = fixture();
  const { id, segment } = seed(f);
  // 150 emoji are 300 UTF-16 units, the unit `purgeShape` counts: refused, so no marker verification rejects is written.
  const long = purge(f, { id, reason: "😀".repeat(150) });
  expect(long.ok).toBe(false);
  expect(coldes(long)).toEqual(["V01"]);
  expect(long.issues[0]!.message).toContain("1..200 characters");
  expect(readFileSync(segment, "utf8")).toContain(CANARY);
  // 100 emoji are exactly the 200-unit limit, and the rewritten segment still verifies.
  const planned = purge(f, { id, reason: "😀".repeat(100) });
  expect(planned.ok).toBe(true);
  const applied = purge(f, { id, reason: "😀".repeat(100), confirm: true, fingerprint: planned.fingerprint });
  expect(applied).toMatchObject({ ok: true, applied: true });
  const journal = readJournal(f.vault);
  expect(journal.segments.flatMap(segment => segment.untrusted ?? [])).toEqual([]);
  expect(journal.segments.flatMap(segment => segment.entries).find(entry => entry.hash === applied.entries[0]!.hash)!.purged!.reason).toBe("😀".repeat(100));

  const secret = fixture();
  const hidden = seed(secret);
  const refused = purge(secret, { id: hidden.id, reason: "token: abcdefghijklmnop" });
  expect(refused.ok).toBe(false);
  expect(coldes(refused)).toEqual(["V06"]);
  expect(refused.issues[0]!.message).toContain("reason is refused by current policy");
  expect(refused.issues[0]!.message).toContain("give a reason without secrets or personal data");
  expect(readFileSync(hidden.segment, "utf8")).toContain(CANARY);

  const personal = fixture();
  const tagged = seed(personal);
  const config = loadRegistry(personal.home);
  config.vaults[0]!.pii = "deny";
  writeFileSync(join(personal.home, CONFIG_FILE), JSON.stringify(config));
  const pii = purge(personal, { id: tagged.id, reason: "asked by person@example.test" });
  expect(pii.ok).toBe(false);
  expect(coldes(pii)).toEqual(["V07"]);
  expect(readFileSync(tagged.segment, "utf8")).toContain(CANARY);
});

test("MCP: an oversized purge request is refused on the frame, and an oversized reply drops its rows", async () => {
  const f = fixture({ write: "mcp" });
  const { appendAssertions: append } = await import("../src/assertions.ts");
  const receipt = append(f.home, { vault: "test", channel: "mcp", ops: [{ op: "declare", subject: "s:test", note: "notes/subject.md" },
    { op: "assert", subject: "s:test", relation: "role", value: CANARY, kind: "state", from: "2025-01-01", to: "open", source: ["mem:fixture"] }] }, { env: f.env, now: new Date("2026-01-01T12:00:00Z") });
  const id = receipt.entries[1]!.id!;
  const server = createVaultMcp(f.home, f.env), input = new PassThrough(), output = new PassThrough();
  let text = ""; output.on("data", chunk => { text += chunk.toString(); });
  const done = serveMcp({ tools: server.tools, handlers: server.handlers, input, output });
  const call = (args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: "purge", method: "tools/call", params: { name: "vmem_assertions_purge", arguments: { vault: "test", id, reason: "evidence_withdrawn", ...args } } });
  for (const frame of [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    call({ pad: "x".repeat(60 * 1024) }),
    call({ pad: "x" })]) input.write(JSON.stringify(frame) + "\n");
  input.end(); await done;
  const [wide, narrow] = text.trim().split("\n").slice(1).map(line => JSON.parse(line) as { error?: { code: number; message: string } });
  expect(wide!.error?.code).toBe(-32600);
  expect(wide!.error?.message).toContain("exceeds 48 KiB");
  expect(narrow!.error?.code).toBe(-32602);

  const rows = Array.from({ length: 100 }, (_, index) => ({ segment: "0123456789abcdef", seq: index + 1, op: "assert" as const, hash: "a".repeat(64) }));
  const segments = Array.from({ length: 100 }, (_, index) => ({ segment: `${index}`.padStart(16, "0"), entries: 1, bytes: 4096, after: 2048 }));
  const reply = purgeReply({ ok: true, applied: true, preview: false, vault: "test", assertion: id, reason: "evidence_withdrawn", at: "2026-01-02T00:00:00Z", fingerprint: "b".repeat(64),
    entries: rows, segments, alreadyPurged: 0, omitted: 0, recovery: segments.map(segment => `dropped 2048 unverified bytes after seq 1 of segment ${segment.segment} ${"x".repeat(560)}`), issues: [] });
  expect(assertFrameBytes(reply, "result")).toBeLessThanOrEqual(48 * 1024);
  const trimmed = reply as PurgeReceipt & { issues: { code: string; message: string }[] };
  expect(trimmed).toMatchObject({ ok: true, applied: true, assertion: id });
  expect(trimmed.issues.map(issue => issue.code)).toContain("LIMIT");
  expect(trimmed.issues.find(issue => issue.code === "LIMIT")!.message).toContain("were rewritten by this confirm");
  expect(readFileSync(join(f.vault, "assertions", `${receipt.segment!}.jsonl`), "utf8")).toContain(CANARY);
});
