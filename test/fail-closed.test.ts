import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { CONFIG_FILE, CONFIG_VERSION } from "../src/config.ts";
import { applyWrite } from "../src/writer.ts";
import { appendLog } from "../src/vault-log.ts";
import { promoteFromAmem, type SeamFactory } from "../src/promote.ts";
import { promoteToOrg } from "../src/org-promote.ts";
import { tidyVault } from "../src/tidy.ts";
import type { WriteOp } from "../src/write-types.ts";
import type { AmemCandidate } from "../src/amem/seam.ts";

// #82 follow-up: a PII policy with members this build does not know cannot be enforced, so every write fails closed.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const note = (title: string) => `---\ntitle: ${JSON.stringify(title)}\ndescription: Synthetic evidence.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\n---\n# ${title}\n\nSee [[beta]].\n\n## Evidence\n\nText.\n\n## Topics\n\n- [[research]]\n`;
function fixture(extended: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-failclosed-"))); roots.push(root);
  const home = join(root, "state"), env = { VMEM_HOME: home, HOME: root, CLAUDECODE: "1" };
  const make = (name: string, stems: string[]) => {
    const notes = join(root, name, "notes"); mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    for (const stem of stems) writeFileSync(join(notes, `${stem}.md`), note(stem[0]!.toUpperCase() + stem.slice(1)));
    return join(root, name);
  };
  addVault(home, { id: "mine", path: make("mine", ["alpha", "beta", "scratch"]), kind: "personal", write: "mcp" });
  addVault(home, { id: "team", path: make("team", []), kind: "org", write: "mcp" });
  if (extended) {
    // What a newer vmem would write: a newer config format whose policies carry a surface this build does not know.
    const file = join(home, CONFIG_FILE), raw = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...raw, version: CONFIG_VERSION + 1, vaults: raw.vaults.map((v: object) => ({ ...v, pii: { email: { notes: "deny", futureSurface: "deny" } } })) }));
  }
  return { root, home, env };
}
/** Every file under the fixture's vaults, path → bytes. */
function bytes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else out[path] = readFileSync(path, "base64"); } };
  for (const vault of ["mine", "team"]) walk(join(root, vault));
  return out;
}
const entry: AmemCandidate = { id: "a".repeat(32), project: "p", kind: "decision", title: "Durable choice", text: "We keep the index derived.", about: [], at: "2026-10-01T00:00:00Z" };
const seam: SeamFactory = async () => ({ project: "p", candidates: async () => [entry], entry: async id => id === entry.id ? entry : undefined, linkedPath: () => undefined, recordLink: async () => "linked", close() {} });
/** Each write kind, run as its caller runs it (two-step kinds preview, then confirm with the fingerprint). */
function writes(home: string, env: Record<string, string>): [string, () => Promise<{ ok: boolean; issues: { code: string; message: string }[] }>][] {
  const write = (operation: WriteOp) => async () => applyWrite(home, { vault: "mine", operation, channel: "cli" }, { env });
  const twoStep = (operation: WriteOp) => async () => {
    const preview = applyWrite(home, { vault: "mine", operation, channel: "cli" }, { env });
    return preview.ok ? applyWrite(home, { vault: "mine", operation, channel: "cli", confirm: true, fingerprint: preview.fingerprint }, { env }) : preview;
  };
  const meta = { type: "decision", domain: "research", topics: ["research"], description: "A promoted decision." };
  return [
    ["create", write({ op: "create", path: "gamma", frontmatter: { type: "insight", domain: "research", description: "Synthetic evidence.", topics: ["[[research]]"] }, body: "# Gamma\n\nText.\n\n## Topics\n\n- [[research]]\n" })],
    ["append", write({ op: "append", path: "alpha", section: "Evidence", markdown: "More text." })],
    ["frontmatter", write({ op: "frontmatter", path: "alpha", set: { title: "Alpha Two" } })],
    ["patch", write({ op: "patch", path: "alpha", oldString: "See [[beta]].", newString: "See [[beta]] again." })],
    ["link", write({ op: "link", from: "alpha", to: "beta", relation: "supports", bidirectional: true })],
    ["supersede", write({ op: "supersede", old: "beta", next: "alpha" })],
    ["move", twoStep({ op: "move", from: "scratch", to: "scratch-two" })],
    ["delete", twoStep({ op: "delete", path: "scratch-two" })],
    ["log append", async () => appendLog(home, { vault: "mine", event: { type: "LEARN", project: "-", source: "notes/alpha.md", note: "manual event" }, channel: "cli" }, { env })],
    ["promote-from-amem", async () => {
      const preview = await promoteFromAmem(home, { vault: "mine", id: entry.id, ...meta }, { env, project: "p", seam });
      return preview.ok ? promoteFromAmem(home, { vault: "mine", id: entry.id, ...meta, confirm: true, fingerprint: preview.fingerprint }, { env, project: "p", seam }) : preview;
    }],
    ["promote", async () => {
      const request = { from: "mine", note: "alpha", to: "team", channel: "cli" as const };
      const preview = promoteToOrg(home, request, { env });
      return preview.ok ? promoteToOrg(home, { ...request, confirm: true, fingerprint: preview.fingerprint }, { env }) : preview;
    }],
    ["tidy", async () => tidyVault(home, { vault: "mine", rules: ["escapes"] }, { env })],
  ];
}

test("an extended PII policy refuses every write kind with PII_POLICY and leaves both vaults byte for byte unchanged", async () => {
  const f = fixture(true), before = bytes(f.root);
  for (const [kind, attempt] of writes(f.home, f.env)) {
    const result = await attempt();
    expect(result.ok, kind).toBe(false);
    expect(result.issues.map(i => i.code), kind).toContain("PII_POLICY");
    expect(result.issues.find(i => i.code === "PII_POLICY")!.message, kind).toContain("email.futureSurface");
    expect(result.issues.find(i => i.code === "PII_POLICY")!.message, kind).toContain("newer vmem");
  }
  expect(bytes(f.root)).toEqual(before);
});

test("the same writes succeed on a plain format-1 policy", async () => {
  const f = fixture(false);
  for (const [kind, attempt] of writes(f.home, f.env)) {
    const result = await attempt();
    expect(result.issues.filter(i => (i as { severity?: string }).severity === "error"), kind).toEqual([]);
    expect(result.ok, kind).toBe(true);
  }
});
