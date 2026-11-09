import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonTableSpec, VaultSpec } from "../src/config.ts";
import { canonRowsForVault, indexCanonRows, matchCanonRows } from "../src/canon-tables.ts";
import { MAX_NOTE_BYTES } from "../src/vault-index.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const table = (rows: string[]) => ["| Key | Meaning |", "| --- | --- |", ...rows].join("\n");
function index(sources: Record<string, string>, tables: readonly CanonTableSpec[] = Object.keys(sources).map(path => ({ path }))) {
  return indexCanonRows(tables, path => sources[path]);
}

test("canonical aliases retain actual source lines and return one longest key per row", () => {
  const source = ["---", "title: Synthetic glossary", "---", "# Terms", "", ...table([
    "| **ACME** (Acme Labs) / `AL`, Acme Group | Synthetic organization |",
    "| Q | Single-character key |",
    "| 제주 연구원 / 제주원 | Synthetic person |",
  ]).split("\n")].join("\n");
  const rows = matchCanonRows(index({ "notes/glossary.md": source }), "acme and ACME LABS, then AL and Acme Group; 제주 연구원.");
  expect(rows).toEqual([
    { path: "notes/glossary.md", line: 8, key: "Acme Group", row: "| **ACME** (Acme Labs) / `AL`, Acme Group | Synthetic organization |" },
    { path: "notes/glossary.md", line: 10, key: "제주 연구원", row: "| 제주 연구원 / 제주원 | Synthetic person |" },
  ]);
  expect(matchCanonRows(index({ "notes/one.md": table(["| Q | ignored |", "| X / A | ignored too |"])}), "Q X A")).toEqual([]);
});

test("Latin characters case-fold inside mixed-script keys, other scripts stay exact and token boundaries include letters, digits, marks and underscore", () => {
  const rows = index({ "notes/keys.md": table(["| ACME | Latin |", "| 제주AI | Mixed script |", "| 제주 | Korean |", "| Café | Latin accented |"])});
  expect(matchCanonRows(rows, "acme CAFÉ 제주AI 제주").map(row => row.key)).toEqual(["ACME", "제주AI", "Café", "제주"]);
  expect(matchCanonRows(rows, "XACME ACME2 _ACME ACME_ ACMÉ 제주AIX 제주원")).toEqual([]);
  expect(matchCanonRows(rows, "(acme), café; 제주AI!").map(row => row.key)).toEqual(["ACME", "제주AI", "Café"]);
  expect(matchCanonRows(rows, "제주ai").map(row => row.key)).toEqual(["제주AI"]);
  const greek = index({ "notes/mixed.md": table(["| ΔΕΛΤΑ AI | Exact Greek, folded Latin |"])});
  expect(matchCanonRows(greek, "ΔΕΛΤΑ ai").map(row => row.key)).toEqual(["ΔΕΛΤΑ AI"]);
  expect(matchCanonRows(greek, "δελτα AI")).toEqual([]);
});

test("table cells honor escaped pipes, wiki aliases, inline-code pipes and the one-based key-column override", () => {
  const source = ["| Other | Key | Meaning |", "| --- | :---: | ---: |",
    "| 1 | [[canonical-entity|Acme Labs]] | Wiki alias |", "| 2 | `Name|Code` | Code pipe |", "| 3 | AC\\|ME | Escaped pipe |"].join("\n");
  const rows = matchCanonRows(index({ "notes/complex.md": source }, [{ path: "notes/complex.md", keyColumn: 2 }]), "Acme Labs and Name|Code, AC|ME");
  expect(rows.map(row => [row.key, row.line])).toEqual([["Acme Labs", 3], ["Name|Code", 4], ["AC|ME", 5]]);
  expect(matchCanonRows(index({ "notes/complex.md": source }), "Acme Labs and Name|Code AC|ME")).toEqual([]);
});

test("frontmatter, fenced examples, headers, separators and unframed pipe prose are not rows", () => {
  const source = ["---", "description: |", "  | Meta | Meaning |", "  | --- | --- |", "  | Hidden | Ignore |", "---",
    "```md", ...table(["| Fenced | Ignore |"] ).split("\n"), "```", "", "Not | a | table", "", ...table(["| Real Entity | Keep |"] ).split("\n")].join("\n");
  const rows = matchCanonRows(index({ "notes/filtered.md": source }), "Hidden Fenced Not Key Meaning Real Entity");
  expect(rows).toEqual([{ path: "notes/filtered.md", line: 17, key: "Real Entity", row: "| Real Entity | Keep |" }]);
  expect(matchCanonRows(index({ "notes/bad.md": "| Fake | Table |\n| only one separator |\n| Bad Entity | No |" }), "Bad Entity")).toEqual([]);
});

test("matches rank by Unicode key length then configured table and row order, with a five-row cap", () => {
  const sources = { "notes/first.md": table(["| Alpha | First |", "| Bravo | Second |", "| Longest Entity | Long |"]), "notes/second.md": table(["| Delta | Third |", "| Echoo | Fourth |", "| Foxtt | Fifth |", "| Short | Sixth |"])};
  const rows = matchCanonRows(index(sources), "Alpha Bravo Longest Entity Delta Echoo Foxtt Short Alpha");
  expect(rows.map(row => row.key)).toEqual(["Longest Entity", "Alpha", "Bravo", "Delta", "Echoo"]);
  expect(rows[0]!.path).toBe("notes/first.md");
});

test("row previews truncate by Unicode characters without splitting an emoji", () => {
  const raw = `| Long Entity | ${"😀".repeat(220)} |`;
  const [row] = matchCanonRows(index({ "notes/long.md": table([raw]) }), "Long Entity");
  expect([...row!.row]).toHaveLength(200);
  expect(row!.row).toBe([...raw].slice(0, 200).join(""));
});

test("a 2000-row table is indexed and matched deterministically within the promotion test budget", () => {
  const rows = Array.from({ length: 2000 }, (_, i) => `| Entity-${String(i).padStart(4, "0")} | Synthetic row ${i} |`);
  const indexed = index({ "notes/many.md": table(rows) });
  expect(matchCanonRows(indexed, "Entity-1999 Entity-0001 Entity-1200").map(row => [row.key, row.line])).toEqual([["Entity-0001", 4], ["Entity-1200", 1203], ["Entity-1999", 2002]]);
  expect(matchCanonRows(indexed, "Entity-1999 Entity-0001 Entity-1200")).toEqual(matchCanonRows(indexed, "Entity-1999 Entity-0001 Entity-1200"));
}, 5000);

test("read budgets are offered before callbacks, use actual UTF-8 bytes and stop at the aggregate cap", () => {
  const calls: number[] = [], large = " ".repeat(MAX_NOTE_BYTES), tables = Array.from({ length: 16 }, (_, i) => ({ path: `notes/table-${i}.md` }));
  indexCanonRows(tables, (_path, maximum) => { calls.push(maximum); return large; });
  expect(calls).toEqual(Array(4).fill(MAX_NOTE_BYTES));
  const partial: number[] = [];
  const values = [large.slice(7), large, large, large, "abc", "four"];
  indexCanonRows(tables, (_path, maximum) => { partial.push(maximum); return values[partial.length - 1]; });
  expect(partial).toEqual([MAX_NOTE_BYTES, MAX_NOTE_BYTES, MAX_NOTE_BYTES, MAX_NOTE_BYTES, 7, 4]);
});

test("missing, oversized and malformed readers remain advisory and failed attempts still count toward sixteen", () => {
  let attempts = 0;
  const tables = Array.from({ length: 20 }, (_, i) => ({ path: `notes/table-${i}.md` }));
  expect(matchCanonRows(indexCanonRows(tables, () => { attempts++; throw new Error("Synthetic unreadable table"); }), "Entity")).toEqual([]);
  expect(attempts).toBe(16);
  const rows = indexCanonRows([{ path: "notes/missing.md" }, { path: "notes/bad.md" }, { path: "notes/oversized.md" }, { path: "notes/good.md" }], path => {
    if (path.endsWith("missing.md")) return undefined;
    if (path.endsWith("bad.md")) return "---\nbad: [\n---\n";
    if (path.endsWith("oversized.md")) return table(["| Oversized Entity | Ignore |\n" + " ".repeat(MAX_NOTE_BYTES)]);
    return table(["| Good Entity | Readable |"]);
  });
  expect(matchCanonRows(rows, "Oversized Entity Good Entity").map(row => row.key)).toEqual(["Good Entity"]);
});

test("the row cap bounds a large configured table without indexing its tail", () => {
  const source = table(Array.from({ length: 20001 }, (_, i) => `| K${String(i).padStart(5, "0")} | Row |`));
  const rows = index({ "notes/capped.md": source });
  expect(matchCanonRows(rows, "K19999 K20000").map(row => row.key)).toEqual(["K19999"]);
  expect(rows.warnings).toContainEqual(expect.stringMatching(/index budget reached.*omitted.*split.*retry/));
});

test("vault adapter uses configured noteSource reads only and excludes literal and canonical denied paths", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-canon-reader-"))); roots.push(root);
  const physical = join(root, "physical"), alias = join(root, "alias"); mkdirSync(join(physical, "notes"), { recursive: true }); symlinkSync(physical, alias);
  const vault: VaultSpec = { id: "fixture", path: alias, kind: "personal", write: "none", pii: "deny", canonTables: [{ path: "notes/literal.md" }, { path: "notes/canonical.md" }, { path: "notes/allowed.md" }] };
  const calls: { path: string; maximum: number }[] = [];
  const reader = { noteSource(path: string, maximum: number) { calls.push({ path, maximum }); return table(["| Allowed Entity | Own vault row |"]); } };
  const indexed = canonRowsForVault(reader, vault, [join(alias, "notes/literal.md"), join(physical, "notes/canonical.md")]);
  expect(calls).toEqual([{ path: "notes/allowed.md", maximum: MAX_NOTE_BYTES }]);
  expect(matchCanonRows(indexed, "Allowed Entity")[0]!.path).toBe("notes/allowed.md");
  calls.length = 0;
  expect(matchCanonRows(canonRowsForVault(reader, { ...vault, canonTables: undefined }, []), "Allowed Entity")).toEqual([]);
  expect(calls).toEqual([]);
});

test("unavailable canonical inputs carry one cause and repair warning each without blocking matches", () => {
  const indexed = indexCanonRows([{ path: "notes/missing.md" }, { path: "notes/permission.md" }, { path: "notes/bad.md" }, { path: "notes/good.md" }], path => {
    if (path.includes("missing")) return undefined;
    if (path.includes("permission")) throw Object.assign(new Error("synthetic private diagnostic"), { code: "EACCES" });
    if (path.includes("bad")) return "---\nbad: [\n---\n";
    return table(["| Good Entity | Available |"]);
  });
  expect(indexed.warnings).toHaveLength(3);
  expect(indexed.warnings.join(" ")).toMatch(/missing.*not read.*missing.*permission.*not read.*permission denied.*bad.*not read.*not parseable/);
  for (const message of indexed.warnings) expect(message).toMatch(/check.*repair.*retry/);
  expect(indexed.warnings.join(" ")).not.toContain("synthetic private diagnostic");
  expect(matchCanonRows(indexed, "Good Entity")).toHaveLength(1);
});

test("multiple configured columns still report each physical row once with its longest matching key", () => {
  const source = "| Key | Alias | Meaning |\n| --- | --- | --- |\n| ACME | Acme Labs | Synthetic |\n| BETA | Beta Group | Synthetic |";
  const indexed = index({ "notes/two.md": source }, [{ path: "notes/two.md" }, { path: "notes/two.md", keyColumn: 2 }]);
  expect(matchCanonRows(indexed, "ACME Acme Labs BETA Beta Group").map(row => [row.key, row.line])).toEqual([["Beta Group", 4], ["Acme Labs", 3]]);
});
