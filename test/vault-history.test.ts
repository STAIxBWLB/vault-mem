import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { run } from "../src/cli.ts";
import { COMMANDS } from "../src/commands-table.ts";
import { validArguments } from "../src/mcp.ts";
import { createVaultMcp, VMEM_TOOL_NAMES } from "../src/mcp-vault.ts";
import { MAX_NOTE_BYTES } from "../src/vault-index.ts";
import { CHANGES_PAGE_LIMIT, HISTORY_PAGE_LIMIT, HISTORY_SCAN_LIMIT, SNAPSHOT_CURSOR_CHARS, SNAPSHOT_TRANSPORT_BYTES, readChanges, readHistory, readRevision } from "../src/vault-history.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const neutral = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const gitEnv = { ...neutral, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "init.templateDir=", "-C", cwd, ...args], { env: gitEnv, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
const note = (title: string, body: string) => `---\ntitle: ${JSON.stringify(title)}\ndescription: Synthetic history evidence.\ntype: insight\ndomain: research\n---\n# ${title}\n\n${body}\n`;
/** What one result costs on the wire: the MCP transport stringifies the handler result into the JSON-RPC frame. */
const frameBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(JSON.stringify(value)));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-history-"))); roots.push(root);
  const home = join(root, "state"), vault = join(root, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  git(vault, "init", "--quiet", "-b", "main");
  const spec = { id: "demo", path: vault, kind: "personal" as const, write: "cli" as const };
  addVault(home, spec);
  const write = (path: string, content: string | Uint8Array): void => {
    const file = join(vault, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  };
  const commit = (message: string): string => { git(vault, "add", "-A"); git(vault, "commit", "--quiet", "-m", message); return git(vault, "rev-parse", "HEAD"); };
  const read = (path: string, extra: Record<string, unknown> = {}) => readHistory({ vault: spec, home, note: path, env: gitEnv, ...extra });
  return { root, home, vault, spec, env: { VMEM_HOME: home }, git, write, commit, read };
}
function tree(dir: string, base = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!base && entry.name === ".git") continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, tree(join(dir, entry.name), rel));
    else if (entry.isFile()) out[rel] = readFileSync(join(dir, entry.name)).toString("base64");
  }
  return out;
}
const fingerprint = (vault: string) => ({ status: git(vault, "status", "--porcelain=v1", "--untracked-files=all"),
  refs: git(vault, "for-each-ref", "--format=%(refname) %(objectname)"), index: readFileSync(join(vault, ".git/index")).toString("base64"), files: tree(vault) });

test("history lists one note's first-parent revisions with Git blob ids, sizes and the pinned head", () => {
  const f = fixture();
  const firstBody = note("Alpha", "first text");
  f.write("notes/alpha.md", firstBody);
  const first = f.commit("alpha v1");
  f.write("notes/other.md", note("Other", "unrelated"));
  f.commit("other note");
  const headBody = note("Alpha", "second text");
  f.write("notes/alpha.md", headBody);
  const head = f.commit("alpha v2");
  const result = f.read("notes/alpha.md");
  expect(result.schemaVersion).toBe(1);
  expect(result.basis).toBe("git_snapshot");
  expect(result.vault).toBe("demo");
  expect(result.head).toBe(head);
  expect(result.firstParent).toBe(true);
  expect(result.renamePolicy).toBe("exact_path");
  expect(result.timeBasis).toBe("git_commit_metadata_not_assertion_time");
  expect(result.coverage).toEqual({ complete: true });
  expect(result.dirtyNotes).toBe(0);
  expect(result.path).toBe("notes/alpha.md");
  expect(result.revisions.map(revision => revision.revision)).toEqual([head, first]);
  expect(result.revisions[1]).toEqual({ revision: first, blob: f.git(f.vault, "rev-parse", `${first}:notes/alpha.md`), bytes: Buffer.byteLength(firstBody),
    committedAt: f.git(f.vault, "log", "-1", "--format=%cI", first) });
  expect(result.revisions[0]!.blob).toBe(f.git(f.vault, "rev-parse", `${head}:notes/alpha.md`));
  expect(result.revisions[0]!.bytes).toBe(Buffer.byteLength(headBody));
  // `scanned` counts commits traversed, not commits that touched the path: the unrelated commit is walked too.
  expect(result.scanned).toBe(3);
  expect(result.scanLimit).toBe(HISTORY_SCAN_LIMIT);
  expect(result.pageLimit).toBe(HISTORY_PAGE_LIMIT);
  expect(result.stopReason).toBe("history_end");
  expect(result.truncated).toBe(false);
  expect(result).not.toHaveProperty("continuation");
  expect(result.skippedSymlink).toBe(0);
  // Never commit messages, authors or a timestamp claim dressed as assertion time.
  expect(JSON.stringify(result)).not.toContain("alpha v2");
  expect(JSON.stringify(result)).not.toContain("fixture@example.invalid");
  expect(JSON.stringify(result)).not.toContain("as_of");
});

test("show --revision returns one old blob while the current note stays current, paged by max-bytes", () => {
  const f = fixture();
  const firstBody = note("Alpha", "first body");
  f.write("notes/alpha.md", firstBody);
  const first = f.commit("alpha v1");
  const headBody = note("Alpha", `second body ${"x".repeat(200)}`);
  f.write("notes/alpha.md", headBody);
  const head = f.commit("alpha v2");
  const old = readRevision({ vault: f.spec, home: f.home, note: "notes/alpha.md", revision: first, env: gitEnv });
  expect(old.found).toBe(true);
  expect(old.basis).toBe("git_snapshot");
  expect(old.revision).toBe(first);
  expect(old.head).toBe(head);
  expect(old.path).toBe("notes/alpha.md");
  expect(old.blob).toBe(f.git(f.vault, "rev-parse", `${first}:notes/alpha.md`));
  expect(old.bytes).toBe(Buffer.byteLength(firstBody));
  expect(old.content).toBe(firstBody);
  expect(old.sha256).toBe(createHash("sha256").update(firstBody).digest("hex"));
  expect(old.truncated).toBe(false);
  expect(old.coverage).toEqual({ complete: true });
  // The current read is untouched by the historical arm.
  expect(JSON.parse(run(["show", "demo", "alpha", "--json"], f.env).text).content).toBe(headBody);
  const paged = readRevision({ vault: f.spec, home: f.home, note: "notes/alpha.md", revision: first, maxBytes: 10, env: gitEnv });
  expect(paged.content).toBe(firstBody.slice(0, 10));
  expect(paged.truncated).toBe(true);
  expect(paged.nextOffset).toBe(Buffer.byteLength(paged.content!));
});

test("a historical section read is bounded to that H2, and an unknown section is refused", () => {
  const f = fixture();
  const body = note("Alpha", "intro line") + "\n## First\n\nalpha text\n\n## Second\n\nbeta text\n";
  f.write("notes/alpha.md", body);
  const head = f.commit("alpha");
  const section = readRevision({ vault: f.spec, home: f.home, note: "notes/alpha.md", revision: head, section: "Second", env: gitEnv });
  expect(section.section).toBe("Second");
  expect(section.content).toContain("beta text");
  expect(section.content).not.toContain("alpha text");
  expect(() => readRevision({ vault: f.spec, home: f.home, note: "notes/alpha.md", revision: head, section: "Third", env: gitEnv }))
    .toThrow(/section: unknown H2 heading/);
});

test("a deleted note keeps a readable history, and a stem lookup needs the exact notes path", () => {
  const f = fixture();
  const body = note("Beta", "kept text");
  f.write("notes/beta.md", body);
  const added = f.commit("add beta");
  rmSync(join(f.vault, "notes/beta.md"));
  const deleted = f.commit("drop beta");
  expect(() => f.read("beta")).toThrow(/pass the note's notes\/<path>\.md/);
  const history = f.read("notes/beta.md");
  expect(history.revisions.map(revision => revision.revision)).toEqual([added]);
  expect(history.scanned).toBe(2);
  expect(readRevision({ vault: f.spec, home: f.home, note: "notes/beta.md", revision: added, env: gitEnv }).content).toBe(body);
  const gone = readRevision({ vault: f.spec, home: f.home, note: "notes/beta.md", revision: deleted, env: gitEnv });
  expect(gone.found).toBe(false);
  expect(gone.revision).toBe(deleted);
  expect(gone.coverage).toEqual({ complete: true });
  expect(gone.content).toBeUndefined();
});

test("renames are exact-path: the old path stops at the rename and the new path starts there", () => {
  const f = fixture();
  f.write("notes/old-name.md", note("Old", "content"));
  const added = f.commit("add old");
  f.git(f.vault, "mv", "notes/old-name.md", "notes/new-name.md");
  const renamed = f.commit("rename note");
  const before = f.read("notes/old-name.md");
  expect(before.revisions.map(revision => revision.revision)).toEqual([added]);
  expect(before.scanned).toBe(2);
  const after = f.read("notes/new-name.md");
  expect(after.revisions.map(revision => revision.revision)).toEqual([renamed]);
  expect(after.revisions[0]!.blob).toBe(f.git(f.vault, "rev-parse", `${renamed}:notes/new-name.md`));
});

test("a merge commit is the boundary for a note changed only on a merged branch", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "main text"));
  const base = f.commit("base");
  f.git(f.vault, "checkout", "--quiet", "-b", "side");
  f.write("notes/alpha.md", note("Alpha", "side text"));
  f.commit("side change");
  f.git(f.vault, "checkout", "--quiet", "main");
  f.write("notes/other.md", note("Other", "main only"));
  f.commit("main change");
  f.git(f.vault, "merge", "--quiet", "--no-ff", "-m", "merge side", "side");
  const merge = f.git(f.vault, "rev-parse", "HEAD");
  const result = f.read("notes/alpha.md");
  expect(result.firstParent).toBe(true);
  expect(result.revisions.map(revision => revision.revision)).toEqual([merge, base]);
  expect(result.revisions[0]!.blob).toBe(f.git(f.vault, "rev-parse", `${merge}:notes/alpha.md`));
  // merge, the main-only commit and base: the side branch is never traversed.
  expect(result.scanned).toBe(3);
});

test("uncommitted edits are counted only by dirtyNotes and never appear as a revision", () => {
  const f = fixture();
  const committed = note("Alpha", "committed");
  f.write("notes/alpha.md", committed);
  const head = f.commit("alpha");
  f.write("notes/alpha.md", note("Alpha", "work in progress"));
  f.write("notes/draft.md", note("Draft", "untracked"));
  const result = f.read("notes/alpha.md");
  expect(result.dirtyNotes).toBe(2);
  expect(result.revisions.map(revision => revision.revision)).toEqual([head]);
  expect(readRevision({ vault: f.spec, home: f.home, note: "notes/alpha.md", revision: head, env: gitEnv }).content).toBe(committed);
});

test("a non-repository, a vault below the top level and an empty repository report capabilities instead of content", () => {
  const f = fixture();
  const plain = join(f.root, "plain"), plainSpec = { id: "plain", path: plain, kind: "personal" as const, write: "none" as const };
  mkdirSync(join(plain, "notes"), { recursive: true });
  writeFileSync(join(plain, "notes", "alpha.md"), note("Alpha", "current text"));
  const notRepo = readHistory({ vault: plainSpec, home: f.home, note: "notes/alpha.md", env: gitEnv });
  expect(notRepo.capability).toBe("not_a_repository");
  expect(notRepo.head).toBeNull();
  expect(notRepo.revisions).toEqual([]);
  expect(notRepo.stopReason).toBe("unsupported");
  expect(notRepo.coverage.complete).toBe(false);
  expect(notRepo.coverage.reason).toBeTruthy();
  const unreachableRead = readRevision({ vault: plainSpec, home: f.home, note: "notes/alpha.md", revision: "0".repeat(40), env: gitEnv });
  expect(unreachableRead.found).toBe(false);
  expect(unreachableRead.capability).toBe("not_a_repository");
  expect(unreachableRead.content).toBeUndefined();
  expect(readChanges({ vault: plainSpec, home: f.home, from: "0".repeat(40), to: "0".repeat(40), env: gitEnv }).changed).toEqual([]);
  // A repository above the vault root is refused, never read through.
  const outer = join(f.root, "outer"), nested = join(outer, "nested");
  mkdirSync(join(nested, "notes"), { recursive: true });
  writeFileSync(join(nested, "notes", "alpha.md"), note("Alpha", "nested text"));
  git(outer, "init", "--quiet", "-b", "main");
  git(outer, "add", "-A");
  git(outer, "commit", "--quiet", "-m", "outer");
  const below = readHistory({ vault: { id: "nested", path: nested, kind: "personal", write: "none" }, home: f.home, note: "notes/alpha.md", env: gitEnv });
  expect(below.capability).toBe("vault_not_repository_root");
  expect(below.revisions).toEqual([]);
  // A repository with no commit names no snapshot.
  const empty = join(f.root, "empty");
  mkdirSync(join(empty, "notes"), { recursive: true });
  writeFileSync(join(empty, "notes", "alpha.md"), note("Alpha", "uncommitted"));
  git(empty, "init", "--quiet", "-b", "main");
  const noCommit = readHistory({ vault: { id: "empty", path: empty, kind: "personal", write: "none" }, home: f.home, note: "notes/alpha.md", env: gitEnv });
  expect(noCommit.capability).toBe("no_commits");
  expect(noCommit.head).toBeNull();
  expect(noCommit.revisions).toEqual([]);
});

test("a shallow clone reports incomplete coverage and never claims a full history", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "one"));
  f.commit("one");
  f.write("notes/alpha.md", note("Alpha", "two"));
  f.commit("two");
  f.write("notes/alpha.md", note("Alpha", "three"));
  const head = f.commit("three");
  const clone = join(f.root, "shallow");
  git(f.root, "clone", "--quiet", "--depth", "1", `file://${f.vault}`, clone);
  const spec = { id: "shallow", path: clone, kind: "personal" as const, write: "none" as const };
  const result = readHistory({ vault: spec, home: f.home, note: "notes/alpha.md", env: gitEnv });
  expect(result.capability).toBe("shallow_history");
  expect(result.coverage).toEqual({ complete: false, reason: "shallow_history" });
  expect(result.head).toBe(head);
  expect(result.revisions.map(revision => revision.revision)).toEqual([head]);
  expect(result.revisions[0]!.blob).toBe(f.git(f.vault, "rev-parse", `${head}:notes/alpha.md`));
});

test("a missing object reports the object_unavailable capability in history and in a revision read", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "first text"));
  const first = f.commit("one");
  f.write("notes/alpha.md", note("Alpha", "second text"));
  const head = f.commit("two");
  const blob = f.git(f.vault, "rev-parse", `${first}:notes/alpha.md`);
  rmSync(join(f.vault, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  const result = f.read("notes/alpha.md");
  expect(result.revisions.map(revision => revision.revision)).toEqual([head]);
  expect(result.capability).toBe("object_unavailable");
  expect(result.coverage).toEqual({ complete: false, reason: "object_unavailable" });
  expect(result.revisions[0]!.blob).not.toBe(blob);
  // A pruned blob is a capability result, not a generic refusal and never the current note.
  const pruned = readRevision({ vault: f.spec, home: f.home, note: "notes/alpha.md", revision: first, env: gitEnv });
  expect(pruned.found).toBe(false);
  expect(pruned.capability).toBe("object_unavailable");
  expect(pruned.coverage).toEqual({ complete: false, reason: "object_unavailable" });
  expect(pruned.revision).toBe(first);
  expect(pruned.content).toBeUndefined();
  expect(JSON.stringify(pruned)).not.toContain("second text");
  expect(run(["show", "demo", "alpha", "--revision", first], f.env).text).toContain("no historical content: object_unavailable");
  // The same holds for a commit object that is gone.
  const missing = "f".repeat(40);
  const absent = readRevision({ vault: f.spec, home: f.home, note: "notes/alpha.md", revision: missing, env: gitEnv });
  expect(absent.capability).toBe("object_unavailable");
  expect(absent.found).toBe(false);
});

test("note targets outside notes/ or with dot segments are refused before any Git call", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "text"));
  const head = f.commit("alpha");
  const refused = ["../outside.md", "notes/../alpha.md", "notes/./alpha.md", "notes/.hidden.md", "/etc/passwd", "reports/alpha.md",
    "notes/alpha.txt", "notes/alpha.md\0", "notes\\alpha.md", "notes/a/b.mp3", `notes/${"a".repeat(1024)}.md`];
  for (const note of refused) {
    expect(() => f.read(note)).toThrow(/note:/);
    expect(() => readRevision({ vault: f.spec, home: f.home, note, revision: head, env: gitEnv })).toThrow(/note:/);
  }
});

test("only one full lowercase commit id is accepted, and an unreachable commit stays closed", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "base"));
  const base = f.commit("base");
  for (const revision of ["HEAD", "main", "HEAD~1", "--all", "--help", "abc1234", base.slice(0, 12), base.toUpperCase(), `${base}0`, ""])
    expect(() => readRevision({ vault: f.spec, home: f.home, note: "notes/alpha.md", revision, env: gitEnv }))
      .toThrow(/expected a full lowercase SHA-1 or SHA-256/);
  f.git(f.vault, "checkout", "--quiet", "-b", "side");
  f.write("notes/alpha.md", note("Alpha", "side only"));
  const side = f.commit("side");
  f.git(f.vault, "checkout", "--quiet", "main");
  expect(() => readRevision({ vault: f.spec, home: f.home, note: "notes/alpha.md", revision: side, env: gitEnv })).toThrow(/not reachable from the vault HEAD/);
  expect(() => readChanges({ vault: f.spec, home: f.home, from: side, to: base, env: gitEnv })).toThrow(/not reachable from the vault HEAD/);
  // A commit object that is not there is a capability result, so an all-zero id is answered rather than refused.
  expect(readRevision({ vault: f.spec, home: f.home, note: "notes/alpha.md", revision: "0".repeat(40), env: gitEnv }).capability).toBe("object_unavailable");
  expect(() => readChanges({ vault: f.spec, home: f.home, from: "0".repeat(40), to: base, env: gitEnv })).toThrow(/not an available commit object/);
});

test("a symlink, a non-UTF-8 blob and an oversized blob are refused, and a symlink is only counted", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "text"));
  const first = f.commit("alpha");
  symlinkSync("/etc/passwd", join(f.vault, "notes", "link.md"));
  f.write("notes/binary.md", Buffer.from([0xff, 0xfe, 0x41]));
  f.write("notes/huge.md", Buffer.alloc(MAX_NOTE_BYTES + 1, 0x61));
  const head = f.commit("link and blobs");
  expect(() => readRevision({ vault: f.spec, home: f.home, note: "notes/link.md", revision: head, env: gitEnv })).toThrow(/symlinked blobs are refused/);
  expect(() => readRevision({ vault: f.spec, home: f.home, note: "notes/binary.md", revision: head, env: gitEnv })).toThrow(/not valid UTF-8/);
  expect(() => readRevision({ vault: f.spec, home: f.home, note: "notes/huge.md", revision: head, env: gitEnv })).toThrow(/over the \d+-byte read bound/);
  const linked = f.read("notes/link.md");
  expect(linked.revisions).toEqual([]);
  expect(linked.skippedSymlink).toBe(1);
  const changes = readChanges({ vault: f.spec, home: f.home, from: first, to: head, env: gitEnv });
  expect(changes.changed.map(change => change.path).sort()).toEqual(["notes/binary.md", "notes/huge.md"]);
  expect(changes.skippedSymlink).toBe(1);
  expect(JSON.stringify(changes)).not.toContain("link.md");
});

test("a denied path is refused by current policy and only counted, never disclosed, by changes", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "one"));
  const first = f.commit("one");
  f.write("notes/alpha.md", note("Alpha", "two"));
  f.write("notes/secret.md", note("Secret", "hidden text"));
  const head = f.commit("two");
  const denyPaths = [join(f.vault, "notes", "secret.md")];
  expect(() => readHistory({ vault: f.spec, home: f.home, denyPaths, note: "notes/secret.md", env: gitEnv })).toThrow(/denied by the built-in secret rules/);
  expect(() => readRevision({ vault: f.spec, home: f.home, denyPaths, note: "notes/secret.md", revision: head, env: gitEnv })).toThrow(/denied/);
  const changes = readChanges({ vault: f.spec, home: f.home, denyPaths, from: first, to: head, env: gitEnv });
  expect(changes.changed.map(change => change.path)).toEqual(["notes/alpha.md"]);
  expect(changes.skippedDenied).toBe(1);
  expect(JSON.stringify(changes)).not.toContain("secret");
  expect(JSON.stringify(changes)).not.toContain("hidden text");
});

test("history paging stays pinned when the vault HEAD advances", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "v1"));
  const a = f.commit("one");
  f.write("notes/alpha.md", note("Alpha", "v2"));
  const b = f.commit("two");
  f.write("notes/alpha.md", note("Alpha", "v3"));
  const c = f.commit("three");
  const page1 = f.read("notes/alpha.md", { limit: 1 });
  expect(page1.revisions.map(revision => revision.revision)).toEqual([c]);
  expect(page1.head).toBe(c);
  expect(page1.stopReason).toBe("page_full");
  expect(page1.truncated).toBe(true);
  expect(page1.continuation).toBeTruthy();
  f.write("notes/alpha.md", note("Alpha", "v4"));
  const d = f.commit("four");
  const page2 = f.read("notes/alpha.md", { limit: 1, cursor: page1.continuation });
  expect(page2.head).toBe(c);
  expect(page2.revisions.map(revision => revision.revision)).toEqual([b]);
  expect(page2.revisions.some(revision => revision.revision === d)).toBe(false);
  const page3 = f.read("notes/alpha.md", { limit: 1, cursor: page2.continuation });
  expect(page3.revisions.map(revision => revision.revision)).toEqual([a]);
  expect(page3.stopReason).toBe("history_end");
  expect(page3).not.toHaveProperty("continuation");
  f.write("notes/beta.md", note("Beta", "other"));
  f.commit("beta");
  expect(() => f.read("notes/beta.md", { cursor: page1.continuation })).toThrow(/another note path/);
  expect(() => f.read("notes/alpha.md", { cursor: "not-a-cursor" })).toThrow(/not a continuation/);
  expect(() => readChanges({ vault: f.spec, home: f.home, from: a, to: d, cursor: page1.continuation!, env: gitEnv })).toThrow(/belongs to a history page/);
});

test("the scan and page limits name their stop reason and the continuation", () => {
  const f = fixture();
  for (const version of [1, 2, 3, 4]) { f.write("notes/alpha.md", note("Alpha", `v${version}`)); f.commit(`c${version}`); }
  const full = f.read("notes/alpha.md");
  expect(full.revisions).toHaveLength(4);
  expect(full.scanned).toBe(4);
  expect(full.stopReason).toBe("history_end");
  const scanned = f.read("notes/alpha.md", {});
  expect(scanned.stopReason).toBe("history_end");
  const shortScan = readHistory({ vault: f.spec, home: f.home, note: "notes/alpha.md", env: gitEnv }, { scanLimit: 2 });
  expect(shortScan.scanLimit).toBe(2);
  expect(shortScan.scanned).toBe(2);
  expect(shortScan.revisions).toHaveLength(2);
  expect(shortScan.stopReason).toBe("scan_limit");
  expect(shortScan.truncated).toBe(true);
  expect(shortScan.continuation).toBeTruthy();
  const paged = readHistory({ vault: f.spec, home: f.home, note: "notes/alpha.md", env: gitEnv }, { pageLimit: 2 });
  expect(paged.pageLimit).toBe(2);
  expect(paged.revisions).toHaveLength(2);
  expect(paged.stopReason).toBe("page_full");
  expect(() => f.read("notes/alpha.md", { limit: HISTORY_PAGE_LIMIT + 1 })).toThrow(/limit: expected integer 1\.\.100/);
  expect(HISTORY_PAGE_LIMIT).toBe(100);
  expect(HISTORY_SCAN_LIMIT).toBe(1000);
  expect(CHANGES_PAGE_LIMIT).toBe(500);
});

test("changes reports notes only, with before and after blob ids and status", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "one"));
  f.write("notes/gamma.md", note("Gamma", "gone soon"));
  const first = f.commit("one");
  f.write("notes/alpha.md", note("Alpha", "two"));
  f.write("notes/beta.md", note("Beta", "new note"));
  rmSync(join(f.vault, "notes", "gamma.md"));
  f.write("reports/report.md", "# Report\n\nnot a note\n");
  const head = f.commit("two");
  const result = readChanges({ vault: f.spec, home: f.home, from: first, to: head, env: gitEnv });
  expect(result.schemaVersion).toBe(1);
  expect(result.basis).toBe("git_snapshot");
  expect(result.from).toBe(first);
  expect(result.to).toBe(head);
  expect(result.head).toBe(head);
  expect(result.total).toBe(3);
  expect(result.truncated).toBe(false);
  expect(result.changed.map(change => [change.path, change.status])).toEqual([["notes/alpha.md", "M"], ["notes/beta.md", "A"], ["notes/gamma.md", "D"]]);
  const alpha = result.changed[0]!, beta = result.changed[1]!, gamma = result.changed[2]!;
  expect(alpha.before).toBe(f.git(f.vault, "rev-parse", `${first}:notes/alpha.md`));
  expect(alpha.after).toBe(f.git(f.vault, "rev-parse", `${head}:notes/alpha.md`));
  expect(alpha.before).not.toBe(alpha.after);
  expect(beta.before).toBeNull();
  expect(beta.after).toBe(f.git(f.vault, "rev-parse", `${head}:notes/beta.md`));
  expect(gamma.before).toBe(f.git(f.vault, "rev-parse", `${first}:notes/gamma.md`));
  expect(gamma.after).toBeNull();
  expect(JSON.stringify(result)).not.toContain("reports/report.md");
  expect(JSON.stringify(result)).not.toContain("not a note");
  expect(result.skippedDenied).toBe(0);
  expect(result.skippedSymlink).toBe(0);
});

test("changes pages with a cursor pinned to its revision pair", () => {
  const f = fixture();
  f.git(f.vault, "commit", "--quiet", "--allow-empty", "-m", "empty");
  const first = f.git(f.vault, "rev-parse", "HEAD");
  for (const name of ["alpha", "beta", "gamma"]) f.write(`notes/${name}.md`, note(name, "added"));
  const head = f.commit("three notes");
  const page1 = readChanges({ vault: f.spec, home: f.home, from: first, to: head, limit: 1, env: gitEnv });
  expect(page1.changed.map(change => change.path)).toEqual(["notes/alpha.md"]);
  expect(page1.total).toBe(3);
  expect(page1.truncated).toBe(true);
  expect(page1.continuation).toBeTruthy();
  const page2 = readChanges({ vault: f.spec, home: f.home, from: first, to: head, limit: 1, cursor: page1.continuation, env: gitEnv });
  expect(page2.changed.map(change => change.path)).toEqual(["notes/beta.md"]);
  const page3 = readChanges({ vault: f.spec, home: f.home, from: first, to: head, limit: 1, cursor: page2.continuation, env: gitEnv });
  expect(page3.changed.map(change => change.path)).toEqual(["notes/gamma.md"]);
  expect(page3.truncated).toBe(false);
  expect(page3).not.toHaveProperty("continuation");
  f.write("notes/delta.md", note("Delta", "later"));
  const later = f.commit("later");
  expect(() => readChanges({ vault: f.spec, home: f.home, from: first, to: later, limit: 1, cursor: page1.continuation, env: gitEnv }))
    .toThrow(/another revision pair/);
});

test("complete responses stay within the transport budget, including escape-heavy Unicode", () => {
  const f = fixture();
  for (const version of [1, 2, 3, 4, 5]) {
    f.write("notes/alpha.md", note("Alpha \"quoted\"", `${"\"".repeat(120)} 🎉한글 경로 ${"\\".repeat(40)} v${version}`));
    f.commit(`c${version}`);
  }
  const whole = f.read("notes/alpha.md", {});
  expect(frameBytes(whole)).toBeLessThanOrEqual(SNAPSHOT_TRANSPORT_BYTES);
  const tight = readHistory({ vault: f.spec, home: f.home, note: "notes/alpha.md", env: gitEnv }, { transportBytes: 900 });
  expect(frameBytes(tight)).toBeLessThanOrEqual(900);
  expect(tight.truncated).toBe(true);
  expect(["transport_limit", "page_full"]).toContain(tight.stopReason);
  expect(tight.revisions.length).toBeLessThan(5);
  const changes = readChanges({ vault: f.spec, home: f.home, from: whole.revisions.at(-1)!.revision, to: whole.head!, env: gitEnv }, { transportBytes: 700 });
  expect(frameBytes(changes)).toBeLessThanOrEqual(700);
  expect(changes.truncated).toBe(true);
});

test("the bound is measured on the JSON-RPC frame, and a heading-heavy page drops headings before overshooting", () => {
  const f = fixture();
  const headings = Array.from({ length: 40 }, (_, index) => `## ${"\"\\".repeat(20)}${index}`).join("\n\n");
  // A truncated 64 KiB page of quotes is a 128 KiB JSON text before the frame escapes it again.
  const body = note("Heavy", `intro\n\n${headings}\n\n${"\"".repeat(70_000)}`);
  f.write("notes/heavy.md", body);
  const head = f.commit("heavy");
  const result = readRevision({ vault: f.spec, home: f.home, note: "notes/heavy.md", revision: head, maxBytes: 65536, env: gitEnv });
  expect(frameBytes(result)).toBeLessThanOrEqual(SNAPSHOT_TRANSPORT_BYTES);
  expect(result.transportLimited).toBe(true);
  expect(result.content!.length).toBeGreaterThan(0);
  // A small budget cannot hold content plus headings, so the list goes and its flag says so.
  const tiny = readRevision({ vault: f.spec, home: f.home, note: "notes/heavy.md", revision: head, maxBytes: 65536, env: gitEnv }, { transportBytes: 2000 });
  expect(frameBytes(tiny)).toBeLessThanOrEqual(2000);
  expect(tiny.headings).toBeUndefined();
  expect(tiny.headingsTruncated).toBe(true);
  expect(tiny.transportLimited).toBe(true);
});

test("a historical read trims on a UTF-8 boundary within 48 KiB and resumes at nextOffset", () => {
  const f = fixture();
  const body = note("Heavy", `${"가나다🎉".repeat(6000)}end`);
  expect(Buffer.byteLength(body)).toBeGreaterThan(SNAPSHOT_TRANSPORT_BYTES);
  f.write("notes/heavy.md", body);
  const head = f.commit("heavy");
  const result = readRevision({ vault: f.spec, home: f.home, note: "notes/heavy.md", revision: head, maxBytes: 65536, env: gitEnv });
  expect(frameBytes(result)).toBeLessThanOrEqual(SNAPSHOT_TRANSPORT_BYTES);
  expect(result.transportLimited).toBe(true);
  expect(result.truncated).toBe(true);
  expect(result.nextOffset).toBe(Buffer.byteLength(result.content!));
  expect(result.nextOffset! > 0).toBe(true);
  const source = Buffer.from(body);
  expect(Buffer.from(result.content!)).toEqual(source.subarray(0, result.nextOffset!));
  expect(result.content!).not.toContain("\ufffd");
  const rest = readRevision({ vault: f.spec, home: f.home, note: "notes/heavy.md", revision: head, maxBytes: 65536, offset: result.nextOffset, env: gitEnv });
  expect(Buffer.from(rest.content!)).toEqual(source.subarray(result.nextOffset!, result.nextOffset! + Buffer.byteLength(rest.content!)));
});

test("history, revision and changes leave Git status, the index, refs and vault files byte for byte unchanged", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "v1"));
  const first = f.commit("one");
  f.write("notes/alpha.md", note("Alpha", "v2"));
  f.write("notes/beta.md", note("Beta", "b"));
  const head = f.commit("two");
  f.write("notes/alpha.md", note("Alpha", "dirty edit"));
  const before = fingerprint(f.vault);
  const history = f.read("notes/alpha.md");
  expect(readRevision({ vault: f.spec, home: f.home, note: "notes/alpha.md", revision: first, env: gitEnv }).found).toBe(true);
  expect(readChanges({ vault: f.spec, home: f.home, from: first, to: head, env: gitEnv }).changed).toHaveLength(2);
  expect(run(["history", "demo", "alpha"], f.env).text).toContain("notes/alpha.md");
  expect(run(["show", "demo", "alpha", "--revision", first], f.env).text).toContain(first.slice(0, 12));
  expect(run(["changes", "demo", "--from", first, "--to", head], f.env).text).toContain("notes/alpha.md");
  expect(fingerprint(f.vault)).toEqual(before);
  expect(history.dirtyNotes).toBe(1);
});

test("the CLI renders history, a pinned revision and a tree comparison with the exact next command", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "v1"));
  const first = f.commit("one");
  f.write("notes/alpha.md", note("Alpha", "v2"));
  const head = f.commit("two");
  const text = run(["history", "demo", "alpha", "--limit", "1"], f.env).text;
  expect(text).toContain("history demo notes/alpha.md");
  expect(text).toContain("git_snapshot");
  expect(text).toContain("REVISION");
  expect(text).toContain("COMMITTED (GIT METADATA)");
  expect(text).toContain(head.slice(0, 12));
  expect(text).toContain("next: vmem history demo notes/alpha.md --limit 1 --cursor ");
  expect(JSON.parse(run(["history", "demo", "alpha", "--json"], f.env).text).revisions).toHaveLength(2);
  expect(() => run(["history", "demo", "alpha", "--limit", "101"], f.env)).toThrow(/limit: expected integer 1\.\.100/);
  expect(() => run(["history", "demo", "alpha", "--cursor", "nope"], f.env)).toThrow(/not a continuation/);
  expect(() => run(["changes", "demo", "--from", first], f.env)).toThrow(/requires one vault id plus --from and --to/);
  const show = run(["show", "demo", "alpha", "--revision", first, "--max-bytes", "12"], f.env).text;
  expect(show).toContain(`show demo notes/alpha.md at ${first.slice(0, 12)}`);
  expect(show).toContain(first);
  expect(show).toContain(`next: vmem show demo alpha --revision ${first} --max-bytes 12 --offset 12`);
  const changes = JSON.parse(run(["changes", "demo", "--from", first, "--to", head, "--json"], f.env).text);
  expect(changes.changed).toEqual([{ path: "notes/alpha.md", status: "M",
    before: f.git(f.vault, "rev-parse", `${first}:notes/alpha.md`), after: f.git(f.vault, "rev-parse", `${head}:notes/alpha.md`) }]);
  expect(run(["changes", "demo", "--from", first, "--to", head], f.env).text).toContain("ST");
});

test("MCP exposes the same provider as read-only tools and refuses a prefix revision in its schema", async () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "v1"));
  const first = f.commit("one");
  f.write("notes/alpha.md", note("Alpha", "v2"));
  const head = f.commit("two");
  const server = createVaultMcp(f.home, { VMEM_HOME: f.home });
  expect(VMEM_TOOL_NAMES).toContain("vmem_history");
  expect(VMEM_TOOL_NAMES).toContain("vmem_changes");
  const tools = server.tools;
  const historyTool = tools.find(entry => entry.name === "vmem_history")!, changesTool = tools.find(entry => entry.name === "vmem_changes")!;
  expect(historyTool.annotations?.readOnlyHint).toBe(true);
  expect(historyTool.annotations?.destructiveHint).toBe(false);
  expect(changesTool.annotations?.readOnlyHint).toBe(true);
  expect(JSON.stringify(historyTool.inputSchema)).toContain('"cursor"');
  expect(validArguments({ path: "notes/alpha.md" }, historyTool.inputSchema)).toBe(true);
  expect(validArguments({ path: "notes/alpha.md", revision: "HEAD" }, historyTool.inputSchema)).toBe(false);
  const readTool = tools.find(entry => entry.name === "vmem_read")!;
  expect(validArguments({ path: "notes/alpha.md", revision: first }, readTool.inputSchema)).toBe(true);
  expect(validArguments({ path: "notes/alpha.md", revision: head.slice(0, 12) }, readTool.inputSchema)).toBe(false);
  expect(validArguments({ path: "notes/alpha.md", revision: "--all" }, readTool.inputSchema)).toBe(false);
  const history = await server.handlers.vmem_history!({ path: "notes/alpha.md" }) as { basis: string; head: string; revisions: { revision: string }[] };
  expect(history.basis).toBe("git_snapshot");
  expect(history.head).toBe(head);
  expect(history.revisions.map(revision => revision.revision)).toEqual([head, first]);
  const revision = await server.handlers.vmem_read!({ path: "notes/alpha.md", revision: first }) as { content: string; found: boolean };
  expect(revision.found).toBe(true);
  expect(revision.content).toBe(note("Alpha", "v1"));
  const changes = await server.handlers.vmem_changes!({ from: first, to: head }) as { changed: { status: string }[] };
  expect(changes.changed.map(change => change.status)).toEqual(["M"]);
});

test("a cursor cannot resume from a commit off the pinned first-parent chain", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "base"));
  const base = f.commit("base");
  f.git(f.vault, "checkout", "--quiet", "-b", "side");
  f.write("notes/side.md", note("Side", "only on the branch"));
  const side = f.commit("side change");
  f.git(f.vault, "checkout", "--quiet", "main");
  f.write("notes/alpha.md", note("Alpha", "main"));
  f.commit("main change");
  f.git(f.vault, "merge", "--quiet", "--no-ff", "-m", "merge side", "side");
  const pin = f.git(f.vault, "rev-parse", "HEAD");
  const page = f.read("notes/alpha.md", { limit: 1 });
  expect(page.head).toBe(pin);
  const cursor = (after: string) => Buffer.from(JSON.stringify({ v: 1, kind: "history", path: "notes/alpha.md", head: pin, after }), "utf8").toString("base64url");
  // `side` is reachable from HEAD through the merge, but this walk never visits it.
  expect(() => f.read("notes/alpha.md", { cursor: cursor(side) })).toThrow(/not on the first-parent chain of the pinned .*restart without --cursor/);
  expect(() => f.read("notes/alpha.md", { cursor: cursor("0".repeat(40)) })).toThrow(/not an available commit object/);
  // The continuation this provider issued still resumes the walk.
  expect(f.read("notes/alpha.md", { cursor: page.continuation }).revisions.map(revision => revision.revision)).toEqual([base]);
});

test("a note path with a control character is refused instead of becoming a Git expression", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "plain"));
  f.write("notes/secret.md", note("Secret", "hidden text"));
  f.write("notes/two\nlines.md", note("Split", "committed under a newline"));
  const head = f.commit("notes");
  for (const target of ["notes/two\nlines.md", "notes/alpha.md\nnotes/secret.md", "notes/two\rlines.md", "notes/two\tlines.md"]) {
    expect(() => f.read(target)).toThrow(/note: expected a note target/);
    expect(() => readRevision({ vault: f.spec, home: f.home, note: target, revision: head, env: gitEnv })).toThrow(/note: expected a note target/);
  }
  // Nothing from the second expression reaches the refusal text or an earlier read.
  let message = "";
  try { f.read("notes/alpha.md\nnotes/secret.md"); } catch (error) { message = error instanceof Error ? error.message : String(error); }
  expect(message).not.toContain("secret");
  const alpha = f.read("notes/alpha.md");
  expect(JSON.stringify(alpha)).not.toContain("two");
  expect(JSON.stringify(alpha)).not.toContain("hidden text");
});

test("a repository's own log.follow, log.showSignature and gpg.program settings never take effect", () => {
  const f = fixture();
  f.write("notes/old-name.md", note("Old", "content"));
  const added = f.commit("add old");
  f.git(f.vault, "mv", "notes/old-name.md", "notes/new-name.md");
  const renamed = f.commit("rename note");
  // A commit that carries a signature header, so Git really consults gpg.program while walking.
  const bodyFile = join(f.root, "signed-commit.txt");
  writeFileSync(bodyFile, ["tree " + f.git(f.vault, "rev-parse", "HEAD^{tree}"), "parent " + renamed,
    "author Fixture <fixture@example.invalid> 1700000000 +0000", "committer Fixture <fixture@example.invalid> 1700000000 +0000",
    "gpgsig -----BEGIN PGP SIGNATURE-----", " ", " ZmFrZXNpZw==", " -----END PGP SIGNATURE-----", "", "signed snapshot", ""].join("\n"));
  const signed = f.git(f.vault, "hash-object", "-t", "commit", "-w", bodyFile);
  f.git(f.vault, "update-ref", "refs/heads/main", signed);
  f.git(f.vault, "config", "log.follow", "true");
  const marker = join(f.root, "gpg-ran"), program = join(f.root, "fake-gpg.sh");
  writeFileSync(program, `#!/bin/sh\nprintf ran >> ${JSON.stringify(marker)}\ncat >/dev/null\n`, { mode: 0o755 });
  f.git(f.vault, "config", "log.showSignature", "true");
  f.git(f.vault, "config", "gpg.program", program);
  // The settings are live in this fixture: plain Git runs the configured program, and this output is not a signature.
  try { f.git(f.vault, "log", "--format=%H", "-1"); } catch { /* verification output is reported, not raised */ }
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
  expect(f.read("notes/old-name.md").revisions.map(revision => revision.revision)).toEqual([added]);
  expect(f.read("notes/new-name.md").revisions.map(revision => revision.revision)).toEqual([renamed]);
  expect(readRevision({ vault: f.spec, home: f.home, note: "notes/new-name.md", revision: renamed, env: gitEnv }).found).toBe(true);
  expect(readChanges({ vault: f.spec, home: f.home, from: added, to: signed, env: gitEnv }).changed).toHaveLength(2);
  expect(existsSync(marker)).toBe(false);
});

test("a clean filter configured for notes/ stops the dirty-note count instead of running it", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "v1"));
  f.commit("one");
  for (const [attributes, label] of [["notes/*.md filter=evil\n", "value"], ["notes/*.md -filter\n", "unset"], ["notes/*.md filter\n", "set"]] as const) {
    f.write(".gitattributes", attributes);
    f.commit(`attributes ${label}`);
    const result = f.read("notes/alpha.md");
    expect(result.dirtyNotes).toBeNull();
    expect(result.dirtyNotesReason).toMatch(/clean filter is configured for notes\//);
  }
  f.write(".gitattributes", "# no filter attribute\n");
  f.commit("no attribute");
  expect(f.read("notes/alpha.md").dirtyNotes).toBe(0);
});

test("the scan limit bounds commits traversed, and an empty page still continues the walk", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "v1"));
  const first = f.commit("one");
  for (const index of [2, 3, 4]) { f.write("notes/other.md", note("Other", `o${index}`)); f.commit(`other${index}`); }
  f.write("notes/alpha.md", note("Alpha", "v2"));
  const head = f.commit("alpha again");
  const whole = f.read("notes/alpha.md");
  expect(whole.revisions.map(revision => revision.revision)).toEqual([head, first]);
  // Every first-parent commit from HEAD, not only the two that touched the note.
  expect(whole.scanned).toBe(5);
  const page1 = readHistory({ vault: f.spec, home: f.home, note: "notes/alpha.md", env: gitEnv }, { scanLimit: 2 });
  expect(page1.scanned).toBe(2);
  expect(page1.revisions.map(revision => revision.revision)).toEqual([head]);
  expect(page1.stopReason).toBe("scan_limit");
  expect(page1.truncated).toBe(true);
  // The limit belongs to the request, not the cursor: a continuation is read with its own scan limit.
  const page2 = readHistory({ vault: f.spec, home: f.home, note: "notes/alpha.md", cursor: page1.continuation, env: gitEnv }, { scanLimit: 2 });
  expect(page2.scanned).toBe(2);
  expect(page2.revisions).toEqual([]);
  expect(page2.stopReason).toBe("scan_limit");
  expect(page2.continuation).toBeTruthy();
  const page3 = readHistory({ vault: f.spec, home: f.home, note: "notes/alpha.md", cursor: page2.continuation, env: gitEnv }, { scanLimit: 2 });
  expect(page3.revisions.map(revision => revision.revision)).toEqual([first]);
  expect(page3.stopReason).toBe("history_end");
  expect(page3).not.toHaveProperty("continuation");
});

test("a continuation survives a note path longer than the old 1024-character cursor cap", () => {
  const f = fixture();
  const deep = `notes/${"d".repeat(200)}/${"d".repeat(200)}/${"d".repeat(200)}/${"e".repeat(195)}.md`;
  f.write(deep, note("Deep", "v1"));
  const first = f.commit("one");
  f.write(deep, note("Deep", "v2"));
  f.commit("two");
  const page = f.read(deep, { limit: 1 });
  expect(page.stopReason).toBe("page_full");
  expect(page.continuation!.length).toBeGreaterThan(1024);
  expect(f.read(deep, { cursor: page.continuation }).revisions.map(revision => revision.revision)).toEqual([first]);
  const tool = createVaultMcp(f.home, { VMEM_HOME: f.home }).tools.find(entry => entry.name === "vmem_history")!;
  expect(validArguments({ path: deep, cursor: page.continuation }, tool.inputSchema)).toBe(true);
  expect(validArguments({ path: deep, cursor: "x".repeat(SNAPSHOT_CURSOR_CHARS + 1) }, tool.inputSchema)).toBe(false);
});

test("history and changes are published read-only, and the MCP handlers use the server's own environment", async () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "v1"));
  const head = f.commit("one");
  expect(COMMANDS.find(item => item.name === "history")!.mutates).toBe(false);
  expect(COMMANDS.find(item => item.name === "changes")!.mutates).toBe(false);
  const manifest = JSON.parse(run(["manifest", "--json"], f.env).text) as { mcp: { tools: (string | { name: string; readOnly?: boolean })[] } };
  for (const name of ["vmem_history", "vmem_changes"]) expect(manifest.mcp.tools).toContainEqual({ name, readOnly: true });
  const broken = createVaultMcp(f.home, { VMEM_HOME: f.home, PATH: join(f.root, "no-git") });
  expect((await broken.handlers.vmem_history!({ path: "notes/alpha.md" }) as { capability?: string }).capability).toBe("git_unavailable");
  expect((await broken.handlers.vmem_read!({ path: "notes/alpha.md", revision: head }) as { capability?: string }).capability).toBe("git_unavailable");
  expect((await broken.handlers.vmem_changes!({ from: head, to: head }) as { capability?: string }).capability).toBe("git_unavailable");
});

test("unavailable Git and an exhausted deadline are explicit, never current content", () => {
  const f = fixture();
  f.write("notes/alpha.md", note("Alpha", "v1"));
  const head = f.commit("one");
  const env = { PATH: join(f.root, "no-git") };
  const unavailable = readHistory({ vault: f.spec, home: f.home, note: "notes/alpha.md", env });
  expect(unavailable.capability).toBe("git_unavailable");
  expect(unavailable.revisions).toEqual([]);
  expect(unavailable.coverage.complete).toBe(false);
  expect(readRevision({ vault: f.spec, home: f.home, note: "notes/alpha.md", revision: head, env }).found).toBe(false);
  expect(readChanges({ vault: f.spec, home: f.home, from: head, to: head, env }).changed).toEqual([]);
  expect(() => readHistory({ vault: f.spec, home: f.home, note: "notes/alpha.md", env: gitEnv }, { deadlineMs: 0 }))
    .toThrow(/budget is spent/);
});
