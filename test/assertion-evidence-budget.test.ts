import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyEvidenceEntry, type EvidenceReads } from "../src/evidence.ts";
import type { VaultSpec } from "../src/config.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("evidence verification checks the aggregate budget before reading and counts attempts", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-evidence-budget-"))); roots.push(root);
  const vaultRoot = join(root, "vault"), notes = join(vaultRoot, "notes"); mkdirSync(notes, { recursive: true });
  writeFileSync(join(root, "workspace.config.yaml"), "name: fixture\n");
  const content = "a quote in a source\n"; writeFileSync(join(notes, "source.md"), content);
  const vault: VaultSpec = { id: "test", path: vaultRoot, kind: "personal", write: "none", registry: join(root, "projects.yaml") };
  const entry = { source: "vault/notes/source.md", sha256: createHash("sha256").update(content).digest("hex"), quote: "a quote" };
  const budget = { remainingFiles: 2, remainingBytes: 3 }, reads: EvidenceReads = new Map();
  expect(verifyEvidenceEntry(vault, entry, 0, [], reads, budget)).toMatchObject({ status: "unsupported", reason: "read_budget" });
  expect(budget).toEqual({ remainingFiles: 1, remainingBytes: 3 });
  // A second distinct attempt still counts even though its size is refused before reading.
  const otherReads: EvidenceReads = new Map();
  expect(verifyEvidenceEntry(vault, entry, 0, [], otherReads, budget)).toMatchObject({ reason: "read_budget" });
  expect(budget.remainingFiles).toBe(0);
});
