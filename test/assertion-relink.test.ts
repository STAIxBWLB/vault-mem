import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { appendAssertions, readJournal } from "../src/assertions.ts";
import { readAssertions } from "../src/assertion-read.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";
import { argumentError } from "../src/mcp.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-relink-"))); roots.push(root);
  const home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes"); mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "old.md"), "---\nstatus: active\n---\nOld\n"); writeFileSync(join(notes, "new.md"), "---\nstatus: active\n---\nNew\n");
  addVault(home, { id: "test", path: vault, kind: "personal", write: "mcp" });
  const env = { HOME: root, VMEM_HOME: home, PATH: process.env.PATH };
  const append = (ops: unknown[], time: string) => appendAssertions(home, { vault: "test", channel: "cli", ops }, { env, now: new Date(time) });
  return { root, home, vault, notes, env, append };
}
test("manual relink keeps the old segment shape and respects as-of cutoff", () => {
  const f = fixture();
  expect(f.append([{ op: "declare", subject: "s:test", label: "Test", note: "notes/old.md" }, { op: "assert", subject: "s:test", relation: "role", value: "member", kind: "state", from: "2025", to: "open", source: ["mem:fixture"] }], "2026-01-01T00:00:00Z").ok).toBe(true);
  expect(f.append([{ op: "relink", subject: "s:test", note: "notes/new.md" }], "2026-02-01T00:00:00Z").ok).toBe(true);
  const journal = readJournal(f.vault), entry = journal.segments[0]!.entries.at(-1)!;
  expect(journal.segments[0]!.untrusted).toBeNull(); expect(entry.op).toBe("subject"); expect(entry.parents).toBeUndefined();
  expect(entry.payload).toEqual({ subject: "s:test", label: "Test", note: "notes/new.md" });
  expect(readAssertions(f.home, { vault: "test", asOf: "2026-01-02" }, { env: f.env }).items[0]?.subjectNote?.path).toBe("notes/old.md");
  expect(readAssertions(f.home, { vault: "test", asOf: "2026-02-02" }, { env: f.env }).items[0]?.subjectNote?.path).toBe("notes/new.md");
});
test("relink validates its subject and note, and MCP accepts the operation", async () => {
  const f = fixture();
  expect(f.append([{ op: "relink", subject: "s:missing", note: "notes/new.md" }], "2026-01-01T00:00:00Z").issues[0]).toMatchObject({ code: "V01" });
  expect(f.append([{ op: "declare", subject: "s:test" }], "2026-01-01T00:00:00Z").ok).toBe(true);
  expect(f.append([{ op: "declare", subject: "s:test" }], "2026-01-02T00:00:00Z").issues[0]?.message).toContain("relink");
  expect(f.append([{ op: "relink", subject: "s:test", note: "outside.md" }], "2026-01-02T00:00:00Z").issues[0]).toMatchObject({ code: "V01" });
  const server = createVaultMcp(f.home, f.env);
  expect(argumentError({ vault: "test", ops: [{ op: "relink", subject: "s:test", note: "notes/new.md" }] }, server.tools.find(tool => tool.name === "vmem_assert")!.inputSchema)).toBeUndefined();
  const receipt = await server.handlers.vmem_assert!({ vault: "test", ops: [{ op: "relink", subject: "s:test", note: "notes/new.md" }] }) as { ok: boolean };
  expect(receipt.ok).toBe(true);
});

test("a locked assertion journal leaves the note move applied and gives an exact relink command", async () => {
  const { applyWrite } = await import("../src/writer.ts");
  const { existsSync } = await import("node:fs");
  const f = fixture(), old = "---\ntitle: Old\ndescription: Synthetic fixture.\ntype: insight\ndomain: research\ntopics: [\"[[research]]\"]\n---\n# Old\n\nBody.\n";
  writeFileSync(join(f.notes, "old.md"), old); writeFileSync(join(f.notes, "research.md"), "---\ntype: moc\ndescription: Synthetic directory.\n---\n# Research\n");
  expect(f.append([{ op: "declare", subject: "s:test", label: "Test", note: "notes/old.md" }], "2026-01-01T00:00:00Z").ok).toBe(true);
  const operation = { op: "move" as const, from: "old", to: "moved" };
  const preview = applyWrite(f.home, { vault: "test", operation, channel: "cli" }, { env: f.env });
  expect(preview.assertions?.relinked).toEqual(["s:test"]);
  const lock = join(f.vault, "assertions.lock"); writeFileSync(lock, "held\n");
  const result = applyWrite(f.home, { vault: "test", operation, channel: "cli", confirm: true, fingerprint: preview.fingerprint }, { env: f.env });
  expect(result.applied).toBe(true); expect(result.assertions?.relinked).toEqual([]);
  expect(result.assertions?.issue?.message).toContain("vmem assert test --batch -");
  expect(result.assertions?.issue?.message).toContain('"subject":"s:test"');
  expect(existsSync(join(f.notes, "moved.md"))).toBe(true); expect(existsSync(join(f.notes, "old.md"))).toBe(false);
  expect(existsSync(lock)).toBe(true);
});

test("automatic move relinks more than one batch and lists the plan before publication", async () => {
  const { applyWrite } = await import("../src/writer.ts"), f = fixture();
  writeFileSync(join(f.notes, "old.md"), "---\ntitle: Old\ndescription: Synthetic fixture.\ntype: insight\ndomain: research\ntopics: [\"[[research]]\"]\n---\n# Old\n\nBody.\n");
  writeFileSync(join(f.notes, "research.md"), "---\ntype: moc\ndescription: Synthetic directory.\n---\n# Research\n");
  const subjects = Array.from({ length: 35 }, (_, i) => `s:s${String(i).padStart(2, "0")}`);
  for (const batch of [subjects.slice(0, 32), subjects.slice(32)]) expect(f.append(batch.map(subject => ({ op: "declare", subject, note: "notes/old.md" })), "2026-01-01T00:00:00Z").ok).toBe(true);
  const operation = { op: "move" as const, from: "old", to: "moved" };
  const preview = applyWrite(f.home, { vault: "test", operation, channel: "mcp" }, { env: f.env });
  expect(preview.assertions?.relinked).toEqual(subjects);
  const result = applyWrite(f.home, { vault: "test", operation, channel: "mcp", confirm: true, fingerprint: preview.fingerprint }, { env: f.env });
  expect(result.applied).toBe(true); expect(result.assertions?.issue).toBeUndefined(); expect(result.assertions?.relinked).toEqual(subjects);
  const entries = readJournal(f.vault).segments.flatMap(segment => segment.entries).filter(entry => entry.payload?.note === "notes/moved.md");
  expect(entries).toHaveLength(35); expect(entries.every(entry => entry.op === "subject" && !entry.parents && entry.actor === "agent" && entry.channel === "mcp")).toBe(true);
});

test("concurrent subject entries choose the later segment on equal record times", async () => {
  const { entryHash, payloadHash, subjectsAtNote } = await import("../src/assertions.ts"), { canonical } = await import("../src/writer.ts");
  const f = fixture();
  expect(f.append([{ op: "declare", subject: "s:test", label: "Test", note: "notes/old.md" }, { op: "assert", subject: "s:test", relation: "role", value: "member", kind: "state", from: "2025", to: "open", source: ["mem:fixture"] }], "2025-01-01T00:00:00Z").ok).toBe(true);
  for (const [segment, note] of [["0000000000000001", "notes/old.md"], ["ffffffffffffffff", "notes/new.md"]] as const) {
    const payload = { subject: "s:test", label: "Test", note }, draft = { v: 1, seg: segment, seq: 1, prev: "0".repeat(64), payload_sha256: payloadHash(payload), recorded_at: "2026-01-01T00:00:00Z", channel: "cli" as const, actor: "person" as const, op: "subject" as const, batch: { id: `${segment}:1`, size: 1, index: 0 }, payload };
    writeFileSync(join(f.vault, "assertions", `${segment}.jsonl`), canonical({ ...draft, hash: entryHash(draft) }) + "\n");
  }
  const journal = readJournal(f.vault); expect(journal.segments.every(segment => !segment.untrusted)).toBe(true);
  expect(subjectsAtNote(journal, "notes/new.md")).toEqual(["s:test"]); expect(subjectsAtNote(journal, "notes/old.md")).toEqual([]);
  expect(readAssertions(f.home, { vault: "test", asOf: "2026-01-01" }, { env: f.env }).items[0]?.subjectNote?.path).toBe("notes/new.md");
});

test("moving a note without an assertion journal never creates one", async () => {
  const { applyWrite } = await import("../src/writer.ts"), { existsSync } = await import("node:fs"), f = fixture();
  writeFileSync(join(f.notes, "old.md"), "---\ntitle: Old\ndescription: Synthetic fixture.\ntype: insight\ndomain: research\ntopics: [\"[[research]]\"]\n---\n# Old\n\nBody.\n");
  writeFileSync(join(f.notes, "research.md"), "---\ntype: moc\ndescription: Synthetic directory.\n---\n# Research\n");
  const operation = { op: "move" as const, from: "old", to: "moved" }, preview = applyWrite(f.home, { vault: "test", operation, channel: "cli" }, { env: f.env });
  expect(preview.ok).toBe(true); expect(preview.assertions).toBeUndefined();
  expect(applyWrite(f.home, { vault: "test", operation, channel: "cli", confirm: true, fingerprint: preview.fingerprint }, { env: f.env }).applied).toBe(true);
  expect(existsSync(join(f.vault, "assertions"))).toBe(false);
});

test("denied assertion journal does not roll back the published note move", async () => {
  const { applyWrite } = await import("../src/writer.ts"), { loadRegistry } = await import("../src/registry.ts"), f = fixture();
  writeFileSync(join(f.notes, "old.md"), "---\ntitle: Old\ndescription: Synthetic fixture.\ntype: insight\ndomain: research\ntopics: [\"[[research]]\"]\n---\n# Old\n\nBody.\n");
  writeFileSync(join(f.notes, "research.md"), "---\ntype: moc\ndescription: Synthetic directory.\n---\n# Research\n");
  expect(f.append([{ op: "declare", subject: "s:test", note: "notes/old.md" }], "2026-01-01T00:00:00Z").ok).toBe(true);
  const config = loadRegistry(f.home); config.denyPaths = [join(f.vault, "assertions")]; writeFileSync(join(f.home, "vmem.config.json"), JSON.stringify(config));
  const operation = { op: "move" as const, from: "old", to: "moved" }, preview = applyWrite(f.home, { vault: "test", operation, channel: "cli" }, { env: f.env });
  expect(preview.ok).toBe(true); expect(preview.assertions?.issue?.message).toContain("cannot be inspected");
  const result = applyWrite(f.home, { vault: "test", operation, channel: "cli", confirm: true, fingerprint: preview.fingerprint }, { env: f.env });
  expect(result.applied).toBe(true); expect(result.assertions?.issue?.message).toContain("vmem assert test --batch -");
});

test("a subject change after the move preview invalidates its fingerprint", async () => {
  const { applyWrite } = await import("../src/writer.ts"), { existsSync } = await import("node:fs"), f = fixture();
  writeFileSync(join(f.notes, "old.md"), "---\ntitle: Old\ndescription: Synthetic fixture.\ntype: insight\ndomain: research\ntopics: [\"[[research]]\"]\n---\n# Old\n\nBody.\n");
  writeFileSync(join(f.notes, "research.md"), "---\ntype: moc\ndescription: Synthetic directory.\n---\n# Research\n");
  expect(f.append([{ op: "declare", subject: "s:first", note: "notes/old.md" }], "2026-01-01T00:00:00Z").ok).toBe(true);
  const operation = { op: "move" as const, from: "old", to: "moved" }, preview = applyWrite(f.home, { vault: "test", operation, channel: "cli" }, { env: f.env });
  expect(preview.assertions?.relinked).toEqual(["s:first"]);
  expect(f.append([{ op: "declare", subject: "s:second", note: "notes/old.md" }], "2026-01-02T00:00:00Z").ok).toBe(true);
  const result = applyWrite(f.home, { vault: "test", operation, channel: "cli", confirm: true, fingerprint: preview.fingerprint }, { env: f.env });
  expect(result.applied).toBe(false); expect(result.issues.some(issue => issue.code === "V09")).toBe(true); expect(existsSync(join(f.notes, "old.md"))).toBe(true);
});

test("CLI accepts a relink batch and returns the stored subject entry", async () => {
  const { run } = await import("../src/cli.ts"), f = fixture();
  expect(f.append([{ op: "declare", subject: "s:test", note: "notes/old.md" }], "2026-01-01T00:00:00Z").ok).toBe(true);
  const batch = join(f.root, "batch.json"); writeFileSync(batch, JSON.stringify({ ops: [{ op: "relink", subject: "s:test", note: "notes/new.md" }] }));
  const output = run(["assert", "test", "--batch", batch, "--json"], f.env);
  expect(output.code).toBe(0); expect(JSON.parse(output.text).entries[0]).toMatchObject({ id: "s:test", op: "subject" });
});
