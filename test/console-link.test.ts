import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";
import { plugin } from "../src/ui/plugin.ts";

// Synthetic vault only; isolate every home before the provider opens.
const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-link-")));
const saved = { VMEM_HOME: process.env.VMEM_HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME, AMEM_HOME: process.env.AMEM_HOME };
process.env.VMEM_HOME = join(root, "state"); process.env.AGENTHUB_HOME = join(root, "family"); process.env.AMEM_HOME = join(root, "memory");
const note = (title: string) => `---\ntitle: ${JSON.stringify(title)}\ndescription: Synthetic note.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\n---\n# ${title}\n\nSynthetic text.\n\n## Topics\n\n- [[research]]\n`;
const notes = join(root, "mine", "notes");
mkdirSync(notes, { recursive: true });
writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic directory.\n---\n# Research\n");
for (const stem of ["alpha", "beta", "gamma", "delta"]) writeFileSync(join(notes, `${stem}.md`), note(stem));
addVault(process.env.VMEM_HOME, { id: "mine", path: join(root, "mine"), kind: "personal", write: "mcp" });
afterAll(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; rmSync(root, { recursive: true, force: true }); });
const read = (stem: string) => readFileSync(join(notes, `${stem}.md`), "utf8");
const logText = () => { try { return readFileSync(join(root, "mine", "log.md"), "utf8"); } catch { return ""; } };

test("vmem_link: no preview/confirm stays one step; preview writes nothing; confirm needs a matching fingerprint", async () => {
  const server = createVaultMcp(process.env.VMEM_HOME!, process.env);
  const link = server.handlers.vmem_link!;
  const before = [read("alpha"), read("beta")], log = logText();
  const preview = await link({ vault: "mine", from: "alpha", to: "beta", relation: "supports", preview: true }) as Record<string, unknown>;
  expect(preview).toMatchObject({ ok: true, applied: false, preview: true, logEvent: { type: "CONNECT", source: "notes/alpha.md", dest: "notes/beta.md" } });
  expect((preview.changes as { path: string }[]).map(c => c.path).sort()).toEqual(["notes/alpha.md", "notes/beta.md"]);
  expect([read("alpha"), read("beta"), logText()]).toEqual([...before, log]);
  expect(JSON.stringify(await link({ vault: "mine", from: "alpha", to: "beta", relation: "supports", confirm: true }))).toContain("confirm requires the preview fingerprint");
  expect([read("alpha"), read("beta")]).toEqual(before);
  const stale = await link({ vault: "mine", from: "alpha", to: "beta", relation: "supports", confirm: true, fingerprint: "0".repeat(64) }) as Record<string, unknown>;
  expect(stale).toMatchObject({ ok: true, applied: false, preview: true, stale: true, fingerprint: preview.fingerprint });
  expect([read("alpha"), read("beta")]).toEqual(before);
  const done = await link({ vault: "mine", from: "alpha", to: "beta", relation: "supports", confirm: true, fingerprint: preview.fingerprint }) as Record<string, unknown>;
  expect(done).toMatchObject({ ok: true, applied: true });
  expect(read("alpha")).toContain("[[beta]] (supports)");
  expect(read("beta")).toContain("[[alpha]] (supports)");
  // One step as in 0.13.0 when neither preview nor confirm is sent.
  expect(await link({ vault: "mine", from: "gamma", to: "delta", relation: "extends", bidirectional: false })).toMatchObject({ ok: true, applied: true });
  expect(read("gamma")).toContain("[[delta]] (extends)");
});

test("console link action: listed, previews both notes, refuses with next steps, confirms and treats an existing link as a no-op", async () => {
  expect(plugin.manifest.capabilities?.actions).toContain("link");
  const p = await plugin.open({ home: process.env.AGENTHUB_HOME!, log: () => {} });
  try {
    expect(await p.action({ action: "link", from: "beta", to: "gamma" })).toMatchObject({ ok: false, error: expect.stringContaining("relation are required") });
    expect(await p.action({ action: "link", from: "beta", to: "gamma", relation: "likes" })).toMatchObject({ ok: false, error: expect.stringContaining("invalid relation likes; use one of") });
    expect(await p.action({ action: "link", from: "beta", to: "missing", relation: "supports" })).toMatchObject({ ok: false, error: expect.stringContaining("note does not exist") });
    const before = read("beta");
    const preview = await p.action({ action: "link", from: "beta", to: "gamma", relation: "context-for", context: "synthetic" });
    if (!("needsConfirm" in preview)) throw new Error("expected a preview");
    expect(preview).toMatchObject({ verb: "Link notes", changes: expect.arrayContaining([{ op: "modify", target: "notes/beta.md" }, { op: "modify", target: "notes/gamma.md" }]) });
    expect((preview.preview as string[])[0]).toBe("link beta → gamma (context-for), both directions");
    expect(read("beta")).toBe(before);
    const stale = await p.action({ action: "link", from: "beta", to: "gamma", relation: "context-for", context: "synthetic", confirmed: true, fingerprint: "0".repeat(64) });
    expect("needsConfirm" in stale && stale.needsConfirm).toBe(true);
    expect(read("beta")).toBe(before);
    expect(await p.action({ action: "link", from: "beta", to: "gamma", relation: "context-for", context: "synthetic", confirmed: true, fingerprint: preview.fingerprint as string })).toMatchObject({ ok: true, message: "Link notes: done" });
    expect(read("beta")).toContain("[[gamma]] (context-for): synthetic");
    expect(await p.action({ action: "link", from: "beta", to: "gamma", relation: "context-for" })).toMatchObject({ ok: true, message: "Link notes: already done, nothing changed" });
  } finally { await p.close?.(); }
});
