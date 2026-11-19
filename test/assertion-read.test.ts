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
