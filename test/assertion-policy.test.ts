import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screenAssertion } from "../src/assertion-policy.ts";
import type { AssertionItem } from "../src/assertions.ts";
import type { VaultSpec, VmemConfig } from "../src/config.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("current policy withholds only denied evidence and rechecks values", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-assertion-policy-"))); roots.push(root);
  const vaultRoot = join(root, "vault"), notes = join(vaultRoot, "notes"); mkdirSync(notes, { recursive: true });
  writeFileSync(join(root, "workspace.config.yaml"), "name: fixture\n");
  const text = "a synthetic source quote\n", sha256 = createHash("sha256").update(text).digest("hex");
  writeFileSync(join(notes, "allowed.md"), text); writeFileSync(join(notes, "denied.md"), text);
  const vault: VaultSpec = { id: "test", path: vaultRoot, kind: "personal", write: "none", registry: join(root, "projects.yaml"), pii: "deny" };
  const config: VmemConfig = { vaults: [vault], denyPaths: [join(notes, "denied.md")] };
  const sources = ["vault/notes/allowed.md", "vault/notes/denied.md"];
  const item: AssertionItem = { id: "a:1234567890abcdef:1", rev: 1, op: "assert", subject: "s:test", relation: "email", hash: "a".repeat(64), recordedAt: "2026-01-01T00:00:00Z", value: "person@example.test", source: sources,
    evidence: sources.map(source => ({ source, sha256, quote: "synthetic source" })) };
  const screened = screenAssertion(item, vault, config, new Map(), { remainingBytes: 1024, remainingFiles: 5 });
  expect(screened.value).toEqual({ withheld: "pii_policy" });
  expect(screened.source).toEqual([sources[0]!, { withheld: true }]);
  expect(screened.evidence).toEqual([{ source: sources[0], sha256, quote: "synthetic source", status: "verified" }, { status: "withheld", reason: "denied_by_current_policy" }]);
  expect(JSON.stringify(screened)).not.toContain("denied.md");
  rmSync(join(notes, "allowed.md"));
  expect(screenAssertion(item, vault, config, new Map(), { remainingBytes: 1024, remainingFiles: 5 }).evidence?.[0]).toEqual({ source: sources[0], status: "unavailable" });
});
