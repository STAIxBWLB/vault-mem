import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CONFIG_FILE } from "../src/config.ts";
import { addVault, loadRegistry } from "../src/registry.ts";
import { appendAssertions, assertFrameBytes, ASSERT_FRAME_BYTES, ASSERTIONS_LOCK, asOfCutoff, evaluateAssertions, readJournal, type Answer, type AssertReceipt, type AssertionAnswerSet, type VerifiedJournal } from "../src/assertions.ts";
import { run } from "../src/cli.ts";
import { argumentError, FRAME_BYTES, serveMcp } from "../src/mcp.ts";
import { assertReply, createVaultMcp } from "../src/mcp-vault.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}` : JSON.stringify(value);
/** Rewrite one segment line and recompute its chained hash, so a forgery is a valid chain on its own. */
function rehash(entry: Record<string, unknown>): string {
  const { hash: _hash, payload: _payload, purged: _purged, ...hashed } = entry;
  return canonical({ ...entry, hash: sha(canonical(hashed)) });
}
const CORPUS = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/temporal-design/corpus.json"), "utf8")) as {
  batches: { entry: string; now: string; ops: Record<string, unknown>[] }[];
  scenario3: { columns: string[]; rows: Record<string, (Answer | undefined)[]> };
};
const SOURCE = "---\ndescription: Synthetic source.\ntype: reference\n---\n# Source\n\n## Decisions\n\nmoves to lead on April 1\n";

/** Isolated workspace root, home and vault; no real notes or credentials. */
function fixture(options: { write?: "mcp" | "cli" | "none"; id?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-assert-"))); roots.push(root);
  const home = join(root, "state"), vault = join(root, "vault"), notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(root, "workspace.config.yaml"), "name: fixture\n");
  writeFileSync(join(root, "projects.yaml"), "projects: []\n");
  writeFileSync(join(notes, "src-note.md"), SOURCE);
  const id = options.id ?? "mine";
  addVault(home, { id, path: vault, kind: "personal", write: options.write ?? "mcp", registry: join(root, "projects.yaml") });
  const env = { HOME: root, VMEM_HOME: home, AGENTHUB_HOME: join(root, "family"), AMEM_HOME: join(root, "memory"), PATH: process.env.PATH };
  const append = (ops: unknown, now: string, extra: Record<string, unknown> = {}) => appendAssertions(home, { vault: id, ops, ...extra }, { env, now: new Date(now) });
  const journal = () => readJournal(vault);
  return { root, home, vault, notes, env, id, append, journal };
}
type Fixture = ReturnType<typeof fixture>;
const ok = (receipt: AssertReceipt) => { expect(receipt.issues.filter(i => i.severity === "error")).toEqual([]); expect(receipt.ok).toBe(true); return receipt; };
function heads(f: Fixture, id: string): string[] {
  const answer = evaluateAssertions(f.journal());
  const found = answer.items.filter(item => item.id === id);
  return found[0]?.heads ?? found.map(item => item.hash);
}
/** Append the corpus batches E1..E5 through the write contract; returns label -> assertion id. */
function loadCorpus(f: Fixture): Record<string, string> {
  const ids: Record<string, string> = {};
  writeFileSync(join(f.notes, "person-a.md"), "---\nstatus: active\n---\nPerson A\n");
  writeFileSync(join(f.notes, "onboarding-2025-09.md"), "joins as member\n");
  for (const batch of CORPUS.batches) {
    const ops = batch.ops.map(raw => {
      const { label: _label, ...op } = raw;
      if (typeof op.id === "string" && op.id.startsWith("$")) { const id = ids[op.id.slice(1)]!; return { ...op, id, expected_heads: heads(f, id) }; }
      return op;
    });
    const receipt = ok(f.append(ops, batch.now));
    batch.ops.forEach((raw, index) => { if (typeof raw.label === "string") ids[raw.label] = receipt.entries[index]!.id; });
  }
  return ids;
}
/** Drive the real stdio transport, so a bound is measured on the frames as they are sent and returned. */
async function mcpSession(home: string, env: NodeJS.ProcessEnv, frames: (string | object)[]) {
  const server = createVaultMcp(home, env), input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.on("data", chunk => { text += chunk.toString(); });
  const done = serveMcp({ tools: server.tools, handlers: server.handlers, input, output });
  const init = [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, { jsonrpc: "2.0", method: "notifications/initialized" }];
  for (const frame of [...init, ...frames]) input.write((typeof frame === "string" ? frame : JSON.stringify(frame)) + "\n");
  input.end(); await done;
  return text.trim().split("\n").map(line => JSON.parse(line) as { error?: { code: number; message: string }; result?: { content: { text: string }[] } }).slice(1);
}
const pick = (answer: AssertionAnswerSet, id: string) => answer.items.filter(item => item.id === id);
const yes = (answer: AssertionAnswerSet) => answer.items.filter(item => item.answer === "yes").map(item => item.value);

test("T1 corpus: Q1 to Q10 and the scenario 3 grid through the evaluation function", () => {
  const f = fixture(), ids = loadCorpus(f), journal = f.journal(), q = (at: string, asOf?: string, relation = "role") => evaluateAssertions(journal, { at, subject: "s:person-a", relation, ...(asOf ? { asOf } : {}) });
  expect(ids.A0).toMatch(/^a:[0-9a-f]{16}:2$/);
  // Q1/Q2: late recording, differ only in as_of.
  const q1 = q("2026-04-05", "2026-04-06");
  expect(yes(q1)).toEqual(["member"]); expect(pick(q1, ids.A0!)[0]).toMatchObject({ rev: 1, answer: "yes" });
  const q2 = q("2026-04-05", "2026-04-11");
  expect(yes(q2)).toEqual(["lead"]); expect(pick(q2, ids.A1!)[0]).toMatchObject({ rev: 1, answer: "yes" }); expect(pick(q2, ids.A0!)[0]).toMatchObject({ rev: 2, answer: "no" });
  // Q3: from inclusive, to exclusive on the change day.
  expect(yes(q("2026-04-01", "2026-04-11"))).toEqual(["lead"]);
  // Q4: a date as_of covers the whole UTC day; an instant is inclusive.
  const q4 = q("2026-04-05", "2026-04-10");
  expect(yes(q4)).toEqual(["lead"]); expect(q4.asOf).toEqual({ requested: "2026-04-10", cutoff: "2026-04-11T00:00:00Z", cutoffInclusive: false });
  expect(yes(q("2026-04-05", "2026-04-10T08:59:59Z"))).toEqual(["member"]);
  expect(yes(q("2026-04-05", "2026-04-10T09:00:00Z"))).toEqual(["lead"]);
  // Q5: before the first entry.
  const q5 = q("2026-04-05", "2025-09-01");
  expect(q5.items).toEqual([]); expect(q5.coverage.beforeFirstEntry).toBe(true);
  // Q6/Q7: correction.
  expect(yes(q("2026-03-30", "2026-04-11"))).toEqual(["member"]);
  const q7 = q("2026-03-30", "2026-05-03");
  expect(yes(q7)).toEqual(["lead"]); expect(pick(q7, ids.A1!)[0]).toMatchObject({ rev: 2 }); expect(pick(q7, ids.A0!)[0]).toMatchObject({ rev: 3, answer: "no" });
  // Q8: history of A1 keeps both revisions with recorded and replaced times.
  const q8 = evaluateAssertions(journal, { history: true }).items.filter(item => item.id === ids.A1);
  expect(q8.map(item => [item.rev, item.from, item.recordedAt, item.replacedAt])).toEqual([[1, "2026-04-01", "2026-04-10T09:00:00Z", "2026-05-02T09:00:00Z"], [2, "2026-03-28", "2026-05-02T09:00:00Z", null]]);
  // Scenario 3 grid, as_of omitted.
  for (const [at, row] of Object.entries(CORPUS.scenario3.rows)) {
    const answer = evaluateAssertions(journal, { at });
    expect(CORPUS.scenario3.columns.map(label => pick(answer, ids[label]!)[0]?.answer)).toEqual(row);
  }
  // Q9/Q10: coexisting values, no winner.
  const q9 = q("2026-05-20", undefined, "team");
  expect(yes(q9).sort()).toEqual(["platform", "research"]);
  expect(q9.overlaps).toEqual([{ subject: "s:person-a", relation: "team", ids: [ids.A8!, ids.A9!] }]);
  const q10 = q("2026-05-10", undefined, "team");
  expect(yes(q10)).toEqual(["platform"]); expect(q10.overlaps).toEqual([]);
  // Without at: no world-time filter and no answer field.
  expect(evaluateAssertions(journal, {}).items.every(item => item.answer === undefined)).toBe(true);
});

test("T2 boundaries: from inclusive, to exclusive, date and instant cutoffs, before_first_entry", () => {
  const f = fixture();
  const r = ok(f.append([{ op: "declare", subject: "s:x" }, { op: "assert", subject: "s:x", relation: "role", value: "v", kind: "state", from: "2026-01-10", to: "2026-01-20", source: ["mem:t2"] }], "2026-02-01T23:59:59Z"));
  const id = r.entries[1]!.id, j = f.journal(), at = (d: string, asOf?: string) => pick(evaluateAssertions(j, { at: d, ...(asOf ? { asOf } : {}) }), id)[0]?.answer;
  expect([at("2026-01-09"), at("2026-01-10"), at("2026-01-19"), at("2026-01-20")]).toEqual(["no", "yes", "yes", "no"]);
  expect(at("2026-01-15", "2026-02-01")).toBe("yes");
  expect(at("2026-01-15", "2026-02-01T23:59:59Z")).toBe("yes");
  expect(at("2026-01-15", "2026-02-01T23:59:58Z")).toBeUndefined();
  expect(evaluateAssertions(j, { asOf: "2026-01-31" }).coverage.beforeFirstEntry).toBe(true);
  expect(() => evaluateAssertions(j, { asOf: "2026-02-30" })).toThrow(/as_of must be/);
  expect(() => evaluateAssertions(j, { at: "2026-1-5" })).toThrow(/at must be a civil date/);
});

test("T3 precision: distinct answers, held_on, refusal of always-unknown and unsatisfiable bounds", () => {
  const f = fixture(), now = "2026-06-01T00:00:00Z";
  ok(f.append([{ op: "declare", subject: "s:p" }], now));
  const one = (fields: Record<string, unknown>) => f.append([{ op: "assert", subject: "s:p", relation: "r", value: "v", source: ["mem:t3"], ...fields }], now);
  const held = ok(one({ kind: "state", from: "unknown", to: "2026-06-01", held_on: "2026-02-15" })).entries[0]!.id;
  const j = f.journal(), at = (d: string) => pick(evaluateAssertions(j, { at: d }), held)[0]?.answer;
  expect([at("2026-02-14"), at("2026-02-15"), at("2026-05-31"), at("2026-06-01")]).toEqual(["unknown", "yes", "yes", "no"]);
  for (const [fields, pattern] of [
    [{ kind: "state", from: "unknown", to: "open" }, /unknown on every day/],
    [{ kind: "state", from: "unknown", to: "unknown" }, /unknown on every day/],
    [{ kind: "state", from: "2026-05-01", to: "2026-04-01" }, /no start before end/],
    [{ kind: "state", from: "2026-05", to: "2026-05-01" }, /no start before end/],
    [{ kind: "state", from: "2026-01-01", to: "2026-03-01", held_on: "2026-04-01" }, /no start before end/],
    [{ kind: "event", on: "unknown" }, /on cannot be unknown or open/],
    [{ kind: "event", on: "2026-02-30" }, /on must be a date value/],
    [{ kind: "state", from: "2026-01-01" }, /needs both from and to/],
    [{ kind: "event", on: "2026", from: "2026-01-01" }, /an event takes on/],
  ] as const) {
    const refused = one(fields);
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]!.message).toMatch(pattern);
  }
});

test("T4 no latest-wins: overlap groups, concurrent heads, partial and full expected_heads, retraction in the conflict set", () => {
  const f = fixture(), now = "2026-06-01T00:00:00Z";
  const a = ok(f.append([{ op: "declare", subject: "s:a" }, { op: "assert", subject: "s:a", relation: "team", value: "one", kind: "state", from: "2026-01-01", to: "open", source: ["mem:t4"] }], now)).entries[1]!.id;
  const root = heads(f, a);
  // Clone B: a second home writes its own segment. It must not see A's revision yet (no sync), so A's segment is
  // moved aside while B appends and restored afterwards, as a later sync would bring it in.
  const homeB = join(f.root, "state-b");
  addVault(homeB, { id: "mine", path: f.vault, kind: "personal", write: "mcp", registry: join(f.root, "projects.yaml") });
  const revise = (home: string, value: string, expected: string[], at: string) => appendAssertions(home, { vault: "mine", ops: [{ op: "revise", id: a, expected_heads: expected, value, kind: "state", from: "2026-01-01", to: "open", source: ["mem:t4"] }] }, { env: f.env, now: new Date(at) });
  const dir = join(f.vault, "assertions"), [segA] = readdirSync(dir), copyA = readFileSync(join(dir, segA!));
  const unsynced = <T>(work: () => T): T => { const now = readFileSync(join(dir, segA!)); writeFileSync(join(dir, segA!), copyA); try { return work(); } finally { writeFileSync(join(dir, segA!), now); } };
  ok(revise(f.home, "two", root, "2026-06-02T00:00:00Z"));
  ok(unsynced(() => revise(homeB, "three", root, "2026-06-02T00:00:01Z")));
  expect(readdirSync(join(f.vault, "assertions")).length).toBe(2);
  const conflict = evaluateAssertions(f.journal(), { at: "2026-03-01" });
  const items = pick(conflict, a);
  expect(items.map(item => item.value).sort()).toEqual(["three", "two"]);
  expect(items.every(item => item.revisionConflict === true && item.answer === "yes" && item.heads?.length === 2)).toBe(true);
  const both = items[0]!.heads!;
  // A revision naming only one head is refused, naming the heads and the next step.
  const partial = revise(f.home, "four", [both[0]!], "2026-06-03T00:00:00Z");
  expect(partial.ok).toBe(false);
  expect(partial.issues[0]).toMatchObject({ code: "STALE_HEADS" });
  expect(partial.issues[0]!.message).toContain("re-read the assertion and resend with every head");
  // A concurrent retraction head joins the conflict set; revision heads are still answered.
  const retractB = appendAssertions(homeB, { vault: "mine", ops: [{ op: "retract", id: a, expected_heads: [both.find(h => pick(conflict, a).find(i => i.hash === h)?.value === "three")!], reason: "other" }] }, { env: f.env, now: new Date("2026-06-03T00:00:01Z") });
  expect(retractB.ok).toBe(false); // B's view still sees both heads, so a partial set is refused.
  // Resolve with both heads, then the assertion has one head again.
  ok(revise(f.home, "five", both, "2026-06-04T00:00:00Z"));
  const resolved = pick(evaluateAssertions(f.journal(), { at: "2026-03-01" }), a);
  expect(resolved).toHaveLength(1); expect(resolved[0]).toMatchObject({ value: "five", rev: 3 }); expect(resolved[0]!.revisionConflict).toBeUndefined();
  // Concurrent retraction: both clones act on the same single head before either syncs the other.
  const single = heads(f, a);
  const segB = readdirSync(dir).find(name => name !== segA)!, copyB = readFileSync(join(dir, segB));
  ok(appendAssertions(homeB, { vault: "mine", ops: [{ op: "retract", id: a, expected_heads: single, reason: "recorded_in_error" }] }, { env: f.env, now: new Date("2026-06-05T00:00:00Z") }));
  const retracted = readFileSync(join(dir, segB));
  writeFileSync(join(dir, segB), copyB);
  ok(revise(f.home, "six", single, "2026-06-05T00:00:01Z"));
  writeFileSync(join(dir, segB), retracted);
  const mixed = pick(evaluateAssertions(f.journal(), { at: "2026-03-01" }), a);
  expect(mixed).toHaveLength(1);
  expect(mixed[0]).toMatchObject({ value: "six", revisionConflict: true, answer: "yes" });
  expect(mixed[0]!.heads).toHaveLength(2);
  // A revise naming both (revision and retraction) heads resolves it; the assertion is not treated as retracted.
  ok(revise(f.home, "seven", mixed[0]!.heads!, "2026-06-06T00:00:00Z"));
  expect(pick(evaluateAssertions(f.journal(), { at: "2026-03-01" }), a)[0]).toMatchObject({ value: "seven" });
});

test("T5 correction and retraction: earlier cutoffs keep earlier answers; retracted and stale revisions refused", () => {
  const f = fixture();
  const a = ok(f.append([{ op: "declare", subject: "s:a" }, { op: "assert", subject: "s:a", relation: "role", value: "x", kind: "state", from: "2026-01-01", to: "open", source: ["mem:t5"] }], "2026-02-01T00:00:00Z")).entries[1]!.id;
  const first = heads(f, a);
  ok(f.append([{ op: "revise", id: a, expected_heads: first, value: "x", kind: "state", from: "2026-01-01", to: "2026-03-01", source: ["mem:t5"] }], "2026-03-05T00:00:00Z"));
  const stale = f.append([{ op: "revise", id: a, expected_heads: first, value: "y", kind: "state", from: "2026-01-01", to: "open", source: ["mem:t5"] }], "2026-03-06T00:00:00Z");
  expect(stale.issues[0]).toMatchObject({ code: "STALE_HEADS" });
  ok(f.append([{ op: "retract", id: a, expected_heads: heads(f, a), reason: "recorded_in_error" }], "2026-04-01T00:00:00Z"));
  const j = f.journal();
  expect(pick(evaluateAssertions(j, { at: "2026-04-15", asOf: "2026-03-01" }), a)[0]).toMatchObject({ rev: 1, answer: "yes" });
  expect(pick(evaluateAssertions(j, { at: "2026-04-15", asOf: "2026-03-31" }), a)[0]).toMatchObject({ rev: 2, answer: "no" });
  expect(pick(evaluateAssertions(j, { at: "2026-02-15", asOf: "2026-04-01" }), a)).toEqual([]);
  expect(pick(evaluateAssertions(j, { history: true }), a).map(item => item.op)).toEqual(["assert", "revise", "retract"]);
  const after = f.append([{ op: "revise", id: a, expected_heads: [pick(evaluateAssertions(j, { history: true }), a)[2]!.hash], value: "z", kind: "state", from: "2026-01-01", to: "open", source: ["mem:t5"] }], "2026-04-02T00:00:00Z");
  expect(after.ok).toBe(false); expect(after.issues[0]!.message).toContain("is retracted; assert a new id instead");
});

test("T6 clock independence: note dates, mtimes, Git dates and confidence change no answer", () => {
  const f = fixture(), ids = loadCorpus(f);
  const before = JSON.stringify(evaluateAssertions(f.journal(), { at: "2026-04-05", asOf: "2026-04-11" }));
  writeFileSync(join(f.notes, "person-a.md"), "---\ncreated: 2020-01-01\nupdated: 2030-01-01\nconfidence: low\n---\n# A\n");
  for (const name of readdirSync(join(f.vault, "assertions"))) utimesSync(join(f.vault, "assertions", name), new Date("2001-01-01"), new Date("2001-01-01"));
  utimesSync(join(f.notes, "src-note.md"), new Date("2040-01-01"), new Date("2040-01-01"));
  expect(JSON.stringify(evaluateAssertions(f.journal(), { at: "2026-04-05", asOf: "2026-04-11" }))).toBe(before);
  expect(ids.A0).toBeDefined();
});

test("T7 tamper evidence: edits, reorder, removal and recorded_at changes mark that entry and later ones untrusted", () => {
  const variants: [string, (lines: string[]) => string[]][] = [
    ["edited value", lines => lines.map((line, i) => i === 2 ? line.replace('"value":"b"', '"value":"z"') : line)],
    ["reordered", lines => [lines[0]!, lines[1]!, lines[3]!, lines[2]!, ...lines.slice(4)]],
    ["removed middle", lines => [lines[0]!, lines[1]!, ...lines.slice(3)]],
    ["recorded_at", lines => lines.map((line, i) => i === 2 ? line.replace(/"recorded_at":"[^"]+"/, '"recorded_at":"2026-01-02T00:00:00Z"') : line)],
  ];
  for (const [name, mutate] of variants) {
    const f = fixture();
    ok(f.append([{ op: "declare", subject: "s:t" }, { op: "assert", subject: "s:t", relation: "r", value: "a", kind: "state", from: "2026", to: "open", source: ["mem:a"] }], "2026-01-01T00:00:00Z"));
    ok(f.append([{ op: "assert", subject: "s:t", relation: "r", value: "b", kind: "state", from: "2026", to: "open", source: ["mem:b"] }], "2026-01-03T00:00:00Z"));
    ok(f.append([{ op: "assert", subject: "s:t", relation: "r", value: "c", kind: "state", from: "2026", to: "open", source: ["mem:c"] }], "2026-01-04T00:00:00Z"));
    const [file] = readdirSync(join(f.vault, "assertions")), path = join(f.vault, "assertions", file!);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    writeFileSync(path, mutate(lines).join("\n") + "\n");
    const answer = evaluateAssertions(f.journal(), {});
    expect([name, answer.coverage.untrusted[0]?.seq]).toEqual([name, 3]);
    expect([name, answer.items.map(item => item.value)]).toEqual([name, ["a"]]);
  }
});

test("T7 recovery: torn tail and partial batch are ignored, then truncated on the next append; writer record detects truncation", () => {
  const f = fixture();
  ok(f.append([{ op: "declare", subject: "s:t" }, { op: "assert", subject: "s:t", relation: "r", value: "a", kind: "state", from: "2026", to: "open", source: ["mem:a"] }], "2026-01-01T00:00:00Z"));
  const [file] = readdirSync(join(f.vault, "assertions")), path = join(f.vault, "assertions", file!);
  const good = readFileSync(path);
  appendFileSync(path, '{"v":1,"seg":"tor');
  let answer = evaluateAssertions(f.journal(), {});
  expect(answer.coverage.tornTail).toEqual([file!.slice(0, 16)]); expect(answer.items).toHaveLength(1);
  expect(run(["assertions", f.id], f.env).text).toContain("torn journal tail");
  const fixed = ok(f.append([{ op: "assert", subject: "s:t", relation: "r", value: "b", kind: "state", from: "2026", to: "open", source: ["mem:b"] }], "2026-01-02T00:00:00Z"));
  expect(fixed.recovery[0]).toMatch(/truncated 17 bytes after seq 2 .*torn tail/);
  expect(readFileSync(path).subarray(0, good.length).equals(good)).toBe(true);
  // Partial batch: a crash after the first line of a two-line batch, before the writer record was updated.
  const size = statSync(path).size, writer = join(f.home, "assertion-writers", "mine.json"), record = readFileSync(writer);
  ok(f.append([{ op: "assert", subject: "s:t", relation: "r", value: "c", kind: "state", from: "2026", to: "open", source: ["mem:c"] }, { op: "assert", subject: "s:t", relation: "r", value: "d", kind: "state", from: "2026", to: "open", source: ["mem:d"] }], "2026-01-03T00:00:00Z"));
  const full = readFileSync(path, "utf8"), cut = full.indexOf("\n", size) + 1;
  writeFileSync(path, full.slice(0, cut)); writeFileSync(writer, record);
  answer = evaluateAssertions(f.journal(), {});
  expect(answer.coverage.partialBatch).toEqual([{ segment: file!.slice(0, 16), seq: 4, entries: 1, size: 2 }]);
  expect(answer.items.map(item => item.value)).toEqual(["a", "b"]);
  const again = ok(f.append([{ op: "assert", subject: "s:t", relation: "r", value: "e", kind: "state", from: "2026", to: "open", source: ["mem:e"] }], "2026-01-04T00:00:00Z"));
  expect(again.recovery[0]).toMatch(/partial batch/);
  expect(evaluateAssertions(f.journal(), {}).items.map(item => item.value)).toEqual(["a", "b", "e"]);
  // Truncation to a valid prefix: the writer record notices, and the next append starts a new segment.
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  writeFileSync(path, lines.slice(0, 3).join("\n") + "\n");
  const moved = ok(f.append([{ op: "assert", subject: "s:t", relation: "r", value: "f", kind: "state", from: "2026", to: "open", source: ["mem:f"] }], "2026-01-05T00:00:00Z"));
  expect(moved.recovery[0]).toMatch(/truncation detected, started a new segment/);
  expect(moved.segment).not.toBe(file!.slice(0, 16));
});

test("T8 clock: regression refused with CLOCK and nothing appended; synced inverted revisions use the parent's effective time", () => {
  const f = fixture();
  const a = ok(f.append([{ op: "declare", subject: "s:c" }, { op: "assert", subject: "s:c", relation: "r", value: "a", kind: "state", from: "2026", to: "open", source: ["mem:a"] }], "2026-05-01T00:00:00Z")).entries[1]!.id;
  const [file] = readdirSync(join(f.vault, "assertions")), before = readFileSync(join(f.vault, "assertions", file!));
  const back = f.append([{ op: "assert", subject: "s:c", relation: "r", value: "b", kind: "state", from: "2026", to: "open", source: ["mem:b"] }], "2026-04-30T23:59:59Z");
  expect(back.issues[0]).toMatchObject({ code: "CLOCK" }); expect(back.issues[0]!.message).toContain("wait until after 2026-05-01T00:00:00Z");
  expect(readFileSync(join(f.vault, "assertions", file!)).equals(before)).toBe(true);
  // Clone B, behind the parent recorded by clone A: refused locally.
  const homeB = join(f.root, "state-b");
  addVault(homeB, { id: "mine", path: f.vault, kind: "personal", write: "mcp", registry: join(f.root, "projects.yaml") });
  const behind = appendAssertions(homeB, { vault: "mine", ops: [{ op: "revise", id: a, expected_heads: heads(f, a), value: "b", kind: "state", from: "2026", to: "open", source: ["mem:b"] }] }, { env: f.env, now: new Date("2026-04-01T00:00:00Z") });
  expect(behind.issues[0]).toMatchObject({ code: "CLOCK" });
  expect(readdirSync(join(f.vault, "assertions"))).toHaveLength(1);
  // A synced entry from a skewed clone: forge one by appending later, then rewriting its own segment is not possible
  // (hashes), so build it with a clock check bypass: a separate vault whose segment is copied in.
  const g = fixture();
  ok(g.append([{ op: "declare", subject: "s:c" }], "2026-01-01T00:00:00Z"));
  const skewHome = join(g.root, "state-skew");
  addVault(skewHome, { id: "mine", path: f.vault, kind: "personal", write: "mcp", registry: join(f.root, "projects.yaml") });
  // Clone C writes at a correct time, then its segment is replayed with a skewed clock by constructing it in g.
  const parentHash = heads(f, a)[0]!;
  const forged = appendAssertions(skewHome, { vault: "mine", ops: [{ op: "revise", id: a, expected_heads: [parentHash], value: "b", kind: "state", from: "2026", to: "open", source: ["mem:b"] }] }, { env: f.env, now: new Date("2026-05-02T00:00:00Z") });
  ok(forged);
  // Rewrite clone C's segment as if its clock had said 2026-04-20: rehash its only entry (a valid chain on its own).
  const segC = forged.segment!, pathC = join(f.vault, "assertions", `${segC}.jsonl`);
  const entry = JSON.parse(readFileSync(pathC, "utf8")) as Record<string, unknown>;
  entry.recorded_at = "2026-04-20T00:00:00Z";
  writeFileSync(pathC, rehash(entry) + "\n");
  const j = f.journal();
  const current = pick(evaluateAssertions(j, {}), a)[0]!;
  expect(current).toMatchObject({ value: "b", clockInverted: true, recordedAt: "2026-04-20T00:00:00Z", effectiveRecordedAt: "2026-05-01T00:00:00Z" });
  // Never counted at a cutoff before its parent; at the parent's time it is the head.
  expect(pick(evaluateAssertions(j, { asOf: "2026-04-25" }), a)).toEqual([]);
  expect(pick(evaluateAssertions(j, { asOf: "2026-05-01T00:00:00Z" }), a)[0]).toMatchObject({ value: "b" });
});

test("write contract: O2, path evidence verified at append, external sources, screening and policy", () => {
  const f = fixture();
  ok(f.append([{ op: "declare", subject: "s:e" }], "2026-01-01T00:00:00Z"));
  const assert = (fields: Record<string, unknown>) => f.append([{ op: "assert", subject: "s:e", relation: "r", value: "v", kind: "state", from: "2026", to: "open", ...fields }], "2026-01-02T00:00:00Z");
  expect(assert({}).issues[0]!.message).toContain("owner decision O2");
  const verified = ok(assert({ evidence: [{ source: "vault/notes/src-note.md", sha256: sha(SOURCE), quote: "moves to lead on April 1", section: "Decisions" }] }));
  const line = readFileSync(join(f.vault, "assertions", `${verified.segment}.jsonl`), "utf8").trim().split("\n").at(-1)!;
  expect(JSON.parse(line).payload.evidence[0].status).toBe("verified");
  const bare = assert({ evidence: [{ source: "notes/src-note.md", sha256: sha(SOURCE), quote: "moves to lead" }] });
  expect(bare.issues[0]).toMatchObject({ code: "EVIDENCE" }); expect(bare.issues[0]!.message).toMatch(/missing \(source_not_found\); re-read/);
  const stale = assert({ evidence: [{ source: "vault/notes/src-note.md", sha256: "0".repeat(64), quote: "moves to lead" }] });
  expect(stale.issues[0]!.message).toMatch(/stale \(sha_mismatch\)/);
  const external = ok(assert({ evidence: [{ source: "https://example.invalid/x", sha256: "1".repeat(64), quote: "q" }] }));
  const ext = readFileSync(join(f.vault, "assertions", `${external.segment}.jsonl`), "utf8").trim().split("\n").at(-1)!;
  expect(JSON.parse(ext).payload.evidence[0].status).toBe("unverified_external");
  expect(assert({ source: ["mem:x"], value: "token=abcdefghijkl" }).issues[0]).toMatchObject({ code: "V06" });
  const unknownField = f.append([{ op: "assert", subject: "s:e", relation: "r", value: "v", kind: "state", from: "2026", to: "open", source: ["mem:x"], recorded_at: "2020-01-01T00:00:00Z" }], "2026-01-03T00:00:00Z");
  expect(unknownField.issues[0]!.message).toContain("vmem assigns ids, times and hashes itself");
  expect(f.append([{ op: "assert", subject: "s:nope", relation: "r", value: "v", kind: "state", from: "2026", to: "open", source: ["mem:x"] }], "2026-01-03T00:00:00Z").issues[0]!.message).toContain("add a declare op");
  // Policy: write=cli refuses MCP, write=none refuses all.
  const cli = fixture({ write: "cli" });
  expect(appendAssertions(cli.home, { vault: "mine", ops: [{ op: "declare", subject: "s:a" }], channel: "mcp" }, { env: cli.env }).issues[0]).toMatchObject({ code: "POLICY" });
  const none = fixture({ write: "none" });
  expect(none.append([{ op: "declare", subject: "s:a" }], "2026-01-01T00:00:00Z").issues[0]).toMatchObject({ code: "POLICY" });
});

test("batch is all-or-nothing, bounded, and a dry run takes no lock and appends nothing", () => {
  const f = fixture();
  const mixed = f.append([{ op: "declare", subject: "s:a" }, { op: "assert", subject: "s:a", relation: "BAD", value: "v", kind: "state", from: "2026", to: "open", source: ["mem:x"] }], "2026-01-01T00:00:00Z");
  expect(mixed.ok).toBe(false); expect(existsSync(join(f.vault, "assertions"))).toBe(false);
  expect(f.append([], "2026-01-01T00:00:00Z").issues[0]!.message).toContain("1..32 operations");
  expect(f.append(Array.from({ length: 33 }, (_, i) => ({ op: "declare", subject: `s:a${i}` })), "2026-01-01T00:00:00Z").issues[0]!.message).toContain("split larger batches");
  // J2: every refusal names its cause and the next step.
  const guided: [Record<string, unknown>[], RegExp][] = [
    [[{ op: "declare", subject: "Person A" }], /write s: then lowercase/],
    [[{ op: "declare", subject: "s:a", label: "x".repeat(201) }], /shorten it and remove control characters/],
    [[{ op: "nope" }], /correct the op name$/],
    [[{ op: "declare", subject: "s:g", note: "notes/a/b.md" }], /cite this vault's note by its notes\/<stem>\.md path$/],
    [[{ op: "declare", subject: "s:g" }, { op: "assert", subject: "s:g", relation: "r", value: "v", kind: "mood", from: "2026", to: "open", source: ["mem:x"] }], /write kind: state with from and to, or kind: event with on$/],
    [[{ op: "declare", subject: "s:g", extra: 1 }], /vmem assigns ids, times and hashes itself$/],
  ];
  expect(mixed.issues[0]!.message).toMatch(/write lowercase letters, digits and hyphens$/);
  for (const [ops, pattern] of guided) expect(f.append(ops, "2026-01-01T00:00:00Z").issues[0]!.message).toMatch(pattern);
  const dry = ok(f.append([{ op: "declare", subject: "s:a" }], "2026-01-01T00:00:00Z", { dryRun: true }));
  expect(dry.dryRun).toBe(true); expect(dry.recordedAt).toBeUndefined();
  expect(existsSync(join(f.vault, "assertions"))).toBe(false); expect(existsSync(join(f.vault, ASSERTIONS_LOCK))).toBe(false);
  // A held lock refuses with guidance and is preserved.
  writeFileSync(join(f.vault, ASSERTIONS_LOCK), "{}\n");
  const locked = f.append([{ op: "declare", subject: "s:a" }], "2026-01-01T00:00:00Z");
  expect(locked.issues[0]).toMatchObject({ code: "LOCKED" }); expect(locked.issues[0]!.message).toMatch(/retry shortly/); expect(existsSync(join(f.vault, ASSERTIONS_LOCK))).toBe(true);
});

test("J3: no note, updated stamp or log line changes unless --log is given", () => {
  const f = fixture(), notes = () => readdirSync(f.notes).map(name => [name, readFileSync(join(f.notes, name), "utf8")]);
  const before = notes();
  ok(f.append([{ op: "declare", subject: "s:a" }], "2026-01-01T00:00:00Z"));
  expect(notes()).toEqual(before); expect(existsSync(join(f.vault, "log"))).toBe(false);
  const logged = ok(f.append([{ op: "declare", subject: "s:b" }], "2026-01-02T00:00:00Z", { log: { type: "LEARN", project: "-", source: "vmem", note: "assertion batch" } }));
  expect(logged.log?.ok).toBe(true);
  expect(readFileSync(join(f.vault, "log"), "utf8")).toContain("assertion batch");
  const badLog = f.append([{ op: "declare", subject: "s:c" }], "2026-01-03T00:00:00Z", { log: { type: "NOPE", project: "-", source: "vmem", note: "x" } });
  expect(badLog.ok).toBe(false); expect(badLog.issues[0]!.message).toContain("log event refused, nothing written");
});

test("CLI and MCP share one implementation; MCP frames stay within 48 KiB", async () => {
  const f = fixture(), batch = join(f.root, "batch.json");
  writeFileSync(batch, JSON.stringify({ ops: [{ op: "declare", subject: "s:a" }, { op: "assert", subject: "s:a", relation: "r", value: "v", kind: "state", from: "2026", to: "open", source: ["mem:x"] }] }));
  const dry = run(["assert", "mine", "--batch", batch, "--dry-run"], f.env);
  expect(dry.code).toBe(0); expect(dry.text).toContain("dry run: 2 operations valid for mine; nothing appended");
  const cli = run(["assert", "mine", "--batch", batch, "--json"], f.env);
  expect(cli.code).toBe(0); expect(JSON.parse(cli.text)).toMatchObject({ ok: true, applied: true, indexUpdated: false });
  const human = run(["assert", "mine", "--batch", batch], f.env);
  expect(human.code).toBe(1); expect(human.text).toContain("assert: refused, nothing appended to mine"); expect(human.text).toContain("already declared");
  expect(() => run(["assert", "mine"], f.env)).toThrow(/--batch FILE\|- is required/);
  const mcp = createVaultMcp(f.home, f.env), tool = mcp.tools.find(t => t.name === "vmem_assert")!;
  expect(tool.annotations.readOnlyHint).toBe(false);
  const args = { vault: "mine", ops: [{ op: "assert", subject: "s:a", relation: "r", value: "w", kind: "state", from: "2026", to: "open", source: ["mem:y"] }] };
  expect(argumentError(args, tool.inputSchema)).toBeUndefined();
  const reply = await mcp.handlers.vmem_assert!(args) as AssertReceipt;
  expect(reply).toMatchObject({ ok: true, applied: true });
  expect(assertFrameBytes(reply, "result")).toBeLessThanOrEqual(ASSERT_FRAME_BYTES);
  // Largest valid batch: 32 declares still answer inside the reply bound.
  const fullReply = await mcp.handlers.vmem_assert!({ vault: "mine", ops: Array.from({ length: 32 }, (_, i) => ({ op: "declare", subject: `s:b${i}`, label: "😀".repeat(200) })) }) as AssertReceipt;
  expect(fullReply.ok).toBe(true);
  expect(assertFrameBytes(fullReply, "result")).toBeLessThanOrEqual(ASSERT_FRAME_BYTES);
});

test("J2: the request bound is measured on the frame as sent, and an oversized reply is trimmed without inviting a replay", async () => {
  const f = fixture();
  ok(f.append([{ op: "declare", subject: "s:a" }], "2026-01-01T00:00:00Z"));
  const before = f.journal().entries, call = (id: number, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "vmem_assert", arguments: args } });
  // The same arguments re-serialized measure far less than the frame the client actually sent.
  const small = { vault: "mine", ops: [{ op: "declare", subject: "s:z" }] }, line = JSON.stringify(call(7, small));
  expect(assertFrameBytes(small)).toBeLessThan(ASSERT_FRAME_BYTES);
  const padded = line + " ".repeat(ASSERT_FRAME_BYTES - Buffer.byteLength(line) + 1);
  expect(Buffer.byteLength(padded) + 1).toBeGreaterThan(ASSERT_FRAME_BYTES);
  expect(Buffer.byteLength(padded) + 1).toBeLessThan(FRAME_BYTES);
  // A real 32-op batch whose evidence pushes the frame itself over the bound is refused the same way.
  const wide = { vault: "mine", ops: Array.from({ length: 32 }, () => ({ op: "assert", subject: "s:a", relation: "r", value: "x".repeat(1000), kind: "state", from: "2026", to: "open", evidence: [{ source: "vault/notes/src-note.md", sha256: sha(SOURCE), quote: "m".repeat(400) }] })) };
  const wideLine = JSON.stringify(call(8, wide));
  expect(Buffer.byteLength(wideLine) + 1).toBeGreaterThan(ASSERT_FRAME_BYTES);
  expect(Buffer.byteLength(wideLine) + 1).toBeLessThan(FRAME_BYTES);
  const [stuffed, oversized, accepted] = await mcpSession(f.home, f.env, [padded, call(8, wide), call(9, { vault: "mine", ops: [{ op: "declare", subject: "s:ok" }] })]);
  for (const refused of [stuffed!, oversized!]) { expect(refused.error).toMatchObject({ code: -32600 }); expect(refused.error!.message).toContain("48 KiB"); }
  expect(JSON.parse(accepted!.result!.content[0]!.text)).toMatchObject({ ok: true, applied: true });
  expect(f.journal().entries).toBe(before + 1);
  // A reply over the bound drops the rows, keeps the fact that the batch is on disk, and never invites a retry.
  const row = (index: number) => ({ seq: index + 1, id: `a:0123456789abcdef:${index + 1}`, rev: 1, op: "assert" as const, hash: "a".repeat(64) });
  const huge: AssertReceipt = { ok: true, applied: true, dryRun: false, segment: "0123456789abcdef", recordedAt: "2026-01-01T00:00:00Z",
    entries: Array.from({ length: 32 }, (_, index) => row(index)), recovery: ["r".repeat(30_000)],
    issues: [{ code: "V01", severity: "error", message: "m".repeat(30_000) }], indexUpdated: false };
  expect(assertFrameBytes(huge, "result")).toBeGreaterThan(ASSERT_FRAME_BYTES);
  const trimmed = assertReply(huge) as AssertReceipt, note = trimmed.issues.at(-1)!;
  expect(trimmed).toMatchObject({ ok: true, applied: true, segment: "0123456789abcdef", entries: [], indexUpdated: false });
  expect(assertFrameBytes(trimmed, "result")).toBeLessThanOrEqual(ASSERT_FRAME_BYTES);
  expect(note).toMatchObject({ code: "LIMIT" });
  expect(note.message).toContain("32 rows were appended to segment 0123456789abcdef");
  expect(note.message).toContain("send smaller batches"); expect(note.message).not.toMatch(/retry/i);
});

test("journal reads are independent of the derived index and report an absent journal", () => {
  const f = fixture();
  const empty: VerifiedJournal = f.journal();
  expect(empty.present).toBe(false);
  expect(evaluateAssertions(empty, { at: "2026-01-01" }).coverage.journal).toBe("absent");
  writeFileSync(join(f.vault, "assertions"), "not a dir");
  expect(() => f.journal()).toThrow(/plain directory/);
});

/** The only segment file of a fixture, and its lines parsed for tampering. */
function segmentOf(f: Fixture): { file: string; lines: string[] } {
  const [name] = readdirSync(join(f.vault, "assertions"));
  const file = join(f.vault, "assertions", name!);
  return { file, lines: readFileSync(file, "utf8").split("\n").filter(Boolean) };
}
/** Re-register the home so one absolute path is denied. */
function denyPath(f: Fixture, path: string): void {
  const config = loadRegistry(f.home); config.denyPaths = [path];
  writeFileSync(join(f.home, CONFIG_FILE), JSON.stringify(config));
}

test("T7: a payload under a purged marker, a malformed marker and a foreign parent are untrusted", async () => {
  const three = (f: Fixture) => {
    ok(f.append([{ op: "declare", subject: "s:p" }, { op: "assert", subject: "s:p", relation: "r", value: "a", kind: "state", from: "2026", to: "open", source: ["mem:p"] }], "2026-01-01T00:00:00Z"));
    ok(f.append([{ op: "assert", subject: "s:p", relation: "r", value: "b", kind: "state", from: "2026", to: "open", source: ["mem:p"] }], "2026-01-03T00:00:00Z"));
    return segmentOf(f);
  };
  const purge = { at: "2026-02-01T00:00:00Z", reason: "evidence_withdrawn" };
  // 1. An edited payload that hides under a purged marker is forged content: neither `purged` nor `payload` is hashed.
  const forged = fixture(), forgedSegment = three(forged), forgedRow = JSON.parse(forgedSegment.lines[2]!) as Record<string, any>;
  forgedRow.payload.value = "FORGED"; forgedRow.purged = purge;
  writeFileSync(forgedSegment.file, [...forgedSegment.lines.slice(0, 2), canonical(forgedRow), ...forgedSegment.lines.slice(3)].join("\n") + "\n");
  const forgedAnswer = evaluateAssertions(forged.journal(), { history: true });
  expect(forgedAnswer.coverage.untrusted).toEqual([{ segment: forgedRow.seg, seq: 3, failedSeq: 3, entries: 1, reason: "a purged entry still carries a payload" }]);
  expect(forgedAnswer.items.some(item => item.value === "FORGED")).toBe(false);
  // 2. A well-formed purge drops only the payload, verifies with the same chain, and is counted as purged.
  const purged = fixture(), purgedSegment = three(purged), purgedRow = JSON.parse(purgedSegment.lines[2]!) as Record<string, any>;
  delete purgedRow.payload; purgedRow.purged = purge;
  writeFileSync(purgedSegment.file, [...purgedSegment.lines.slice(0, 2), canonical(purgedRow)].join("\n") + "\n");
  const purgedAnswer = evaluateAssertions(purged.journal(), { history: true });
  expect(purgedAnswer.coverage.untrusted).toEqual([]); expect(purgedAnswer.coverage.purged).toBe(1);
  expect(purgedAnswer.items.filter(item => item.purged).map(item => item.value)).toEqual([undefined]);
  expect(purgedAnswer.items.filter(item => item.value !== undefined).map(item => item.value)).toEqual(["a"]);
  const { readAssertions } = await import("../src/assertion-read.ts");
  expect(readAssertions(purged.home, { vault: purged.id, history: true }, { env: purged.env }).items.find(item => item.purged)).toMatchObject({ availability: "unavailable", evidence: [{ status: "unavailable" }] });
  // 3. The marker is exactly {at, reason}: a bad instant or an extra key is not a purge.
  for (const [marker, name] of [[{ at: "2026-02-30T00:00:00Z", reason: "other" }, "instant"], [{ ...purge, extra: 1 }, "key"]] as const) {
    const malformed = fixture(), segment = three(malformed), row = JSON.parse(segment.lines[2]!) as Record<string, any>;
    delete row.payload; row.purged = marker;
    writeFileSync(segment.file, [...segment.lines.slice(0, 2), canonical(row)].join("\n") + "\n");
    expect([name, evaluateAssertions(malformed.journal(), {}).coverage.untrusted]).toEqual([name, [{ segment: row.seg, seq: 3, failedSeq: 3, entries: 1, reason: "invalid purged" }]]);
  }
  // 4. A revision naming a parent that belongs to another assertion is untrusted: the named assertion keeps its own
  // head, and the dropped revision leaves its real parent as the head it already was.
  const foreign = fixture();
  const first = ok(foreign.append([{ op: "declare", subject: "s:p" }, { op: "assert", subject: "s:p", relation: "r", value: "a", kind: "state", from: "2026", to: "open", source: ["mem:p"] }], "2026-01-01T00:00:00Z")).entries[1]!.id;
  const other = ok(foreign.append([{ op: "assert", subject: "s:p", relation: "r2", value: "b", kind: "state", from: "2026", to: "open", source: ["mem:p"] }], "2026-01-02T00:00:00Z")).entries[0]!.id;
  ok(foreign.append([{ op: "revise", id: first, expected_heads: heads(foreign, first), value: "c", kind: "state", from: "2026", to: "open", source: ["mem:p"] }], "2026-01-04T00:00:00Z"));
  const segment = segmentOf(foreign), revise = JSON.parse(segment.lines.at(-1)!) as Record<string, any>;
  revise.payload.id = other; revise.payload_sha256 = sha(canonical(revise.payload));
  writeFileSync(segment.file, [...segment.lines.slice(0, -1), rehash(revise)].join("\n") + "\n");
  const answer = evaluateAssertions(foreign.journal(), { history: true });
  expect(answer.coverage.untrusted).toEqual([{ segment: revise.seg, seq: revise.seq, failedSeq: revise.seq, entries: 1, reason: "a parent belongs to another assertion" }]);
  expect(pick(answer, first).map(item => item.value)).toEqual(["a"]); expect(pick(answer, other).map(item => item.value)).toEqual(["b"]);
});

test("write contract: absolute denyPaths refuse, a linked segment is ignored, and a post-write failure keeps applied", () => {
  const f = fixture();
  denyPath(f, join(f.root, "secret"));
  const denied = f.append([{ op: "declare", subject: "s:d" }, { op: "assert", subject: "s:d", relation: "r", value: "v", kind: "state", from: "2026", to: "open", source: ["secret/x.md"] }], "2026-01-01T00:00:00Z");
  expect(denied.issues[0]).toMatchObject({ code: "V06" }); expect(existsSync(join(f.vault, "assertions"))).toBe(false);
  // A segment that is a link is never read: it is reported as ignored and the journal keeps its own entries.
  const g = fixture(), first = ok(g.append([{ op: "declare", subject: "s:l" }], "2026-01-01T00:00:00Z")).segment!;
  const outside = join(g.root, "outside.jsonl");
  writeFileSync(outside, readFileSync(join(g.vault, "assertions", `${first}.jsonl`)));
  symlinkSync(outside, join(g.vault, "assertions", "0123456789abcdef.jsonl"));
  const journal = g.journal();
  expect(journal.ignored).toEqual(["0123456789abcdef.jsonl"]);
  expect(journal.segments.map(report => report.segment)).toEqual([first]);
  expect(journal.entries).toBe(1);
  // A failure after the bytes are in the segment reports the batch as applied and never offers a retry.
  const i = fixture();
  writeFileSync(join(i.home, "assertion-writers"), "not a directory");
  const written = ok(i.append([{ op: "declare", subject: "s:w" }, { op: "assert", subject: "s:w", relation: "r", value: "v", kind: "state", from: "2026", to: "open", source: ["mem:w"] }], "2026-01-01T00:00:00Z"));
  expect(written).toMatchObject({ ok: true, applied: true });
  expect(written.issues[0]).toMatchObject({ code: "WRITER_RECORD", severity: "warning" });
  expect(written.issues[0]!.message).toContain("the batch is appended");
  expect(evaluateAssertions(i.journal(), {}).items.map(item => item.value)).toEqual(["v"]);
});

test.skipIf(process.getuid?.() === 0)("write contract: the lock names its own cause, not another writer", () => {
  const f = fixture();
  chmodSync(f.vault, 0o500);
  try {
    const blocked = f.append([{ op: "declare", subject: "s:k" }], "2026-01-01T00:00:00Z");
    expect(blocked.issues[0]).toMatchObject({ code: "LOCK" });
    expect(blocked.issues[0]!.message).toContain("EACCES"); expect(blocked.issues[0]!.message).toContain("read-only mount");
    expect(blocked.issues[0]!.message).not.toContain("held by another writer");
  } finally { chmodSync(f.vault, 0o700); }
});

test("n1: as_of on the last representable day keeps its own last second", () => {
  expect(asOfCutoff("9999-12-31")).toEqual({ requested: "9999-12-31", cutoff: "9999-12-31T23:59:59Z", cutoffInclusive: true });
  expect(asOfCutoff("9999-12-30")).toEqual({ requested: "9999-12-30", cutoff: "9999-12-31T00:00:00Z", cutoffInclusive: false });
  expect(asOfCutoff("2026-04-10")).toEqual({ requested: "2026-04-10", cutoff: "2026-04-11T00:00:00Z", cutoffInclusive: false });
});

test("T9 assertion reads match the corpus evaluation after index removal and rebuild", async () => {
  const { readAssertions } = await import("../src/assertion-read.ts");
  const f = fixture(); loadCorpus(f);
  const requests = [
    { at: "2026-04-05", asOf: "2026-04-06", subject: "s:person-a", relation: "role" },
    { at: "2026-04-05", asOf: "2026-04-11", subject: "s:person-a", relation: "role" },
    { at: "2026-04-01", asOf: "2026-04-11", subject: "s:person-a", relation: "role" },
    { at: "2026-04-05", asOf: "2026-04-10", subject: "s:person-a", relation: "role" },
    { at: "2026-04-05", asOf: "2026-04-10T08:59:59Z", subject: "s:person-a", relation: "role" },
    { at: "2026-04-05", asOf: "2026-04-10T09:00:00Z", subject: "s:person-a", relation: "role" },
    { at: "2026-04-05", asOf: "2025-09-01", subject: "s:person-a", relation: "role" },
    { at: "2026-03-30", asOf: "2026-04-11", subject: "s:person-a", relation: "role" },
    { at: "2026-03-30", asOf: "2026-05-03", subject: "s:person-a", relation: "role" },
    { at: "2026-05-20", subject: "s:person-a", relation: "team" },
    { at: "2026-05-10", subject: "s:person-a", relation: "team" },
    { history: true },
    {},
    ...Object.keys(CORPUS.scenario3.rows).map(at => ({ at })),
  ];
  for (const request of requests) {
    const pure = evaluateAssertions(f.journal(), request), query = { vault: f.id, ...request, limit: 100 };
    const first = readAssertions(f.home, query, { env: f.env });
    expect(first.pin).toEqual(pure.pin); expect(first.items.map(item => [item.id, item.rev, item.answer, item.value])).toEqual(pure.items.map(item => [item.id, item.rev, item.answer, item.value]));
    const indexes = join(f.home, "indexes"); rmSync(indexes, { recursive: true, force: true });
    expect(readAssertions(f.home, query, { env: f.env })).toEqual(first);
  }
});

test("Q1 read uses the full corpus and the example's evidence and subject fixtures", async () => {
  const { readAssertions } = await import("../src/assertion-read.ts");
  const f = fixture(), ids = loadCorpus(f);
  const answer = readAssertions(f.home, { vault: f.id, subject: "s:person-a", relation: "role", at: "2026-04-05", asOf: "2026-04-06" }, { env: f.env });
  expect(answer.pin).toHaveLength(1); expect(answer.pin[0]?.seq).toBe(15);
  expect(answer).toMatchObject({ schemaVersion: 1, basis: "assertion_journal", at: "2026-04-05", asOf: { requested: "2026-04-06", cutoff: "2026-04-07T00:00:00Z", cutoffInclusive: false },
    coverage: { journal: "present", untrusted: [], unsupported: [], tornTail: [], purged: 0 }, overlaps: [], truncated: false,
    items: [{ id: ids.A0, rev: 1, subject: "s:person-a", relation: "role", value: "member", kind: "state", from: "2025-09-01", to: "open", answer: "yes", recordedAt: "2025-09-02T09:00:00Z",
      evidence: [{ source: "vault/notes/onboarding-2025-09.md", status: "verified", quote: "joins as member" }], subjectNote: { path: "notes/person-a.md", status: "present" } }] });
  const source = "vault/notes/onboarding-2025-09.md", query = { vault: f.id, subject: "s:person-a", relation: "role", at: "2026-04-05", asOf: "2026-04-06" };
  denyPath(f, join(f.notes, "onboarding-2025-09.md"));
  const withheld = readAssertions(f.home, query, { env: f.env });
  expect(withheld.items[0]?.evidence).toEqual([{ status: "withheld", reason: "denied_by_current_policy" }]);
  expect(JSON.stringify(withheld)).not.toContain(source); expect(JSON.stringify(withheld)).not.toContain("joins as member");
  const config = loadRegistry(f.home); delete config.denyPaths; writeFileSync(join(f.home, CONFIG_FILE), JSON.stringify(config));
  rmSync(join(f.notes, "onboarding-2025-09.md"));
  expect(readAssertions(f.home, query, { env: f.env }).items[0]?.evidence).toEqual([{ source, status: "unavailable" }]);
});

test("purged assert and revision remain identifiable through their verified parents", async () => {
  const { readAssertions } = await import("../src/assertion-read.ts"), f = fixture();
  const created = ok(f.append([{ op: "declare", subject: "s:private" }, { op: "assert", subject: "s:private", relation: "role", value: "member", kind: "state", from: "2025", to: "open", source: ["mem:fixture"] }], "2026-01-01T00:00:00Z"));
  const id = created.entries[1]!.id;
  ok(f.append([{ op: "revise", id, expected_heads: heads(f, id), value: "lead", kind: "state", from: "2025", to: "open", source: ["mem:fixture"] }], "2026-01-02T00:00:00Z"));
  const segment = segmentOf(f), rows = segment.lines.map(line => JSON.parse(line) as Record<string, any>);
  delete rows[2]!.payload; rows[2]!.purged = { at: "2026-02-01T00:00:00Z", reason: "evidence_withdrawn" };
  writeFileSync(segment.file, rows.map(canonical).join("\n") + "\n");
  const earlier = readAssertions(f.home, { vault: f.id, at: "2026-01-01", asOf: "2026-01-01" }, { env: f.env });
  expect(earlier.items).toEqual([]); expect(earlier.coverage.purged).toBe(1);
  for (const row of rows.slice(1)) { delete row.payload; row.purged = { at: "2026-02-01T00:00:00Z", reason: "evidence_withdrawn" }; }
  writeFileSync(segment.file, rows.map(canonical).join("\n") + "\n");
  const all = readAssertions(f.home, { vault: f.id, history: true }, { env: f.env });
  expect(all.coverage.untrusted).toEqual([]); expect(all.coverage.purged).toBe(1);
  expect(all.items.map(row => ({ id: row.id, segment: row.segment, seq: row.seq, hash: row.hash, rev: row.rev, availability: row.availability }))).toEqual(rows.slice(1).map((row, index) => ({ id, segment: row.seg, seq: row.seq, hash: row.hash, rev: index + 1, availability: "unavailable" })));
  for (const query of [{ subject: "s:private" }, { relation: "role" }]) {
    const result = readAssertions(f.home, { vault: f.id, history: true, ...query }, { env: f.env });
    expect(result.items).toEqual([]); expect(result.coverage.purged).toBe(1);
  }
  expect(readAssertions(f.home, { vault: f.id, at: "2026-03-01" }, { env: f.env }).items).toEqual([]);
});

test("damaged batches report left-out entries and consistent CLI coverage", async () => {
  const f = fixture();
  ok(f.append([{ op: "declare", subject: "s:alpha" }], "2026-01-01T00:00:00Z"));
  const ops = Array.from({ length: 30 }, (_, i) => ({ op: "assert", subject: "s:alpha", relation: `r${i}`, value: "synthetic", kind: "state", from: "2026", to: "open", source: ["mem:x"] }));
  ok(f.append(ops, "2026-01-02T00:00:00Z")); ok(f.append(ops, "2026-01-03T00:00:00Z"));
  const { file, lines } = segmentOf(f), segment = file.split("/").at(-1)!.slice(0, 16);
  expect(lines).toHaveLength(61);
  const { readAssertions } = await import("../src/assertion-read.ts");
  const { assertionCoverageWarnings } = await import("../src/assertion-coverage.ts");
  const damaged = [...lines]; damaged[9] = damaged[9]!.replace('"recorded_at":"2026-01-02T00:00:00Z"', '"recorded_at":"2026-01-04T00:00:00Z"');
  writeFileSync(file, damaged.join("\n") + "\n");
  for (const history of [false, true]) {
    const result = readAssertions(f.home, { vault: f.id, history }, { env: f.env });
    expect(result.items).toHaveLength(0);
    expect(result.coverage.untrusted).toEqual([{ segment, seq: 2, failedSeq: 10, entries: 60, reason: "hash mismatch" }]);
    const warning = assertionCoverageWarnings(result.coverage)[0]!.message;
    expect(warning).toContain(`${segment}#2, failed #10, 60 left out`);
    expect(run(["assertions", f.id, ...(history ? ["--history"] : [])], f.env).text).toContain(warning.replaceAll("`", "").replace("<vault>", f.id));
    expect(JSON.parse(run(["assertions", f.id, ...(history ? ["--history"] : []), "--json"], f.env).text).coverage.untrusted).toEqual(result.coverage.untrusted);
  }
  for (const [length, seq, kept] of [[18, 2, 0], [48, 32, 30]] as const) {
    writeFileSync(file, lines.slice(0, length).join("\n") + "\n");
    const result = readAssertions(f.home, { vault: f.id }, { env: f.env });
    expect(result.items).toHaveLength(kept);
    expect(result.coverage.partialBatch).toEqual([{ segment, seq, entries: 17, size: 30 }]);
    const warning = `batch ${segment}:${seq} has 17 of 30 entries; all 17 are left out; resubmit the batch`;
    expect(assertionCoverageWarnings(result.coverage).map(w => w.message)).toContain(warning);
    expect(run(["assertions", f.id], f.env).text).toContain(warning);
  }
  writeFileSync(file, damaged.join("\n") + "\n" + '{"torn":');
  const torn = readAssertions(f.home, { vault: f.id }, { env: f.env });
  expect(torn.coverage.untrusted[0]!.entries).toBe(60);
  expect(torn.coverage.tornTail).toEqual([]);
  expect(run(["assertions", f.id], f.env).text).not.toContain("torn journal tail");
  const unsupported = [...lines]; unsupported[9] = unsupported[9]!.replace('"v":1', '"v":2');
  writeFileSync(file, unsupported.join("\n") + "\n" + '{"torn":');
  const newer = readAssertions(f.home, { vault: f.id }, { env: f.env });
  expect(newer.coverage.unsupported).toEqual([{ segment, seq: 2, failedSeq: 10, entries: 60 }]);
  expect(newer.coverage.tornTail).toEqual([]);
  expect(run(["assertions", f.id], f.env).text).toContain(`${segment}#2, failed #10, 60 left out`);
  expect(run(["assertions", f.id], f.env).text).not.toContain("torn journal tail");
});
