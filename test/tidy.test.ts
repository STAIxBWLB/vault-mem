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
import { LOG_LOCK } from "../src/vault-log.ts";
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
  expect(preview.counts).toMatchObject({ connections: 1, escapes: 2, enums: 2, sources: 2, topics: 1, secrets: 1, log: 1 });
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
  expect(log).toContain("someone@example.invalid"); // pii: allow keeps email in the log
  expect(log).not.toContain(TOKEN);
  expect(log).toContain("clean line");
  expect(log.trim().split("\n").at(-1)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}  LINT  -  vmem:tidy  — tidy: connections 1, escapes 2, enums 2, keys \d+, sources 2, topics 1, secrets 1, log 1$/);
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

test("--log redacts email addresses only in a pii-deny vault", () => {
  const f = fixture();
  expect(f.tidy(["log"]).log).toMatchObject({ redactions: 1 });
  const config = JSON.parse(readFileSync(join(f.home, "vmem.config.json"), "utf8"));
  config.vaults[0].pii = "deny"; writeFileSync(join(f.home, "vmem.config.json"), JSON.stringify(config));
  const preview = f.tidy(["log"]);
  expect(preview.log).toMatchObject({ redactions: 2 });
  expect(f.tidy(["log"], { confirm: true, fingerprint: preview.fingerprint }).ok).toBe(true);
  const log = readFileSync(join(f.vault, "log"), "utf8");
  expect(log).not.toContain("someone@example.invalid"); expect(log).not.toContain(TOKEN);
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

test("change lines and reports never echo a secret held in a dropped or mapped value", () => {
  const f = fixture();
  writeFileSync(join(f.notes, "legacy-secret.md"), fm([...base(), `origin: "token = ${TOKEN}"`, `keywords: ["${TOKEN}"]`]) + "# Legacy Secret\n\nText.\n\n## Topics\n\n- [[research]]\n");
  writeFileSync(join(f.notes, "enum-secret.md"), fm([...base(), `confidence: "${TOKEN}"`]) + "# Enum Secret\n\nText.\n\n## Topics\n\n- [[research]]\n");
  const preview = f.tidy(["keys", "enums", "secrets"]);
  const changes = preview.notes.find(n => n.path === "notes/legacy-secret.md")!.changes.join("\n");
  expect(changes).toContain('keys: dropped origin = "[redacted]"');
  expect(changes).toContain('keys: dropped keywords = "[redacted]"');
  expect(preview.reported.find(r => r.path === "notes/enum-secret.md")!.message).toContain('"[redacted]"');
  const done = f.tidy(["keys", "enums", "secrets"], { confirm: true, fingerprint: preview.fingerprint });
  for (const result of [preview, done]) expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(f.read("legacy-secret")).not.toContain(TOKEN);
  // A pii-deny vault also screens email and phone values echoed into change lines.
  const g = fixture();
  const config = JSON.parse(readFileSync(join(g.home, "vmem.config.json"), "utf8"));
  config.vaults[0].pii = "deny"; writeFileSync(join(g.home, "vmem.config.json"), JSON.stringify(config));
  writeFileSync(join(g.notes, "legacy-mail.md"), fm([...base(), `origin: "someone@example.invalid"`]) + "# Legacy Mail\n\nText.\n\n## Topics\n\n- [[research]]\n");
  const denied = g.tidy(["keys"]);
  expect(JSON.stringify(denied.notes)).not.toContain("someone@example.invalid");
  expect(denied.notes.find(n => n.path === "notes/legacy-mail.md")!.changes.join("\n")).toContain('keys: dropped origin = "[redacted]"');
});

test("--log normalizes legacy lines that fail the L09 structure check and is idempotent", () => {
  const f = fixture();
  const legacy = [
    "# header comment",
    "2026-09-01 15:28:42  GRAPH  -  reports/graph.md  — synthetic graph",
    "- 2026-05-11T05:03:16.756Z task-management: meetings/x.md",
    "- 2026-07-19 CORRECT synthetic-note: wording fixed",
    "2026-10-02 09:00  CORRECT  -  a  — legacy type stays",
    "2026-10-02 09:01  LEARN  -  a → b  — canonical line",
  ].join("\n") + "\n";
  writeFileSync(join(f.vault, "log"), legacy);
  const preview = f.tidy(["log"]);
  expect(preview.ok).toBe(true);
  expect(preview.log).toMatchObject({ redactions: 0, formats: 3 });
  expect(preview.log!.changes).toEqual(["log: line 2, format", "log: line 3, format", "log: line 4, format"]);
  const done = f.tidy(["log"], { confirm: true, fingerprint: preview.fingerprint });
  expect(done.ok).toBe(true); expect(done.written).toContain("log");
  const lines = readFileSync(join(f.vault, "log"), "utf8").split("\n");
  expect(lines.slice(0, 6)).toEqual([
    "# header comment",
    "2026-09-01 15:28  GRAPH  -  reports/graph.md  — synthetic graph",
    "# legacy: - 2026-05-11T05:03:16.756Z task-management: meetings/x.md",
    "# legacy: - 2026-07-19 CORRECT synthetic-note: wording fixed",
    "2026-10-02 09:00  CORRECT  -  a  — legacy type stays",
    "2026-10-02 09:01  LEARN  -  a → b  — canonical line",
  ]);
  expect(f.tidy(["log"]).log).toMatchObject({ lines: 0, formats: 0 });
  expect(lintVault(analysisInput(f.home, "mine").snapshot).findings.L09).toEqual([]);
});

test("--log refuses when the log path is denied and writes nothing", () => {
  const f = fixture(), logBefore = readFileSync(join(f.vault, "log"), "utf8"), before = f.disk();
  const config = JSON.parse(readFileSync(join(f.home, "vmem.config.json"), "utf8"));
  config.denyPaths = [`${f.vault.split("/").at(-1)}/log`];
  writeFileSync(join(f.home, "vmem.config.json"), JSON.stringify(config));
  const result = f.tidy(["secrets", "log"]);
  expect(result).toMatchObject({ ok: false, issues: [{ code: "V06" }] });
  expect(result.fingerprint).toBeUndefined();
  expect(readFileSync(join(f.vault, "log"), "utf8")).toBe(logBefore);
  expect(f.disk()).toEqual(before);
  expect(f.tidy(["secrets"]).ok).toBe(true); // other rules still run
});

test("--sources never splits a URL or memory id; only joined paths are split", () => {
  const f = fixture();
  writeFileSync(join(f.notes, "url-source.md"), fm([...base(), 'source: "https://example.invalid/a,b/c"']) + "# Url Source\n\nText.\n\n## Topics\n\n- [[research]]\n");
  writeFileSync(join(f.notes, "path-url-source.md"), fm([...base(), 'source: "work/projects/a.md, https://example.invalid/x"']) + "# Path Url Source\n\nText.\n\n## Topics\n\n- [[research]]\n");
  const preview = f.tidy(["sources"]);
  const paths = preview.notes.map(n => n.path);
  expect(paths).not.toContain("notes/url-source.md");
  expect(paths).toContain("notes/sources.md");
  f.tidy(["sources"], { confirm: true, fingerprint: preview.fingerprint });
  expect(parseFrontmatter(f.read("url-source")).data.source).toBe("https://example.invalid/a,b/c");
  expect(parseFrontmatter(f.read("sources")).data.source).toEqual(["projects/a.md", "projects/b.md"]);
  expect(Array.isArray(parseFrontmatter(f.read("path-url-source")).data.source)).toBe(false);
});

test("counts and the LINT event exclude skipped notes", () => {
  const f = fixture();
  writeFileSync(join(f.notes, "bad-key.md"), fm([...base(), `api_note: "token = ${TOKEN}"`]) + "# Bad Key\n\nText.\n\n## Topics\n\n- [[research]]\n");
  const preview = f.tidy(["secrets"]);
  expect(preview.skipped).toEqual(["notes/bad-key.md"]);
  expect(preview.counts).toEqual({ secrets: 1 });
  expect(preview.event).toBe("tidy: secrets 1");
});

test("the LINT event cannot land in another vault when the id is re-registered before the append", () => {
  const f = fixture(), rebound = join(f.root, "other-vault"); mkdirSync(join(rebound, "mine", "notes"), { recursive: true });
  const child = Bun.spawnSync([process.execPath, "test/fixtures/log-rebind.ts", f.home, "tidy", rebound], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.applied).toBe(true); expect(result.written).toContain("notes/no-topics.md");
  expect(result.issues.some((i: { code: string }) => i.code === "LOG_DRIFT")).toBe(true);
  expect(existsSync(join(rebound, "mine", "log"))).toBe(false);
  expect(readFileSync(join(f.vault, "log"), "utf8")).not.toContain("LINT");
  expect(f.read("no-topics")).toContain("## Topics"); // the committed note is not rolled back
});

test("a tidy write cannot land in another vault when the id is re-registered before the write", () => {
  const f = fixture(), rebound = join(f.root, "other-vault"), copy = join(rebound, "mine", "notes"); mkdirSync(copy, { recursive: true });
  for (const name of readdirSync(f.notes)) writeFileSync(join(copy, name), readFileSync(join(f.notes, name)));
  const before = { own: f.disk(), other: readdirSync(copy).map(n => readFileSync(join(copy, n), "utf8")) };
  const child = Bun.spawnSync([process.execPath, "test/fixtures/log-rebind.ts", f.home, "tidy-write", rebound], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.ok).toBe(false); expect(result.issues.some((i: { code: string }) => i.code === "VAULT_DRIFT")).toBe(true);
  expect(readdirSync(copy).map(n => readFileSync(join(copy, n), "utf8"))).toEqual(before.other);
  expect(f.disk()).toEqual(before.own);
});

test("tidy reports drift before its first dry run as a whole-run error and keeps applied after a partial write", () => {
  const dry = fixture(), elsewhere = join(dry.root, "other-vault"); mkdirSync(join(elsewhere, "mine", "notes"), { recursive: true });
  const preview = JSON.parse(Bun.spawnSync([process.execPath, "test/fixtures/log-rebind.ts", dry.home, "tidy-dry", elsewhere], { stdout: "pipe", stderr: "pipe" }).stdout.toString());
  expect(preview.ok).toBe(false); expect(preview.preview).toBeUndefined(); expect(preview.issues.map((i: { code: string }) => i.code)).toEqual(["VAULT_DRIFT"]);
  const f = fixture(), rebound = join(f.root, "other-vault"); mkdirSync(join(rebound, "mine", "notes"), { recursive: true });
  writeFileSync(join(f.notes, "zz-no-topics.md"), fm(base()) + "# Zz No Topics\n\nText.\n");
  const result = JSON.parse(Bun.spawnSync([process.execPath, "test/fixtures/log-rebind.ts", f.home, "tidy-second", rebound], { stdout: "pipe", stderr: "pipe" }).stdout.toString());
  expect(result.ok).toBe(false); expect(result.applied).toBe(true); expect(result.written).toEqual(["notes/no-topics.md"]);
  expect(result.issues.some((i: { code: string }) => i.code === "VAULT_DRIFT")).toBe(true);
  expect(f.read("zz-no-topics")).not.toContain("## Topics");
});

test("a log rewrite that lands before its lock removal fails is reported as written and applied", () => {
  const f = fixture();
  const child = Bun.spawnSync([process.execPath, "test/fixtures/commit-fault.ts", f.home, "tidy-log", join(f.vault, LOG_LOCK)], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.ok).toBe(false); expect(result.applied).toBe(true); expect(result.written).toEqual(["log"]);
  expect(result.issues.some((i: { code: string }) => i.code === "LOG")).toBe(true);
  expect(readFileSync(join(f.vault, "log"), "utf8")).not.toContain(TOKEN);
});

test("tidy migrates missing Topics and writes retained misplaced Topics with a warning", () => {
  const f = fixture();
  const missing = fm(base(["confidence: confirmed"])) + "# Missing topics\n\nText.\n";
  const misplaced = fm(base(["confidence: confirmed"])) + "# Misplaced topics\n\n## Topics\n- [[research]]\n\n## Detail\nText.\n";
  writeFileSync(join(f.notes, "migration-missing.md"), missing);
  writeFileSync(join(f.notes, "migration-misplaced.md"), misplaced);
  const preview = f.tidy(ALL);
  for (const path of ["notes/migration-missing.md", "notes/migration-misplaced.md"]) {
    expect(preview.notes.some(note => note.path === path)).toBe(true);
    expect(preview.skipped).not.toContain(path);
  }
  const warned = applyWrite(f.home, { vault: "mine", operation: { op: "sanitize", path: "notes/migration-misplaced.md", text: misplaced.replace("confirmed", "proven") }, dryRun: true, log: false });
  expect(warned.ok).toBe(true);
  expect(warned.issues).toContainEqual(expect.objectContaining({ code: "V05", severity: "warning" }));
  const done = f.tidy(ALL, { confirm: true, fingerprint: preview.fingerprint });
  expect(done.ok).toBe(true);
  expect(done.written).toContain("notes/migration-missing.md");
  expect(done.written).toContain("notes/migration-misplaced.md");
  expect(f.read("migration-missing")).toContain("## Topics");
  expect(parseFrontmatter(f.read("migration-misplaced")).data.confidence).toBe("proven");
});
