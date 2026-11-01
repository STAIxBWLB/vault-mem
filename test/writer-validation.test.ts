import { describe, expect, test } from "bun:test";
import { looksSecret as upstreamLooksSecret } from "@staix/agent-mem";
import type { VaultSpec, VmemConfig } from "../src/config.ts";
import { screenContent, validateWrite } from "../src/write-validation.ts";
import type { PlannedChange, ValidationContext, WriteOp } from "../src/write-types.ts";

const vault: VaultSpec = { id: "synthetic", path: "/synthetic/vault", kind: "personal", write: "mcp" };
const config: VmemConfig = { vaults: [vault] };
function note(data: Record<string, unknown> = {}, body = "# Synthetic claim\n\nA distinct synthetic body.\n\n## Topics\n- [[research]]\n"): string {
  const fm = { description: "Adds supporting detail beyond the claim", type: "insight", domain: "research", topics: ["[[research]]"], ...data };
  return `---\n${Object.entries(fm).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${body}`;
}
const moc = "---\ntype: moc\ndescription: Synthetic research domain directory\n---\n# Research\n";
function context(notes: Map<string, string> = new Map([["notes/research.md", moc]]), operation: WriteOp = { op: "create", path: "notes/claim.md", frontmatter: {} }): ValidationContext {
  return { vault, config, notes, operation };
}
function create(after: string, path = "notes/claim.md"): PlannedChange { return { path, before: null, after }; }
function errors(changes: PlannedChange[], ctx = context()) { return validateWrite(changes, ctx).filter(value => value.severity === "error"); }

describe("writer validation schema and topics", () => {
  test("accepts valid synthetic notes, thin MOCs, supported metadata and promotion fields", () => {
    expect(errors([create(note())])).toEqual([]);
    expect(errors([create("---\ntype: moc\ndescription: A synthetic directory for testing\n---\n# New MOC", "notes/new-moc.md")])).toEqual([]);
    expect(errors([create(note({ confidence: "proven", status: "active", aliases: ["Claim Alias"], tags: ["synthetic"], cssclasses: ["card"], title: "Extra title", created: "2026-01-01", updated: "2026-01-02", received: "2026-01-01", entities: ["Fixture"], methodology: "Synthetic", promoted_from: "mem:synthetic", promoted_at: "2026-01-01", promoted_to: "org:notes/claim.md" }))])).toEqual([]);
  });
  test("rejects required fields, enums, unknown keys and uninformative descriptions", () => {
    for (const fields of [
      { description: "" }, { description: "x".repeat(201) }, { description: "Synthetic claim" },
      { description: "ＣＬＡＩＭ", title: "claim" }, { description: "claim" }, { type: "unknown" },
      { domain: "unknown" }, { confidence: "high" }, { status: "done" }, { category: "unknown" }, { privateUnknown: "private-value" },
    ]) expect(errors([create(note(fields))]).some(value => value.code === "V01")).toBe(true);
    const missing = "---\ndescription: A distinct description\n---\n# Claim\n";
    expect(errors([create(missing)]).some(value => value.code === "V01")).toBe(true);
    const unicode = note({ description: "가".repeat(200) });
    expect(errors([create(unicode)]).filter(value => value.code === "V01")).toEqual([]);
  });
  test("topics require nonempty exact wiki links to existing MOC paths, not aliases", () => {
    for (const topics of [undefined, [], "[[research]]", ["research"], ["[[missing]]"], ["[[research#Heading]]"], ["[[research|Alias]]"], [1]]) {
      const text = topics === undefined ? note().replace(/^topics:.*\n/m, "") : note({ topics });
      expect(errors([create(text)]).some(value => value.code === "V02")).toBe(true);
    }
    const notes = new Map([["notes/research.md", moc.replace("type: moc", "type: reference")]]);
    expect(errors([create(note())], context(notes)).some(value => value.code === "V02")).toBe(true);
    const aliases = new Map([["notes/research.md", moc.replace("type: moc", 'type: moc\naliases: ["Research Alias"]')]]);
    expect(errors([create(note({ topics: ["[[research alias]]"] }))], context(aliases)).some(value => value.code === "V02")).toBe(true);
  });
  test("the final snapshot resolves new MOCs and refuses removing an existing topic target", () => {
    expect(errors([create(note({ topics: ["[[new-moc]]"] }).replace("- [[research]]", "- [[new-moc]]")), create(moc.replace("# Research", "# New synthetic MOC"), "notes/new-moc.md")])).toEqual([]);
    const existing = note();
    const ctx = context(new Map([["notes/research.md", moc], ["notes/claim.md", existing]]), { op: "delete", path: "notes/research.md" });
    expect(errors([{ path: "notes/research.md", before: moc, after: null }], ctx).some(value => value.code === "V02")).toBe(true);
  });
  test("Topics section is the last H2, has exact links and skips fenced code", () => {
    const after = note({}, "# Synthetic claim\n```md\n## Wrong\n```\n## Topics\n- [[research]]\n");
    expect(validateWrite([create(after)], context()).filter(value => value.code === "V05")).toEqual([]);
    for (const body of ["# Claim\n", "# Claim\n## Topics\n- [[research]]\n## Extra\n", "# Claim\n## Topics\n- [[research]]\nextra text", "# Claim\n## Topics\n- [[research]]\n- [[research]]\n"]) {
      const found = validateWrite([create(note({}, body))], context()).filter(value => value.code === "V05");
      expect(found).toHaveLength(1); expect(found[0]!.severity).toBe("error");
    }
  });
});

describe("writer validation references and duplicates", () => {
  test("new unresolved links error, retained signatures warn, extra copies error", () => {
    const before = note({}, "# Synthetic claim\n[[missing]]\n## Topics\n- [[research]]\n");
    const ctx = context(new Map([["notes/research.md", moc], ["notes/claim.md", before]]), { op: "patch", path: "notes/claim.md", oldString: "x", newString: "y" });
    const unchanged = validateWrite([{ path: "notes/claim.md", before, after: before + "\nDetail.\n" }], ctx).filter(value => value.code === "V03");
    expect(unchanged.map(value => value.severity)).toEqual(["warning"]);
    const duplicated = validateWrite([{ path: "notes/claim.md", before, after: before + "\n[[missing]]\n" }], ctx).filter(value => value.code === "V03");
    expect(duplicated.map(value => value.severity).sort()).toEqual(["error", "warning"]);
    expect(errors([create(before)]).some(value => value.code === "V03")).toBe(true);
  });
  test("heading, block and embed links resolve using the final corpus; alias-only links are refused", () => {
    const target = note({ aliases: ["Target Alias"] }, "# Target\n## Detail\nA paragraph ^synthetic-block\n## Topics\n- [[research]]\n");
    const notes = new Map([["notes/research.md", moc], ["notes/target.md", target]]);
    const body = "# Synthetic claim\n[[TARGET#Detail]] ![[target#^synthetic-block]]\n```\n[[missing]]\n```\n## Topics\n- [[research]]\n";
    expect(errors([create(note({}, body))], context(notes))).toEqual([]);
    expect(errors([create(note({}, body.replace("[[TARGET#Detail]]", "[[TARGET ALIAS#Detail]]")))], context(notes)).some(value => value.code === "V03")).toBe(true);
    const bad = body.replace("#Detail", "#Missing");
    expect(errors([create(note({}, bad))], context(notes)).some(value => value.code === "V03")).toBe(true);
  });
  test("deletion that breaks untouched inbound links is refused", () => {
    const target = note({}, "# Target\n## Topics\n- [[research]]\n"), referring = note({}, "# Referrer\n[[target]]\n## Topics\n- [[research]]\n");
    const ctx = context(new Map([["notes/research.md", moc], ["notes/target.md", target], ["notes/referrer.md", referring]]), { op: "delete", path: "notes/target.md" });
    expect(errors([{ path: "notes/target.md", before: target, after: null }], ctx).some(value => value.code === "V03" && value.path === "notes/referrer.md")).toBe(true);
  });
  test("moving a note retains pre-existing dead-link warning identity", () => {
    const before = note({}, "# Synthetic claim\n[[missing]]\n## Topics\n- [[research]]\n");
    const ctx = context(new Map([["notes/research.md", moc], ["notes/old.md", before]]), { op: "move", from: "old", to: "new" });
    const issues = validateWrite([{ path: "notes/old.md", before, after: null }, { path: "notes/new.md", before: null, after: before }], ctx).filter(value => value.code === "V03");
    expect(issues.map(value => value.severity)).toEqual(["warning"]);
    const anchored = note({}, "# Synthetic claim\n[[old#Missing heading]]\n## Topics\n- [[research]]\n");
    const anchoredContext = context(new Map([["notes/research.md", moc], ["notes/old.md", anchored]]), { op: "move", from: "old", to: "new" });
    const anchoredIssues = validateWrite([{ path: "notes/old.md", before: anchored, after: null }, { path: "notes/new.md", before: null, after: anchored.replace("[[old#", "[[new#") }], anchoredContext).filter(value => value.code === "V03");
    expect(anchoredIssues.map(value => value.severity)).toEqual(["warning"]);
  });
  test("create refuses exact stem and NFKC-folded H1 duplicates", () => {
    const existing = note({}, "# ＳＹＮＴＨＥＴＩＣ claim\n## Topics\n- [[research]]\n");
    const ctx = context(new Map([["notes/research.md", moc], ["notes/existing.md", existing]]));
    expect(errors([create(note())], ctx).some(value => value.code === "V08")).toBe(true);
    expect(errors([create(existing, "notes/existing.md")], ctx).some(value => value.code === "V08")).toBe(true);
    expect(errors([create(existing, "notes/existing.md")], { ...ctx, operation: { op: "check", path: "notes/existing.md", text: existing } }).filter(value => value.code === "V08")).toEqual([]);
  });
  test("superseded status and supersession references need existing targets", () => {
    for (const fields of [{ status: "superseded" }, { status: "superseded", superseded_by: "[[missing]]" }, { supersedes: 42 }]) expect(errors([create(note(fields))]).some(value => value.code === "V10")).toBe(true);
    expect(errors([create(note({ status: "superseded", superseded_by: "[[research]]" }))])).toEqual([]);
  });
});

describe("writer validation path and screening", () => {
  test("restricts paths and sizes; reports are schema-exempt but screened", () => {
    for (const path of ["../claim.md", "notes/nested/claim.md", "notes/UPPER.md", "notes/한글.md", "notes/.hidden.md", `notes/${"a".repeat(193)}.md`]) expect(errors([create(note(), path)]).some(value => value.code === "V04")).toBe(true);
    expect(errors([create(note({}, "x".repeat(256 * 1024)))]).some(value => value.code === "V09")).toBe(true);
    const ctx = context(undefined, { op: "report", path: "reports/synthetic.json", text: "{}" });
    expect(errors([create("{}", "reports/synthetic.json")], ctx)).toEqual([]);
    for (const path of ["reports/../notes/claim.md", "reports/.hidden.md", "templates/claim.md", "ops//claim.md"]) expect(errors([create("{}", path)], ctx).some(value => value.code === "V04")).toBe(true);
  });
  test("secret regex set has exact parity with pinned agent-mem, without echoing matches", () => {
    const planted = [
      "-----BEGIN PRIVATE KEY-----", `AKIA${"A".repeat(16)}`, `ghp_${"A".repeat(30)}`, `github_pat_${"A".repeat(40)}`,
      `sk-${"a".repeat(20)}`, `xoxb-${"a".repeat(10)}`, `AIza${"A".repeat(35)}`, `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`, "password=synthetic-value",
      "ordinary synthetic prose", "2026-01-01", "AKIA-short", "ghp_short", "token=short", "public key discussion",
    ];
    for (const sample of planted) {
      const found = screenContent(sample, vault, config);
      expect(found.some(value => value.code === "V06")).toBe(upstreamLooksSecret(sample));
      expect(JSON.stringify(found)).not.toContain(sample);
    }
  });
  test("screens entire frontmatter and denied source paths", () => {
    expect(errors([create(note({ title: `sk-${"a".repeat(20)}` }))]).some(value => value.code === "V06")).toBe(true);
    for (const source of [".maru/secrets/synthetic.txt", "/synthetic/.env", "/synthetic/private/notes.md"]) {
      const ctx = { ...context(), config: { ...config, denyPaths: ["/private/"] } };
      expect(errors([create(note({ source }))], ctx).some(value => value.code === "V06")).toBe(true);
    }
    const found = errors([create(note({ privateUnknown: "sensitive-value" }))]);
    expect(JSON.stringify(found)).not.toContain("sensitive-value");
    expect(JSON.stringify(found)).not.toContain("privateUnknown");
  });
  test("PII defaults to org deny and personal allow, and explicit policy overrides", () => {
    for (const text of ["synthetic@example.test", "+82 10-1234-5678", "01012345678", "+1 (212) 555-0100"]) {
      expect(screenContent(text, { ...vault, kind: "org" }, config).some(value => value.code === "V07")).toBe(true);
      expect(screenContent(text, vault, config)).toEqual([]);
      expect(screenContent(text, { ...vault, pii: "deny" }, config).some(value => value.code === "V07")).toBe(true);
      expect(screenContent(text, { ...vault, kind: "org", pii: "allow" }, config)).toEqual([]);
    }
    expect(screenContent("2026-01-01", { ...vault, kind: "org" }, config)).toEqual([]);
    expect(screenContent("fixture-account-123", { ...vault, pii: "deny" }, { ...config, piiPatterns: ["fixture-account-[0-9]+"] }).some(value => value.code === "V07")).toBe(true);
    expect(screenContent("ordinary", { ...vault, pii: "deny" }, { ...config, piiPatterns: ["["] }).some(value => value.code === "V07")).toBe(true);
  });
});

test("frontmatter references resolve separately from unclosed body fences and against real target anchors", () => {
  const target = "---\ntype: moc\ndescription: An independently anchored target.\n---\n# Target\n## Detail\nA paragraph ^block\n";
  for (const suffix of ["```md\n[[hidden]]", "~~~\n[[hidden]]", "`unfinished\n[[hidden]]"]) {
    for (const [field, value] of [
      ["supersedes", "[[target]]"], ["superseded_by", "[[target]]"], ["project", "[[target#Detail]]"],
      ["source_ref", "![[target#^block]]"], ["topics", ["[[target]]"]],
    ] as const) {
      const referrer = note({ [field]: value }, `# Referrer\n${suffix}`);
      const ctx = context(new Map([["notes/research.md", moc], ["notes/target.md", target], ["notes/referrer.md", referrer]]), { op: "delete", path: "target" });
      expect(errors([], ctx).filter(value => value.code === "V03")).toEqual([]);
      expect(errors([{ path: "notes/target.md", before: target, after: null }], ctx).some(value => value.code === "V03" && value.path === "notes/referrer.md")).toBe(true);
    }
  }
});
test("moving legacy notes with an existing normalized H1 duplicate does not introduce a create duplicate", () => {
  const old = note({}, "# Shared claim\n## Topics\n- [[research]]\n"), duplicate = note({}, "# ＳＨＡＲＥＤ claim\n## Topics\n- [[research]]\n");
  const ctx = context(new Map([["notes/research.md", moc], ["notes/old.md", old], ["notes/legacy.md", duplicate]]), { op: "move", from: "old", to: "renamed" });
  const changes = [{ path: "notes/old.md", before: old, after: null }, { path: "notes/renamed.md", before: null, after: old }];
  expect(errors(changes, ctx)).toEqual([]);
  expect(errors([create(old, "notes/third.md")], { ...ctx, operation: { op: "create", path: "third", frontmatter: {} } }).some(value => value.code === "V08")).toBe(true);
});

test("ISO timestamps are metadata, while nearby telephone numbers still trigger denied PII", () => {
  const privateVault = { ...vault, kind: "org" as const };
  for (const text of ["2026-10-29 09:32", "2026-10-29T09:32:18Z", "2026-10-29T09:32:18.123+09:00"]) {
    expect(screenContent(text, privateVault, config)).toEqual([]);
    expect(screenContent(`${text} call +82 10-1234-5678`, privateVault, config).some(issue => issue.code === "V07")).toBe(true);
    expect(screenContent(`010-1234-5678 ${text} 010-9876-5432`, privateVault, config).some(issue => issue.code === "V07")).toBe(true);
    expect(screenContent(`010-1234-5678 ${text}`, privateVault, config).some(issue => issue.code === "V07")).toBe(true);
  }
});

test("space-separated telephone numbers are screened one by one", () => {
  const privateVault = { ...vault, kind: "org" as const };
  for (const text of ["010-1234-5678 010-9876-5432", "+82 10 1234 5678 +82 10 9876 5432", "02 123 4567 02 765 4321"]) {
    expect(screenContent(text, privateVault, config).some(issue => issue.code === "V07")).toBe(true);
  }
  expect(screenContent("2026-10-29 09:32 2026-10-30 10:00", privateVault, config)).toEqual([]);
});
