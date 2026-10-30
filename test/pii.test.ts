import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePii, type VaultSpec, type VmemConfig } from "../src/config.ts";
import { piiPolicy, piiShorthand, redactPii } from "../src/pii.ts";
import { screenContent } from "../src/write-validation.ts";
import { formatLogEvent } from "../src/log-format.ts";
import { screenForOrg } from "../src/org-promote.ts";
import { addVault } from "../src/registry.ts";
import { tidyVault } from "../src/tidy.ts";
import { run } from "../src/cli.ts";
import { applyWrite } from "../src/writer.ts";

// Synthetic values only: example.invalid addresses and 010-0000-xxxx numbers.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const vault = (pii?: VaultSpec["pii"], kind: VaultSpec["kind"] = "personal"): VaultSpec => ({ id: "v", path: "/x", kind, write: "mcp", ...(pii !== undefined ? { pii } : {}) });
const config: VmemConfig = { vaults: [] };
const MAIL = "reach a.person@example.invalid now", PHONE = "call 010-0000-1234 today";
const codes = (issues: { code: string; severity: string }[]) => issues.map(i => `${i.code}:${i.severity}`);

test("parsePii accepts shorthand and objects and rejects malformed policies", () => {
  expect(parsePii("deny")).toBe("deny");
  expect(parsePii({ email: { log: "deny" }, allow: ["@example.invalid"] })).toEqual({ email: { log: "deny" }, allow: ["@example.invalid"] });
  for (const bad of ["warn", "block", { email: "block" }, { email: { body: "deny" } }, { other: "deny" }, { patterns: [{ name: "Bad", regex: "x" }] },
    { patterns: [{ name: "a", regex: "(" }] }, { patterns: [{ name: "a", regex: "x" }, { name: "a", regex: "y" }] },
    { patterns: Array.from({ length: 33 }, (_, i) => ({ name: `p${i}`, regex: "x" })) }]) expect(() => parsePii(bad)).toThrow();
});

test("shorthand and defaults keep the previous allow/deny behavior", () => {
  expect(piiShorthand(vault())).toBe("allow"); expect(piiShorthand(vault(undefined, "org"))).toBe("deny");
  expect(piiPolicy(vault({ phone: "warn" })).email.notes).toBe("allow");
  expect(piiPolicy(vault({ phone: "warn" }, "org")).email.notes).toBe("deny");
  expect(piiShorthand(vault({ phone: "warn" }))).toBe("custom");
  expect(screenContent(MAIL, vault(), config)).toEqual([]);
  expect(screenContent(MAIL, vault("deny"), config)).toEqual([{ code: "V07", severity: "error", message: "PII is refused by the vault policy" }]);
  expect(codes(screenContent("id 12345", vault("deny"), { vaults: [], piiPatterns: ["\\b\\d{5}\\b"] }))).toEqual(["V07:error"]);
  expect(screenContent("id 12345", vault("allow"), { vaults: [], piiPatterns: ["\\b\\d{5}\\b"] })).toEqual([]);
});

test("each category and surface takes its own action", () => {
  const v = vault({ email: { notes: "warn", log: "deny" }, phone: { notes: "allow", promotion: "deny" } });
  expect(codes(screenContent(MAIL, v, config, "notes"))).toEqual(["V07:warning"]);
  expect(codes(screenContent(MAIL, v, config, "log"))).toEqual(["V07:error"]);
  expect(screenContent(MAIL, v, config, "promotion")).toEqual([]);
  expect(screenContent(PHONE, v, config, "notes")).toEqual([]);
  expect(codes(screenContent(PHONE, v, config, "promotion"))).toEqual(["V07:error"]);
  expect(codes(screenContent("TOKEN=" + "sk-" + "Z".repeat(32), vault("allow"), config))).toEqual(["V06:error"]); // secrets stay outside the policy
});

test("the allow list exempts exact addresses, domains and phone digits", () => {
  const v = vault({ email: "deny", phone: "deny", allow: ["Owner@Example.invalid", "@team.example.invalid", "+82 10-0000-1234"] });
  expect(screenContent("owner@example.invalid and x@team.example.invalid", v, config)).toEqual([]);
  expect(codes(screenContent("other@example.invalid", v, config))).toEqual(["V07:error"]);
  expect(screenContent("call (+82) 10.0000.1234", v, config)).toEqual([]);
  expect(codes(screenContent("010-0000-9999", v, config))).toEqual(["V07:error"]);
});

test("named patterns and the custom category follow their cells", () => {
  const v = vault({ custom: "warn", patterns: [{ name: "student-id", regex: "S\\d{6}", action: { notes: "deny", log: "allow" } }] });
  const cfg: VmemConfig = { vaults: [], piiPatterns: ["\\bCASE-\\d+\\b"] };
  expect(screenContent("student S123456", v, cfg, "notes")).toEqual([{ code: "V07", severity: "error", message: "PII pattern student-id matched" }]);
  expect(screenContent("student S123456", v, cfg, "log")).toEqual([]);
  expect(codes(screenContent("see CASE-12", v, cfg, "notes"))).toEqual(["V07:warning"]);
});

test("log appends and redaction follow the log surface; promotion warn reports without refusing", () => {
  const event = { type: "LEARN", project: "-", source: "a", note: "mail a.person@example.invalid" } as const;
  const ctx = (pii: VaultSpec["pii"]) => ({ vault: vault(pii), config: { vaults: [] } });
  expect(formatLogEvent(event, ctx({ email: { log: "deny" } })).line).toBeUndefined();
  expect(formatLogEvent(event, ctx({ email: { log: "warn" } }))).toMatchObject({ issues: [{ code: "V07", severity: "warning" }] });
  expect(formatLogEvent(event, ctx({ email: { notes: "deny" } })).line).toContain("a.person@example.invalid");
  expect(redactPii(MAIL + " " + PHONE, vault({ email: { log: "deny" }, phone: { log: "warn" } }), config, "log")).toEqual({ text: "reach [redacted] now call 010-0000-1234 today", hits: 1 });
  const target = vault({ email: { promotion: "warn" } }, "org");
  const warn = screenForOrg(MAIL, { type: "insight" }, target, config);
  expect(codes(warn)).toEqual(["V07:warning"]);
  expect(codes(screenForOrg(MAIL, { type: "insight" }, vault(undefined, "org"), config))).toEqual(["V07:error"]);
});

function fixture(pii?: unknown) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-pii-"))); roots.push(root);
  const home = join(root, "state"), dir = join(root, "vault");
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "log"), "2026-10-01 10:00  LEARN  -  a  — sent to a.person@example.invalid\n2026-10-01 10:01  LEARN  -  a  — owner@example.invalid\n");
  addVault(home, { id: "mine", path: dir, kind: "personal", write: "mcp", ...(pii !== undefined ? { pii } : {}) });
  return { home, dir, env: { VMEM_HOME: home } };
}

test("tidy --log redacts only log-surface deny matches outside the allow list", () => {
  const plain = fixture();
  expect(tidyVault(plain.home, { vault: "mine", rules: ["log"] }, { env: plain.env }).log).toMatchObject({ redactions: 0 });
  const f = fixture({ email: { log: "deny" }, allow: ["owner@example.invalid"] });
  const preview = tidyVault(f.home, { vault: "mine", rules: ["log"] }, { env: f.env });
  expect(preview.log).toMatchObject({ redactions: 1 });
  expect(tidyVault(f.home, { vault: "mine", rules: ["log"], confirm: true, fingerprint: preview.fingerprint }, { env: f.env }).ok).toBe(true);
  const log = readFileSync(join(f.dir, "log"), "utf8");
  expect(log).toContain("sent to [redacted]"); expect(log).toContain("owner@example.invalid");
});

test("vaults pii previews, lists loosened cells and writes only with --confirm", () => {
  const f = fixture("deny");
  const show = JSON.parse(run(["vaults", "pii", "mine", "--json"], f.env).text);
  expect(show).toMatchObject({ vault: "mine", pii: "deny", piiPolicy: { email: { notes: "deny", log: "deny", promotion: "deny" } } });
  const set = JSON.stringify({ email: { log: "warn" }, phone: "deny", custom: "deny", allow: ["@example.invalid"] });
  const preview = JSON.parse(run(["vaults", "pii", "mine", "--set", set, "--json"], f.env).text);
  expect(preview).toMatchObject({ applied: false, preview: true, changed: true, pii: "custom" });
  expect(preview.loosened).toEqual(["email.notes: deny -> allow", "email.log: deny -> warn", "email.promotion: deny -> allow", "allow: + @example.invalid"]);
  expect(JSON.parse(run(["vaults", "pii", "mine", "--json"], f.env).text).pii).toBe("deny");
  expect(JSON.parse(run(["vaults", "pii", "mine", "--set", set, "--confirm", "--json"], f.env).text)).toMatchObject({ applied: true });
  const listed = JSON.parse(run(["vaults", "list", "--json"], f.env).text)[0];
  expect(listed).toMatchObject({ pii: "custom", piiPolicy: { email: { log: "warn" }, allow: ["@example.invalid"] } });
  expect(() => run(["vaults", "pii", "mine", "--confirm"], f.env)).toThrow("--confirm requires --set");
  expect(() => run(["vaults", "pii", "mine", "--set", "{\"email\":\"block\"}"], f.env)).toThrow();
});

test("note writes proceed with a warn cell and are refused by a deny cell", () => {
  const create = (home: string, stem: string) => applyWrite(home, { vault: "mine", operation: { op: "create", path: stem, frontmatter: { description: "Synthetic contact note.", type: "insight", domain: "research", topics: [] }, body: "# Contact\n\nWrite to a.person@example.invalid.\n" }, dryRun: true });
  const warn = fixture({ email: { notes: "warn" } }), deny = fixture({ email: { notes: "deny" } });
  expect(create(warn.home, "contact").issues.filter(i => i.code === "V07").map(i => i.severity)).toEqual(["warning"]);
  expect(create(deny.home, "contact").issues.filter(i => i.code === "V07").map(i => i.severity)).toEqual(["error"]);
});
