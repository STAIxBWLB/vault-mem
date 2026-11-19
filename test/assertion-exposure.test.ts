import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { appendAssertions, assertFrameBytes, evaluateAssertions, readJournal, verifySegment } from "../src/assertions.ts";
import { EXPOSURE_BLOB_BYTES, scanAssertionExposure, writeReplaceFile, type ExposureReceipt } from "../src/assertion-exposure.ts";
import { run } from "../src/cli.ts";
import { CONFIG_FILE } from "../src/config.ts";
import { createVaultMcp, exposureReply } from "../src/mcp-vault.ts";
import { serveMcp } from "../src/mcp.ts";
import { addVault, loadRegistry } from "../src/registry.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
/** A value that must not survive in any receipt, only in the expressions file that removes it. */
const CANARY = "exposure-canary-7f2b31da";
const IDENTITY = { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, env: { ...process.env, ...IDENTITY }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir} (exit ${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function gitBytes(dir: string, args: string[]): Buffer {
  const result = spawnSync("git", args, { cwd: dir, env: { ...process.env, ...IDENTITY } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${String(result.stderr)}`);
  return result.stdout;
}

function fixture(options: { write?: "mcp" | "cli" | "none"; repository?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-assertion-exposure-"))); roots.push(root);
  const home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes"), outside = join(root, "outside");
  mkdirSync(notes, { recursive: true }); mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "workspace.config.yaml"), "name: fixture\n");
  writeFileSync(join(notes, "subject.md"), "---\nstatus: active\ntype: note\n---\n# Subject\n");
  if (options.repository !== false) git(vault, ["init", "-q", "-b", "main"]);
  addVault(home, { id: "test", path: vault, kind: "personal", write: options.write ?? "cli", registry: join(root, "projects.yaml") });
  const env = { HOME: root, VMEM_HOME: home, PATH: process.env.PATH };
  const append = (ops: unknown[], date = "2026-01-01T12:00:00Z") => appendAssertions(home, { vault: "test", ops, channel: "cli" }, { env, now: new Date(date) });
  const commit = (message: string) => { git(vault, ["add", "-A"]); git(vault, ["commit", "-q", "-m", message]); return git(vault, ["rev-parse", "HEAD"]); };
  const exposure = (args: string[] = []) => JSON.parse(run(["assertions", "exposure", "test", ...args, "--json"], env).text) as ExposureReceipt;
  return { root, home, vault, notes, outside, env, append, commit, exposure };
}
type Fixture = ReturnType<typeof fixture>;

/** One declared subject with one assertion whose value carries the canary; returns the assertion id and segment id. */
function seed(f: Fixture, value = CANARY): { id: string; segment: string } {
  const receipt = f.append([{ op: "declare", subject: "s:test", note: "notes/subject.md" },
    { op: "assert", subject: "s:test", relation: "role", value, kind: "state", from: "2025-01-01", to: "open", source: ["mem:fixture"] }]);
  expect(receipt.issues.filter(issue => issue.severity === "error")).toEqual([]);
  return { id: receipt.entries[1]!.id!, segment: receipt.segment! };
}
const purgePreview = (f: Fixture, id: string) => JSON.parse(run(["assertions", "purge", "test", id, "--reason", "evidence_withdrawn", "--json"], f.env).text) as { fingerprint: string };
const purgeConfirm = (f: Fixture, id: string, fingerprint: string) => JSON.parse(run(["assertions", "purge", "test", id, "--reason", "evidence_withdrawn", "--confirm", "--fingerprint", fingerprint, "--json"], f.env).text) as { ok: boolean; applied: boolean; entries: { hash: string }[] };
const purge = (f: Fixture, id: string) => purgeConfirm(f, id, purgePreview(f, id).fingerprint);
/** The message a refusing call throws, so two surfaces can be compared byte for byte. */
const thrown = (thunk: () => unknown) => { try { thunk(); return ""; } catch (error) { return (error as Error).message; } };

test("X1: a payload that never reached a commit is clean", () => {
  const f = fixture();
  f.commit("notes only");
  const { id } = seed(f);
  expect(purge(f, id)).toMatchObject({ ok: true, applied: true });
  const receipt = f.exposure();
  expect(receipt).toMatchObject({ vault: "test", clean: true, truncated: null, exposed: [], scanned: { commits: 0, blobs: 0, bytes: 0 } });
  // A clean local scan still says what it does not cover.
  expect(receipt.issues).toHaveLength(1);
  expect(receipt.issues[0]).toContain("reads this local repository only");
  expect(run(["assertions", "exposure", "test", "--json"], f.env).code).toBe(0);
});

test("X1: a purge committed after the payload is reported by position and hash, without payload text", () => {
  const f = fixture();
  f.commit("notes only");
  const { id, segment } = seed(f);
  const payloadCommit = f.commit("journal with payload");
  git(f.vault, ["tag", "leak"]);
  const applied = purge(f, id);
  const purgeCommit = f.commit("purge the payload");
  expect(purgeCommit).not.toBe(payloadCommit);

  const receipt = f.exposure();
  expect(receipt).toMatchObject({ vault: "test", clean: false, truncated: null });
  expect(receipt.scanned.commits).toBe(2);
  expect(receipt.scanned.blobs).toBe(2);
  expect(receipt.scanned.bytes).toBeGreaterThan(0);
  expect(receipt.exposed).toHaveLength(1);
  const row = receipt.exposed[0]!;
  expect(row).toMatchObject({ assertion: id, segment, seq: 2, hash: applied.entries[0]!.hash, commits: { count: 1, first: payloadCommit, last: payloadCommit }, replaceable: true });
  expect(row.refs).toEqual(["refs/heads/main", "refs/tags/leak"]);
  expect(row.manual).toBeUndefined();
  expect(JSON.stringify(receipt)).not.toContain(CANARY);

  const printed = run(["assertions", "exposure", "test"], f.env);
  expect(printed.code).toBe(1);
  expect(printed.text).toContain(id);
  expect(printed.text).toContain("refs/heads/main");
  expect(printed.text).toContain("refs/tags/leak");
  expect(printed.text).not.toContain(CANARY);
  // One assertion's id narrows the same scan, and an id that is not purged is refused.
  expect(f.exposure([id]).exposed.map(value => value.hash)).toEqual([applied.entries[0]!.hash]);
  expect(thrown(() => f.exposure(["a:0123456789abcdef:99"]))).toContain("no verified journal entry belongs to");
});

test("X2: the generated replace file clears the history, and every rewritten tip still verifies", () => {
  const f = fixture();
  f.commit("notes only");
  const { id, segment } = seed(f);
  f.commit("journal with payload");
  purge(f, id);
  f.commit("purge the payload");
  const before = f.exposure();
  expect(before.exposed.map(row => row.segment)).toEqual([segment]);

  const replaceFile = join(f.outside, "replace.txt");
  const written = f.exposure(["--replace-file", replaceFile]);
  expect(written.replaceFile).toMatchObject({ lines: 1, unreplaceable: 0, path: replaceFile });
  const expressions = readFileSync(replaceFile, "utf8").split("\n").filter(Boolean);
  expect(expressions).toHaveLength(1);
  const separator = expressions[0]!.indexOf("==>");
  const exposedLine = expressions[0]!.slice(0, separator), purgedLine = expressions[0]!.slice(separator + 3);
  expect(exposedLine).toContain(CANARY);
  expect(purgedLine).not.toContain(CANARY);
  expect(purgedLine).toContain('"purged":{"at":');

  const rewritten = join(f.root, "rewritten"), how = rewrite(f.vault, rewritten, replaceFile, expressions);
  addVault(f.home, { id: "rewritten", path: rewritten, kind: "personal", write: "none", registry: join(f.root, "projects.yaml") });
  const after = JSON.parse(run(["assertions", "exposure", "rewritten", "--json"], f.env).text) as ExposureReceipt;
  expect(how).toMatch(/^(git-filter-repo|literal)$/);
  expect(after).toMatchObject({ vault: "rewritten", clean: true, truncated: null, exposed: [] });
  expect(after.scanned.commits).toBeGreaterThan(0);
  // Every rewritten commit's assertion blob still verifies as the journal it claims to be.
  let checked = 0;
  for (const commit of git(rewritten, ["rev-list", "--all"]).split("\n").filter(Boolean)) {
    for (const path of git(rewritten, ["ls-tree", "-r", "--name-only", commit, "--", "assertions"]).split("\n").filter(Boolean)) {
      expect(path).toMatch(/^assertions\/[0-9a-f]{16}\.jsonl$/);
      const bytes = gitBytes(rewritten, ["cat-file", "blob", `${commit}:${path}`]);
      const report = verifySegment(path.slice("assertions/".length, -".jsonl".length), bytes);
      expect({ untrusted: report.untrusted, unsupported: report.unsupported, tornTail: report.tornTail, partialBatch: report.partialBatch, verified: report.verifiedBytes, size: bytes.length })
        .toEqual({ untrusted: null, unsupported: null, tornTail: false, partialBatch: null, verified: bytes.length, size: bytes.length });
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
});

/** Rewrite a clone of `source` with the expressions file: git-filter-repo when installed, the same literals otherwise. */
function rewrite(source: string, target: string, replaceFile: string, expressions: string[]): "git-filter-repo" | "literal" {
  git(dirname(target), ["clone", "-q", source, target]);
  if (spawnSync("git", ["filter-repo", "--version"]).status === 0) {
    git(target, ["filter-repo", "--replace-text", replaceFile, "--force"]);
    return "git-filter-repo";
  }
  const pairs = expressions.map(line => { const at = line.indexOf("==>"); return [line.slice(0, at), line.slice(at + 3)] as const; });
  const replace = (content: string) => pairs.reduce((value, [from, to]) => value.split(from).join(to), content);
  const segments = () => {
    const dir = join(target, "assertions");
    return existsSync(dir) ? readdirSync(dir).filter(name => /^[0-9a-f]{16}\.jsonl$/.test(name)).map(name => join("assertions", name)) : [];
  };
  const commits = git(target, ["rev-list", "--reverse", "HEAD"]).split("\n").filter(Boolean);
  git(target, ["checkout", "-q", "--orphan", "replay"]);
  for (const commit of commits) {
    git(target, ["read-tree", "--reset", "-u", commit]);
    for (const path of segments()) writeFileSync(join(target, path), replace(readFileSync(join(target, path), "utf8")));
    git(target, ["add", "-A"]);
    // A replacement can make two neighbouring trees identical; the replay keeps the commit order either way.
    git(target, ["commit", "-q", "--allow-empty", "-m", "rewrite"]);
  }
  git(target, ["branch", "-f", "main", "HEAD"]);
  git(target, ["checkout", "-q", "main"]);
  git(target, ["branch", "-D", "replay"]);
  // A clone keeps the payload under refs/remotes/*, so the rewrite drops that remote and every copied tag.
  git(target, ["remote", "remove", "origin"]);
  for (const tag of git(target, ["tag", "-l"]).split("\n").filter(Boolean)) git(target, ["tag", "-d", tag]);
  return "literal";
}

test("X3: a truncated scan is never clean", () => {
  const f = fixture();
  f.commit("notes only");
  const { id } = seed(f);
  purge(f, id);
  // A segment blob over the per-blob bound that Git lists but the scan refuses to read. It is committed and then
  // removed from the working tree, so the current journal stays readable while history holds the oversized blob.
  const oversized = join(f.vault, "assertions", "0123456789abcdef.jsonl");
  writeFileSync(oversized, "x".repeat(EXPOSURE_BLOB_BYTES + 1));
  f.commit("oversized segment");
  rmSync(oversized);
  const receipt = f.exposure();
  expect(receipt.exposed).toEqual([]);
  expect(receipt.truncated).toContain("8 MiB per-blob budget");
  expect(receipt.clean).toBe(false);
  expect(receipt.issues.some(issue => issue.includes("a partial scan is never reported clean"))).toBe(true);
});

test("X3: the replace file is 0600, refuses an existing path and refuses a path inside the vault", () => {
  const f = fixture();
  f.commit("notes only");
  const { id } = seed(f);
  f.commit("journal with payload");
  purge(f, id);
  f.commit("purge the payload");
  const target = join(f.outside, "replace.txt");
  const written = f.exposure(["--replace-file", target]);
  expect(written.replaceFile).toMatchObject({ path: target, lines: 1, unreplaceable: 0 });
  expect(written.replaceFile!.delete).toContain("delete this file after the rewrite");
  expect(statSync(target).mode & 0o777).toBe(0o600);

  expect(thrown(() => f.exposure(["--replace-file", target]))).toContain("refuses an existing path");
  const inside = join(f.vault, "replace.txt");
  expect(thrown(() => f.exposure(["--replace-file", inside]))).toContain("must lie outside the vault");
  expect(existsSync(inside)).toBe(false);
  expect(thrown(() => f.exposure(["--replace-file", join(f.root, "missing", "replace.txt")]))).toContain("does not exist");
});

test("X3: a line carrying \"==>\" is unreplaceable and lists the manual step", () => {
  const f = fixture();
  f.commit("notes only");
  const { id } = seed(f, "chair==>stool");
  f.commit("journal with payload");
  purge(f, id);
  f.commit("purge the payload");
  const receipt = f.exposure();
  expect(receipt.exposed).toHaveLength(1);
  expect(receipt.exposed[0]!.replaceable).toBe(false);
  expect(receipt.exposed[0]!.manual).toContain("git-filter-repo --replace-text cannot express literally");
  expect(JSON.stringify(receipt)).not.toContain("chair==>stool");
  expect(thrown(() => f.exposure(["--replace-file", join(f.outside, "replace.txt")]))).toContain("no exposed line can be written");
  expect(existsSync(join(f.outside, "replace.txt"))).toBe(false);
  expect(run(["assertions", "exposure", "test"], f.env).text).toContain("manual step:");
});

test("X4: the write policy, denyPaths and read permissions refuse exposure as they refuse vmem assertions", () => {
  const f = fixture();
  f.commit("notes only");
  const { id } = seed(f);
  f.commit("journal with payload");
  purge(f, id);
  f.commit("purge the payload");
  // A read-only scan works under write: none, exactly as `vmem assertions` does.
  const closed = loadRegistry(f.home);
  closed.vaults[0]!.write = "none";
  writeFileSync(join(f.home, CONFIG_FILE), JSON.stringify(closed));
  expect(f.exposure().clean).toBe(false);

  const denied = loadRegistry(f.home);
  denied.denyPaths = [join(f.vault, "assertions")];
  writeFileSync(join(f.home, CONFIG_FILE), JSON.stringify(denied));
  const exposureMessage = thrown(() => f.exposure()), assertionsMessage = thrown(() => run(["assertions", "test", "--json"], f.env));
  expect(exposureMessage).toContain("denied by denyPaths");
  expect(exposureMessage).toBe(assertionsMessage);

  const unreadable = loadRegistry(f.home);
  delete unreadable.denyPaths;
  writeFileSync(join(f.home, CONFIG_FILE), JSON.stringify(unreadable));
  chmodSync(join(f.vault, "assertions"), 0o000);
  try {
    const one = thrown(() => f.exposure()), two = thrown(() => run(["assertions", "test", "--json"], f.env));
    expect(one).not.toBe("");
    expect(one).toBe(two);
  } finally { chmodSync(join(f.vault, "assertions"), 0o755); }
});

test("a vault that is not a git repository reports clean: null", () => {
  const f = fixture({ repository: false });
  const receipt = f.exposure();
  expect(receipt).toMatchObject({ vault: "test", clean: null, truncated: null, exposed: [], issues: ["not a git repository"] });
  expect(run(["assertions", "exposure", "test", "--json"], f.env).code).toBe(1);
});

test("MCP: vmem_assertions_exposure is read-only, payload-free and bounded", async () => {
  const f = fixture({ write: "mcp" });
  f.commit("notes only");
  const { id } = seed(f);
  f.commit("journal with payload");
  purge(f, id);
  f.commit("purge the payload");
  const server = createVaultMcp(f.home, f.env), tool = server.tools.find(value => value.name === "vmem_assertions_exposure")!;
  expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  expect(Object.keys(tool.inputSchema.properties as Record<string, unknown>).sort()).toEqual(["assertion", "vault"]);
  const input = new PassThrough(), output = new PassThrough();
  let text = ""; output.on("data", chunk => { text += chunk.toString(); });
  const done = serveMcp({ tools: server.tools, handlers: server.handlers, input, output });
  for (const frame of [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: "exposure", method: "tools/call", params: { name: "vmem_assertions_exposure", arguments: { vault: "test" } } }]) input.write(JSON.stringify(frame) + "\n");
  input.end(); await done;
  const reply = JSON.parse(text.trim().split("\n")[1]!) as { result: { content: { text: string }[] } };
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(48 * 1024);
  const receipt = JSON.parse(reply.result.content[0]!.text) as ExposureReceipt;
  expect(receipt).toMatchObject({ clean: false, truncated: null });
  expect(receipt.exposed).toHaveLength(1);
  expect(reply.result.content[0]!.text).not.toContain(CANARY);
});

test("MCP: an oversized exposure reply drops refs first, then rows with an omitted count", () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ assertion: `a:0123456789abcdef:${index + 1}`, segment: "0123456789abcdef", seq: index + 1, hash: "a".repeat(64),
    commits: { count: 3, first: "b".repeat(40), last: "c".repeat(40) },
    refs: Array.from({ length: 8 }, (_, ref) => `refs/remotes/origin/branch-${ref}-${"x".repeat(24)}`), replaceable: true }));
  const base = { vault: "test", scanned: { commits: 12, blobs: 12, bytes: 4096 }, clean: false as const, truncated: null, issues: ["the scan reads this local repository only"] };
  const wide = exposureReply({ ...base, exposed: rows }) as ExposureReceipt;
  expect(assertFrameBytes(wide, "result")).toBeLessThanOrEqual(48 * 1024);
  expect(wide.refsOmitted).toBe(true);
  expect(wide.exposed.every(row => row.refs.length === 0)).toBe(true);

  const huge = [{ ...rows[0]!, manual: "m".repeat(60 * 1024), replaceable: false }, rows[1]!];
  const tiny = exposureReply({ ...base, exposed: huge }) as ExposureReceipt;
  expect(assertFrameBytes(tiny, "result")).toBeLessThanOrEqual(48 * 1024);
  expect(tiny.exposed).toEqual([]);
  expect(tiny.omitted).toBe(2);
  expect(tiny.refsOmitted).toBe(true);
});

test("X1: every purged entry is reported, and a purged revision resolves its assertion through parents", () => {
  const f = fixture();
  f.commit("notes only");
  const { id } = seed(f);
  const heads = () => { const items = evaluateAssertions(readJournal(f.vault)).items.filter(item => item.id === id); return items[0]?.heads ?? items.map(item => item.hash); };
  const revised = f.append([{ op: "revise", id, expected_heads: heads(), value: "stool", kind: "state", from: "2025-06-01", to: "open", source: ["mem:fixture"] }], "2026-02-01T00:00:00Z");
  expect(revised.ok).toBe(true);
  f.commit("revision with payload");
  purge(f, id);
  f.commit("purge both entries");
  const receipt = f.exposure();
  // Both entries carry the assertion's own id, and the one commit that stored both payloads holds each of them.
  expect(receipt.exposed.map(row => [row.assertion, row.seq, row.commits.count])).toEqual([[id, 2, 1], [id, 3, 1]]);
  expect(receipt.exposed[0]!.commits.last).toBe(git(f.vault, ["rev-parse", "HEAD~1"]));
  expect(receipt.scanned.commits).toBe(2);
  expect(JSON.stringify(receipt)).not.toContain(CANARY);
  expect(JSON.stringify(receipt)).not.toContain("stool");
});

test("X1: a commit that touches another assertions/ path still counts as holding an unchanged segment blob", () => {
  const f = fixture();
  f.commit("notes only");
  const { id } = seed(f);
  const payloadCommit = f.commit("journal with payload");
  writeFileSync(join(f.vault, "assertions", "notes.txt"), "not a segment\n");
  const strayCommit = f.commit("stray file beside the segment");
  purge(f, id);
  f.commit("purge the payload");
  const row = f.exposure().exposed[0]!;
  expect(row.commits).toEqual({ count: 2, first: payloadCommit, last: strayCommit });
});

test("writeReplaceFile refuses a scan with nothing replaceable and writes no file", () => {
  const f = fixture();
  const scan = { root: f.vault, lines: [], receipt: { vault: "test", scanned: { commits: 1, blobs: 1, bytes: 10 }, clean: false, truncated: null, issues: [],
    exposed: [{ assertion: "a:0123456789abcdef:2", segment: "0123456789abcdef", seq: 2, hash: "a".repeat(64), commits: { count: 1, first: "b".repeat(40), last: "b".repeat(40) }, refs: [], replaceable: false, manual: "by hand" }] } };
  expect(thrown(() => writeReplaceFile(scan, join(f.outside, "replace.txt")))).toContain("no exposed line can be written");
  expect(existsSync(join(f.outside, "replace.txt"))).toBe(false);
  const clean = { ...scan, receipt: { ...scan.receipt, clean: true, exposed: [] } };
  expect(thrown(() => writeReplaceFile(clean, join(f.outside, "replace-clean.txt")))).toContain("there is nothing to replace");
  // The same rules hold through the CLI: a non-repository vault has no history to map, so no file is written.
  const bare = fixture({ repository: false });
  expect(thrown(() => bare.exposure(["--replace-file", join(bare.outside, "replace.txt")]))).toContain("did not complete");
});
