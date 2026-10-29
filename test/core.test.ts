import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { VaultIndex, MAX_NOTE_BYTES } from "../src/vault-index.ts";
import { extractLinks, resolveLinks } from "../src/links.ts";
import { addVault } from "../src/registry.ts";
import { run } from "../src/cli.ts";
const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-core-"))); roots.push(root);
  const vault = join(root, "vault"), home = join(root, "home"), notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true });
  for (const file of readdirSync("test/fixtures/core")) copyFileSync(join("test/fixtures/core", file), join(notes, file));
  const spec = { id: "test", path: resolve(vault), kind: "personal" as const, write: "none" as const };
  return { root, vault, home, notes, spec };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("wiki, aliases, headings, blocks, embeds, NFC and case; fences skipped", () => {
  const notes = [
    { path: "café.md", title: "Coffee", aliases: ["Coffee"], body: "# Connections\ntext ^summary\n" },
    { path: "map.md", title: "Map", aliases: [], body: "[[CAFÉ#connections|label]] ![[COFFEE#^SUMMARY]] [[#Here]] [[café#missing]] [[café#^absent]] [[dead]]\n# Here\n~~~\n[[hidden]]\n~~~~\n```md\n[[also hidden]]\n```\n`[[inline]]` and \\[[escaped]]\n" },
  ];
  const links = resolveLinks(notes);
  expect(links).toHaveLength(6);
  // Path-only resolution, like Obsidian: the alias "Coffee" is not a link target.
  expect(links.slice(0, 3).map(v => v.resolved)).toEqual(["café.md", null, "map.md"]);
  expect(links[1]!.reason).toBe("missing-note");
  expect(links[0]!.label).toBe("label"); expect(links[1]!.embed).toBe(true);
  expect(links.slice(3).map(v => v.reason)).toEqual(["missing-heading", "missing-block", "missing-note"]);
  expect(extractLinks("   ```md\n[[x]]\n  ````\n[[y]]")).toHaveLength(1);
  expect(extractLinks("```js\n[[x]]")).toHaveLength(0);
  // Paths that differ only by case or Unicode normalization are ambiguous; an alias never competes.
  expect(resolveLinks([...notes, { path: "CAFÉ.md", title: "Dup", aliases: [], body: "[[café]]" }]).at(-1)!.reason).toBe("ambiguous-note");
  expect(resolveLinks([...notes, { path: "dup.md", title: "Dup", aliases: ["café"], body: "[[café]]" }]).at(-1)!.resolved).toBe("café.md");
});
function snapshot(index: VaultIndex) {
  const db = new Database(index.file, { readonly: true });
  try { return {
    notes: db.query("SELECT path,hash,title,description,body,type,domain,aliases FROM notes ORDER BY path").all(),
    fts: db.query("SELECT path,title,description,body FROM fts ORDER BY path").all(),
    links: db.query("SELECT data FROM links ORDER BY source,ordinal").all(),
    search: index.search("synthetic"),
  }; } finally { db.close(); }
}
test("incremental metadata scan matches clean rebuild after create/edit/delete/rename", () => {
  const { home, spec, notes } = fixture();
  const index = new VaultIndex(home, spec);
  try {
    expect(index.scan()).toEqual({ notes: 3, changed: 3, removed: 0 });
    expect(index.scan()).toEqual({ notes: 3, changed: 0, removed: 0 });
    const steps = [
      () => writeFileSync(join(notes, "new.md"), "---\ntitle: New Synthetic\naliases: [NewAlias]\n---\n[[Atlas]]\n"),
      () => writeFileSync(join(notes, "café.md"), "---\ntitle: New Coffee\naliases: [Tea]\n---\n# Connections\nEdited synthetic discovery ^summary\n"),
      () => rmSync(join(notes, "method.md")),
      () => renameSync(join(notes, "new.md"), join(notes, "renamed.md")),
      () => writeFileSync(join(notes, "projects.md"), "---\ntitle: Map\n---\n[[NewAlias]] [[Tea#Connections]]\n"),
      // Unchanged sources re-resolve when a target loses an alias, regains it without the heading, or an alias turns ambiguous.
      () => writeFileSync(join(notes, "café.md"), "---\ntitle: New Coffee\n---\n# Connections\nEdited synthetic discovery ^summary\n"),
      () => writeFileSync(join(notes, "café.md"), "---\ntitle: New Coffee\naliases: [Tea]\n---\nEdited synthetic discovery ^summary\n"),
      () => writeFileSync(join(notes, "dup.md"), "---\ntitle: Dup\naliases: [NewAlias]\n---\nDuplicate synthetic alias.\n"),
    ];
    for (const change of steps) {
      change(); index.scan(); const incremental = snapshot(index);
      const clean = new VaultIndex(join(home, "clean"), spec);
      try { clean.scan(true); expect(snapshot(clean)).toEqual(incremental); } finally { clean.close(); }
    }
    // Metadata change without content change is rehashed but not reindexed.
    const file = join(notes, "projects.md"), now = new Date(Date.now() + 2000);
    utimesSync(file, now, now); expect(index.scan().changed).toBe(0);
    // Same size/mtime edits are still detected through ctime metadata.
    const before = statSync(file), content = readFileSync(file, "utf8");
    writeFileSync(file, content.replace("Map", "Mop")); utimesSync(file, before.atime, before.mtime);
    expect(index.scan().changed).toBe(1);
    expect(index.show("projects").content).toContain("Mop");
  } finally { index.close(); }
});
test("a cache written by an older link resolver recomputes every link on the next scan", () => {
  const { home, spec } = fixture();
  const index = new VaultIndex(home, spec);
  try {
    index.scan(); const fresh = snapshot(index);
    // Simulate an older cache: stale link rows and no resolution version.
    const db = new Database(index.file);
    try { db.run("UPDATE links SET data=json_set(data,'$.resolved','stale.md','$.reason',NULL)"); db.run("PRAGMA user_version = 0"); } finally { db.close(); }
    expect(index.scan()).toEqual({ notes: 3, changed: 0, removed: 0 });
    expect(snapshot(index)).toEqual(fresh);
  } finally { index.close(); }
});
test("unicode FTS5, BM25 relevance, filters, bounded search/show/links", () => {
  const { home, spec, notes } = fixture(), index = new VaultIndex(home, spec);
  try {
    index.scan();
    expect(index.search("café").map(n => n.path)).toContain("café.md");
    expect(index.search("coffee")[0]!.path).toBe("café.md");
    expect(index.search("synthetic", { type: "moc", domain: "research" }).map(n => n.path)).toEqual(["projects.md"]);
    expect(index.search("synthetic", { domain: "teaching" }).map(n => n.path)).toEqual(["method.md"]);
    expect(index.search("synthetic", { limit: 1 })).toHaveLength(1);
    expect(index.show("COFFEE", 21).truncated).toBe(true);
    expect(index.show("CAFÉ").path).toBe("café.md");
    expect(index.show("notes/CAFÉ.md").path).toBe("café.md");
    expect(Buffer.byteLength(index.show("COFFEE", 21).content)).toBeLessThanOrEqual(21);
    expect(index.links("Atlas", 2)).toHaveLength(2);
    expect(index.links("projects").find(link => link.target === "Missing Note")!.reason).toBe("missing-note");
    for (const limit of [0, -1, 1.2, 501, NaN, Infinity]) {
      expect(() => index.search("synthetic", { limit })).toThrow(); expect(() => index.links("Atlas", limit)).toThrow();
    }
    for (const size of [0, 65537, 2.5]) expect(() => index.show("Atlas", size)).toThrow();
    expect(() => index.search(" ")).toThrow(); expect(() => index.search("a".repeat(1025))).toThrow();
    expect(index.search('" OR *')).toEqual([]);
    expect(() => index.show("../outside")).toThrow();
    writeFileSync(join(notes, "collision.md"), "---\naliases: [Coffee]\n---\n[[café]]\n");
    index.scan();
    expect(() => index.show("Coffee")).toThrow("ambiguous");
    expect(() => index.links("Coffee")).toThrow("ambiguous");
    expect(index.show("café").path).toBe("café.md");
    writeFileSync(join(notes, "huge.md"), "x".repeat(MAX_NOTE_BYTES + 1));
    expect(() => index.scan()).toThrow("exceeds");
    expect(index.search("coffee")[0]!.path).toBe("café.md");
  } finally { index.close(); }
});
test("only flat regular notes; symlink replacement fails; cache outside vault", () => {
  const { root, home, spec, vault, notes } = fixture();
  mkdirSync(join(notes, "nested")); writeFileSync(join(notes, "nested", "skip.md"), "secret synthetic");
  writeFileSync(join(vault, "skip.md"), "secret synthetic");
  symlinkSync(join(vault, "skip.md"), join(notes, "linked.md"));
  mkdirSync(join(vault, ".obsidian")); writeFileSync(join(vault, ".obsidian", "keep.json"), "{}");
  const before = new Map(readdirSync(notes).filter(p => lstatSync(join(notes, p)).isFile()).map(p => [p, readFileSync(join(notes, p))]));
  const index = new VaultIndex(home, spec);
  try {
    expect(index.scan().notes).toBe(3); expect(index.search("secret")).toEqual([]);
    expect(index.file.startsWith(vault)).toBe(false);
    expect(statSync(index.file).mode & 0o777).toBe(0o600);
    for (const [file, bytes] of before) expect(readFileSync(join(notes, file))).toEqual(bytes);
    expect(readFileSync(join(vault, ".obsidian", "keep.json"), "utf8")).toBe("{}");
    expect(() => new VaultIndex(vault, spec)).toThrow("outside");
    expect(existsSync(join(vault, "indexes"))).toBe(false);
    const linkedHome = join(root, "linked-home"); symlinkSync(vault, linkedHome);
    expect(() => new VaultIndex(linkedHome, spec)).toThrow("outside");
    renameSync(notes, join(vault, "old-notes")); symlinkSync(join(vault, "old-notes"), notes);
    expect(() => index.scan()).toThrow("changed");
  } finally { index.close(); }
});
test("cache escapes through another registered vault or a linked index refuse", () => {
  const first = fixture(), second = fixture();
  expect(() => new VaultIndex(second.vault, first.spec, [first.vault, second.vault])).toThrow("outside");
  mkdirSync(first.home); symlinkSync(first.root, join(first.home, "indexes"));
  expect(() => new VaultIndex(first.home, first.spec)).toThrow("plain cache");
});
test("CLI reads refresh cache, bound arguments and never edit notes/config", () => {
  const { home, spec, notes, vault } = fixture(); addVault(home, spec);
  const env = { VMEM_HOME: home }, config = readFileSync(join(home, "vmem.config.json"));
  expect(JSON.parse(run(["rebuild", "test", "--json"], env).text).notes).toBe(3);
  expect(JSON.parse(run(["search", "test", "synthetic", "--type", "moc", "--limit", "1"], env).text)[0].path).toBe("projects.md");
  writeFileSync(join(notes, "created.md"), "# Created\nnewword [[Atlas]]");
  expect(JSON.parse(run(["search", "test", "newword"], env).text)[0].path).toBe("created.md");
  // "Atlas" is only an alias of projects.md; links resolve by path, like Obsidian and lint L01.
  expect(JSON.parse(run(["links", "test", "created"], env).text)[0].resolved).toBeNull();
  expect(JSON.parse(run(["show", "test", "created", "--max-bytes", "3"], env).text).content).toBe("# C");
  for (const args of [["search", "test"], ["rebuild", "test", "extra"], ["show", "test", "created", "--limit", "1"], ["links", "test", "created", "--limit", "501"], ["search", "test", "x", "--limit", "1e2"], ["show", "test", "x", "--json", "--json"], ["rebuild", "missing"]]) expect(() => run(args, env)).toThrow();
  expect(readFileSync(join(home, "vmem.config.json"))).toEqual(config);
  expect(readdirSync(vault)).toEqual(["notes"]);
});

test("anchor indexes are built once for thousands of heading and block links", () => {
  let reads = 0;
  const body = "# Heading\nA paragraph ^block\n" + "[[#Heading]] [[#^block]]\n".repeat(4000);
  const note = { path: "anchors.md", title: "Anchors", aliases: [], get body() { reads++; return body; } };
  const links = resolveLinks([note]);
  expect(links).toHaveLength(8000);
  expect(links.every(link => link.resolved === "anchors.md" && link.reason === null)).toBe(true);
  // One body read shared by the anchor-index and outgoing-link passes, independent of link count.
  expect(reads).toBe(1);
});

test("ATX closing hashes require whitespace and preserve literal heading hashes", () => {
  const body = "# C#\n## F# ###\n### Hash#   \n# Spaced ###\n[[#C#]] [[#C]] [[#F#]] [[#F]] [[#Hash#]] [[#Hash]] [[#Spaced]]\n";
  const links = resolveLinks([{ path: "hashes.md", title: "Hashes", aliases: [], body }]);
  expect(links.map(link => link.reason)).toEqual([null, "missing-heading", null, "missing-heading", null, "missing-heading", null]);
});

test("multiline inline code hides wiki links with exact delimiter matching and stable lines", () => {
  expect(extractLinks("`code\n[[hidden]]`\n[[visible]]").map(link => [link.target, link.line])).toEqual([["visible", 3]]);
  expect(extractLinks("before ``code\r\n` [[hidden]]\r\n`` [[visible]]\r\n[[after]]").map(link => [link.target, link.line])).toEqual([["visible", 3], ["after", 4]]);
  expect(extractLinks("unmatched ` [[literal]]\n[[also-literal]]").map(link => link.target)).toEqual(["literal", "also-literal"]);
  expect(extractLinks("\\` [[literal]]\n`hidden [[inside]]`\n[[visible]]").map(link => [link.target, link.line])).toEqual([["literal", 1], ["visible", 3]]);
});
