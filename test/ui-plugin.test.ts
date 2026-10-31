import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerConsoleConformance } from "@staix/agent-console/conformance";
import { addVault } from "../src/registry.ts";
import { consoleManifest } from "../src/setup.ts";
import { parseLogLine, plugin, typedFindings } from "../src/ui/plugin.ts";

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
  expect(await p.snapshot({ after: 0, panel: "overview" })).toMatchObject({ vault: "mine", noteCount: 3 });
  expect(await p.snapshot({ after: 0, panel: "note", path: "missing" })).toMatchObject({ note: null });
  // Alerts keep the time they were first seen, so snooze and oldest-first order survive polls.
  const first = (await p.snapshot({ after: 0, panel: "inbox" })).items as { id: string; at: string }[];
  await Bun.sleep(5);
  const second = (await p.snapshot({ after: 0, panel: "inbox" })).items as { id: string; at: string }[];
  expect(first.length).toBeGreaterThan(0);
  expect(second.map(i => [i.id, i.at])).toEqual(first.map(i => [i.id, i.at]));
  expect(await p.snapshot({ after: 0, panel: "overview" })).toMatchObject({ noteCountCapped: false });
});

test("delete writes only on the console's confirmation with the current fingerprint", async () => {
  const p = await plugin.open({ home: process.env.AGENTHUB_HOME!, log: () => {} });
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
});
