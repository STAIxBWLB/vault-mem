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
  expect(dry).toMatchObject({ code: 0, text: expect.stringMatching(/^dry run: would create notes\/fresh-finding\.md\n\nlog: none \(dry run\)$/) });
  const json = run([...args, "--dry-run", "--json"], f.env).text;
  expect(json).toBe(JSON.stringify(JSON.parse(json)));
  expect(JSON.parse(json)).toMatchObject({ ok: true, preview: true, changes: [{ path: "notes/fresh-finding.md" }] });
  const created = run(args, f.env);
  expect(created.code).toBe(0);
  expect(created.text).toMatch(/^created notes\/fresh-finding\.md\n  sha256  [0-9a-f]{64}\n\nlog: appended \(\d+ bytes\)$/);
  expect(created.text).not.toContain("separate synthetic result");
  expect(run([...args, "--color=always"], f.env).text).toContain("\u001b[");
});

test("a multi-file change prints a CHANGES table and a refusal prints the issue table", () => {
  const link = receipt({ changes: [{ path: "notes/a.md", beforeSha: SHA, sha256: SHA, bytes: 245 }, { path: "notes/b.md", beforeSha: SHA, sha256: null, bytes: 0 }], log: { ok: true, appended: true, synced: true, bytesWritten: 71, issues: [] } });
  expect(renderWriteReceipt(link, PLAIN, ctx("link", "test", "a", "b", "--relation", "supports"))).toBe([
    "linked notes/a.md and notes/b.md", "",
    "PATH        ACTION  BYTES  SHA", "notes/a.md  update  245    aaaaaaaaaaaa", "notes/b.md  delete  -      -", "",
    "log: appended (71 bytes)"].join("\n"));
  const refused = receipt({ ok: false, applied: false, issues: [{ code: "V02", severity: "warning", path: "notes/x.md", message: "weak" }, { code: "V01", severity: "error", path: "notes/x.md", message: "invalid or missing note type" }], possibleDuplicates: ["notes/y.md"] });
  expect(renderWriteReceipt(refused, PLAIN, ctx("new", "test", "x"))).toBe([
    "refused: nothing written", "",
    "LEVEL    CODE  PATH        MESSAGE", "error    V01   notes/x.md  invalid or missing note type", "warning  V02   notes/x.md  weak", "",
    "possible duplicates:", "  - notes/y.md"].join("\n"));
  expect(renderWriteReceipt(receipt({ applied: false, unchanged: true }), PLAIN, ctx("link", "test", "a", "b"))).toBe("unchanged: links already present");
  const logFailed = receipt({ changes: [{ path: "notes/a.md", beforeSha: SHA, sha256: SHA, bytes: 9 }], log: { ok: false, appended: null, synced: false, bytesWritten: null, issues: [{ code: "LOG_IO", severity: "error", message: "log append failed" }] } });
  expect(renderWriteReceipt(logFailed, PLAIN, ctx("patch", "test", "a"))).toContain("patched notes/a.md\n  sha256  " + SHA + "\n\nlog: not appended\n\nLEVEL  CODE    PATH  MESSAGE\nerror  LOG_IO  -     log append failed");
  expect(renderWriteReceipt(receipt({ preview: true, applied: false }), PLAIN, ctx("check", "test", "-", "--path", "x"))).toBe("ok: the note passes validation");
  expect(renderWriteReceipt(receipt({ ok: false, applied: false, preview: true, issues: [{ code: "V01", severity: "error", path: "notes/x.md", message: "bad" }] }), PLAIN, ctx("check", "test", "-")))
    .toBe("LEVEL  CODE  PATH        MESSAGE\nerror  V01   notes/x.md  bad\n\nfail: notes/x.md has 1 error");
});

test("#114 AC4: a move preview prints the plan and a confirm command that applies with the same fingerprint", () => {
  const f = fixture(), preview = run(["move", "test", "lone", "lone-renamed"], f.env), json = JSON.parse(run(["move", "test", "lone", "lone-renamed", "--json"], f.env).text);
  expect(preview.code).toBe(0);
  const parts = preview.text.split("\n\n");
  expect(parts[0]).toBe("dry run: would move notes/lone.md to notes/lone-renamed.md and rewrite links in 1 note");
  expect(parts[1]!.split("\n").map(row => row.split(/ +/).slice(0, 2).join(" "))).toEqual(["PATH ACTION", "notes/lone-renamed.md create", "notes/lone.md delete", "notes/old.md update"]);
  expect(parts.slice(2)).toEqual(["log: written on confirm", `confirm: vmem move test lone lone-renamed --confirm --fingerprint ${json.fingerprint}`]);
  const confirm = preview.text.split("confirm: vmem ")[1]!.split(" ");
  const done = run(confirm, f.env);
  expect(done).toMatchObject({ code: 0, text: expect.stringMatching(/^moved notes\/lone\.md to notes\/lone-renamed\.md and rewrote links in 1 note\n/) });
  expect(confirmCommand(["delete", "v", "a b", "--log", "{\"note\":\"it's\"}", "--json", "--dry-run", "--fingerprint", "old"], FP))
    .toBe(`vmem delete v 'a b' --log '{"note":"it'"'"'s"}' --confirm --fingerprint ${FP}`);
});

test("tidy previews show counts per rule, the notes touched and the confirm command", () => {
  const preview: TidyResult = { ok: true, applied: false, preview: true, rules: ["connections", "enums"], counts: { enums: 2 }, notes: [{ path: "notes/a.md", changes: ["x", "y"] }],
    reported: [{ path: "notes/b.md", message: "unparsable note skipped" }], written: [], issues: [], fingerprint: FP, event: "tidy: connections 0, enums 2" };
  expect(renderTidy(preview, PLAIN, ctx("tidy", "test", "--connections", "--enums", "--json"))).toBe([
    "dry run: would tidy 1 note in test", "", "RULE   CHANGES", "enums  2", "", "NOTE        CHANGES", "notes/a.md  2", "",
    "LEFT UNCHANGED  REASON", "notes/b.md      unparsable note skipped", "", `confirm: vmem tidy test --connections --enums --confirm --fingerprint ${FP}`].join("\n"));
  expect(renderTidy({ ...preview, preview: undefined, applied: true, written: ["notes/a.md"], reported: [] }, PLAIN, ctx("tidy", "test", "--all")))
    .toBe("tidied 1 note in test\n\nRULE   CHANGES\nenums  2\n\nNOTE        CHANGES\nnotes/a.md  2\n\nlogged: LINT tidy: connections 0, enums 2");
  expect(renderTidy({ ...preview, counts: {}, notes: [], reported: [] }, PLAIN, ctx("tidy", "test", "--all"))).toBe("unchanged: nothing to tidy in test");
  const f = fixture();
  expect(run(["tidy", "test", "--connections"], f.env).text).toBe("unchanged: nothing to tidy in test");
});

test("promote, sync and promote-from-amem previews print the confirm command; drafts stay out of the text", () => {
  const promote: OrgPromoteResult = { ok: true, applied: false, preview: true, source: "mine:notes/a.md", target: "team:notes/a.md", text: "SECRET BODY", droppedLinks: ["private"],
    screen: { passed: true, issues: [] }, fingerprint: FP, issues: [], lint: { passed: true, issues: [] } };
  expect(renderOrgPromote(promote, PLAIN, ctx("promote", "mine", "a", "--to", "team"))).toBe([
    "dry run: would promote mine:notes/a.md to team:notes/a.md", "", "dropped links:", "  - private", "", "org lint: passed", "",
    `confirm: vmem promote mine a --to team --confirm --fingerprint ${FP}`].join("\n"));
  const sync: SyncResult = { ok: true, applied: false, preview: true, vault: "team", remote: { configured: "git@example.com:o/v.git", origin: "git@example.com:o/v.git", matches: true },
    branch: "main", paths: ["notes/a.md"], ignored: ["scratch.txt"], ahead: 0, behind: 1, fingerprint: FP, issues: [] };
  expect(renderSync(sync, PLAIN, ctx("sync", "team", "--message", "two words"))).toBe([
    "dry run: would commit 1 path, rebase onto origin/main, push main to git@example.com:o/v.git",
    "  vault   team", "  branch  main", "  remote  git@example.com:o/v.git", "  origin  git@example.com:o/v.git", "  ahead   0", "  behind  1", "",
    "PATH", "notes/a.md", "", "not synced (outside notes/, reports/ and log):", "  - scratch.txt", "",
    `confirm: vmem sync team --message 'two words' --confirm --fingerprint ${FP}`].join("\n"));
  expect(renderSync({ ...sync, preview: undefined, applied: true, commit: "c".repeat(40), pushed: true }, PLAIN, ctx("sync", "team")).split("\n")[0]).toBe("synced team: cccccccccccc pushed to git@example.com:o/v.git main");
  const amem: PromoteResult = { ok: true, action: "create", applied: false, preview: true, id: "0".repeat(32), path: "notes/a.md", text: "SECRET BODY", fingerprint: FP, issues: [], linked: null };
  const argv = ["promote-from-amem", "mine", "0".repeat(32), "--edit", "--json"];
  expect(renderPromote(amem, PLAIN, ctx(...argv), true)).toBe([
    `dry run: would create notes/a.md from mem:${"0".repeat(32)}`, "", "draft: 11 bytes; --json shows the text, --edit opens it in $EDITOR", "",
    "edited text is only previewed: save it and confirm with --body <file> and this fingerprint", "",
    `confirm: vmem promote-from-amem mine ${"0".repeat(32)} --body <file> --confirm --fingerprint ${FP}`].join("\n"));
  for (const text of [renderOrgPromote(promote, PLAIN, ctx("promote", "mine", "a")), renderPromote(amem, PLAIN, ctx(...argv))]) expect(text).not.toContain("SECRET");
  expect(renderPromote({ ...amem, action: "link", alreadyLinked: true, linked: "notes/a.md", text: undefined }, PLAIN, ctx("promote-from-amem", "mine", "x"))).toBe(`unchanged: mem:${"0".repeat(32)} already links notes/a.md\n  linked  notes/a.md`);
  const list = { projects: [{ project: "p", candidates: [{ id: "1".repeat(32), project: "p", kind: "decision", title: "한글 제목", at: "2026-11-04" }] }] };
  expect(renderCandidates(list, PLAIN, ctx("promote-from-amem", "mine"))).toBe([
    "p: 1 candidate", "ID                                KIND      AT          TITLE", `${"1".repeat(32)}  decision  2026-11-04  한글 제목`, "",
    `preview one: vmem promote-from-amem mine ${"1".repeat(32)} --project p`].join("\n"));
  expect(renderCandidates({ projects: [] }, PLAIN, ctx("promote-from-amem", "mine"))).toBe("no promotion candidates");
});
