import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { tidyVault, parseTidyMap, type TidyRule } from "../src/tidy.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { analysisInput } from "../src/analysis-input.ts";
import { lintVault } from "../src/vault-lint.ts";
import { buildGraph } from "../src/vault-graph.ts";
import { applyWrite } from "../src/writer.ts";
import { run } from "../src/cli.ts";

// Synthetic fixture only: every note body below is invented for the test.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ALL: TidyRule[] = ["connections", "escapes", "enums", "keys", "sources", "topics", "secrets", "log"];
const TOKEN = "sk-" + "Z".repeat(32);
const fm = (lines: string[]) => `---\n${lines.join("\n")}\n---\n`;
const base = (extra: string[] = [], type = "insight") => ["description: Synthetic evidence for navigation.", `type: ${type}`, "domain: research", 'topics: ["[[research]]"]', ...extra];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-tidy-"))); roots.push(root);
  const home = join(root, "state"), vault = join(root, "vault"), notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true });
  for (const dir of [".obsidian", "templates", "self"]) { mkdirSync(join(vault, dir)); writeFileSync(join(vault, dir, "keep.md"), fm(["confidence: confirmed", "keywords: [x]"]) + "Untouched.\n"); }
  const write = (name: string, text: string) => writeFileSync(join(notes, `${name}.md`), text);
  write("research", fm(["type: moc", "description: Synthetic research directory."]) + "# Research\n");
  write("anchor", fm(base()) + "# Anchor\n\nAnchor text.\n\n## Topics\n\n- [[research]]\n");
  write("escaped", fm([...base(), 'title: "Caf\\u00e9 notes"']) + "# Escaped\n\nText.\n\n## Topics\n\n- [[research]]\n");
  write("wrapped", fm(['description: "A long synthetic description that the old writer \\', '  wrapped across lines."', "type: insight", "domain: research", 'topics: ["[[research]]"]']) + "# Wrapped\n\nText.\n\n## Topics\n\n- [[research]]\n");
  write("enums", fm(base(["confidence: confirmed"])) + "# Enums\n\nText.\n\n## Topics\n\n- [[research]]\n");
  write("combined", fm(base(["confidence: proven | likely"])) + "# Combined\n\nText.\n\n## Topics\n\n- [[research]]\n");
  write("unmapped-enum", fm(base(["confidence: hunch", "status: draft"])) + "# Unmapped Enum\n\nText.\n\n## Topics\n\n- [[research]]\n");
  write("keys", fm(base(["date: 2026-01-02", "keywords: [alpha, beta]", "origin: inbox", "related: [\"[[anchor]]\", \"work/projects/x.md\"]"])) + "# Keys\n\nText.\n\n## Topics\n\n- [[research]]\n");
  write("decision", fm(base(["decided_date: 2026-02-03"], "decision")) + "# Decision\n\nText.\n\n## Topics\n\n- [[research]]\n");
  write("contact", fm(base(["email: someone@example.invalid"], "person").map(l => l === "domain: research" ? "domain: people" : l)) + "# Contact\n\nText.\n\n## Topics\n\n- [[research]]\n");
  write("unmapped-key", fm(base(["mood: calm"])) + "# Unmapped Key\n\nText.\n\n## Topics\n\n- [[research]]\n");
  write("sources", fm(base(['source: "work/projects/a.md, work/projects/b.md"'])) + "# Sources\n\nText.\n\n## Topics\n\n- [[research]]\n");
  write("no-topics", fm(base()) + "# No Topics\n\nText.\n");
  write("connections", fm(base()) + "# Connections\n\nText.\n\n## Connections (2026-03)\n\n- [[anchor]]\n\n## Topics\n\n- [[research]]\n");
  write("secret", fm(base()) + `# Secret\n\nThe key was ${TOKEN} once.\n\n## Topics\n\n- [[research]]\n`);
  writeFileSync(join(vault, "log"), `2026-10-01 10:00  LEARN  -  a → b  — sent to someone@example.invalid\n2026-10-01 10:01  LEARN  -  a → b  — token ${TOKEN}\n2026-10-01 10:02  LEARN  -  a → b  — clean line\n`);
  addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp" });
  const env = { VMEM_HOME: home };
  const tidy = (rules: TidyRule[], extra: Record<string, unknown> = {}) => tidyVault(home, { vault: "mine", rules, ...extra }, { env });
  const disk = () => Object.fromEntries(readdirSync(notes).sort().map(name => [name, readFileSync(join(notes, name), "utf8")]));
  return { root, home, vault, notes, env, tidy, disk, read: (name: string) => readFileSync(join(notes, `${name}.md`), "utf8") };
}

test("preview lists every change and writes nothing; confirm applies; a second run previews zero", () => {
  const f = fixture(), before = f.disk(), logBefore = readFileSync(join(f.vault, "log"), "utf8");
  const preview = f.tidy(ALL);
  expect(preview).toMatchObject({ ok: true, preview: true, applied: false });
  expect(preview.counts).toMatchObject({ connections: 1, escapes: 2, enums: 2, sources: 2, topics: 1, secrets: 1, log: 2 });
  expect(preview.counts.keys).toBeGreaterThanOrEqual(5);
  const changed = Object.fromEntries(preview.notes.map(n => [n.path, n.changes.join("\n")]));
  expect(changed["notes/enums.md"]).toContain('confidence: "confirmed" -> "proven"');
  expect(changed["notes/combined.md"]).toContain('-> "likely"');
  expect(changed["notes/keys.md"]).toContain("keys: date -> created");
  expect(changed["notes/keys.md"]).toContain('keys: dropped keywords = ["alpha","beta"]');
  expect(changed["notes/decision.md"]).toContain("keys: decided_date -> decided_at");
  expect(changed["notes/no-topics.md"]).toContain("topics: added ## Topics section");
  expect(changed["notes/secret.md"]).toMatch(/secrets: 1 value redacted at line \d+/);
  expect(preview.reported.map(r => r.message)).toEqual(expect.arrayContaining([expect.stringContaining("enums: confidence \"hunch\" has no mapping"), expect.stringContaining("enums: status \"draft\" has no mapping"), "keys: unknown key mood has no mapping; unchanged"]));
  expect(f.disk()).toEqual(before);
  expect(readFileSync(join(f.vault, "log"), "utf8")).toBe(logBefore);

  expect(f.tidy(ALL, { confirm: true, fingerprint: "0".repeat(64) }).issues[0]!.code).toBe("V09");
  const done = f.tidy(ALL, { confirm: true, fingerprint: preview.fingerprint });
  expect(done).toMatchObject({ ok: true, applied: true });
  expect(parseFrontmatter(f.read("escaped")).data.title).toBe("Café notes");
  expect(f.read("escaped")).not.toContain("\\u00e9");
  expect(f.read("wrapped")).not.toMatch(/\\\s*\n/);
  expect(parseFrontmatter(f.read("enums")).data.confidence).toBe("proven");
  const keys = parseFrontmatter(f.read("keys"));
  expect(keys.data).toMatchObject({ created: "2026-01-02", source: "projects/x.md" });
  for (const key of ["date", "keywords", "origin", "related"]) expect(keys.data[key]).toBeUndefined();
  expect(keys.body).toContain("- [[anchor]]");
  expect(parseFrontmatter(f.read("decision")).data).toMatchObject({ decided_at: "2026-02-03" });
  expect(parseFrontmatter(f.read("contact")).data.email).toBe("someone@example.invalid"); // adopted on person notes in a personal vault
  expect(parseFrontmatter(f.read("sources")).data.source).toEqual(["projects/a.md", "projects/b.md"]);
  expect(f.read("no-topics")).toMatch(/## Topics\n\n- \[\[research\]\]\n$/);
  expect(f.read("connections")).not.toContain("## Connections");
  expect(f.read("secret")).toContain("[redacted]");
  expect(f.read("unmapped-key")).toContain("mood: calm");
  expect(parseFrontmatter(f.read("unmapped-enum")).data.confidence).toBe("hunch");
  // Never touches .obsidian/, templates/ or self/.
  for (const dir of [".obsidian", "templates", "self"]) expect(readFileSync(join(f.vault, dir, "keep.md"), "utf8")).toContain("confidence: confirmed");
  const log = readFileSync(join(f.vault, "log"), "utf8");
  expect(log).not.toContain("someone@example.invalid");
  expect(log).not.toContain(TOKEN);
  expect(log).toContain("clean line");
  expect(log.trim().split("\n").at(-1)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}  LINT  -  vmem:tidy  — tidy: connections 1, escapes 2, enums 2, keys \d+, sources 2, topics 1, secrets 1, log 2$/);
  const again = f.tidy(ALL);
  expect(again).toMatchObject({ ok: true, preview: true, notes: [] });
  expect(again.counts).toEqual({});
});

test("--secrets and --log never print a matched value in preview, receipts or the LINT event", () => {
  const f = fixture();
  const preview = f.tidy(["secrets", "log"]);
  const done = f.tidy(["secrets", "log"], { confirm: true, fingerprint: preview.fingerprint });
  for (const result of [preview, done]) {
    const text = JSON.stringify(result);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("someone@example.invalid");
  }
  expect(readFileSync(join(f.vault, "log"), "utf8")).not.toContain(TOKEN);
});

test("--secrets in frontmatter keeps a valid key and does not block the rest of the run", () => {
  const f = fixture();
  writeFileSync(join(f.notes, "fm-secret.md"), fm([...base().filter(l => !l.startsWith("description")), `description: "Rotated token = ${TOKEN} recorded here."`, `aliases: ["${TOKEN}", "plain"]`]) + "# Fm Secret\n\nText.\n\n## Topics\n\n- [[research]]\n");
  writeFileSync(join(f.notes, "comment-secret.md"), fm([...base(), `# ${TOKEN}`]) + "# Comment Secret\n\nText.\n\n## Topics\n\n- [[research]]\n");
  const preview = f.tidy(["secrets"]);
  expect(preview).toMatchObject({ ok: true, preview: true });
  expect(preview.notes.map(n => n.path)).toEqual(expect.arrayContaining(["notes/fm-secret.md", "notes/secret.md"]));
  expect(preview.reported.some(r => r.path === "notes/comment-secret.md" && r.message.startsWith("secrets:"))).toBe(true);
  expect(JSON.stringify(preview)).not.toContain(TOKEN);
  const done = f.tidy(["secrets"], { confirm: true, fingerprint: preview.fingerprint });
  expect(done.ok).toBe(true);
  const data = parseFrontmatter(f.read("fm-secret")).data;
  expect(data).toMatchObject({ description: "[redacted]", aliases: ["[redacted]", "plain"] });
  expect(f.read("fm-secret")).not.toContain(TOKEN);
  expect(f.read("secret")).not.toContain(TOKEN);
  // A sanitized note the writer would refuse (here an unknown key holding the secret) is skipped, not blocking.
  writeFileSync(join(f.notes, "bad-key.md"), fm([...base(), `api_note: "token = ${TOKEN}"`]) + "# Bad Key\n\nText.\n\n## Topics\n\n- [[research]]\n");
  writeFileSync(join(f.notes, "body-secret.md"), fm(base()) + `# Body Secret\n\nOld ${TOKEN} here.\n\n## Topics\n\n- [[research]]\n`);
  const mixed = f.tidy(["secrets"]);
  expect(mixed).toMatchObject({ ok: true, skipped: ["notes/bad-key.md"] });
  expect(mixed.notes.map(n => n.path)).toEqual(["notes/body-secret.md"]);
  expect(f.tidy(["secrets"], { confirm: true, fingerprint: mixed.fingerprint }).ok).toBe(true);
  expect(f.read("body-secret")).not.toContain(TOKEN);
  expect(f.read("bad-key")).toContain(TOKEN);
});

test("--map overrides defaults; unmapped values stay; map parsing is strict", () => {
  const f = fixture();
  const mapText = JSON.stringify({ enums: { confidence: { hunch: "experimental", confirmed: "likely" } }, keys: { mood: "drop", keywords: "keep", origin: { rename: "received" } } });
  const map = parseTidyMap(mapText);
  const preview = f.tidy(["enums", "keys"], { map, mapText });
  const changed = Object.fromEntries(preview.notes.map(n => [n.path, n.changes.join("\n")]));
  expect(changed["notes/enums.md"]).toContain('"confirmed" -> "likely"');
  expect(changed["notes/unmapped-enum.md"]).toContain('"hunch" -> "experimental"');
  expect(changed["notes/unmapped-key.md"]).toContain("keys: dropped mood");
  expect(changed["notes/keys.md"]).toContain("keys: origin -> received");
  expect(changed["notes/keys.md"]).not.toContain("keywords");
  // The map is part of the fingerprint.
  expect(f.tidy(["enums", "keys"]).fingerprint).not.toBe(preview.fingerprint);
  for (const bad of ["[]", "{\"extra\":1}", "{\"enums\":{\"domain\":{}}}", "{\"keys\":{\"x\":\"delete\"}}", "{\"keys\":{\"x\":{\"rename\":\"bad key\"}}}", "not json"]) expect(() => parseTidyMap(bad), bad).toThrow();
});

test("after --all the fixture has no L02 or V01 errors and the graph only gains related links", () => {
  const f = fixture();
  const edges = (graph: ReturnType<typeof buildGraph>) => graph.edges.map(e => `${e.source}~${e.target}`).sort();
  const beforeGraph = buildGraph(analysisInput(f.home, "mine").snapshot);
  const preview = f.tidy(ALL);
  f.tidy(ALL, { confirm: true, fingerprint: preview.fingerprint });
  const snapshot = analysisInput(f.home, "mine").snapshot, report = lintVault(snapshot);
  const l02 = report.findings.L02.filter(line => !line.includes("unmapped-enum"));
  expect(l02).toEqual([]);
  const afterGraph = buildGraph(snapshot);
  expect(afterGraph.nodes.map(n => n.id).sort()).toEqual(beforeGraph.nodes.map(n => n.id).sort());
  const added = edges(afterGraph).filter(edge => !edges(beforeGraph).includes(edge));
  // Links from `related`, plus the note-to-MOC edges a newly added `## Topics` section makes visible (the graph reads body links).
  expect(added).toEqual(["anchor~keys", "no-topics~research"]);
  expect(edges(beforeGraph).every(edge => edges(afterGraph).includes(edge))).toBe(true);
  // V01: unknown keys remain only where reported (unmapped), never introduced.
  for (const [name, text] of Object.entries(f.disk())) {
    if (["unmapped-key.md", "unmapped-enum.md", "research.md"].includes(name)) continue;
    const check = applyWrite(f.home, { vault: "mine", operation: { op: "check", path: `notes/${name}`, text } });
    expect(check.issues.filter(i => i.code === "V01" && i.severity === "error"), name).toEqual([]);
  }
});

test("interrupted run leaves each note fully old or fully new and a rerun completes the rest", () => {
  const f = fixture();
  const preview = f.tidy(["enums", "keys"]);
  // Simulate a crash after the first note: apply exactly one planned note, then edit nothing else.
  const first = preview.notes[0]!.path;
  const partial = Bun.spawnSync([process.execPath, "-e", `
    const { tidyVault } = await import("./src/tidy.ts");
    const writer = await import("./src/writer.ts");
    let calls = 0;
    const original = writer.applyWrite;
    // Count real (non-dry) writes; abort the process after the first one lands.
    const { mock } = await import("bun:test");
    mock.module("./src/writer.ts", () => ({ ...writer, applyWrite: (home, request, options) => { const r = original(home, request, options); if (!request.dryRun && ++calls === 1) process.exit(3); return r; } }));
    const fresh = await import("./src/tidy.ts?again");
    fresh.tidyVault(${JSON.stringify(f.home)}, { vault: "mine", rules: ["enums", "keys"], confirm: true, fingerprint: ${JSON.stringify(preview.fingerprint)} }, { env: { VMEM_HOME: ${JSON.stringify(f.home)} } });
  `], { stdout: "pipe", stderr: "pipe" });
  expect(partial.exitCode).toBe(3);
  expect(existsSync(join(f.vault, "mutation.lock"))).toBe(false);
  for (const note of preview.notes) {
    const text = f.read(note.path.slice(6, -3));
    expect(() => parseFrontmatter(text), note.path).not.toThrow();
  }
  expect(preview.notes.some(n => n.path === first)).toBe(true);
  const rerun = f.tidy(["enums", "keys"]);
  expect(rerun.notes.length).toBe(preview.notes.length - 1);
  expect(f.tidy(["enums", "keys"], { confirm: true, fingerprint: rerun.fingerprint }).ok).toBe(true);
  expect(f.tidy(["enums", "keys"]).notes).toEqual([]);
});

test("CLI: rule flags, --all, --map file, non-TTY, exclusive flags", () => {
  const f = fixture();
  const preview = JSON.parse(run(["tidy", "mine", "--enums", "--json"], f.env).text);
  expect(preview).toMatchObject({ ok: true, preview: true, rules: ["enums"] });
  const mapFile = join(f.root, "map.json"); writeFileSync(mapFile, JSON.stringify({ keys: { mood: "drop" } }));
  const keys = JSON.parse(run(["tidy", "mine", "--keys", "--map", mapFile, "--json"], f.env).text);
  expect(keys.notes.some((n: { path: string }) => n.path === "notes/unmapped-key.md")).toBe(true);
  const all = JSON.parse(run(["tidy", "mine", "--all", "--json"], f.env).text);
  expect(all.rules).toEqual(ALL);
  const done = run(["tidy", "mine", "--all", "--confirm", "--fingerprint", all.fingerprint, "--json"], f.env);
  expect(done.code).toBe(0);
  expect(() => run(["tidy", "mine"], f.env)).toThrow("select at least one rule");
  expect(() => run(["tidy", "mine", "--all", "--enums"], f.env)).toThrow("not both");
  expect(run(["tidy", "mine", "--connections"], f.env).code).toBe(0);
});
