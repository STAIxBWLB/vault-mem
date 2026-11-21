import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault, loadRegistry } from "../src/registry.ts";
import { appendAssertions, evaluateAssertions, readJournal } from "../src/assertions.ts";
import { screenAssertion } from "../src/assertion-policy.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-origin-"))); roots.push(root);
  const home = join(root, "home"), vault = join(root, "vault"), note = join(vault, "notes", "source.md");
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(note, "synthetic source\n");
  addVault(home, { id: "test", path: vault, kind: "personal", write: "mcp" });
  const origin = { path: "notes/source.md", sha256: createHash("sha256").update("synthetic source\n").digest("hex"), producer: { skill: "example", version: "1", model: "local" }, createdAt: "2026-11-21T00:00:00.000Z" };
  const ops = [{ op: "declare", subject: "s:test" }, { op: "assert", subject: "s:test", relation: "role", value: "member", kind: "event", on: "2026", source: ["https://example.org"] }];
  return { home, vault, note, origin, ops };
}
test("origin is journaled, read back and older assertions remain readable", () => {
  const f = setup();
  const receipt = appendAssertions(f.home, { vault: "test", ops: f.ops }, { origin: f.origin });
  expect(receipt.ok).toBe(true);
  const item = evaluateAssertions(readJournal(f.vault)).items[0]!;
  expect(item.origin).toEqual({ ...f.origin, status: "unverified" });
  const second = appendAssertions(f.home, { vault: "test", ops: [{ ...f.ops[1], relation: "team" }] });
  expect(second.ok).toBe(true);
  expect(evaluateAssertions(readJournal(f.vault)).items.find(i => i.relation === "team")?.origin).toBeUndefined();
});
test("stale, malformed and prohibited origin refuse the whole batch", () => {
  const f = setup();
  writeFileSync(f.note, "changed synthetic source\n");
  const stale = appendAssertions(f.home, { vault: "test", ops: f.ops }, { origin: f.origin });
  expect(stale.applied).toBe(false); expect(stale.issues[0]?.code).toBe("STALE_ORIGIN");
  expect(stale.issues[0]?.message).toContain("reread"); expect(readJournal(f.vault).entries).toBe(0);
  const malformed = appendAssertions(f.home, { vault: "test", ops: f.ops }, { origin: { ...f.origin, extra: true } as typeof f.origin });
  expect(malformed.issues[0]?.code).toBe("V01");
  const bad = appendAssertions(f.home, { vault: "test", ops: f.ops }, { origin: { ...f.origin, producer: { ...f.origin.producer, model: "line\nbreak" } } });
  expect(bad.issues[0]?.code).toBe("V01");
});
test("current path and PII policies withhold the complete origin", () => {
  const f = setup(); expect(appendAssertions(f.home, { vault: "test", ops: f.ops }, { origin: f.origin }).ok).toBe(true);
  const item = evaluateAssertions(readJournal(f.vault)).items[0]!, config = loadRegistry(f.home), vault = config.vaults[0]!;
  const project = (cfg: typeof config, piiVault = vault) => screenAssertion(item, piiVault, cfg, new Map(), { remainingBytes: 100000, remainingFiles: 10 });
  expect(project({ ...config, denyPaths: [join(f.vault, "notes", "source.md")] }).origin).toEqual({ withheld: true });
  expect(project({ ...config, piiPatterns: ["example"] }, { ...vault, pii: "deny" }).origin).toEqual({ withheld: true });
});
