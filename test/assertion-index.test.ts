import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertionIndexPath, rebuildAssertionIndex } from "../src/assertion-index.ts";
import type { JournalEntry, VerifiedJournal } from "../src/assertions.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-assertion-index-"))); roots.push(root);
  const home = join(root, "home"), vault = join(root, "vault"); mkdirSync(home); mkdirSync(vault);
  const entry: JournalEntry = { v: 1, seg: "1234567890abcdef", seq: 1, prev: "0".repeat(64), hash: "a".repeat(64), payload_sha256: "b".repeat(64), recorded_at: "2026-01-01T00:00:00Z", channel: "cli", actor: "person", op: "subject", batch: { id: "1234567890abcdef:1", index: 0, size: 1 }, payload: { subject: "s:fixture" } };
  const journal: VerifiedJournal = { present: true, ignored: [], bytes: 1, entries: 1, segments: [{ segment: entry.seg, entries: [entry], tail: { seq: 1, hash: entry.hash, recordedAt: entry.recorded_at }, verifiedBytes: 1, size: 1, tornTail: false, partialBatch: null, untrusted: null, unsupported: null }] };
  return { root, home, vault, journal };
}

test("a verified journal builds a private, byte-identical disposable SQLite projection", () => {
  const f = fixture(), file = rebuildAssertionIndex(f.home, f.vault, f.journal), first = readFileSync(file);
  expect(file).toBe(assertionIndexPath(f.home, f.vault)); expect(statSync(file).mode & 0o777).toBe(0o600);
  const db = new Database(file, { readonly: true });
  try { expect(db.query("SELECT segment, seq, entry FROM entries").all()).toEqual([{ segment: "1234567890abcdef", seq: 1, entry: expect.stringContaining('"subject":"s:fixture"') }]); } finally { db.close(); }
  rmSync(file); rebuildAssertionIndex(f.home, f.vault, f.journal);
  expect(readFileSync(file).equals(first)).toBe(true);
});

test("the index refuses an in-vault home and a linked indexes directory", () => {
  const f = fixture(), inside = join(f.vault, "home"); mkdirSync(inside);
  expect(() => assertionIndexPath(inside, f.vault)).toThrow("inside a vault");
  expect(() => assertionIndexPath(inside, f.home, [f.home, f.vault])).toThrow("inside a vault");
  symlinkSync(f.vault, join(f.home, "indexes"));
  expect(() => rebuildAssertionIndex(f.home, f.vault, f.journal)).toThrow("not a plain directory");
  expect(existsSync(join(f.vault, "assertions"))).toBe(false);
});
