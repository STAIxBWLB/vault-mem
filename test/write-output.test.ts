import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { run } from "../src/cli.ts";
import { PLAIN } from "../src/text-output.ts";
import { confirmCommand, renderCandidates, renderOrgPromote, renderPromote, renderSync, renderTidy, renderWriteReceipt } from "../src/write-output.ts";
import type { WriteReceipt } from "../src/write-types.ts";
import type { TidyResult } from "../src/tidy.ts";
import type { OrgPromoteResult } from "../src/org-promote.ts";
import type { SyncResult } from "../src/sync.ts";
import type { PromoteResult } from "../src/promote.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const note = (title: string, body: string) => `---\ntitle: ${JSON.stringify(title)}\ndescription: Synthetic evidence for navigation.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\n---\n# ${title}\n\n${body}\n\n## Topics\n\n- [[research]]\n`;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-write-output-"))); roots.push(root);
  const home = join(root, "state"), vault = join(root, "vault"), notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
  writeFileSync(join(notes, "old.md"), note("Old Finding", "Original text. See [[lone]]."));
  writeFileSync(join(notes, "lone.md"), note("Lone Finding", "Unlinked text."));
  addVault(home, { id: "test", path: vault, kind: "personal", write: "mcp" });
  return { env: { VMEM_HOME: home } };
}
const SHA = "a".repeat(64), FP = "f".repeat(64);
const ctx = (...argv: string[]) => ({ argv, positional: argv.slice(1).filter(word => !word.startsWith("--")) });
const receipt = (extra: Partial<WriteReceipt>): WriteReceipt => ({ ok: true, applied: true, issues: [], changes: [], indexUpdated: true, ...extra });

test("#114 AC1: a create prints what changed, its sha and the log receipt; --json keeps the compact JSON", () => {
  const f = fixture(), args = ["new", "test", "fresh-finding", "--type", "insight", "--domain", "research", "--topics", "research", "--description", "A separate synthetic result."];
  const dry = run([...args, "--dry-run"], f.env);
  expect(dry.code).toBe(0);
  expect(dry.text).toContain("dry run: would create notes/fresh-finding.md");
  expect(dry.text).toContain("none (dry run)");
  const json = run([...args, "--dry-run", "--json"], f.env).text;
  expect(json).toBe(JSON.stringify(JSON.parse(json)));
  expect(JSON.parse(json)).toMatchObject({ ok: true, preview: true, changes: [{ path: "notes/fresh-finding.md" }] });
  const created = run(args, f.env);
  expect(created.code).toBe(0);
  expect(created.text).toContain("created notes/fresh-finding.md");
  expect(created.text).toMatch(/sha256 [0-9a-f]{64}/);
  expect(created.text).toContain("appended");
  expect(created.text).not.toContain("separate synthetic result");
  expect(run([...args, "--color=always"], f.env).text).toContain("\u001b[");
});

test("a multi-file change prints a CHANGES table and a refusal prints the issue table", () => {
  const link = receipt({ changes: [{ path: "notes/a.md", beforeSha: SHA, sha256: SHA, bytes: 245 }, { path: "notes/b.md", beforeSha: SHA, sha256: null, bytes: 0 }], log: { ok: true, appended: true, synced: true, bytesWritten: 71, issues: [] } });
  const linked = renderWriteReceipt(link, PLAIN, ctx("link", "test", "a", "b", "--relation", "supports"));
  expect(linked).toContain("linked notes/a.md and notes/b.md");
  expect(linked).toContain("notes/a.md: update");
  expect(linked).toContain("notes/b.md: delete");
  const refused = receipt({ ok: false, applied: false, issues: [{ code: "V02", severity: "warning", path: "notes/x.md", message: "weak" }, { code: "V01", severity: "error", path: "notes/x.md", message: "invalid or missing note type" }], possibleDuplicates: ["notes/y.md"] });
  const refusedText = renderWriteReceipt(refused, PLAIN, ctx("new", "test", "x"));
  expect(refusedText.indexOf("V01")).toBeLessThan(refusedText.indexOf("V02"));
  expect(refusedText).toContain("notes/y.md");
  expect(renderWriteReceipt(receipt({ applied: false, unchanged: true }), PLAIN, ctx("link", "test", "a", "b"))).toContain("unchanged: links already present");
  const logFailed = receipt({ changes: [{ path: "notes/a.md", beforeSha: SHA, sha256: SHA, bytes: 9 }], log: { ok: false, appended: null, synced: false, bytesWritten: null, issues: [{ code: "LOG_IO", severity: "error", message: "log append failed" }] } });
  const logText = renderWriteReceipt(logFailed, PLAIN, ctx("patch", "test", "a"));
  expect(logText).toContain("log append failed"); expect(logText).toContain(SHA);
  const check = renderWriteReceipt(receipt({ ok: false, applied: false, preview: true, issues: [{ code: "V01", severity: "error", path: "notes/x.md", message: "bad" }] }), PLAIN, ctx("check", "test", "-"));
  expect(check).toContain("V01 notes/x.md: bad"); expect(check.split("\n").at(-1)).toBe("✗ 1 failed");
  expect(check).not.toContain("fail: notes/x.md has");
});

test("#114 AC4: a move preview prints the plan and a confirm command that applies with the same fingerprint", () => {
  const f = fixture(), preview = run(["move", "test", "lone", "lone-renamed"], f.env), json = JSON.parse(run(["move", "test", "lone", "lone-renamed", "--json"], f.env).text);
  expect(preview.code).toBe(0);
  expect(preview.text).toContain("would move notes/lone.md to notes/lone-renamed.md");
  for (const path of ["notes/lone-renamed.md", "notes/lone.md", "notes/old.md"]) expect(preview.text).toContain(path);
  const command = `vmem move test lone lone-renamed --confirm --fingerprint ${json.fingerprint}`;
  expect(preview.text).toContain(command);
  const done = run(command.split(" ").slice(1), f.env);
  expect(done.code).toBe(0); expect(done.text).toContain("moved notes/lone.md");
  expect(confirmCommand(["delete", "v", "a b", "--log", "{\"note\":\"it's\"}", "--json", "--dry-run", "--fingerprint", "old"], FP))
    .toBe(`vmem delete v 'a b' --log '{"note":"it'"'"'s"}' --confirm --fingerprint ${FP}`);
});

test("tidy previews show counts per rule, the notes touched and the confirm command", () => {
  const preview: TidyResult = { ok: true, applied: false, preview: true, rules: ["connections", "enums"], counts: { enums: 2 }, notes: [{ path: "notes/a.md", changes: ["x", "y"] }],
    reported: [{ path: "notes/b.md", message: "unparsable note skipped" }], written: [], issues: [], fingerprint: FP, event: "tidy: connections 0, enums 2" };
  const text = renderTidy(preview, PLAIN, ctx("tidy", "test", "--connections", "--enums", "--json"));
  expect(text).toContain("would tidy 1 note"); expect(text).toContain("unparsable note skipped");
  expect(text).toContain(`vmem tidy test --connections --enums --confirm --fingerprint ${FP}`);
  expect(renderTidy({ ...preview, preview: undefined, applied: true, written: ["notes/a.md"], reported: [] }, PLAIN, ctx("tidy", "test", "--all"))).toContain("logged LINT");
  expect(renderTidy({ ...preview, counts: {}, notes: [], reported: [] }, PLAIN, ctx("tidy", "test", "--all"))).toContain("nothing to tidy");
  const f = fixture(); expect(run(["tidy", "test", "--connections"], f.env).text).toContain("nothing to tidy");
});

test("promote, sync and promote-from-amem previews print the confirm command; drafts stay out of the text", () => {
  const promote: OrgPromoteResult = { ok: true, applied: false, preview: true, source: "mine:notes/a.md", target: "team:notes/a.md", text: "SECRET BODY", droppedLinks: ["private"],
    screen: { passed: true, issues: [] }, fingerprint: FP, issues: [], lint: { passed: true, issues: [] } };
  const promoted = renderOrgPromote(promote, PLAIN, ctx("promote", "mine", "a", "--to", "team"));
  expect(promoted).toContain("private"); expect(promoted).toContain(`vmem promote mine a --to team --confirm --fingerprint ${FP}`);
  const sync: SyncResult = { ok: true, applied: false, preview: true, vault: "team", remote: { configured: "git@example.com:o/v.git", origin: "git@example.com:o/v.git", matches: true }, branch: "main", paths: ["notes/a.md"], ignored: ["scratch.txt"], ahead: 0, behind: 1, fingerprint: FP, issues: [] };
  const syncText = renderSync(sync, PLAIN, ctx("sync", "team", "--message", "two words"));
  expect(syncText).toContain("scratch.txt"); expect(syncText).toContain(`vmem sync team --message 'two words' --confirm --fingerprint ${FP}`);
  const amem: PromoteResult = { ok: true, action: "create", applied: false, preview: true, id: "0".repeat(32), path: "notes/a.md", text: "SECRET BODY", fingerprint: FP, issues: [], linked: null };
  const argv = ["promote-from-amem", "mine", "0".repeat(32), "--edit", "--json"];
  const edited = renderPromote(amem, PLAIN, ctx(...argv), true);
  expect(edited).not.toContain("--body <file>"); expect(edited).not.toContain("--confirm --fingerprint");
  expect(edited).toContain("--json"); expect(edited).toContain("--body");
  for (const text of [promoted, edited, renderPromote(amem, PLAIN, ctx(...argv))]) expect(text).not.toContain("SECRET");
  expect(renderPromote({ ...amem, action: "link", alreadyLinked: true, linked: "notes/a.md", text: undefined }, PLAIN, ctx("promote-from-amem", "mine", "x"))).toContain("already links notes/a.md");
  const list = { projects: [{ project: "p", candidates: [{ id: "1".repeat(32), project: "p", kind: "decision", title: "한글 제목", at: "2026-11-04" }] }] };
  expect(renderCandidates(list, PLAIN, ctx("promote-from-amem", "mine"))).toContain(`vmem promote-from-amem mine ${"1".repeat(32)} --project p`);
  expect(renderCandidates({ projects: [] }, PLAIN, ctx("promote-from-amem", "mine"))).toContain("no promotion candidates");
});
