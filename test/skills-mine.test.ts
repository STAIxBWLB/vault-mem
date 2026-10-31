import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Test-only: the fixture authors amem rows through agent-mem's own stores; src/ reaches the root only via the seam.
import { CaptureStore, MemoryStore, migrate } from "@staix/agent-mem";
import { addVault } from "../src/registry.ts";
import { runAsync } from "../src/cli.ts";
import { createVaultMcp, VMEM_TOOL_NAMES } from "../src/mcp-vault.ts";
import {
  allPeople, buildSurfaceIndex, communityToCandidate, findMatches, jaccard, maskText, mineRecords, mineSkills, nodeId, skillFrontmatter, slugify, tokenize,
  type MineRecord, type RegistryProject, type ScoreGraph, type SurfaceKind,
} from "../src/skills-mine.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "skills-mine");
const oracle = JSON.parse(readFileSync(join(FIXTURES, "python-oracle.json"), "utf8"));
const actions = [{ canon: "summarize", surface: ["요약", "요약해줘", "summarize", "summary"] }, { canon: "organize", surface: ["정리", "정리해줘", "organize", "tidy"] }, { canon: "create", surface: ["작성", "create", "write", "draft"] }];
const objects = [{ canon: "meeting-notes", surface: ["회의록", "meeting", "meeting-notes"] }, { canon: "email", surface: ["메일", "email", "Gmail"] }, { canon: "inbox", surface: ["inbox", "수신함"] }];
const projects: RegistryProject[] = [{ id: "alpha", name: "Alpha", keywords: { ko: ["알파"], en: ["Alpha Lab"] }, acronyms: ["AL"], people: ["Kim Minsu", "홍길동"], orgs: ["Acme Corp"], sub_projects: [{ id: "alpha-web", keywords_extra: ["web portal"] }] }];

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("dictionary matching, slugs and masking match the Python materialize.py functions", () => {
  const index = buildSurfaceIndex(actions, objects, projects);
  // Same surfaces in the same longest-first order; person canons are digests here instead of name slugs.
  expect(index.map(s => [s.surface, s.kind])).toEqual(oracle.index.map(([surface, kind]: string[]) => [surface, kind]));
  for (const [i, s] of index.entries()) if (s.kind !== "person") expect(s.canon).toBe(oracle.index[i][2]);
  const persons = index.filter(s => s.kind === "person");
  expect(persons.every(s => /^p[0-9a-f]{10}$/.test(s.canon))).toBe(true);
  const texts = ["Please summarize the Meeting notes for Alpha Lab", "회의록 요약해줘 그리고 메일 작성", "TIDY the inbox; write a DRAFT", "홍길동 asked Kim Minsu about AL web portal", "summarizes GMAIL"];
  const personOf = new Map(persons.map(s => [slugify(s.surface), nodeId("person", s.canon)]));
  texts.forEach((text, i) => {
    const expected = (oracle.matches[i] as [string, string][]).map(([kind, canon]) => kind === "person" ? personOf.get(canon)! : nodeId(kind as SurfaceKind, canon)).sort();
    expect([...findMatches(text, index)].sort()).toEqual(expected);
  });
  expect(["Acme Corp", "  Hello  World ", "a/b:c", "", "회의 록!!", "x__y..z"].map(slugify)).toEqual(oracle.slug);
  const people = allPeople(projects);
  expect(people).toEqual(oracle.people);
  expect(["mail me at kim@example.org", "see /Users/x/notes/a.md and ~/w/b", "C:\\Users\\x\\f.txt done", "홍길동 met Kim Minsu"].map(t => maskText(t, people))).toEqual(oracle.mask);
  expect(nodeId("action", "Summarize")).toBe("action--summarize");
  expect(nodeId("org", "Acme Corp")).toBe("entity--org--acme-corp");
  expect(nodeId("project", "alpha-web")).toBe("entity--project--alpha-web");
  // Masking follows matching: ASCII names case-insensitively (as literals), Hangul exactly.
  expect(maskText("kim minsu and KIM MINSU met 홍길동", people)).toBe("[PERSON] and [PERSON] met [PERSON]");
  expect(maskText("a.b c", ["a.b"])).toBe("[PERSON] c");
  expect(maskText("axb c", ["a.b"])).toBe("axb c");
});

test("SKILL.md parsing, tokens, Jaccard and candidate scoring match the Python analyze.py functions", () => {
  expect(skillFrontmatter("---\nname: vault-sync\ndescription: Scan work for changes\n  and propose extractions\nx: 1\n---\nbody\n")).toEqual(oracle.fm);
  expect([...tokenize("Vault-sync: scan 회의록 a b_c ZZ")].sort()).toEqual(oracle.tok);
  expect([jaccard(new Set(["a", "b"]), new Set(["b", "c"])), jaccard(new Set(), new Set(["a"]))]).toEqual(oracle.jac);
  // The same hand graph as python-oracle.py: four records, four vocabulary nodes, edges in the same order.
  const at = ["2026-10-01T09:00:00Z", "2026-10-03T09:00:00Z", "2026-10-03T18:00:00Z", "2026-10-08T09:00:00Z"];
  const records = new Map<string, MineRecord>(at.map((value, i) => [`p_${i + 1}`, { source: "capture", kind: "UserPromptSubmit", at: value, text: `r${i}`, project: "x" }]));
  const edges: [string, string][] = [["p_1", "action--summarize"], ["p_1", "object--meeting-notes"], ["p_2", "action--summarize"], ["p_2", "object--meeting-notes"], ["p_3", "action--summarize"], ["p_3", "object--email"], ["p_4", "object--meeting-notes"], ["p_4", "entity--org--acme-corp"]];
  const members = ["p_1", "p_2", "p_3", "p_4", "action--summarize", "object--meeting-notes", "object--email", "entity--org--acme-corp"];
  const neighbors = new Map(members.map(id => [id, new Set<string>()]));
  for (const [a, b] of edges) { neighbors.get(a)!.add(b); neighbors.get(b)!.add(a); }
  const graph: ScoreGraph = { neighbors, records };
  const existing = [{ name: "meeting-notes", bag: tokenize("meeting-notes Turn a transcript into meeting notes") }, { name: "summarize", bag: tokenize("summarize summarize text") }];
  const candidate = communityToCandidate(0, members, graph, existing)!;
  const { label, gloss, size, day_span, unique_days, cohesion, novelty, rank, triggers, trigger_nodes, similar_skills } = candidate;
  expect({ label, gloss, size, day_span, unique_days, cohesion, novelty, rank, triggers, trigger_nodes, similar_skills }).toEqual(oracle.cand);
  expect(communityToCandidate(1, ["p_1", "p_2", "action--summarize"], graph, existing)).toBeNull();
});

// ── end-to-end over a synthetic amem home and vault ───────────────────

const project = "github.com/synthetic/skill-lab";
const other = "github.com/synthetic/other-lab";
const NOW = new Date("2026-10-31T12:00:00Z");
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const file = join(d, entry.name);
      if (entry.isDirectory()) { out.set(file + "/", ""); walk(file); }
      else out.set(file, createHash("sha256").update(readFileSync(file)).digest("hex") + ":" + statSync(file).mtimeMs);
    }
  };
  walk(dir);
  return out;
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-mine-"))); roots.push(root);
  const memoryDir = join(root, "memory"), home = join(root, "state"), vault = join(root, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  const registry = join(root, "registry.yaml");
  writeFileSync(registry, "projects:\n  - id: alpha\n    people: [Kim Minsu]\n    orgs: [Acme Corp]\n");
  const note = (stem: string, fm: string, body: string) => writeFileSync(join(vault, "notes", `${stem}.md`), `---\n${fm}\n---\n${body}\n`);
  note("weekly-summary", "type: decision\ndomain: research\ndescription: Summarize meeting notes every Friday\ncreated: 2026-10-20", "# Weekly summary\n\nWe summarize the meeting notes and email them to Kim Minsu.");
  note("draft-replies", "type: insight\ndomain: research\ndescription: Draft email replies from the inbox\ndate: 2026-10-25", "# Draft replies\n\nWrite a draft for each inbox email.");
  note("kim", "type: person\ndomain: people\ndescription: Summarize meeting notes person card", "# Kim\n\nmeeting summary person note");
  note("hub", "type: moc\ndomain: research\ndescription: Summarize meeting notes hub", "# Hub\n");
  note("old", "type: decision\ndomain: research\ndescription: Summarize meeting notes long ago\ncreated: 2025-01-01", "# Old\n");
  note("undated", "type: insight\ndomain: research\ndescription: Organize the inbox", "# Undated\n\nTidy the inbox weekly.");
  utimesSync(join(vault, "notes", "undated.md"), new Date("2026-10-28T00:00:00Z"), new Date("2026-10-28T00:00:00Z"));
  addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp", registry });
  const config = JSON.parse(readFileSync(join(home, "vmem.config.json"), "utf8"));
  config.piiPatterns = ["confidential-codename"];
  writeFileSync(join(home, "vmem.config.json"), JSON.stringify(config, null, 2) + "\n");

  const base = { op: "note" as const, scope: "project" as const, tier: "long" as const, peer: "person", about: [], source: "person" as const };
  let clock = Date.parse("2026-10-21T09:00:00Z");
  const store = new MemoryStore({ memoryDir, deferPromotions: true, now: () => (clock += 86400000) });
  store.note({ ...base, project, kind: "decision", title: "Summarize meeting notes", text: "Summarize the meeting notes into an email digest." });
  store.note({ ...base, project, kind: "finding", title: "Policy screened", text: "The confidential-codename summary must stay private." });
  store.note({ ...base, project, kind: "fact" as never, title: "Not mined", text: "A fact about meeting notes summary." });
  store.note({ ...base, project: other, kind: "fail", title: "Inbox draft", text: "Drafting inbox replies by hand failed; write a template." });
  store.close();
  await migrate({ memoryDir, mode: "apply", generation: "c".repeat(32), authorizedPerson: true, tty: true });
  const capture = new CaptureStore({ memoryDir, project });
  let day = 22;
  const add = (event: string, excerpt: string, tool?: string) => capture.append({ project, agent: "claude", event, excerpt, at: `2026-10-${day++}T10:00:00.000Z`, ...(tool ? { tool } : {}) } as never);
  add("UserPromptSubmit", "요약해줘 회의록 for /Users/someone/work/notes.md and mail kim@example.org");
  add("UserPromptSubmit", "Please summarize the meeting notes and email the summary");
  add("UserPromptSubmit", "Please summarize the meeting notes for confidential-codename and email the summary");
  add("observation", "Summary of meeting notes was emailed");
  add("summary", "Session summarized meeting notes for Kim Minsu");
  add("PostToolUse", "summarize meeting notes tool event", "Bash");
  add("UserPromptSubmit", "Please summarize the meeting notes and email the summary");
  capture.close();
  const env = { AMEM_HOME: memoryDir, VMEM_HOME: home, CLAUDECODE: "1" };
  return { root, memoryDir, home, vault, env };
}

test("skills mine reads curated, capture and vault records, masks them and writes nothing anywhere", async () => {
  const f = await fixture();
  const before = [tree(f.memoryDir), tree(f.vault), tree(f.home)];
  const result = await mineSkills(f.home, { vault: "mine", env: f.env, vocab: join(FIXTURES, "vocab"), skills: [join(FIXTURES, "skills")], now: NOW, minSize: 3, minNovelty: 0.3 });
  const after = [tree(f.memoryDir), tree(f.vault), tree(f.home)];
  // A read-only SQLite open may create an empty -wal and a -shm WAL index (allocated at its mapped size, no row
  // content) next to a database it reads. Every other file, including each .db, must be byte-identical.
  const sidecar = (file: string) => /\.db-(wal|shm)$/.test(file);
  const content = (m: Map<string, string>) => new Map([...m].filter(([file]) => !sidecar(file)).map(([file, value]) => [file, value.split(":")[0]]));
  for (let i = 0; i < 3; i++) expect(content(after[i]!)).toEqual(content(before[i]!));
  for (const [file, value] of after[0]!) if (sidecar(file) && !before[0]!.has(file)) {
    expect(after[0]!.has(file.replace(/-(wal|shm)$/, ""))).toBe(true);
    if (file.endsWith("-wal")) expect(value.split(":")[0]).toBe(createHash("sha256").update("").digest("hex"));
    else expect(statSync(file).size % 32768).toBe(0);
  }
  expect([...after[1]!.keys()]).toEqual([...before[1]!.keys()]);
  expect([...after[2]!.keys()]).toEqual([...before[2]!.keys()]);

  expect(result.projects).toEqual([other, project].sort());
  // curated: decision + fail pass, one finding screened by piiPatterns, a fact skipped; capture: 5 mined events, a tool event skipped, 1 duplicate;
  // vault: 3 notes in the window (person, moc and an old note excluded; the undated one uses its mtime).
  expect(result.records).toEqual({ curated: 2, capture: 5, vault: 3 });
  expect(result.dropped).toEqual({ secret: 0, policy: 1, oversized: 0, duplicate: 1, unreadable: 0, truncatedCapture: 0 });
  expect(result.graph).toEqual({ nodes: 17, edges: 28, communities: 3, partitioner: "leiden" });
  expect(result.candidates.map(({ cid, label, gloss, size, day_span, unique_days, cohesion, novelty, rank, triggers, similar_skills, sources }) =>
    ({ cid, label, gloss, size, day_span, unique_days, cohesion, novelty, rank, triggers, similar_skills, sources }))).toEqual([
    { cid: 0, label: "summarize-meeting-notes", gloss: "summarize + meeting-notes + email", size: 5, day_span: 3, unique_days: 4, cohesion: 0.5, novelty: 0.8, rank: 1.238,
      triggers: ["summarize", "meeting-notes", "email"], similar_skills: [{ name: "summarize", similarity: 0.2 }, { name: "meeting-notes", similarity: 0.111 }], sources: { curated: 1, capture: 4, vault: 0 } },
    { cid: 1, label: "create-inbox", gloss: "inbox + create + organize", size: 3, day_span: 8, unique_days: 3, cohesion: 0.4, novelty: 1, rank: 0.238,
      triggers: ["inbox", "create", "organize"], similar_skills: [], sources: { curated: 1, capture: 0, vault: 2 } },
  ]);
  // Leiden splits the two records that mention a registry person into their own cluster (below three records).
  expect(result.rejected).toEqual({ below3: 1, detailed: [] });
  expect(result.candidates[0]!.samples.map(s => s.text)).toContain("요약해줘 회의록 for [PATH] and mail [EMAIL]");
  const json = JSON.stringify(result);
  for (const secret of ["kim@example.org", "/Users/someone", "Kim Minsu", "confidential-codename"]) expect(json).not.toContain(secret);
  expect(result.candidates[0]!.samples.map(s => s.text)).toContain("Please summarize the meeting notes for [PII] and email the summary");
  expect(json).toContain("[EMAIL]");
  expect(json).toContain("[PATH]");
  // Both records naming a registry person fall in the cluster below three records, so no sample carries [PERSON] here;
  // the name is still absent above, and maskText's [PERSON] rule is pinned in the materialize parity test.
  expect(result.report).toContain("## Candidates");
  expect(result.report).toContain("- sources: curated 1, capture 4, vault 0");
  expect(result.report).toContain("## Surprising connections");

  // Exact scores are stable for the same inputs.
  const again = await mineSkills(f.home, { vault: "mine", env: f.env, vocab: join(FIXTURES, "vocab"), skills: [join(FIXTURES, "skills")], now: NOW });
  expect(again).toEqual(result);
});

test("project filter, thresholds, secrets and bounds", async () => {
  const f = await fixture();
  const one = await mineSkills(f.home, { vault: "mine", env: f.env, project: other, vocab: join(FIXTURES, "vocab"), now: NOW });
  expect(one.projects).toEqual([other]);
  expect(one.records.capture).toBe(0);
  await expect(mineSkills(f.home, { vault: "mine", env: f.env, project: "github.com/synthetic/none", now: NOW })).rejects.toThrow("no active project shard");
  await expect(mineSkills(f.home, { vault: "mine", env: f.env, project: other, allProjects: true })).rejects.toThrow("either");
  await expect(mineSkills(f.home, { vault: "mine", env: f.env, days: 0 })).rejects.toThrow("--days");
  const strict = await mineSkills(f.home, { vault: "mine", env: f.env, vocab: join(FIXTURES, "vocab"), skills: [join(FIXTURES, "skills")], now: NOW, minNovelty: 0.9, minSize: 4 });
  expect(strict.candidates).toEqual([]);
  expect(strict.rejected.detailed.map(r => [r.label, r.reason])).toEqual([["summarize-meeting-notes", "novelty<min"], ["create-inbox", "size<min"]]);
  expect(strict.report).toContain("- create-inbox (size=3, novelty=1, reason=size<min)");

  const record = (text: string, at = "2026-10-30T00:00:00Z"): MineRecord => ({ source: "capture", kind: "UserPromptSubmit", at, text, project: "x" });
  const pure = (records: MineRecord[]) => mineRecords({ vault: "v", days: 30, since: "", projects: [], records, vocab: { actions, objects }, registry: [], skills: [], minSize: 3, minNovelty: 0.3, today: "2026-10-31" });
  const secret = pure([record("summarize meeting ghp_" + "a".repeat(36)), record("summarize meeting a"), record("summarize meeting b"), record("summarize meeting c")]);
  expect(secret.dropped.secret).toBe(1);
  expect(JSON.stringify(secret)).not.toContain("ghp_");
  expect(pure([record("x".repeat(64 * 1024 + 1))]).dropped.oversized).toBe(1);
  expect(() => pure(Array.from({ length: 20001 }, (_, i) => record(`r${i}`)))).toThrow("more than 20000 records");
});

test("CLI and MCP expose the same read-only command", async () => {
  const f = await fixture();
  const before = tree(f.vault);
  const cli = await runAsync(["skills", "mine", "mine", "--vocab", join(FIXTURES, "vocab"), "--skills", join(FIXTURES, "skills"), "--days", "3650", "--json"], f.env);
  expect(cli.code).toBe(0);
  const parsed = JSON.parse(cli.text);
  expect(parsed.records.curated + parsed.records.capture + parsed.records.vault).toBeGreaterThan(0);
  const markdown = await runAsync(["skills", "mine", "mine", "--vocab", join(FIXTURES, "vocab"), "--days", "3650"], f.env);
  expect(markdown.text.startsWith("# Skill Candidates")).toBe(true);
  await expect(runAsync(["skills", "mine", "mine", "--bogus"], f.env)).rejects.toThrow("unknown option");
  await expect(runAsync(["skills", "list"], f.env)).rejects.toThrow("skills mine");
  expect(VMEM_TOOL_NAMES).toContain("vmem_skills_mine");
  const server = createVaultMcp(f.home, f.env);
  const tool = server.tools.find(t => t.name === "vmem_skills_mine")!;
  expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  const viaMcp = await server.handlers.vmem_skills_mine!({ vault: "mine", vocab: join(FIXTURES, "vocab"), days: 3650 }) as { records: unknown; report: string };
  expect(viaMcp.records).toEqual(parsed.records);
  expect(tree(f.vault)).toEqual(before);
});

test("vmem_skills_mine refuses a vault re-registered after server startup", async () => {
  const f = await fixture(), other = await fixture();
  const server = createVaultMcp(f.home, f.env);
  const config = JSON.parse(readFileSync(join(f.home, "vmem.config.json"), "utf8"));
  config.vaults[0].path = other.vault;
  writeFileSync(join(f.home, "vmem.config.json"), JSON.stringify(config));
  const before = tree(other.vault);
  const result = await server.handlers.vmem_skills_mine!({ vault: "mine", days: 3650 }) as { refused?: boolean; issues?: { message: string }[] };
  expect(result.refused).toBe(true);
  expect(result.issues![0]!.message).toContain("binding changed");
  expect(tree(other.vault)).toEqual(before);
});

test("an absent amem home yields vault records only and creates no amem home", async () => {
  const f = await fixture();
  const missing = join(f.root, "no-memory");
  const result = await mineSkills(f.home, { vault: "mine", env: { ...f.env, AMEM_HOME: missing }, vocab: join(FIXTURES, "vocab"), now: NOW });
  expect(result.projects).toEqual([]);
  expect(result.records).toEqual({ curated: 0, capture: 0, vault: 3 });
  expect(() => statSync(missing)).toThrow();
});
