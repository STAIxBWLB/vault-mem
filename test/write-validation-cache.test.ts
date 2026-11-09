import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VaultSpec } from "../src/config.ts";
import { emitFrontmatter, parseFrontmatter } from "../src/frontmatter.ts";
import { planOperation, stampContentChanges } from "../src/write-operations.ts";
import type { PlannedChange, ValidationContext, WriteIssue, WriteOp } from "../src/write-types.ts";
import { createWriteValidator, validateWrite } from "../src/write-validation.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function note(title: string, body = "Synthetic evidence.", extra: Record<string, unknown> = {}): string {
  const data = { title, description: "Distinct synthetic validation evidence.", type: "insight", domain: "research", topics: ["[[research]]"], ...extra };
  return emitFrontmatter(parseFrontmatter(`# ${title}\n\n${body}\n\n## Topics\n\n- [[research]]\n`), data);
}
function context(operation: WriteOp = { op: "patch", path: "claim", oldString: "Synthetic evidence.", newString: "Edited evidence." }): ValidationContext {
  const vault: VaultSpec = { id: "fixture", path: "/synthetic/validation-vault", kind: "personal", write: "mcp", pii: "allow" };
  return { vault, config: { vaults: [vault] }, operation, notes: new Map([
    ["notes/research.md", "---\ntype: moc\ndescription: Synthetic directory.\n---\n# Research\n"],
    ["notes/claim.md", note("Claim", "Synthetic evidence. [[next#Details]]")],
    ["notes/next.md", note("Next", "## Details\n\nMore evidence.")],
  ]) };
}
function change(ctx: ValidationContext, after: string | null, path = "notes/claim.md"): PlannedChange[] { return [{ path, before: ctx.notes.get(path) ?? null, after }]; }
function equivalent(validate: (changes: PlannedChange[]) => WriteIssue[], changes: PlannedChange[], ctx: ValidationContext): WriteIssue[] {
  const result = validate(changes); expect(result).toEqual(validateWrite(changes, ctx)); return result;
}

for (const operation of [
  { op: "patch", path: "claim", oldString: "Synthetic evidence.", newString: "Edited evidence." },
  { op: "append", path: "claim", section: "Evidence", markdown: "Additional evidence." },
  { op: "frontmatter", path: "claim", set: { confidence: "likely" } },
  { op: "create", path: "new", frontmatter: { title: "New", description: "A separate finding.", type: "insight", domain: "research", topics: ["[[research]]"] } },
  { op: "supersede", old: "claim", next: "next" }, { op: "merge", keep: "claim", absorb: "next" },
  { op: "move", from: "claim", to: "renamed" }, { op: "delete", path: "claim" },
  { op: "report", path: "reports/synthetic.md", text: "Synthetic report." },
  { op: "check", path: "claim", text: note("Claim") },
] satisfies WriteOp[]) test(`write-local session equals fresh validation before and after stamping ${operation.op}`, () => {
  const ctx = context(operation), validate = createWriteValidator(ctx), raw = planOperation(operation, ctx.notes);
  const first = equivalent(validate, raw, ctx);
  const stamped = stampContentChanges(operation, raw, "2026-01-02");
  expect(equivalent(validate, stamped, ctx)).toEqual(first);
  equivalent(validate, raw, ctx);
});

test("changed metadata, body and malformed YAML are reparsed while baseline debt remains warning-only", () => {
  const ctx = context(), before = note("Claim", "Synthetic evidence. [[missing]]", { confidence: "legacy" });
  ctx.notes.set("notes/claim.md", before);
  const validate = createWriteValidator(ctx), raw = before.replace("Synthetic evidence.", "Edited evidence.");
  const retained = equivalent(validate, change(ctx, raw), ctx);
  expect(retained).toContainEqual(expect.objectContaining({ code: "V01", severity: "warning" }));
  expect(retained).toContainEqual(expect.objectContaining({ code: "V03", severity: "warning" }));
  const newDebt = equivalent(validate, change(ctx, raw + "\n[[new-missing]]\n"), ctx);
  expect(newDebt).toContainEqual(expect.objectContaining({ code: "V03", severity: "error" }));
  expect(newDebt).toContainEqual(expect.objectContaining({ code: "V05", severity: "error" }));
  const metadata = emitFrontmatter(parseFrontmatter(raw), { confidence: "new-invalid", updated: "2026-01-02" });
  expect(equivalent(validate, change(ctx, metadata), ctx)).toContainEqual(expect.objectContaining({ code: "V01", severity: "error" }));
  expect(equivalent(validate, change(ctx, "---\ninvalid: [\n---\n"), ctx)).toContainEqual(expect.objectContaining({ code: "V01", severity: "error" }));
  expect(equivalent(validate, change(ctx, raw), ctx)).toEqual(retained);
});

test("a raw secret is refused even when a later stamped candidate removes it", () => {
  const ctx = context(), validate = createWriteValidator(ctx), original = ctx.notes.get("notes/claim.md")!;
  const raw = emitFrontmatter(parseFrontmatter(original), { updated: "password: synthetic-value" });
  const stamped = emitFrontmatter(parseFrontmatter(raw), { updated: "2026-01-02" });
  for (const candidate of [raw, stamped, raw]) {
    const issues = equivalent(validate, change(ctx, candidate), ctx);
    if (candidate === raw) expect(issues).toContainEqual(expect.objectContaining({ code: "V06", severity: "error", path: "notes/claim.md" }));
    else expect(issues.some(issue => issue.code === "V06")).toBe(false);
  }
  expect(ctx.notes.get("notes/claim.md")).toBe(original);
});

test("deleted and restored targets cannot leave stale names, anchors or MOC membership", () => {
  const ctx = context(), validate = createWriteValidator(ctx), original = ctx.notes.get("notes/claim.md")!;
  expect(equivalent(validate, change(ctx, original.replace("Synthetic evidence.", "Edited evidence.")), ctx).filter(issue => issue.severity === "error")).toEqual([]);
  const deleted = equivalent(validate, [{ path: "notes/research.md", before: ctx.notes.get("notes/research.md")!, after: null }], ctx);
  expect(deleted).toContainEqual(expect.objectContaining({ code: "V02", severity: "error" }));
  const missingAnchor = note("Next", "A changed body without Details.");
  expect(equivalent(validate, change(ctx, missingAnchor, "notes/next.md"), ctx)).toContainEqual(expect.objectContaining({ code: "V03", severity: "error" }));
  expect(equivalent(validate, [], ctx).filter(issue => issue.severity === "error")).toEqual([]);
});

test("baseline path/source edits and Map order changes invalidate only session-local parsed reuse", () => {
  const ctx = context(), validate = createWriteValidator(ctx), next = ctx.notes.get("notes/next.md")!;
  equivalent(validate, [], ctx);
  ctx.notes.delete("notes/next.md");
  expect(equivalent(validate, [], ctx)).toContainEqual(expect.objectContaining({ code: "V03", severity: "warning" }));
  ctx.notes.set("notes/next.md", next.replace("## Details", "## Renamed"));
  expect(equivalent(validate, [], ctx)).toContainEqual(expect.objectContaining({ code: "V03", severity: "warning" }));
  ctx.notes.set("notes/next.md", next);
  const first = ctx.notes.get("notes/research.md")!; ctx.notes.delete("notes/research.md"); ctx.notes.set("notes/research.md", first);
  expect(equivalent(validate, [], ctx)).toEqual([]);
});

test("screens and policy rerun on every call and sessions never share mutable results", () => {
  const allow = context(), deny = context(); deny.vault.pii = "deny";
  const first = createWriteValidator(allow), second = createWriteValidator(deny);
  const text = note("Claim", "Synthetic evidence. fixture@example.invalid");
  const accepted = equivalent(first, change(allow, text), allow);
  expect(accepted.some(issue => issue.code === "V07")).toBe(false);
  expect(equivalent(second, change(deny, text), deny)).toContainEqual(expect.objectContaining({ code: "V07", severity: "error" }));
  accepted.push({ code: "SYNTHETIC", message: "Caller-owned issue", severity: "warning" });
  expect(equivalent(first, change(allow, text), allow).some(issue => issue.code === "SYNTHETIC")).toBe(false);
  allow.vault.pii = "deny";
  expect(equivalent(first, change(allow, text), allow)).toContainEqual(expect.objectContaining({ code: "V07", severity: "error" }));
  expect(equivalent(first, change(allow, note("Claim", "password: synthetic-value")), allow)).toContainEqual(expect.objectContaining({ code: "V06", severity: "error" }));
});

test("source existence and deny policy are not cached with parsed notes", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-validation-source-"))); roots.push(root);
  const ctx = context(); ctx.vault.registry = join(root, "registry.yaml");
  const validate = createWriteValidator(ctx), candidate = change(ctx, note("Claim", "Edited evidence.", { source: "evidence.md" }));
  expect(equivalent(validate, candidate, ctx)).toContainEqual(expect.objectContaining({ code: "V11", severity: "warning" }));
  writeFileSync(join(root, "evidence.md"), "Synthetic source evidence.\n");
  expect(equivalent(validate, candidate, ctx).some(issue => issue.code === "V11")).toBe(false);
  ctx.config.denyPaths = [join(root, "evidence.md")];
  expect(equivalent(validate, candidate, ctx)).toContainEqual(expect.objectContaining({ code: "V06", severity: "error" }));
});
