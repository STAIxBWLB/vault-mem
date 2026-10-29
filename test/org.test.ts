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
  expect(sameRemote("file:///srv/vault.git", "/srv/vault")).toBe(true);
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
