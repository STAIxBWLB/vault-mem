import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { promoteToOrg, screenForOrg, dropUnresolvedLinks, replaceTopicsSection } from "../src/org-promote.ts";
import { syncVault, sameRemote } from "../src/sync.ts";
import { readLog } from "../src/vault-log.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { run } from "../src/cli.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const plainEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"].includes(key)));
const gitEnv = { ...plainEnv, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: gitEnv, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
}
const note = (title: string, body: string, extra = "") => `---\ntitle: ${JSON.stringify(title)}\ndescription: Synthetic evidence for navigation.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\n${extra}---\n# ${title}\n\n${body}\n\n## Relevant Notes\n\n## Topics\n\n- [[research]]\n`;
const moc = "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n";
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-org-"))); roots.push(root);
  const home = join(root, "state"), personal = join(root, "personal"), org = join(root, "org"), remote = join(root, "org-remote.git");
  for (const vault of [personal, org]) { mkdirSync(join(vault, "notes"), { recursive: true }); writeFileSync(join(vault, "notes", "research.md"), moc); }
  writeFileSync(join(personal, "notes", "shared-method.md"), note("Shared Method", "Uses [[org-only]] and [[private-idea|a private idea]] and [[research]]."));
  writeFileSync(join(personal, "notes", "private-idea.md"), note("Private Idea", "Personal."));
  writeFileSync(join(org, "notes", "org-only.md"), note("Org Only", "Org text."));
  Bun.spawnSync(["git", "init", "--bare", "--quiet", "-b", "main", remote], { env: gitEnv });
  git(org, "init", "--quiet", "-b", "main"); git(org, "add", "."); git(org, "commit", "--quiet", "-m", "init"); git(org, "remote", "add", "origin", remote); git(org, "push", "--quiet", "origin", "main");
  addVault(home, { id: "personal", path: personal, kind: "personal", write: "mcp" });
  addVault(home, { id: "team", path: org, kind: "org", write: "cli", remote: `file://${remote}` });
  const env = { ...gitEnv, VMEM_HOME: home };
  return { root, home, personal, org, remote, env };
}
const snapshot = (dir: string) => git(dir, "status", "--porcelain", "--untracked-files=all");

test("preview shows full transformed text and dropped links and writes nothing; confirm writes org note, provenance and SYNC in both vaults", () => {
  const f = fixture(), before = { personal: readFileSync(join(f.personal, "notes", "shared-method.md"), "utf8"), org: snapshot(f.org) };
  const preview = promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team" }, { env: f.env });
  expect(preview).toMatchObject({ ok: true, preview: true, applied: false, source: "personal:notes/shared-method.md", target: "team:notes/shared-method.md", screen: { passed: true }, droppedLinks: ["private-idea"] });
  expect(preview.text).toContain("Uses [[org-only]] and a private idea and [[research]].");
  expect(preview.lint).toMatchObject({ passed: true, issues: [] });
  expect(preview.text).toContain(`"promoted_from": "personal:notes/shared-method.md"`);
  expect(readFileSync(join(f.personal, "notes", "shared-method.md"), "utf8")).toBe(before.personal);
  expect(snapshot(f.org)).toBe(before.org);
  expect(existsSync(join(f.personal, "log")) || existsSync(join(f.org, "log"))).toBe(false);

  expect(promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team", confirm: true, fingerprint: "0".repeat(64) }, { env: f.env }).issues[0]!.code).toBe("V09");
  const done = promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team", confirm: true, fingerprint: preview.fingerprint }, { env: f.env });
  expect(done).toMatchObject({ ok: true, applied: true, lint: { passed: true } });
  expect(readFileSync(join(f.org, "notes", "shared-method.md"), "utf8")).toBe(preview.text!);
  expect(parseFrontmatter(readFileSync(join(f.personal, "notes", "shared-method.md"), "utf8")).data.promoted_to).toBe("team:notes/shared-method.md");
  for (const vault of ["personal", "team"]) {
    const log = readLog(f.home, { vault });
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}  SYNC  -  personal:notes\/shared-method\.md → team:notes\/shared-method\.md  — promoted: insight$/);
  }
  // Promotion never publishes: the remote is untouched and nothing was committed.
  expect(git(f.org, "rev-parse", "HEAD")).toBe(git(f.remote, "rev-parse", "main"));
  expect(snapshot(f.org)).toContain("notes/shared-method.md");
  // Repeat promotion needs --again, and the existing org copy is never overwritten.
  expect(promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team" }, { env: f.env }).issues[0]!.code).toBe("AGAIN");
  expect(promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team", again: true }, { env: f.env }).issues[0]!.code).toBe("V08");
});

test("fail-closed screen refuses secrets, PII, people records, correspondence and meeting sources without writing", () => {
  const f = fixture();
  const cases: [string, string, string][] = [
    ["secret-note", note("Secret Note", "token = sk-" + "a".repeat(40)), "V06"],
    ["pii-note", note("Pii Note", "Call 010-1234-5678 for details."), "V07"],
    ["email-note", note("Email Note", "Mail someone@example.invalid today."), "V07"],
    ["person-note", note("Person Note", "Bio.").replace("type: insight", "type: person"), "SCREEN"],
    ["people-note", note("People Note", "Bio.").replace("domain: research", "domain: people"), "SCREEN"],
    ["mail-note", note("Mail Note", "Summary.", "source: \"outlook:thread-1\"\n"), "SCREEN"],
    ["chat-note", note("Chat Note", "Summary.", "source: \"telegram(group)\"\n"), "SCREEN"],
    ["inbox-note", note("Inbox Note", "Summary.", "source: \"inbox/2026/a.md\"\n"), "SCREEN"],
    ["meeting-note", note("Meeting Note", "Summary.", "source: \"meetings/2026-10-01.md\"\n"), "SCREEN"],
  ];
  for (const [stem, text] of cases) writeFileSync(join(f.personal, "notes", `${stem}.md`), text);
  const before = { personal: readFileSync(join(f.personal, "notes", "secret-note.md"), "utf8"), org: snapshot(f.org) };
  for (const [stem, , code] of cases) {
    const result = promoteToOrg(f.home, { from: "personal", note: stem, to: "team" }, { env: f.env });
    expect(result.ok, stem).toBe(false);
    expect(result.screen.passed, stem).toBe(false);
    expect(result.issues.map(i => i.code), stem).toContain(code);
  }
  expect(snapshot(f.org)).toBe(before.org);
  expect(readFileSync(join(f.personal, "notes", "secret-note.md"), "utf8")).toBe(before.personal);
  expect(existsSync(join(f.org, "log"))).toBe(false);
  expect(screenForOrg("plain", { type: "insight" }, { id: "t", path: "/x", kind: "org", write: "cli" }, { vaults: [], piiPatterns: ["ACCT-\\d+"] })).toEqual([]);
  expect(screenForOrg("ACCT-12345", {}, { id: "t", path: "/x", kind: "org", write: "cli" }, { vaults: [], piiPatterns: ["ACCT-\\d+"] })[0]!.code).toBe("V07");
});

test("source must be personal, target writable org, topics existing target MOCs", () => {
  const f = fixture();
  expect(promoteToOrg(f.home, { from: "team", note: "org-only", to: "personal" }, { env: f.env }).issues[0]!.code).toBe("POLICY");
  expect(promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "personal" }, { env: f.env }).issues[0]!.code).toBe("POLICY");
  expect(promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team", topics: ["missing-moc"] }, { env: f.env }).issues[0]!.code).toBe("V02");
  expect(promoteToOrg(f.home, { from: "personal", note: "nope", to: "team" }, { env: f.env }).issues[0]!.code).toBe("V04");
  expect(promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team", channel: "mcp" }, { env: f.env }).issues[0]!.code).toBe("POLICY");
  expect(dropUnresolvedLinks("[[a#h]] ![[b]] [[c|C]] `[[d]]`\n```\n[[e]]\n```", t => t === "c")).toEqual({ body: "a h b [[c|C]] `[[d]]`\n```\n[[e]]\n```", dropped: ["a", "b"] });
});

test("sync previews, stages only planned paths, pushes on confirm and verifies the remote", () => {
  const f = fixture();
  const preview = promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team" }, { env: f.env });
  promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team", confirm: true, fingerprint: preview.fingerprint }, { env: f.env });
  writeFileSync(join(f.org, "scratch.txt"), "unrelated");
  const remoteBefore = git(f.remote, "rev-parse", "main");
  const plan = syncVault(f.home, { vault: "team" }, { env: f.env });
  expect(plan).toMatchObject({ ok: true, preview: true, remote: { matches: true }, branch: "main", paths: ["log", "notes/shared-method.md"], ignored: ["scratch.txt"] });
  expect(git(f.remote, "rev-parse", "main")).toBe(remoteBefore);
  expect(syncVault(f.home, { vault: "team", confirm: true, fingerprint: "0".repeat(64) }, { env: f.env }).issues[0]!.code).toBe("V09");
  const pushed = syncVault(f.home, { vault: "team", confirm: true, fingerprint: plan.fingerprint }, { env: f.env });
  expect(pushed).toMatchObject({ ok: true, applied: true, pushed: true });
  expect(git(f.remote, "rev-parse", "main")).toBe(pushed.commit!);
  expect(git(f.remote, "show", "--name-only", "--format=", "main").split("\n").sort()).toEqual(["log", "notes/shared-method.md"]);
  expect(snapshot(f.org)).toBe("?? scratch.txt");
  // CLI parity, non-TTY: a fresh preview with nothing to publish is a no-op success.
  const cli = run(["sync", "team", "--json"], f.env);
  expect(JSON.parse(cli.text)).toMatchObject({ ok: true, preview: true, paths: [] });
});

test("sync refuses a mismatched remote, reports divergence and failed pushes without false success", () => {
  const f = fixture();
  // Mismatch: configured remote differs from origin; nothing is fetched or pushed.
  const other = join(f.root, "other.git"); Bun.spawnSync(["git", "init", "--bare", "--quiet", other], { env: gitEnv });
  git(f.org, "remote", "set-url", "origin", other);
  expect(syncVault(f.home, { vault: "team" }, { env: f.env })).toMatchObject({ ok: false, remote: { matches: false }, issues: [{ code: "REMOTE" }] });
  git(f.org, "remote", "set-url", "origin", f.remote);
  // Divergence: someone else changed the same file upstream.
  const peer = join(f.root, "peer"); Bun.spawnSync(["git", "clone", "--quiet", f.remote, peer], { env: gitEnv });
  writeFileSync(join(peer, "notes", "org-only.md"), note("Org Only", "Peer edit."));
  git(peer, "commit", "--quiet", "-am", "peer"); git(peer, "push", "--quiet", "origin", "main");
  writeFileSync(join(f.org, "notes", "org-only.md"), note("Org Only", "Local edit."));
  const plan = syncVault(f.home, { vault: "team" }, { env: f.env });
  expect(plan).toMatchObject({ ok: true, behind: 1, paths: ["notes/org-only.md"] });
  const diverged = syncVault(f.home, { vault: "team", confirm: true, fingerprint: plan.fingerprint }, { env: f.env });
  expect(diverged).toMatchObject({ ok: false, issues: [{ code: "DIVERGED" }] });
  expect(git(f.remote, "rev-parse", "main")).toBe(git(peer, "rev-parse", "HEAD"));
  expect(existsSync(join(f.org, ".git", "rebase-merge")) || existsSync(join(f.org, ".git", "rebase-apply"))).toBe(false);
}, 30_000);

test("credential-free https remote fails without prompting or success", () => {
  const f = fixture();
  const url = "https://127.0.0.1:9/org/vault.git";
  git(f.org, "remote", "set-url", "origin", url);
  const config = JSON.parse(readFileSync(join(f.home, "vmem.config.json"), "utf8"));
  config.vaults.find((v: { id: string }) => v.id === "team").remote = url;
  writeFileSync(join(f.home, "vmem.config.json"), JSON.stringify(config));
  const result = syncVault(f.home, { vault: "team" }, { env: { ...f.env, GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false" } });
  expect(result).toMatchObject({ ok: false, remote: { matches: true }, issues: [{ code: "FETCH" }] });
  expect(sameRemote("git@github.com:Org/Vault.git", "https://github.com/org/vault")).toBe(true);
  expect(sameRemote("https://github.com/org/vault.git", "https://github.com/org/other.git")).toBe(false);
}, 30_000);

test("a link that matches an org note only by alias is dropped, as Obsidian would not resolve it", () => {
  const f = fixture();
  writeFileSync(join(f.org, "notes", "org-only.md"), note("Org Only", "Org text.", "aliases: [Org Alias]\n"));
  git(f.org, "add", "."); git(f.org, "commit", "--quiet", "-m", "alias"); git(f.org, "push", "--quiet", "origin", "main");
  writeFileSync(join(f.personal, "notes", "shared-method.md"), note("Shared Method", "Uses [[org-only]] and [[Org Alias]] and [[research]]."));
  const preview = promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team" }, { env: f.env });
  expect(preview).toMatchObject({ ok: true, droppedLinks: ["Org Alias"] });
  expect(preview.text).toContain("Uses [[org-only]] and Org Alias and [[research]].");
  // Another note's alias equal to a real stem must not make that path link ambiguous.
  writeFileSync(join(f.org, "notes", "shadow.md"), note("Shadow", "Shadow text.", "aliases: [org-only]\n"));
  git(f.org, "add", "."); git(f.org, "commit", "--quiet", "-m", "shadow"); git(f.org, "push", "--quiet", "origin", "main");
  const shadowed = promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team" }, { env: f.env });
  expect(shadowed).toMatchObject({ ok: true, droppedLinks: ["Org Alias"] });
  expect(shadowed.text).toContain("Uses [[org-only]] and Org Alias and [[research]].");
});
test("dropped links to person, meeting or correspondence notes refuse without leaking their names", () => {
  const f = fixture();
  writeFileSync(join(f.personal, "notes", "jane-doe-contact.md"), note("Jane Doe Contact", "Bio.").replace("type: insight", "type: person"));
  writeFileSync(join(f.personal, "notes", "board-sync-2026.md"), note("Board Sync 2026", "Minutes.", "source: \"meetings/2026-10-01.md\"\n"));
  writeFileSync(join(f.personal, "notes", "vendor-thread.md"), note("Vendor Thread", "Summary.", "source: \"outlook:thread-9\"\n"));
  const cases: [string, string][] = [["jane-doe-contact", "personal_data"], ["board-sync-2026", "internal_meeting_notes"], ["vendor-thread", "private_correspondence"]];
  const before = snapshot(f.org);
  for (const [linked, category] of cases) {
    writeFileSync(join(f.personal, "notes", "shared-method.md"), note("Shared Method", `Uses [[org-only]] and [[${linked}|someone]].`));
    const result = promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team" }, { env: f.env });
    expect(result.ok, linked).toBe(false);
    expect(result.screen.passed).toBe(false);
    expect(result.issues.some(i => i.code === "SCREEN" && i.message.startsWith(category))).toBe(true);
    expect(JSON.stringify(result.issues)).not.toContain(linked);
  }
  expect(snapshot(f.org)).toBe(before);
  // An ordinary personal note link is still dropped to plain text and allowed.
  writeFileSync(join(f.personal, "notes", "shared-method.md"), note("Shared Method", "Uses [[org-only]] and [[private-idea]]."));
  expect(promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team" }, { env: f.env })).toMatchObject({ ok: true, droppedLinks: ["private-idea"] });
});

test("a failed provenance write is recoverable with a provenance-only rerun", () => {
  const f = fixture();
  const preview = promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team" }, { env: f.env });
  promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team", confirm: true, fingerprint: preview.fingerprint }, { env: f.env });
  // Simulate the lost provenance write: restore the source without promoted_to.
  writeFileSync(join(f.personal, "notes", "shared-method.md"), note("Shared Method", "Uses [[org-only]] and [[private-idea|a private idea]] and [[research]]."));
  const orgBefore = readFileSync(join(f.org, "notes", "shared-method.md"), "utf8");
  const rerun = promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team" }, { env: f.env });
  expect(rerun).toMatchObject({ ok: true, preview: true, recovery: "provenance-only" });
  const fixed = promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team", confirm: true, fingerprint: rerun.fingerprint }, { env: f.env });
  expect(fixed).toMatchObject({ ok: true, applied: true, recovery: "provenance-only" });
  expect(parseFrontmatter(readFileSync(join(f.personal, "notes", "shared-method.md"), "utf8")).data.promoted_to).toBe("team:notes/shared-method.md");
  expect(readFileSync(join(f.org, "notes", "shared-method.md"), "utf8")).toBe(orgBefore);
  expect(readLog(f.home, { vault: "team" }).lines).toHaveLength(1);
  // A foreign org note at the same path is still never overwritten.
  writeFileSync(join(f.personal, "notes", "org-only.md"), note("Org Only", "Personal copy."));
  expect(promoteToOrg(f.home, { from: "personal", note: "org-only", to: "team" }, { env: f.env }).issues[0]!.code).toBe("V08");
});

test("a note that would fail org lint is refused at preview and never written", () => {
  const f = fixture(), before = snapshot(f.org);
  // lint.py parity: a wiki link inside inline code still counts, so it is a dead link in the org vault.
  writeFileSync(join(f.personal, "notes", "shared-method.md"), note("Shared Method", "Uses [[org-only]]. Code `[[kept]]`."));
  const result = promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team" }, { env: f.env });
  expect(result).toMatchObject({ ok: false, applied: false, lint: { passed: false } });
  expect(result.issues.map(i => i.code)).toContain("L01");
  expect(snapshot(f.org)).toBe(before);
});

test("local remote paths compare case-sensitively", () => {
  expect(sameRemote("/srv/Vault.git", "/srv/vault.git")).toBe(false);
  expect(sameRemote("file:///srv/vault.git", "/srv/vault.git")).toBe(true);
  // Local repositories `x` and `x.git` are distinct; only host remotes drop the suffix.
  expect(sameRemote("file:///srv/vault.git", "/srv/vault")).toBe(false);
  expect(sameRemote("/srv/team", "/srv/team.git")).toBe(false);
});

test("sync refuses when any push URL or URL rewrite points away from the configured remote", () => {
  const f = fixture();
  const elsewhere = join(f.root, "elsewhere.git"); Bun.spawnSync(["git", "init", "--bare", "--quiet", "-b", "main", elsewhere], { env: gitEnv });
  writeFileSync(join(f.org, "notes", "org-only.md"), note("Org Only", "Changed."));
  const before = { remote: git(f.remote, "rev-parse", "main"), elsewhere: git(elsewhere, "rev-parse", "--all") };
  // pushurl: fetch URL matches, push would go elsewhere.
  git(f.org, "config", "remote.origin.pushurl", elsewhere);
  expect(syncVault(f.home, { vault: "team" }, { env: f.env })).toMatchObject({ ok: false, remote: { matches: false, push: [elsewhere] }, issues: [{ code: "REMOTE" }] });
  git(f.org, "config", "--unset", "remote.origin.pushurl");
  // pushInsteadOf rewrite: refused because the destination cannot be verified.
  git(f.org, "config", `url.${elsewhere}.pushInsteadOf`, f.remote);
  expect(syncVault(f.home, { vault: "team" }, { env: f.env })).toMatchObject({ ok: false, issues: [{ code: "REMOTE" }] });
  git(f.org, "config", "--unset", `url.${elsewhere}.pushInsteadOf`);
  // pushInsteadOf matching only an explicit pushurl: git does not report that rewrite, so it is refused too.
  git(f.org, "config", "remote.origin.pushurl", `file://${f.remote}`);
  git(f.org, "config", `url.${elsewhere}.pushInsteadOf`, "file://");
  expect(syncVault(f.home, { vault: "team" }, { env: f.env })).toMatchObject({ ok: false, issues: [{ code: "REMOTE", message: expect.stringContaining("pushinsteadof file://") }] });
  git(f.org, "config", "--unset", `url.${elsewhere}.pushInsteadOf`);
  git(f.org, "config", "--unset", "remote.origin.pushurl");
  // A rewrite that matches none of the vault's URLs (a global https-to-ssh rule) does not block sync.
  git(f.org, "config", "url.git@example.invalid:.insteadOf", "https://example.invalid/");
  expect(syncVault(f.home, { vault: "team" }, { env: f.env })).toMatchObject({ ok: true, remote: { matches: true } });
  git(f.org, "config", "--unset", "url.git@example.invalid:.insteadOf");
  // A pushurl added after the preview is caught by the fingerprint, and nothing is pushed anywhere.
  const plan = syncVault(f.home, { vault: "team" }, { env: f.env });
  expect(plan).toMatchObject({ ok: true, remote: { matches: true } });
  git(f.org, "config", "remote.origin.pushurl", elsewhere);
  expect(syncVault(f.home, { vault: "team", confirm: true, fingerprint: plan.fingerprint }, { env: f.env }).ok).toBe(false);
  expect(git(f.remote, "rev-parse", "main")).toBe(before.remote);
  expect(git(elsewhere, "rev-parse", "--all")).toBe(before.elsewhere);
}, 30_000);

test("the Topics section is found outside code fences; fenced headings and content are kept", () => {
  const f = fixture();
  const body = "Uses [[org-only]].\n\n```md\n## Topics\n\n- [[org-only]]\n```\n\nMore prose after the fence.";
  writeFileSync(join(f.personal, "notes", "shared-method.md"), note("Shared Method", body));
  const preview = promoteToOrg(f.home, { from: "personal", note: "shared-method", to: "team" }, { env: f.env });
  expect(preview.ok).toBe(true);
  expect(preview.text).toContain("```md\n## Topics\n\n- [[org-only]]\n```\n\nMore prose after the fence.");
  expect(preview.text!.endsWith("## Topics\n\n- [[research]]\n")).toBe(true);
  expect(replaceTopicsSection("# T\n\nText.", ["[[a]]"])).toBe("# T\n\nText.\n\n## Topics\n\n- [[a]]\n");
  expect(replaceTopicsSection("# T\n\n## Topics\n\n- [[old]]\n\n## After\n\nKeep.\n", ["[[a]]"])).toBe("# T\n\n## Topics\n\n- [[a]]\n\n## After\n\nKeep.\n");
});

test("a local remote and its .git twin are different destinations", () => {
  const f = fixture();
  // Two real bare repos: <remote> and <remote without .git>. Origin points at the twin.
  const twin = f.remote.replace(/\.git$/, "");
  Bun.spawnSync(["git", "init", "--bare", "--quiet", "-b", "main", twin], { env: gitEnv });
  git(f.org, "remote", "set-url", "origin", twin);
  writeFileSync(join(f.org, "notes", "org-only.md"), note("Org Only", "Changed."));
  const before = git(f.remote, "rev-parse", "main");
  expect(syncVault(f.home, { vault: "team" }, { env: f.env })).toMatchObject({ ok: false, remote: { matches: false }, issues: [{ code: "REMOTE" }] });
  expect(git(f.remote, "rev-parse", "main")).toBe(before);
  expect(Bun.spawnSync(["git", "-C", twin, "rev-parse", "--verify", "--quiet", "refs/heads/main"], { env: gitEnv }).exitCode).not.toBe(0);
}, 30_000);

test("sync never hashes, stages or pushes a denied path, and refuses a denied vault", () => {
  const f = fixture();
  const config = JSON.parse(readFileSync(join(f.home, "vmem.config.json"), "utf8"));
  config.denyPaths = ["private-ledger"];
  writeFileSync(join(f.home, "vmem.config.json"), JSON.stringify(config));
  writeFileSync(join(f.org, "notes", "private-ledger.md"), note("Private Ledger", "Denied content."));
  writeFileSync(join(f.org, "notes", "org-only.md"), note("Org Only", "Changed."));
  const before = git(f.remote, "rev-parse", "main");
  const preview = syncVault(f.home, { vault: "team" }, { env: f.env });
  expect(preview).toMatchObject({ ok: false, issues: [{ code: "V06" }], paths: ["notes/org-only.md"] });
  expect(preview.fingerprint).toBeUndefined();
  expect(JSON.stringify(preview.issues)).not.toContain("private-ledger");
  expect(syncVault(f.home, { vault: "team", confirm: true, fingerprint: "0".repeat(64) }, { env: f.env }).ok).toBe(false);
  expect(git(f.org, "diff", "--cached", "--name-only")).toBe("");
  expect(git(f.remote, "rev-parse", "main")).toBe(before);
  // Default deny names apply too (for example a credentials file).
  rmSync(join(f.org, "notes", "private-ledger.md"));
  writeFileSync(join(f.org, "notes", "credentials.json"), "{}");
  expect(syncVault(f.home, { vault: "team" }, { env: f.env })).toMatchObject({ ok: false, issues: [{ code: "V06" }] });
  rmSync(join(f.org, "notes", "credentials.json"));
  // A denied vault root refuses the whole sync before any git call.
  config.denyPaths = [f.org.split("/").at(-1)!];
  writeFileSync(join(f.home, "vmem.config.json"), JSON.stringify(config));
  expect(syncVault(f.home, { vault: "team" }, { env: f.env })).toMatchObject({ ok: false, branch: null, issues: [{ code: "V06" }] });
}, 30_000);

test("SYNC events cannot land in another vault when ids are re-registered before the appends", () => {
  const f = fixture(), rebound = join(f.root, "elsewhere"); for (const id of ["personal", "team"]) mkdirSync(join(rebound, id, "notes"), { recursive: true });
  const child = Bun.spawnSync([process.execPath, "test/fixtures/log-rebind.ts", f.home, "promote", rebound], { stdout: "pipe", stderr: "pipe", env: f.env });
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.applied).toBe(true); expect(result.ok).toBe(false);
  for (const key of ["source", "target"]) expect(result.logs[key].issues.some((i: { code: string }) => i.code === "LOG_DRIFT")).toBe(true);
  for (const id of ["personal", "team"]) expect(existsSync(join(rebound, id, "log"))).toBe(false);
  expect(existsSync(join(f.org, "notes", "shared-method.md"))).toBe(true); // the committed promotion is not rolled back
});

test("the promoted note cannot land in another vault when the target id is re-registered before the write", () => {
  const f = fixture(), rebound = join(f.root, "elsewhere"); for (const id of ["personal", "team"]) mkdirSync(join(rebound, id, "notes"), { recursive: true });
  const child = Bun.spawnSync([process.execPath, "test/fixtures/log-rebind.ts", f.home, "promote-write", rebound], { stdout: "pipe", stderr: "pipe", env: f.env });
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.ok).toBe(false); expect(result.issues.some((i: { code: string }) => i.code === "VAULT_DRIFT")).toBe(true);
  expect(existsSync(join(rebound, "team", "notes", "shared-method.md"))).toBe(false);
  expect(existsSync(join(f.org, "notes", "shared-method.md"))).toBe(false);
});

test("a promoted note that commits before its lock removal fails is reported as applied", () => {
  const f = fixture();
  const child = Bun.spawnSync([process.execPath, "test/fixtures/commit-fault.ts", f.home, "promote", join(f.org, "mutation.lock")], { stdout: "pipe", stderr: "pipe", env: f.env });
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.ok).toBe(false); expect(result.applied).toBe(true);
  expect(result.issues.some((i: { code: string }) => i.code === "CLEANUP")).toBe(true);
  expect(existsSync(join(f.org, "notes", "shared-method.md"))).toBe(true);
});

test("doctor validates a matching remote locally, leaves status unchanged and omits absent checks", () => {
  const f = fixture();
  // An unreachable origin still passes: doctor must never fetch or test reachability.
  rmSync(f.remote, { recursive: true });
  git(f.org, "config", "url.git@example.invalid:.insteadOf", "https://example.invalid/"); // unrelated rewrite
  const before = { status: run(["status", "--json"], f.env), config: readFileSync(join(f.home, "vmem.config.json"), "utf8"), head: git(f.org, "rev-parse", "HEAD"), files: snapshot(f.org) };
  const result = run(["doctor", "--json"], f.env), report = JSON.parse(result.text);
  expect(result.code).toBe(0);
  expect(report.healthy).toBe(true);
  expect(report.vaults.find((v: { id: string }) => v.id === "team").checks).toEqual({ remote: { ok: true } });
  expect(report.vaults.find((v: { id: string }) => v.id === "personal")).not.toHaveProperty("checks");
  expect(JSON.parse(before.status.text).vaults.every((v: object) => !("checks" in v))).toBe(true);
  expect(run(["status", "--json"], f.env)).toEqual(before.status);
  expect(readFileSync(join(f.home, "vmem.config.json"), "utf8")).toBe(before.config);
  expect(git(f.org, "rev-parse", "HEAD")).toBe(before.head);
  expect(snapshot(f.org)).toBe(before.files);
});

test.each(["mismatch", "missing", "non-repo", "nested", "insteadOf", "pushInsteadOf", "pushurl", "extra-fetch", "extra-push"])("doctor refuses remote %s with exit 1 while status remains healthy", mode => {
  const f = fixture(), other = join(f.root, "other.git");
  if (mode === "mismatch") git(f.org, "remote", "set-url", "origin", other);
  if (mode === "missing") git(f.org, "remote", "remove", "origin");
  if (mode === "non-repo") rmSync(join(f.org, ".git"), { recursive: true });
  if (mode === "nested") {
    git(f.root, "init", "--quiet");
    rmSync(join(f.org, ".git"), { recursive: true });
  }
  if (mode === "insteadOf" || mode === "pushInsteadOf") git(f.org, "config", `url.${other}.${mode}`, f.remote);
  if (mode === "pushurl") git(f.org, "config", "remote.origin.pushurl", other);
  if (mode === "extra-fetch") git(f.org, "config", "--add", "remote.origin.url", other);
  if (mode === "extra-push") {
    git(f.org, "config", "remote.origin.pushurl", f.remote);
    git(f.org, "config", "--add", "remote.origin.pushurl", other);
  }
  const result = run(["doctor", "--json"], f.env), report = JSON.parse(result.text);
  expect(result.code).toBe(1);
  expect(report.healthy).toBe(false);
  const team = report.vaults.find((v: { id: string }) => v.id === "team");
  expect(team.healthy).toBe(true);
  expect(team.checks.remote.ok).toBe(false);
  expect(team.checks.remote.issue.length).toBeGreaterThan(0);
  const status = run(["status", "--json"], f.env);
  expect(status.code).toBe(0);
  expect(JSON.parse(status.text).healthy).toBe(true);
  expect(JSON.parse(status.text).vaults.every((v: object) => !("checks" in v))).toBe(true);
});

test.each(["valid", "missing", "malformed", "no-projects", "duplicate", "invalid-id", "oversize", "denied"])("doctor uses write-time registry validation for %s", mode => {
  const f = fixture(), file = join(f.root, "project-registry.yaml");
  const configFile = join(f.home, "vmem.config.json"), config = JSON.parse(readFileSync(configFile, "utf8"));
  config.vaults.find((v: { id: string }) => v.id === "team").registry = file;
  const contents: Record<string, string> = {
    valid: "projects:\n  - id: project-a\n    sub_projects:\n      - id: project-b\n",
    malformed: "projects: [",
    "no-projects": "other: []\n",
    duplicate: "projects:\n  - id: same\n  - id: same\n",
    "invalid-id": "projects:\n  - id: Invalid_ID\n",
    oversize: " ".repeat(1024 * 1024 + 1),
    denied: "projects: []\n",
  };
  if (contents[mode] !== undefined) writeFileSync(file, contents[mode]!);
  if (mode === "denied") config.denyPaths = ["project-registry.yaml"];
  writeFileSync(configFile, JSON.stringify(config));
  const before = run(["status", "--json"], f.env);
  const result = run(["doctor", "--json"], f.env), report = JSON.parse(result.text);
  expect(result.code).toBe(mode === "valid" ? 0 : 1);
  expect(report.healthy).toBe(mode === "valid");
  const checks = report.vaults.find((v: { id: string }) => v.id === "team").checks;
  expect(checks.remote).toEqual({ ok: true });
  expect(checks.registry.ok).toBe(mode === "valid");
  if (mode !== "valid") expect(checks.registry.issue.length).toBeGreaterThan(0);
  expect(run(["status", "--json"], f.env)).toEqual(before);
});

test("doctor skips optional checks on unavailable vaults", () => {
  const f = fixture();
  rmSync(join(f.org, "notes"), { recursive: true });
  const result = run(["doctor", "--json"], f.env);
  expect(result.code).toBe(1);
  const team = JSON.parse(result.text).vaults.find((v: { id: string }) => v.id === "team");
  expect(team.healthy).toBe(false);
  expect(team).not.toHaveProperty("checks");
});
