import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerConsoleConformance } from "@staix/agent-console/conformance";
import { addVault } from "../src/registry.ts";
import { consoleManifest } from "../src/setup.ts";
import { confirmedOutcome, followUpProblems, parseLogLine, plugin, typedFindings } from "../src/ui/plugin.ts";

// The provider resolves its home from the environment, like `vmem mcp`; isolate it before any test opens it.
const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-ui-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
process.env.VMEM_HOME = join(root, "state");
process.env.AGENTHUB_HOME = join(root, "family");
const note = (title: string, body: string, type = "insight") => `---\ntitle: ${JSON.stringify(title)}\ndescription: Synthetic evidence for navigation.\ntype: ${type}\ndomain: research\ntopics: ["[[research]]"]\n---\n# ${title}\n\n${body}\n\n## Topics\n\n- [[research]]\n`;
const make = (name: string) => {
  const notes = join(root, name, "notes"); mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
  writeFileSync(join(notes, "alpha.md"), note("Alpha Finding", "Alpha text about lanterns."));
  writeFileSync(join(notes, "beta.md"), note("Beta Finding", "Beta links to [[alpha]]."));
  return join(root, name);
};
addVault(process.env.VMEM_HOME, { id: "team", path: make("team"), kind: "org", write: "cli" });
addVault(process.env.VMEM_HOME, { id: "mine", path: make("mine"), kind: "personal", write: "mcp" });
const mine = join(root, "mine", "notes");

registerConsoleConformance(plugin, { destructive: [{ action: "delete", path: "beta" }, { action: "move", from: "alpha", to: "gamma" }] });

test("panels read the vault and the palette searches it", async () => {
  const p = await plugin.open({ home: process.env.AGENTHUB_HOME!, log: () => {} });
  const search = await p.snapshot({ after: 0, panel: "search", q: "lanterns", limit: 10 });
  expect(search).toMatchObject({ total: 1, hits: [{ id: "alpha.md", kind: "note", link: { panel: "note", params: { path: "alpha.md" } } }] });
  const read = await p.snapshot({ after: 0, panel: "note", path: "alpha" }) as { note: { frontmatter: { title: string } }; links: { in: unknown[] }; orgVaults: string[] };
  expect(read.note.frontmatter.title).toBe("Alpha Finding");
  expect(read.links.in).toHaveLength(1);
  expect(read.orgVaults).toEqual(["team"]);
  // Org promotion reads from the default personal vault only, so another vault never offers or runs it.
  expect(await p.snapshot({ after: 0, panel: "note", path: "alpha", vault: "team" })).toMatchObject({ orgVaults: [] });
  expect(await p.action({ action: "promote", path: "alpha", to: "team", vault: "team" })).toMatchObject({ ok: false });
  expect(await p.snapshot({ after: 0, panel: "overview", vault: "mine" })).toMatchObject({ vault: "mine", noteCount: 3 });
  expect(await p.snapshot({ after: 0, panel: "note", path: "missing" })).toMatchObject({ note: null });
  // Alerts keep the time they were first seen, so snooze and oldest-first order survive polls.
  const first = (await p.snapshot({ after: 0, panel: "inbox" })).items as { id: string; at: string }[];
  await Bun.sleep(5);
  const second = (await p.snapshot({ after: 0, panel: "inbox" })).items as { id: string; at: string }[];
  expect(first.length).toBeGreaterThan(0);
  expect(second.map(i => [i.id, i.at])).toEqual(first.map(i => [i.id, i.at]));
  expect(await p.snapshot({ after: 0, panel: "overview" })).toMatchObject({ noteCountCapped: false });
  // A vault chosen on one panel stays chosen when a tab navigates without params; actions follow it too.
  const q = await plugin.open({ home: process.env.AGENTHUB_HOME!, log: () => {} });
  expect(await q.snapshot({ after: 0, panel: "overview", vault: "team" })).toMatchObject({ vault: "team" });
  expect(await q.snapshot({ after: 0, panel: "lint" })).toMatchObject({ vault: "team" });
  expect(await q.action({ action: "promote", path: "alpha", to: "team" })).toMatchObject({ ok: false });
});

test("delete writes only on the console's confirmation with the current fingerprint", async () => {
  const p = await plugin.open({ home: process.env.AGENTHUB_HOME!, log: () => {} });
  // An explicit vault that does not exist is refused like MCP refuses it, never replaced by another vault.
  expect(await p.action({ action: "delete", path: "beta", vault: "missing" })).toMatchObject({ ok: false });
  expect(await p.snapshot({ after: 0, panel: "note", path: "beta", vault: "missing" })).toMatchObject({ note: null });
  // vmem refuses to delete a note that others link to; the refusal reaches the console as an error.
  expect(await p.action({ action: "delete", path: "alpha" })).toMatchObject({ ok: false });
  const preview = await p.action({ action: "delete", path: "beta" });
  if (!("needsConfirm" in preview)) throw new Error("expected a preview");
  expect(preview).toMatchObject({ verb: "Delete note", changes: [{ op: "delete", target: "notes/beta.md" }] });
  // A stale fingerprint gets a fresh preview, never a write.
  const stale = await p.action({ action: "delete", path: "beta", confirmed: true, fingerprint: "0".repeat(64) });
  expect("needsConfirm" in stale && stale.needsConfirm).toBe(true);
  expect(existsSync(join(mine, "beta.md"))).toBe(true);
  // The file changed after the preview: the old fingerprint no longer writes.
  writeFileSync(join(mine, "beta.md"), note("Beta Finding", "Beta changed."));
  const drift = await p.action({ action: "delete", path: "beta", confirmed: true, fingerprint: preview.fingerprint as string });
  expect("needsConfirm" in drift && drift.fingerprint !== preview.fingerprint).toBe(true);
  expect(existsSync(join(mine, "beta.md"))).toBe(true);
  if (!("needsConfirm" in drift)) throw new Error("expected a fresh preview");
  expect(await p.action({ action: "delete", path: "beta", confirmed: true, fingerprint: drift.fingerprint as string })).toMatchObject({ ok: true });
  expect(existsSync(join(mine, "beta.md"))).toBe(false);
  expect(await p.action({ action: "delete", path: "beta" })).toMatchObject({ ok: false });
  expect(await p.action({ action: "promote-from-amem", id: "not-an-id" })).toMatchObject({ ok: false, error: "a memory id is required" });
  // Options the MCP tool declares are forwarded and checked against its schema: a bad value is refused before anything runs.
  expect(await p.action({ action: "promote", path: "alpha", to: "team", again: "maybe" })).toMatchObject({ ok: false, error: "invalid input for vmem_promote" });
  const promote = await p.action({ action: "promote", path: "alpha", to: "team", topics: "research, shared", again: "true" });
  expect("error" in promote ? promote.error : "").not.toBe("invalid input for vmem_promote");
});

test("an applied write whose log append fails is reported as applied, with what is missing", async () => {
  const p = await plugin.open({ home: process.env.AGENTHUB_HOME!, log: () => {} });
  const preview = await p.action({ action: "move", from: "alpha", to: "gamma", vault: "mine" });
  if (!("needsConfirm" in preview)) throw new Error("expected a preview");
  const lock = join(root, "mine", "log.lock");
  writeFileSync(lock, "held by another writer\n");
  try {
    const done = await p.action({ action: "move", from: "alpha", to: "gamma", vault: "mine", confirmed: true, fingerprint: preview.fingerprint as string });
    expect(done).toMatchObject({ ok: true, message: expect.stringContaining("applied, but") });
    expect(existsSync(join(mine, "gamma.md"))).toBe(true);
  } finally { rmSync(lock, { force: true }); }
  expect(followUpProblems({ ok: true, applied: true, log: { ok: true } })).toEqual([]);
  expect(followUpProblems({ ok: false, applied: true, issues: [{ severity: "error", message: "agent-mem link failed" }] })).toEqual(["agent-mem link failed"]);
  expect(followUpProblems({ ok: true, applied: true, logs: { source: null, target: { ok: false, issues: [{ severity: "error", message: "SYNC append failed" }] } } })).toEqual(["SYNC append failed"]);
});

test("a confirmed write that changed nothing is success, not a refusal", () => {
  // promoteFromAmem answers a retried confirmation of an existing link this way.
  expect(confirmedOutcome({ ok: true, applied: false, alreadyLinked: true, issues: [] }, "Link memory")).toEqual({ ok: true, message: "Link memory: already done, nothing changed" });
  expect(confirmedOutcome({ ok: true, applied: false, issues: [{ severity: "warning", message: "w" }] }, "Promote")).toMatchObject({ ok: true });
  expect(confirmedOutcome({ ok: false, applied: false, issues: [{ severity: "error", message: "stale preview" }] }, "Promote")).toEqual({ ok: false, error: "stale preview" });
  expect(confirmedOutcome({ ok: true, applied: false, issues: [{ severity: "error", message: "blocked" }] }, "Promote")).toEqual({ ok: false, error: "blocked" });
  expect(confirmedOutcome({ ok: true, applied: true }, "Move")).toEqual({ ok: true, message: "Move: done" });
});

test("log lines and lint findings become typed rows", () => {
  expect(parseLogLine("2026-10-31 09:12  LEARN  proj  mem:abc → notes/x.md  — promoted: decision (vmem:agent)\n"))
    .toEqual({ at: "2026-10-31 09:12", type: "LEARN", project: "proj", source: "mem:abc", dest: "notes/x.md", note: "promoted: decision", agent: true });
  expect(parseLogLine("2026-10-31 09:12  LINT  -  vault  — 0 errors")).toMatchObject({ type: "LINT", project: "-", source: "vault", note: "0 errors", agent: false });
  expect(parseLogLine("garbage")).toEqual({ raw: "garbage" });
  expect(typedFindings({ L03: ["`notes/a.md`: in-link 0, topics 0"], L13: ["`notes/B.md`: expected lowercase ASCII kebab-case filename"], L11: ["graph report 없음"] })).toEqual([
    { code: "L03", severity: "warning", path: "notes/a.md", message: "`notes/a.md`: in-link 0, topics 0" },
    { code: "L13", severity: "error", path: "notes/B.md", message: "`notes/B.md`: expected lowercase ASCII kebab-case filename" },
    { code: "L11", severity: "warning", message: "graph report 없음" },
  ]);
});

test("setup writes, keeps and removes the acon manifest", () => {
  const env = { AGENTHUB_HOME: join(root, "setup-family") };
  const file = join(env.AGENTHUB_HOME, "console", "plugins", "vmem.json");
  expect(consoleManifest("dry-run", env)).toMatchObject({ change: "add" });
  expect(existsSync(file)).toBe(false);
  const added = consoleManifest("apply", env);
  expect(added.change).toBe("add");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  expect(manifest).toEqual({ api: 1, tool: "vmem", module: added.module, sha256: createHash("sha256").update(readFileSync(added.module)).digest("hex") });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(env.AGENTHUB_HOME, "console", "plugins")).mode & 0o777).toBe(0o700);
  expect(consoleManifest("apply", env).change).toBe("unchanged");
  writeFileSync(file, JSON.stringify({ ...manifest, module: "/elsewhere/plugin.ts" }), { mode: 0o600 });
  expect(consoleManifest("undo", env)).toMatchObject({ change: "refused" });
  writeFileSync(file, JSON.stringify(manifest), { mode: 0o600 });
  expect(consoleManifest("undo", env).change).toBe("remove");
  expect(existsSync(file)).toBe(false);
  // Same content but modes acon refuses: setup reports and fixes them instead of "unchanged".
  consoleManifest("apply", env);
  chmodSync(join(env.AGENTHUB_HOME, "console", "plugins"), 0o775); chmodSync(file, 0o664);
  expect(consoleManifest("dry-run", env)).toMatchObject({ change: "replace", reason: expect.stringContaining("permissions") });
  expect(consoleManifest("apply", env).change).toBe("replace");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(env.AGENTHUB_HOME, "console", "plugins")).mode & 0o777).toBe(0o700);
  expect(consoleManifest("apply", env).change).toBe("unchanged");
  // A linked plugin directory passes stat but acon refuses it (lstat), so setup refuses too.
  const linked = { AGENTHUB_HOME: join(root, "linked-family") };
  mkdirSync(join(root, "real-plugins"), { recursive: true, mode: 0o700 });
  mkdirSync(join(linked.AGENTHUB_HOME, "console"), { recursive: true });
  symlinkSync(join(root, "real-plugins"), join(linked.AGENTHUB_HOME, "console", "plugins"));
  expect(consoleManifest("apply", linked)).toMatchObject({ change: "refused", reason: expect.stringContaining("real directory") });
  expect(existsSync(join(root, "real-plugins", "vmem.json"))).toBe(false);
  // Undo through the same link is refused too and leaves the manifest behind it alone.
  writeFileSync(join(root, "real-plugins", "vmem.json"), JSON.stringify({ api: 1, tool: "vmem", module: added.module, sha256: "0".repeat(64) }), { mode: 0o600 });
  expect(consoleManifest("undo", linked)).toMatchObject({ change: "refused" });
  expect(existsSync(join(root, "real-plugins", "vmem.json"))).toBe(true);
});
