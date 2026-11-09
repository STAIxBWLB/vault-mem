import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { applyWrite, MAX_WRITE_BYTES, sha256 } from "../src/writer.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { planOperation } from "../src/write-operations.ts";
import type { WriteOp, WriteReceipt } from "../src/write-types.ts";

const roots: string[] = [];
const now = new Date(2026, 0, 2, 1), today = "2026-01-02";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const metadata = { title: "Existing Finding", description: "Synthetic evidence for preserving authored changes.", type: "insight", domain: "research", topics: ["[[research]]"] };
const body = "# Existing Finding\n\nOriginal evidence.\n\n## Topics\n\n- [[research]]\n";
function note(title = "Existing Finding", content = body): string {
  return "---\n" + Object.entries({ ...metadata, title }).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join("") + "---\n" + content;
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-date-followups-"))); roots.push(root);
  const home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
  writeFileSync(join(notes, "existing.md"), note());
  addVault(home, { id: "test", path: vault, kind: "personal", write: "mcp" });
  const write = (operation: WriteOp, dryRun = false) => applyWrite(home, { vault: "test", operation, dryRun }, { env: {}, now });
  return { root, home, vault, notes, write };
}
function disk(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    try { files[name] = readFileSync(join(root, name)).toString("base64"); } catch { /* Directories have no content. */ }
  }
  return files;
}
function atBytes(text: string, maximum: number): string {
  const padding = maximum - Buffer.byteLength(text) + Buffer.byteLength("PADDING");
  expect(padding).toBeGreaterThan(0);
  const filled = text.replace("PADDING", "X".repeat(padding));
  expect(Buffer.byteLength(filled)).toBe(maximum);
  return filled;
}
function stampWarning(receipt: WriteReceipt, cause: RegExp) {
  expect(receipt.issues).toContainEqual(expect.objectContaining({ code: "V01", severity: "warning" }));
  expect(receipt.issues.some(issue => issue.code === "V01" && issue.severity === "warning" && cause.test(issue.message))).toBe(true);
  expect(receipt.issues.some(issue => issue.severity === "error")).toBe(false);
}

for (const format of ["flow", "merge-key"] as const) for (const kind of ["patch", "append"] as const) test(`#185 ${kind} preserves an uneditable ${format} header byte for byte and warns instead of canonicalizing it`, () => {
  const f = fixture(), file = join(f.notes, "existing.md");
  const fields = { ...metadata, created: "legacy creation", updated: "2001-01-01" };
  const header = format === "flow"
    ? "﻿---\r\n# keep this flow comment\r\n" + JSON.stringify(fields) + " # keep this trailing comment\r\n---\r\n"
    : "---\n# keep this merge-key comment\n<<: {status: active}\n" + Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join("") + "---\n";
  const original = header + (format === "flow" ? body.replaceAll("\n", "\r\n") : body);
  writeFileSync(file, original);
  const operation: WriteOp = kind === "patch"
    ? { op: "patch", path: "existing", oldString: "Original evidence.", newString: "Changed authored evidence." }
    : { op: "append", path: "existing", section: "Evidence", markdown: "Added authored evidence." };
  const candidate = planOperation(operation, new Map([["notes/existing.md", original]]))[0]!.after!;
  expect(parseFrontmatter(candidate).frontmatter).toBe(header);
  const before = disk(f.root), preview = f.write(operation, true);
  expect(preview).toMatchObject({ ok: true, applied: false, preview: true });
  stampWarning(preview, /header|mapping|edit|canonical/i);
  expect(preview.changes).toContainEqual(expect.objectContaining({ path: "notes/existing.md", sha256: sha256(candidate) }));
  expect(disk(f.root)).toEqual(before);
  const result = f.write(operation);
  expect(result).toMatchObject({ ok: true, applied: true });
  stampWarning(result, /header|mapping|edit|canonical/i);
  expect(readFileSync(file, "utf8")).toBe(candidate);
  const after = parseFrontmatter(candidate);
  expect(after.frontmatter).toBe(header);
  expect(after.data).toMatchObject({ created: "legacy creation", updated: "2001-01-01" });
});

for (const kind of ["patch", "create"] as const) test(`#185 ${kind} accepts an exact-limit authored candidate when only automatic dates exceed the limit`, () => {
  const f = fixture(), file = join(f.notes, kind === "create" ? "new-finding.md" : "existing.md");
  let operation: WriteOp, candidate: string;
  if (kind === "patch") {
    const original = atBytes(note("Existing Finding", body.replace("Original evidence.", "Original evidence.\n\nPADDING")), MAX_WRITE_BYTES - 1);
    writeFileSync(file, original);
    operation = { op: "patch", path: "existing", oldString: "Original evidence.", newString: "Original evidence.!" };
    candidate = original.replace("Original evidence.", "Original evidence.!");
  } else {
    candidate = atBytes(note("New Finding", body.replace("Existing Finding", "New Finding").replace("Original evidence.", "Original evidence.\n\nPADDING")), MAX_WRITE_BYTES);
    operation = { op: "create", path: "new-finding", frontmatter: {}, body: candidate };
  }
  expect(Buffer.byteLength(candidate)).toBe(MAX_WRITE_BYTES);
  const before = disk(f.root), preview = f.write(operation, true);
  expect(preview).toMatchObject({ ok: true, applied: false, preview: true });
  stampWarning(preview, /limit|size|256|budget/i);
  expect(preview.changes).toContainEqual(expect.objectContaining({ sha256: sha256(candidate), bytes: MAX_WRITE_BYTES }));
  expect(disk(f.root)).toEqual(before);
  const result = f.write(operation);
  expect(result).toMatchObject({ ok: true, applied: true });
  stampWarning(result, /limit|size|256|budget/i);
  expect(readFileSync(file, "utf8")).toBe(candidate);
  const data = parseFrontmatter(candidate).data;
  expect(data).not.toHaveProperty("updated");
  expect(data).not.toHaveProperty("created");
});

for (const kind of ["patch", "create"] as const) test(`#185 ${kind} still refuses an oversized caller candidate before automatic stamping`, () => {
  const f = fixture();
  const original = atBytes(note("Existing Finding", body.replace("Original evidence.", "Original evidence.\n\nPADDING")), MAX_WRITE_BYTES);
  writeFileSync(join(f.notes, "existing.md"), original);
  const operation: WriteOp = kind === "patch"
    ? { op: "patch", path: "existing", oldString: "Original evidence.", newString: "Original evidence.!" }
    : { op: "create", path: "new-finding", frontmatter: {}, body: atBytes(note("New Finding", body.replace("Existing Finding", "New Finding").replace("Original evidence.", "Original evidence.\n\nPADDING")), MAX_WRITE_BYTES + 1) };
  const before = disk(f.root);
  for (const dryRun of [true, false]) {
    const result = f.write(operation, dryRun);
    expect(result).toMatchObject({ ok: false, applied: false });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "V09", severity: "error" }));
    expect(disk(f.root)).toEqual(before);
  }
  expect(existsSync(join(f.notes, "new-finding.md"))).toBe(false);
});

for (const intent of ["set", "unset"] as const) test(`#185 automatic today takes precedence over an explicit updated ${intent} on an authored write`, () => {
  const f = fixture(), file = join(f.notes, "existing.md"), original = note().replace("---\n# Existing", 'created: "legacy creation"\nupdated: "2001-01-01"\n---\n# Existing');
  writeFileSync(file, original);
  const operation: WriteOp = intent === "set"
    ? { op: "frontmatter", path: "existing", set: { updated: "1999-12-31" } }
    : { op: "frontmatter", path: "existing", set: {}, unset: ["updated"] };
  const before = disk(f.root), preview = f.write(operation, true);
  expect(preview).toMatchObject({ ok: true, applied: false, preview: true });
  expect(disk(f.root)).toEqual(before);
  expect(f.write(operation)).toMatchObject({ ok: true, applied: true });
  const after = parseFrontmatter(readFileSync(file, "utf8"));
  expect(after.data).toMatchObject({ updated: today, created: "legacy creation" });
  expect(after.body).toBe(parseFrontmatter(original).body);
});
