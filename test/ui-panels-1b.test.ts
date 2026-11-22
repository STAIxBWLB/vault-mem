import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsoleProvider } from "@staix/agent-console/contract";
import { addVault } from "../src/registry.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";
import { assertionCoverageWarnings, plugin } from "../src/ui/plugin.ts";

// Panels for proposals, assertions and note history (vault-mem#266 increment 1b), through the console provider.
const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-ui-1b-")));
const home = join(root, "state"), vault = join(root, "vault"), notes = join(vault, "notes");
const saved = { VMEM_HOME: process.env.VMEM_HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME };
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
});
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "F", GIT_AUTHOR_EMAIL: "f@example.invalid", GIT_COMMITTER_NAME: "F", GIT_COMMITTER_EMAIL: "f@example.invalid" };
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", vault, ...args], { env: gitEnv, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
mkdirSync(notes, { recursive: true });
writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
const alpha = (text: string) => `---\ntitle: "Alpha"\ndescription: Synthetic note.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\n---\n# Alpha\n\n${text}\n\n## Topics\n\n- [[research]]\n`;
writeFileSync(join(notes, "alpha.md"), alpha("first"));
git("init", "-q", "-b", "main"); git("config", "maintenance.auto", "false"); git("config", "gc.auto", "0");
git("add", "."); git("commit", "-qm", "one");
writeFileSync(join(notes, "alpha.md"), alpha("second"));
git("commit", "-qam", "two");
addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp" });

const operation = (path: string) => ({ op: "create", path, frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"], source: "https://example.invalid/source", evidence: [{ source: "https://example.invalid/source", sha256: "a".repeat(64), quote: "Synthetic quote" }] }, body: `# ${path}\n\nSynthetic.\n\n## Topics\n\n- [[research]]\n` });
const submit = async (path: string) => (await createVaultMcp(home, { VMEM_HOME: home }).handlers.vmem_proposal_submit!({ vault: "mine", operation: operation(path) }) as { id: string }).id;
async function open(): Promise<ConsoleProvider> {
  process.env.VMEM_HOME = home; process.env.AGENTHUB_HOME = join(root, "family");
  return plugin.open({ home: process.env.AGENTHUB_HOME, log: () => {} });
}

test("the manifest lists the new panels and actions after the existing ones", () => {
  const panels = plugin.manifest.panels.map(p => p.id);
  expect(panels.slice(0, 6)).toEqual(["overview", "notes", "note", "promote", "lint", "log"]);
  expect(panels).toEqual(expect.arrayContaining(["proposals", "assertions", "history"]));
  expect(plugin.manifest.capabilities?.actions).toEqual(expect.arrayContaining(["delete", "move", "promote", "promote-from-amem", "proposal-apply", "proposal-reject"]));
});

test("proposals: list, show, apply with the two-step confirm and reject with a reason", async () => {
  const p = await open();
  try {
    const first = await submit("candidate"), second = await submit("discarded");
    const listed = await p.snapshot({ after: 0, panel: "proposals", vault: "mine" }) as { state: string; page: { items: { id: string }[] } };
    expect(listed.state).toBe("pending");
    expect(listed.page.items.map(i => i.id).sort()).toEqual([first, second].sort());
    const shown = await p.snapshot({ after: 0, panel: "proposals", vault: "mine", id: first }) as { selected: { id: string; content: string } };
    expect(shown.selected.id).toBe(first);
    expect(JSON.parse(shown.selected.content)).toMatchObject({ path: "notes/candidate.md" });

    const preview = await p.action({ action: "proposal-apply", id: first, vault: "mine" });
    expect(preview).toMatchObject({ ok: false, needsConfirm: true, verb: "Apply proposal", changes: [{ op: "create", target: "notes/candidate.md" }] });
    expect(existsSync(join(notes, "candidate.md"))).toBe(false);
    // A stale fingerprint only shows the preview again; nothing is written.
    expect(await p.action({ action: "proposal-apply", id: first, vault: "mine", confirmed: true, fingerprint: "0".repeat(64) })).toMatchObject({ needsConfirm: true });
    expect(existsSync(join(notes, "candidate.md"))).toBe(false);
    const fingerprint = (preview as { fingerprint: string }).fingerprint;
    expect(await p.action({ action: "proposal-apply", id: first, vault: "mine", confirmed: true, fingerprint })).toMatchObject({ ok: true });
    expect(existsSync(join(notes, "candidate.md"))).toBe(true);
    // A decided proposal is refused with its cause and next step.
    const again = await p.action({ action: "proposal-apply", id: first, vault: "mine" }) as { ok: boolean; error: string };
    expect(again.ok).toBe(false);
    expect(again.error).toContain("no longer pending; inspect the proposal");

    expect(await p.action({ action: "proposal-reject", id: second, vault: "mine" })).toMatchObject({ ok: false, error: "rejection needs a reason; enter one and reject again" });
    const reject = await p.action({ action: "proposal-reject", id: second, reason: "not needed", vault: "mine" }) as { needsConfirm: boolean; fingerprint: string; verb: string };
    expect(reject).toMatchObject({ needsConfirm: true, verb: "Reject proposal" });
    expect(await p.action({ action: "proposal-reject", id: second, reason: "not needed", vault: "mine", confirmed: true, fingerprint: reject.fingerprint })).toMatchObject({ ok: true, message: "Reject proposal: done" });
    expect(existsSync(join(notes, "discarded.md"))).toBe(false);
    const rejected = await p.snapshot({ after: 0, panel: "proposals", vault: "mine", state: "rejected" }) as { page: { items: { id: string }[] } };
    expect(rejected.page.items.map(i => i.id)).toEqual([second]);
  } finally { await p.close?.(); }
});

test("proposals refusals name cause and next step", async () => {
  const p = await open();
  try {
    expect(await p.action({ action: "proposal-apply", vault: "mine" })).toMatchObject({ ok: false, error: "a proposal id is required; select a proposal in the Proposals panel" });
    const missing = await p.snapshot({ after: 0, panel: "proposals", vault: "mine", id: "00000000-0000-4000-8000-000000000000" }) as { selected: unknown; error: string };
    expect(missing.selected).toBeNull();
    expect(missing.error).toBe("proposal: id not found; use proposal list to find an existing id");
    expect(await p.snapshot({ after: 0, panel: "proposals", vault: "nope" })).toMatchObject({ vault: null, error: "unknown vault nope; pick a registered vault from Overview" });
  } finally { await p.close?.(); }
});

test("assertions panel reads through vmem_assertions and reports invalid input", async () => {
  const p = await open();
  try {
    const empty = await p.snapshot({ after: 0, panel: "assertions", vault: "mine" }) as { vault: string; result: { items: unknown[]; basis: string } };
    expect(empty.vault).toBe("mine");
    expect(empty.result).toMatchObject({ basis: "assertion_journal", items: [] });
    const bad = await p.snapshot({ after: 0, panel: "assertions", vault: "mine", at: "not-a-date-at-all" }) as { result: unknown; error: string };
    expect(bad.result).toBeNull();
    expect(bad.error).toBe("invalid input for vmem_assertions; correct the panel parameters and reload");
    expect((empty as unknown as { warnings: unknown[] }).warnings).toBeInstanceOf(Array);
  } finally { await p.close?.(); }
});

test("assertion coverage gaps become warnings naming the next step", () => {
  const base = { journal: "present" as const, beforeFirstEntry: false, untrusted: [], unsupported: [], tornTail: [], partialBatch: [], purged: 0, unsynced: 0 };
  expect(assertionCoverageWarnings(base)).toEqual([]);
  const warnings = assertionCoverageWarnings({ ...base, untrusted: [{ segment: "s1", seq: 4, failedSeq: 4, entries: 1, reason: "hash mismatch" }], unsupported: [{ segment: "s1", seq: 5, failedSeq: 5, entries: 1 }], tornTail: ["s2"], partialBatch: [{ segment: "s1", seq: 6, entries: 1, size: 2 }], purged: 2, unsynced: 3, indexIssue: "assertion index could not be read or verified; check VMEM_HOME/indexes and retry" });
  expect(warnings.map(w => w.tone)).toEqual(["err", "warn", "warn", "warn", "neutral", "warn", "warn"]);
  expect(warnings[0]!.message).toBe("1 journal entry is untrusted and left out (s1#4, failed #4, 1 left out: hash mismatch); run `vmem assertions <vault> --history --json` and inspect the journal segments");
  expect(warnings[5]!.message).toContain("run `vmem sync`");
  expect(assertionCoverageWarnings({ ...base, unsynced: null }).map(w => w.tone)).toEqual(["neutral"]);
  const many = assertionCoverageWarnings({ ...base,
    untrusted: [{ segment: "a", seq: 2, failedSeq: 10, entries: 60, reason: "hash mismatch" }, { segment: "b", seq: 4, failedSeq: 4, entries: 2, reason: "invalid JSON" }],
    partialBatch: [{ segment: "a", seq: 2, entries: 17, size: 30 }, { segment: "b", seq: 32, entries: 3, size: 10 }] });
  expect(many[0]!.message).toContain("62 journal entries are untrusted");
  expect(many[0]!.message).toContain("a#2, failed #10, 60 left out");
  expect(many.slice(1).map(w => w.message)).toEqual(["batch a:2 has 17 of 30 entries; all 17 are left out; resubmit the batch", "batch b:32 has 3 of 10 entries; all 3 are left out; resubmit the batch"]);
});

test("proposal action input refusals name the next step", async () => {
  const p = await open();
  try {
    const id = await submit("long-reason");
    const r = await p.action({ action: "proposal-reject", id, reason: "x".repeat(5000), vault: "mine" }) as { ok: boolean; error: string };
    expect(r).toMatchObject({ ok: false, error: "invalid input for vmem_proposal_reject; shorten the reason to at most 4096 bytes and reject again" });
    expect(await p.action({ action: "proposal-apply", id: "x".repeat(40), vault: "mine" })).toMatchObject({ ok: false, error: "invalid input for vmem_proposal_apply; select the proposal again from the Proposals panel" });
  } finally { await p.close?.(); }
});

test("assertion continuation pages keep the query (at, asOf, history, subject, relation)", async () => {
  const p = await open();
  try {
    const mcp = createVaultMcp(home, { VMEM_HOME: home });
    const ops = [{ op: "declare", subject: "s:page" }, ...Array.from({ length: 3 }, (_, i) => ({ op: "assert", subject: "s:page", relation: `r${i}`, value: "v", kind: "state", from: "2026", to: "open", source: ["mem:x"] }))];
    expect(await mcp.handlers.vmem_assert!({ vault: "mine", ops })).toMatchObject({ ok: true, applied: true });
    const query = { subject: "s:page", at: "2026-06-01", history: "true", limit: 1 };
    const first = await p.snapshot({ after: 0, panel: "assertions", vault: "mine", ...query }) as { result: { items: unknown[]; continuation?: string } };
    expect(first.result.items).toHaveLength(1);
    const cursor = first.result.continuation!;
    expect(typeof cursor).toBe("string");

    // The shipped panel's Next page carries the whole query with the continuation.
    const source = readFileSync(new URL("../src/ui/panel.js", import.meta.url), "utf8");
    const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    type El = { kind: string; props: Record<string, unknown>; children: El[] };
    const el = (kind: string, props: Record<string, unknown> = {}, ...children: (El | null)[]): El => ({ kind, props, children: children.filter(Boolean) as El[] });
    const mount = { children: [] as El[], append(...n: El[]) { this.children.push(...n); } };
    let receive!: (s: unknown) => void, navigated: Record<string, unknown> | undefined;
    const root = { ...el("div"), append() {}, replaceChildren(...n: El[]) { this.children = n.filter(Boolean); }, querySelectorAll: () => [], contains: () => false, querySelector: () => null };
    const host = { tool: "vmem", mount, onSnapshot: (fn: typeof receive) => { receive = fn; }, navigate: (_t: string, _p: string, params: Record<string, unknown>) => { navigated = params; },
      ui: { h: (k: string, pr: Record<string, unknown>, ...c: El[]) => k === "div" && pr.class === "vmem" ? root : el(k, pr, ...c), rows: (r: unknown[], f: (x: unknown) => El) => r.length ? el("rows", {}, ...r.map(f)) : null,
        row: (pr: Record<string, unknown>) => el("row", pr), button: (label: string, onClick: () => void) => el("button", { label, onClick }), notice: (text: string) => el("notice", { text }), empty: (title: string) => el("empty", { title }) } };
    const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { value: { activeElement: null }, configurable: true });
    try {
      const panel = mod.default(host);
      panel.show("assertions", { vault: "mine", ...query });
      receive(first);
      const next = root.children.find(c => c.kind === "button" && c.props.label === "Next page")!;
      (next.props.onClick as () => void)();
      expect(navigated).toEqual({ vault: "mine", ...query, cursor });
    } finally { if (saved) Object.defineProperty(globalThis, "document", saved); else delete (globalThis as { document?: unknown }).document; }

    // Following it reads the next page; dropping the query would be refused as an invalid cursor.
    const second = await p.snapshot({ after: 0, panel: "assertions", ...navigated }) as { result: { items: unknown[] } | null; error?: string };
    expect(second.error).toBeUndefined();
    expect(second.result!.items).toHaveLength(1);
    expect(await p.snapshot({ after: 0, panel: "assertions", vault: "mine", subject: "s:page", cursor })).toMatchObject({ result: null, error: expect.any(String) });
  } finally { await p.close?.(); }
});

test("history panel lists revisions and the changes between two of them", async () => {
  const p = await open();
  try {
    expect(await p.snapshot({ after: 0, panel: "history", vault: "mine" })).toMatchObject({ vault: "mine", path: null, history: null, changes: null });
    const h = await p.snapshot({ after: 0, panel: "history", vault: "mine", path: "notes/alpha.md" }) as { history: { revisions: { revision: string }[] } };
    expect(h.history.revisions).toHaveLength(2);
    const [newer, older] = h.history.revisions.map(r => r.revision);
    const c = await p.snapshot({ after: 0, panel: "history", vault: "mine", path: "notes/alpha.md", from: older, to: newer }) as { changes: { changed: { path: string; status: string }[] } };
    expect(c.changes.changed).toEqual([expect.objectContaining({ path: "notes/alpha.md" })]);
    expect(await p.snapshot({ after: 0, panel: "history", vault: "mine", from: older })).toMatchObject({ error: "changes need both from and to commit ids; pick two revisions from the history list" });
    const bad = await p.snapshot({ after: 0, panel: "history", vault: "mine", from: "a".repeat(40), to: "b".repeat(40) }) as { changes: unknown; error: string };
    expect(bad.changes).toBeNull();
    expect(bad.error).toContain("Pick a full commit id from `vmem history <vault> <note>`");
    // Continuation pages: one revision per page, the returned continuation opens the older one.
    const page1 = await p.snapshot({ after: 0, panel: "history", vault: "mine", path: "notes/alpha.md", limit: 1 }) as { history: { revisions: { revision: string }[]; continuation?: string } };
    expect(page1.history.revisions.map(r => r.revision)).toEqual([newer!]);
    expect(typeof page1.history.continuation).toBe("string");
    const page2 = await p.snapshot({ after: 0, panel: "history", vault: "mine", path: "notes/alpha.md", limit: 1, cursor: page1.history.continuation }) as { history: { revisions: { revision: string }[] } };
    expect(page2.history.revisions.map(r => r.revision)).toEqual([older!]);
    expect(await p.snapshot({ after: 0, panel: "history", vault: "mine", path: "notes/alpha.md", cursor: "garbage" })).toMatchObject({ history: null, error: expect.stringContaining("restart without --cursor") });
  } finally { await p.close?.(); }
});
