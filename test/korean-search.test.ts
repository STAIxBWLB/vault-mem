import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSpec, addVault } from "../src/registry.ts";
import { SpecIndex } from "../src/spec-source.ts";
import { INDEX_SCHEMA, LINK_RESOLUTION, VaultIndex } from "../src/vault-index.ts";
import { applyWrite } from "../src/writer.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const note = (title: string, body: string, description = "") => `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\ntype: insight\ndomain: research\n---\n${body}\n`;
// Synthetic Korean forms: standalone, particle, compound, prefixed compound, and two near misses split by a space.
const NOTES: Record<string, string> = {
  "standalone.md": note("사업단 개요", "사업단 운영 기록."),
  "particle.md": note("보고", "사업단은 매년 보고한다."),
  "compound.md": note("회의", "사업단장 회의 기록."),
  "overseas.md": note("소개", "기록.", "해외사업단 소개"),
  "course.md": note("과정", "교육과정을 개편한다."),
  "split.md": note("분리", "사업 업단 단체. 교 육."),
  "latin.md": note("Synthetic Marker", "Synthetic marker alpha evidence. café"),
  "mixed.md": note("Mixed", "Synthetic AI교육 notes and marker beta."),
};
function fixture(notes = NOTES) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-korean-"))); roots.push(root);
  const home = join(root, "home"), vault = join(root, "vault"), dir = join(vault, "notes"); mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(notes)) writeFileSync(join(dir, path), text);
  const spec = { id: "ko", path: vault, kind: "personal" as const, write: "mcp" as const };
  return { root, home, vault, dir, spec };
}
const paths = (index: VaultIndex, query: string) => index.search(query, { limit: 500 }).map(hit => hit.path).sort();
function substringScan(index: VaultIndex, query: string): string[] {
  const db = new Database(index.file, { readonly: true });
  try {
    return db.query<{ path: string; title: string; description: string; body: string }, []>("SELECT path,title,description,body FROM notes").all()
      .filter(row => [row.title, row.description, row.body].some(field => field.includes(query))).map(row => row.path).sort();
  } finally { db.close(); }
}

test("Korean terms match particle, compound and prefixed forms, equal to a substring scan of the indexed fields", () => {
  const f = fixture(), index = new VaultIndex(f.home, f.spec);
  try {
    index.scan();
    expect(paths(index, "사업단")).toEqual(["compound.md", "overseas.md", "particle.md", "standalone.md"]);
    expect(paths(index, "교육")).toEqual(["course.md", "mixed.md"]);
    for (const query of ["사업단", "교육", "사업", "업단", "단장", "해외사업단", "사업단장", "육과", "기록", "과정을", "단체", "교육과정"]) {
      expect(paths(index, query)).toEqual(substringScan(index, query));
    }
    // Punctuation around one CJK run keeps substring matching; AND across terms still applies.
    expect(paths(index, "「사업단」")).toEqual(paths(index, "사업단"));
    expect(paths(index, "사업단 기록")).toEqual(["compound.md", "overseas.md", "standalone.md"]);
  } finally { index.close(); }
});

test("standalone-word and title/description hits rank above substring-only body hits, deterministically", () => {
  const f = fixture(), index = new VaultIndex(f.home, f.spec);
  try {
    index.scan();
    const order = index.search("사업단").map(hit => hit.path);
    expect(new Set(order.slice(0, 2))).toEqual(new Set(["standalone.md", "overseas.md"]));
    expect(new Set(order.slice(2))).toEqual(new Set(["particle.md", "compound.md"]));
    expect(index.search("사업단").map(hit => hit.path)).toEqual(order);
    expect(index.search("사업단", { limit: 1 }).map(hit => hit.path)).toEqual(order.slice(0, 1));
  } finally { index.close(); }
});

test("Latin and mixed-script terms return the same results, scores and snippets as the unicode61-only index", () => {
  const f = fixture(), index = new VaultIndex(f.home, f.spec);
  try {
    index.scan();
    const db = new Database(":memory:"), disk = new Database(index.file, { readonly: true });
    try {
      db.run("CREATE VIRTUAL TABLE fts USING fts5(path UNINDEXED, title, description, body, tokenize='unicode61')");
      for (const row of disk.query<{ path: string; title: string; description: string; body: string }, []>("SELECT path,title,description,body FROM notes").all()) db.query("INSERT INTO fts VALUES (?,?,?,?)").run(row.path, row.title, row.description, row.body);
      for (const query of ["synthetic", "marker alpha", "Synthetic evidence", "cafe", "ai교육", "0", "교"]) {
        const terms = query.split(/\s+/).map(term => `"${term}"`).join(" AND ");
        const before = db.query<{ path: string; score: number; snippet: string }, [string]>("SELECT path, bm25(fts,0,5,2,1) AS score, snippet(fts,3,'','',' ... ',32) AS snippet FROM fts WHERE fts MATCH ? ORDER BY score,path").all(terms);
        expect(index.search(query, { limit: 500 }).map(({ path, score, snippet }) => ({ path, score, snippet }))).toEqual(before);
      }
    } finally { db.close(); disk.close(); }
    expect(index.search('" OR *')).toEqual([]);
  } finally { index.close(); }
});

test("incremental index equals a clean rebuild after Korean edits, deletes and creates", () => {
  const f = fixture(), index = new VaultIndex(f.home, f.spec);
  const rows = (file: string) => { const db = new Database(file, { readonly: true }); try { return db.query("SELECT * FROM fts ORDER BY path").all(); } finally { db.close(); } };
  try {
    index.scan();
    writeFileSync(join(f.dir, "particle.md"), note("보고", "사업 단은 분리됐다."));
    rmSync(join(f.dir, "compound.md"));
    writeFileSync(join(f.dir, "added.md"), note("신규 사업단장", "교육을 시작한다."));
    expect(index.scan()).toMatchObject({ changed: 2, removed: 1 });
    const g = fixture(Object.fromEntries(readdirSync(f.dir).map(name => [name, readFileSync(join(f.dir, name), "utf8")]))), fresh = new VaultIndex(g.home, g.spec);
    try {
      fresh.scan();
      expect(rows(index.file)).toEqual(rows(fresh.file));
      for (const query of ["사업단", "교육", "사업단장", "synthetic"]) expect(index.search(query)).toEqual(fresh.search(query));
      expect(paths(index, "사업단")).toEqual(["added.md", "overseas.md", "standalone.md"]);
    } finally { fresh.close(); }
  } finally { index.close(); }
});

test("an index built by 0.2.1 or 0.3.3 stays untouched and this schema builds its own file on first open", () => {
  const f = fixture(), indexes = join(f.home, "indexes"), digest = createHash("sha256").update(f.vault).digest("hex");
  mkdirSync(indexes, { recursive: true });
  // 0.2.1 used `<digest>.sqlite`, 0.3.3 `<digest>-links2.sqlite`, both with the unicode61-only fts table.
  for (const name of [`${digest}.sqlite`, `${digest}-links${LINK_RESOLUTION}.sqlite`]) {
    const db = new Database(join(indexes, name));
    db.run(`CREATE TABLE notes (path TEXT PRIMARY KEY, hash TEXT NOT NULL, metadata TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL, type TEXT NOT NULL, domain TEXT NOT NULL, aliases TEXT NOT NULL, source TEXT NOT NULL);
      CREATE VIRTUAL TABLE fts USING fts5(path UNINDEXED, title, description, body, tokenize='unicode61');`);
    db.query("INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?)").run("particle.md", "0".repeat(64), "stale", "보고", "", "사업단은", "", "", "[]", "");
    db.query("INSERT INTO fts VALUES (?,?,?,?)").run("particle.md", "보고", "", "사업단은");
    db.close();
  }
  const legacy = readdirSync(indexes).sort().map(name => [name, readFileSync(join(indexes, name)).toString("base64")]);
  const index = new VaultIndex(f.home, f.spec);
  try {
    expect(index.scan()).toMatchObject({ notes: Object.keys(NOTES).length, changed: Object.keys(NOTES).length, removed: 0 });
    expect(paths(index, "사업단")).toEqual(["compound.md", "overseas.md", "particle.md", "standalone.md"]);
  } finally { index.close(); }
  expect(readdirSync(indexes).sort()).toEqual([...legacy.map(([name]) => name!), `${digest}-links${LINK_RESOLUTION}-schema${INDEX_SCHEMA}.sqlite`].sort());
  expect(readdirSync(indexes).filter(name => legacy.some(([old]) => old === name)).sort().map(name => [name, readFileSync(join(indexes, name)).toString("base64")])).toEqual(legacy);
});

test("dry-run reuse of the disk cache keeps Korean matching", () => {
  const f = fixture(), disk = new VaultIndex(f.home, f.spec);
  try { disk.scan(); } finally { disk.close(); }
  const memory = new VaultIndex(f.home, f.spec, [f.vault], { memory: true });
  try { memory.scan(); expect(paths(memory, "사업단")).toEqual(["compound.md", "overseas.md", "particle.md", "standalone.md"]); } finally { memory.close(); }
});

test("writer duplicate hints use the same Korean substring matching", () => {
  const f = fixture({ ...NOTES, "research.md": "---\ntype: moc\ndescription: Synthetic directory.\n---\n# Research\n" });
  addVault(f.home, f.spec);
  const create = (title: string) => applyWrite(f.home, { vault: "ko", operation: { op: "create", path: "new-unit", frontmatter: { title, description: "Synthetic.", type: "insight", domain: "research", topics: ["[[research]]"] }, body: `# ${title}\n\n본문.\n\n## Topics\n\n- [[research]]\n` }, dryRun: true });
  const duplicate = create("해외사업단");
  expect(duplicate.ok).toBe(true);
  expect(duplicate.possibleDuplicates).toEqual(["notes/overseas.md"]);
  // Four notes contain 사업단; hints keep the top three.
  const hints = create("사업단").possibleDuplicates ?? [];
  expect(hints).toHaveLength(3);
  for (const hint of hints) expect(["notes/standalone.md", "notes/overseas.md", "notes/particle.md", "notes/compound.md"]).toContain(hint);
});

test("spec search shares the Korean matching", () => {
  const f = fixture(), repo = join(f.root, "repo");
  mkdirSync(join(repo, "notes"), { recursive: true });
  const git = (args: string[]) => expect(Bun.spawnSync(["git", "-C", repo, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", ...args], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  git(["-c", "init.templateDir=", "init", "--quiet"]);
  writeFileSync(join(repo, "notes/unit.md"), "---\nid: unit\ntype: module\ntitle: Design unit\n---\n# Design\n\n사업단장 설계.\n");
  git(["add", "--all"]); git(["commit", "--quiet", "-m", "Synthetic fixture"]);
  const specs = new SpecIndex(f.home, addSpec(f.home, { id: "specs", path: repo }));
  try { specs.scan(); expect(specs.search("사업단").map(hit => hit.id)).toEqual(["unit"]); } finally { specs.close(); }
});
