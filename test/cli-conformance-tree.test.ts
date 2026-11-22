import { afterAll, expect, test } from "bun:test";
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLE_SGR } from "@staix/cli-output";
import { COMMANDS } from "../src/commands-table.ts";
import { runAsync } from "../src/cli.ts";
import { addVault, LOCK_FILE } from "../src/registry.ts";
import { readStoredProposal, replaceStoredProposal } from "../src/proposal-storage.ts";
import { proposalRecordDigest } from "../src/proposals.ts";
import { stripTerminal, width } from "../src/text-output.ts";
import { renderCandidates } from "../src/write-output.ts";

// #312 T4: the five standard-v1 conformance checks and the AC3/AC4 layout and content rules over the whole command tree,
// on a synthetic home (no host paths, no note contents from a real vault), at COLUMNS=80 and LC_ALL=C.

/** Exemptions recorded on #312 T1, each with its reason. */
const EXEMPT: Record<string, string> = {
  mcp: "stdio is MCP protocol, not human output",
  completion: "emits shell source for evaluation",
  "--version": "machine-readable version scalar",
};
/** Bodies printed verbatim (#312: note and spec bodies keep their bytes); the surrounding report is still checked. */
const BODY_AFTER: Record<string, RegExp> = { show: /\n> Content\n/, "proposal show": /\n> Content\n/ };
/** Renderer findings reported to the family owner on #312; each entry suspends one rule for one command until fixed. */
const KNOWN: Record<string, "markdown"> = { lint: "markdown" };

const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-tree-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home"), vault = join(root, "vault"), org = join(root, "org"), repo = join(root, "repo"), out = join(root, "out");
const note = (title: string, body: string, type = "insight") => `---\ntitle: ${JSON.stringify(title)}\ndescription: Synthetic note.\ntype: ${type}\ndomain: research\ntopics: ["[[research]]"]\n---\n# ${title}\n\n${body}\n\n## Topics\n\n- [[research]]\n`;
const git = (cwd: string, ...args: string[]) => { const r = Bun.spawnSync(["git", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.templateDir=", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); if (r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
for (const dir of [vault, org]) {
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "notes", "research.md"), "---\ntype: moc\ndescription: Synthetic directory.\n---\n# Research\n");
  writeFileSync(join(dir, "notes", "alpha.md"), note("Alpha", "Alpha links to [[beta]]."));
  writeFileSync(join(dir, "notes", "beta.md"), note("Beta", "Beta text about lanterns."));
  writeFileSync(join(dir, "notes", "gamma.md"), note("Gamma", "Gamma text."));
  git(dir, "init", "-q"); git(dir, "add", "-A"); git(dir, "commit", "-qm", "synthetic");
}
const firstCommit = git(vault, "rev-parse", "HEAD");
writeFileSync(join(vault, "notes", "gamma.md"), note("Gamma", "Gamma text, revised."));
git(vault, "commit", "-qam", "revise");
const secondCommit = git(vault, "rev-parse", "HEAD");
mkdirSync(join(repo, "docs"), { recursive: true });
writeFileSync(join(repo, "SPEC.md"), "---\nid: root\ntype: goal\ntitle: Synthetic root\n---\n# Root\n\nSynthetic spec body.\n");
git(repo, "init", "-q"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "spec");
addVault(home, { id: "mine", path: vault, kind: "personal", write: "cli" });
addVault(home, { id: "team", path: org, kind: "org", write: "cli" });
writeFileSync(join(root, "draft.md"), note("Draft", "Draft body."));
writeFileSync(join(root, "batch.json"), JSON.stringify({ ops: [{ op: "declare", subject: "s:alpha", note: "notes/alpha.md" }, { op: "assert", subject: "s:alpha", relation: "status", value: "active", kind: "state", from: "2026-01-01", to: "open", source: ["mem:synthetic"] }] }));
const proposalFile = (path: string) => { const file = join(root, `${path}.json`); writeFileSync(file, JSON.stringify({ op: "create", path, frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"], source: "https://example.invalid/source", evidence: [{ source: "https://example.invalid/source", sha256: "a".repeat(64), quote: "Synthetic quote" }] }, body: `# ${path}\n\nSynthetic.\n\n## Topics\n\n- [[research]]\n` })); return file; };
// A real install root for setup and an existing git vault for vaults add.
const pkg = join(root, "pkg"); mkdirSync(join(pkg, "bin"), { recursive: true });
writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@staix/vault-mem", version: "0.0.0" })); writeFileSync(join(pkg, "bin", "vmem.js"), "");
const extra = join(root, "extra"); mkdirSync(join(extra, "notes"), { recursive: true }); writeFileSync(join(extra, "notes", "research.md"), "---\ntype: moc\ndescription: Synthetic directory.\n---\n# Research\n");
git(extra, "init", "-q"); git(extra, "add", "-A"); git(extra, "commit", "-qm", "synthetic");
const env: NodeJS.ProcessEnv = { VMEM_HOME: home, AGENTHUB_HOME: join(root, "hub"), AMEM_HOME: join(root, "amem"), HOME: root, COLUMNS: "80", LC_ALL: "C", LANG: "C", TERM: "xterm", PATH: process.env.PATH };
// Two proposals submitted up front: A is shown and applied, B is rejected, R is reconciled.
const submit = async (path: string) => (JSON.parse((await runAsync(["proposal", "submit", "mine", proposalFile(path), "--json"], env)).text) as { id: string }).id;
const proposalA = await submit("synthetic-a"), proposalB = await submit("synthetic-b"), proposalR = await submit("synthetic-r");
// Reconcile needs an uncertain apply: mark proposal R as interrupted mid-apply, the way the proposals tests do.
{
  const digest = readdirSync(join(home, "proposals")).find(name => /^[a-f0-9]{64}$/.test(name))!, pending = readStoredProposal(home, digest, proposalR);
  const fd = openSync(join(home, LOCK_FILE), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { replaceStoredProposal(home, digest, proposalR, proposalRecordDigest(pending), { ...pending, state: "apply_unknown", intent: { fingerprint: "a".repeat(64), beforeSha: null, afterSha: "b".repeat(64) } }, [], fd); }
  finally { closeSync(fd); rmSync(join(home, LOCK_FILE)); }
}
/** Cases that cannot render on a synthetic home, with the reason; each has a direct renderer case below. */
const EXPECTED_REFUSAL: Record<string, string> = { "promote-from-amem": "needs an agent-mem generation-profile home" };

type Kind = "check" | "view" | "other";
/** One representative invocation per non-exempt command, in an order where earlier writes do not break later reads. */
const CASES: { name: string; args: string[]; kind: Kind }[] = [
  { name: "status", args: ["status"], kind: "view" },
  { name: "doctor", args: ["doctor"], kind: "check" },
  { name: "settings", args: ["settings", "mine"], kind: "view" },
  { name: "recover", args: ["recover"], kind: "other" },
  { name: "vaults list", args: ["vaults", "list"], kind: "view" },
  { name: "vaults pii", args: ["vaults", "pii", "mine"], kind: "view" },
  { name: "specs add", args: ["specs", "add", "app", repo], kind: "other" },
  { name: "specs list", args: ["specs", "list"], kind: "view" },
  { name: "spec get", args: ["spec", "get", "root"], kind: "view" },
  { name: "spec graph", args: ["spec", "graph", "root"], kind: "view" },
  { name: "spec grep", args: ["spec", "grep", "Synthetic"], kind: "view" },
  { name: "spec validate", args: ["spec", "validate"], kind: "check" },
  { name: "spec create", args: ["spec", "create", "docs/cache.md", "--id", "cache", "--type", "module", "--title", "Cache", "--parent", "root"], kind: "other" },
  { name: "spec update", args: ["spec", "update", "cache", "--set", "{\"status\":\"active\"}"], kind: "other" },
  { name: "spec delete", args: ["spec", "delete", "cache"], kind: "other" },
  { name: "rebuild", args: ["rebuild", "mine"], kind: "other" },
  { name: "search", args: ["search", "mine", "lanterns"], kind: "view" },
  { name: "show", args: ["show", "mine", "alpha"], kind: "view" },
  { name: "links", args: ["links", "mine", "alpha"], kind: "view" },
  { name: "brief", args: ["brief", "mine", "--for", "lanterns"], kind: "view" },
  { name: "evidence", args: ["evidence", "mine", "alpha"], kind: "view" },
  { name: "history", args: ["history", "mine", "gamma"], kind: "view" },
  { name: "changes", args: ["changes", "mine", "--from", firstCommit, "--to", secondCommit], kind: "view" },
  { name: "stats", args: ["stats", "mine"], kind: "view" },
  { name: "lint", args: ["lint", "mine"], kind: "check" },
  { name: "graph build", args: ["graph", "build", "mine", "--dry-run"], kind: "other" },
  { name: "graph neighbors", args: ["graph", "neighbors", "mine", "alpha"], kind: "view" },
  { name: "graph path", args: ["graph", "path", "mine", "alpha", "beta"], kind: "view" },
  { name: "graph explain", args: ["graph", "explain", "mine", "alpha", "beta"], kind: "view" },
  { name: "skills mine", args: ["skills", "mine", "mine"], kind: "view" },
  { name: "skills export", args: ["skills", "export", out], kind: "other" },
  { name: "check", args: ["check", "mine", join(root, "draft.md"), "--path", "draft"], kind: "check" },
  { name: "new", args: ["new", "mine", "delta", "--type", "insight", "--domain", "research", "--topics", "research", "--description", "Synthetic delta.", "--dry-run"], kind: "other" },
  { name: "patch", args: ["patch", "mine", "gamma", "--old", "revised", "--new", "edited", "--dry-run"], kind: "other" },
  { name: "append", args: ["append", "mine", "gamma", "--section", "Topics", "--markdown", "- [[alpha]]", "--dry-run"], kind: "other" },
  { name: "frontmatter", args: ["frontmatter", "mine", "gamma", "--set", "{\"status\":\"active\"}", "--dry-run"], kind: "other" },
  { name: "link", args: ["link", "mine", "gamma", "alpha", "--relation", "supports", "--dry-run"], kind: "other" },
  { name: "supersede", args: ["supersede", "mine", "gamma", "beta", "--dry-run"], kind: "other" },
  { name: "merge", args: ["merge", "mine", "beta", "gamma"], kind: "other" },
  { name: "move", args: ["move", "mine", "gamma", "gamma-two"], kind: "other" },
  { name: "delete", args: ["delete", "mine", "gamma"], kind: "other" },
  { name: "tidy", args: ["tidy", "mine", "--all"], kind: "other" },
  { name: "report", args: ["report", "mine", "reports/weekly.md", "--body", join(root, "draft.md"), "--dry-run"], kind: "other" },
  { name: "log append", args: ["log", "append", "mine", "LEARN", "-", "notes/alpha.md", "synthetic"], kind: "other" },
  { name: "log tail", args: ["log", "tail", "mine"], kind: "view" },
  { name: "log grep", args: ["log", "grep", "mine", "synthetic"], kind: "view" },
  { name: "assert", args: ["assert", "mine", "--batch", join(root, "batch.json")], kind: "other" },
  { name: "assertions", args: ["assertions", "mine"], kind: "view" },
  { name: "assertions purge", args: ["assertions", "purge", "mine", "a:0001:1", "--reason", "privacy"], kind: "other" },
  { name: "assertions exposure", args: ["assertions", "exposure", "mine"], kind: "check" },
  { name: "proposal submit", args: ["proposal", "submit", "mine", proposalFile("synthetic-c")], kind: "other" },
  { name: "proposal list", args: ["proposal", "list", "mine"], kind: "view" },
  { name: "proposal show", args: ["proposal", "show", "mine", proposalA], kind: "view" },
  { name: "proposal apply", args: ["proposal", "apply", "mine", proposalA], kind: "other" },
  { name: "proposal reject", args: ["proposal", "reject", "mine", proposalB, "--reason", "duplicate"], kind: "other" },
  { name: "proposal reconcile", args: ["proposal", "reconcile", "mine", proposalR], kind: "other" },
  { name: "promote-from-amem", args: ["promote-from-amem", "mine"], kind: "view" },
  { name: "promote", args: ["promote", "mine", "alpha", "--to", "team"], kind: "other" },
  { name: "sync", args: ["sync", "mine"], kind: "other" },
  { name: "setup", args: ["setup", "claude", "--root", pkg], kind: "other" },
  { name: "manifest", args: ["manifest"], kind: "view" },
  { name: "vaults add", args: ["vaults", "add", "extra", extra, "--kind", "personal", "--write", "cli"], kind: "other" },
  { name: "vaults remove", args: ["vaults", "remove", "team"], kind: "other" },
  { name: "specs remove", args: ["specs", "remove", "app"], kind: "other" },
];

interface Ran { text: string; code: number; stderr?: string }
async function invoke(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Ran> {
  try { return await runAsync(args, { ...env, ...extra }); }
  catch (error) { return { text: "", code: -1, stderr: error instanceof Error ? error.message : String(error) }; }
}
const results = new Map<string, { plain: Ran; colored: Ran }>();
for (const c of CASES) results.set(c.name, { plain: await invoke([...c.args, "--color=never"]), colored: await invoke([...c.args, "--color=always"]) });
/** The report part of a text: a printed body is cut off, since it keeps its own bytes. */
const reportPart = (name: string, text: string) => { const at = BODY_AFTER[name]?.exec(text); return at ? text.slice(0, at.index + at[0].length - 1) : text; };

test("every command is either exercised or exempt with a reason", () => {
  const covered = new Set(CASES.map(c => c.name));
  for (const command of COMMANDS) expect(covered.has(command.name) || Object.hasOwn(EXEMPT, command.name), command.name).toBe(true);
  for (const name of Object.keys(EXEMPT)) expect(covered.has(name)).toBe(false);
  for (const name of covered) expect(COMMANDS.some(c => c.name === name), name).toBe(true);
});

// Each case reaches its renderer: it prints a report (a header line) or refuses through the CLI error path with `vmem: ` text.
for (const c of CASES) test(`conformance: ${c.name}`, () => {
  const { plain, colored } = results.get(c.name)!;
  // Every case must reach its renderer, unless it is a listed expected refusal (which is checked at renderer level).
  if (Object.hasOwn(EXPECTED_REFUSAL, c.name)) { expect(plain.code, `${c.name}: expected refusal now renders; drop it from EXPECTED_REFUSAL`).toBe(-1); return; }
  expect(plain.stderr, `${c.name}: threw before rendering`).toBeUndefined();
  const text = reportPart(c.name, plain.text), lines = text.split("\n");
  // Check 1: color off has no ESC; --color=always paints with the standard SGR codes and strips back to the same text.
  expect(plain.text.includes("\u001b"), `${c.name}: ESC with --color=never`).toBe(false);
  // Writes run twice, so the second (colored) run may report "unchanged" or refuse; only reads must match byte for byte.
  if (c.kind !== "other") expect(stripTerminal(colored.text), `${c.name}: colored text differs`).toBe(plain.text);
  if (/\S/.test(colored.text)) expect(Object.values(ROLE_SGR).some(sgr => colored.text.includes(sgr)), `${c.name}: no role color`).toBe(true);
  // Check 3: COLUMNS=80, no report line over 80 cells (a printed command to copy is never shortened, per the standard).
  for (const line of lines) if (!/^\s*(->|→)\s/.test(line)) expect(width(line), `${c.name}: ${line}`).toBeLessThanOrEqual(80);
  // Check 5: LC_ALL=C prints ASCII markers only.
  expect(/[✓✗⚠→▸]/.test(text), `${c.name}: UTF-8 marker under LC_ALL=C`).toBe(false);
  // AC3 layout: one header first; sections have one blank line before and none after; no double or trailing blank lines.
  expect(lines[0], `${c.name}: header`).toMatch(/^ vmem \S/);
  expect(lines.slice(1).filter(line => /^ vmem \S/.test(line)), `${c.name}: second header`).toEqual([]);
  for (const [i, line] of lines.entries()) if (/^> \S/.test(line)) {
    expect(lines[i - 1], `${c.name}: blank before ${line}`).toBe("");
    expect(lines[i + 1] ?? "x", `${c.name}: blank after ${line}`).not.toBe("");
  }
  if (BODY_AFTER[c.name]) expect(lines.at(-1), `${c.name}: body section`).toMatch(/^> /);
  expect(/\n\n\n/.test(text), `${c.name}: double blank line`).toBe(false);
  expect(plain.text.endsWith("\n"), `${c.name}: trailing blank line`).toBe(false);
  // AC4 content: no raw JSON, Markdown markup, (s) plurals or placeholders in printed commands.
  expect(/^\s*[{[]"/m.test(text), `${c.name}: raw JSON`).toBe(false);
  if (KNOWN[c.name] !== "markdown") expect(/`[^`\n]+`|^#{1,6} |\*\*[^*\n]+\*\*/m.test(text), `${c.name}: Markdown markup`).toBe(false);
  expect(/\w\(s\)/.test(text), `${c.name}: (s) plural`).toBe(false);
  for (const line of lines.filter(line => /^\s*(->|→)\s/.test(line))) expect(/<[a-z][\w-]*>/.test(line), `${c.name}: placeholder in ${line}`).toBe(false);
  // Summary lines: exactly one, last, on check commands; none on view commands; no prose verdict beside it.
  const summaries = lines.filter(line => /^(x|!|\?|ok) \d+ (failed|warnings?|unknown|ok)/.test(line));
  if (c.kind === "check") {
    expect(summaries.length, `${c.name}: summary lines`).toBe(1);
    expect(lines.at(-1), `${c.name}: summary last`).toBe(summaries[0]);
    expect(lines.slice(0, -1).filter(line => /^\s*(verdict|result|overall)\b|\b(healthy|unhealthy|all checks passed)\b/i.test(line)), `${c.name}: prose verdict`).toEqual([]);
  }
  if (c.kind === "view") expect(summaries, `${c.name}: summary on a view`).toEqual([]);
});

test("check 2: NO_COLOR with --color=auto has no ESC, --json never has ESC, FORCE_COLOR colors a pipe", async () => {
  for (const c of CASES.filter(c => c.kind !== "other").slice(0, 12)) {
    const auto = await invoke(c.args, { NO_COLOR: "1", FORCE_COLOR: "1" });
    expect(auto.text.includes("\u001b"), c.name).toBe(false);
    const json = await invoke([...c.args, "--json", "--color=always"], { FORCE_COLOR: "1" });
    if (json.code !== -1) { expect(json.text.includes("\u001b"), c.name).toBe(false); JSON.parse(json.text); }
  }
  expect((await invoke(["status"], { FORCE_COLOR: "1" })).text).toContain("\u001b[");
});

test("check 4: failures exit non-zero with vmem: on stderr and usage errors exit 2, across command families", () => {
  const bin = new URL("../bin/vmem.js", import.meta.url).pathname;
  for (const c of CASES) {
    const usage = Bun.spawnSync([process.execPath, bin, ...c.args.slice(0, c.name.split(" ").length), "--no-such-flag"], { env, stdout: "pipe", stderr: "pipe" });
    expect(usage.exitCode, c.name).toBe(2);
    expect(usage.stderr.toString(), c.name).toStartWith("vmem: ");
    expect(usage.stderr.toString(), c.name).toContain(`Run 'vmem help`);
  }
  const failed = Bun.spawnSync([process.execPath, bin, "show", "nope", "alpha"], { env, stdout: "pipe", stderr: "pipe" });
  expect(failed.exitCode).toBe(1);
  expect(failed.stderr.toString()).toStartWith("vmem: ");
});

// Direct renderer cases for EXPECTED_REFUSAL, run through the same layout rules.
test("renderer: promote-from-amem candidates (empty and populated)", () => {
  const ctx = { argv: ["promote-from-amem", "mine"], positional: ["mine"] };
  const fill = { projects: [{ project: "synthetic", candidates: [{ id: "mem-1", project: "synthetic", kind: "decision", title: "Synthetic decision", at: "2026-01-01" }] }] };
  for (const data of [{ projects: [] }, fill]) {
    const plain = renderCandidates(data, { color: false, columns: 80, ascii: true }, ctx), colored = renderCandidates(data, { color: true, columns: 80, ascii: true }, ctx);
    const lines = plain.split("\n");
    expect(plain.includes("\u001b")).toBe(false);
    expect(stripTerminal(colored)).toBe(plain);
    expect(lines[0]).toMatch(/^ vmem promote-from-amem/);
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(80);
    for (const [i, line] of lines.entries()) if (/^> \S/.test(line)) { expect(lines[i - 1]).toBe(""); expect(lines[i + 1] ?? "x").not.toBe(""); }
    expect(/\n\n\n|\(s\)|`/.test(plain) || plain.endsWith("\n")).toBe(false);
    expect(lines.filter(line => /^(x|!|\?|ok) \d+ /.test(line))).toEqual([]);
  }
  expect(Object.keys(EXPECTED_REFUSAL)).toEqual(["promote-from-amem"]);
});

test("exempt commands keep their raw output", async () => {
  expect((await invoke(["--version"])).text).toMatch(/^\d+\.\d+\.\d+/);
  expect((await invoke(["completion", "bash"])).text).toContain("complete -F _vmem vmem");
});
