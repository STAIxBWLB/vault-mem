import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { run } from "../src/cli.ts";
import { renderStats } from "../src/cli-output.ts";
import { commandUsage } from "../src/commands-table.ts";
import { textOptions } from "../src/text-output.ts";
import { addVault, removeVault } from "../src/registry.ts";
import { serveMcp } from "../src/mcp.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";
import { VaultIndex } from "../src/vault-index.ts";
import { vaultStats } from "../src/vault-stats.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const note = (type: string, domain: string, status?: string) =>
  `---\ntype: ${type}\ndomain: ${domain}\ndescription: Synthetic note.\n${status ? `status: ${status}\n` : ""}---\n# Synthetic\n`;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-stats-"))); roots.push(root);
  const vault = join(root, "vault"), notes = join(vault, "notes"), home = join(root, "state");
  mkdirSync(notes, { recursive: true });
  addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp" });
  return { root, vault, notes, home };
}
/** Every path under root with its size and mtime, to prove a call wrote nothing there. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name), stat = lstatSync(file);
    out.push(`${file}:${stat.size}:${stat.mtimeMs}`);
    if (entry.isDirectory()) walk(file);
  } };
  walk(root); return out.sort();
}
async function mcp(home: string, calls: [string, Record<string, unknown>][]) {
  const server = createVaultMcp(home, { VMEM_HOME: home });
  const input = new PassThrough(), output = new PassThrough(); let text = "";
  output.on("data", chunk => { text += chunk.toString(); });
  const done = serveMcp({ tools: server.tools, handlers: server.handlers, input, output });
  const frames = [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, { jsonrpc: "2.0", method: "notifications/initialized" },
    ...calls.map(([name, args], i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: args } }))];
  for (const frame of frames) input.write(JSON.stringify(frame) + "\n");
  input.end(); await done;
  return text.trim().split("\n").map(line => JSON.parse(line)).slice(1).map(r => r.result?.content ? JSON.parse(r.result.content[0].text) : r);
}

test("#62 AC1: paging a 5000-note vault returns every note exactly once, in stable path order", () => {
  const f = fixture();
  const index = new VaultIndex(f.home, { id: "mine", path: f.vault, kind: "personal", write: "mcp" }, [f.vault], { memory: true, reuseCache: false });
  try {
    // Seed the in-memory index directly (paging is pure SQL over it) instead of writing and scanning 5000 files.
    // Paths are shuffled against insert order so path order is not insertion order.
    const db = index["db"], insert = db.query("INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?)");
    db.transaction(() => { for (let i = 0; i < 5000; i++) insert.run(`n-${String((i * 7919) % 5000).padStart(4, "0")}.md`, "h", `1:${i}:10:1790000000000:1790000000000`, "t", "d", "b", "insight", "research", "[]", "s"); })();
    const seen: string[] = [];
    let cursor: string | undefined, pages = 0;
    do {
      const page = index.list("", 500, cursor);
      expect(page.total).toBe(5000);
      seen.push(...page.notes.map(n => n.path)); cursor = page.nextCursor; pages++;
    } while (cursor);
    expect(pages).toBe(10);
    expect(new Set(seen).size).toBe(5000);
    expect(seen).toEqual([...seen].sort());
    // The same cursor gives the same page.
    expect(index.list("", 500, seen[499]).notes.map(n => n.path)).toEqual(seen.slice(500, 1000));
  } finally { index.close(); }
});

test("#62 list: prefix total, per-row mtime from the index, last page without cursor, invalid cursor refused", async () => {
  const f = fixture();
  for (const name of ["a-1", "a-2", "a-3", "b-1"]) writeFileSync(join(f.notes, `${name}.md`), note("insight", "research"));
  const when = new Date("2026-10-01T08:30:00.000Z");
  utimesSync(join(f.notes, "a-2.md"), when, when);
  const [first, second, wrong, all] = await mcp(f.home, [["vmem_list", { prefix: "a", limit: 2 }], ["vmem_list", { prefix: "a", limit: 2, cursor: "a-2.md" }], ["vmem_list", { prefix: "a", cursor: "b-1.md" }], ["vmem_list", {}]]);
  expect(first).toMatchObject({ total: 3, nextCursor: "a-2.md" });
  expect(first.notes.map((n: any) => n.path)).toEqual(["a-1.md", "a-2.md"]);
  expect(first.notes[1].mtime).toBe(when.toISOString());
  expect(second.notes.map((n: any) => n.path)).toEqual(["a-3.md"]);
  expect(second.total).toBe(3);
  expect(second).not.toHaveProperty("nextCursor");
  expect(wrong.refused).toBe(true);
  expect(wrong.issues[0].message).toContain("list again without cursor");
  expect(all.total).toBe(4);
  expect(all).not.toHaveProperty("nextCursor");
});

test("#62 AC2: stats match a direct count, and write or lock nothing in the vault", async () => {
  const f = fixture(), now = new Date(2026, 10, 4, 12, 0);
  const day = (back: number) => new Date(2026, 10, 4 - back, 9, 0);
  const fixtures: [string, string, string, string | undefined, number][] = [
    ["today", "insight", "research", "active", 0], ["six", "insight", "research", "active", 6], ["seven", "decision", "ops", "done", 7],
    ["twentynine", "decision", "ops", undefined, 29], ["thirty", "moc", "research", undefined, 30], ["old", "insight", "ops", "done", 90],
  ];
  for (const [name, type, domain, status, back] of fixtures) {
    const file = join(f.notes, `${name}.md`); writeFileSync(file, note(type, domain, status)); utimesSync(file, day(back), day(back));
  }
  writeFileSync(join(f.vault, "log"), [
    "# comment line",
    "2026-10-05 23:59  INGEST  p  s  — outside the 30-day window",
    "2026-10-06 00:00  INGEST  p  s  — first day of the window",
    "2026-10-20 10:00  LEARN  p  s  — inside",
    "2026-11-04 08:00  LEARN  p  s  — today",
    "2026-11-04 08:01  LEGACY  p  s  — unknown type",
    "",
  ].join("\n"));
  // The derived index cache under VMEM_HOME may be refreshed, as by every read tool; the vault (notes, log) may not change.
  const before = tree(f.vault);
  const stats = vaultStats(f.home, "mine", { now });
  expect(tree(f.vault)).toEqual(before);
  expect(existsSync(join(f.vault, "log.lock"))).toBe(false);
  expect(stats.asOf).toBe("2026-11-04");
  expect(stats.notes).toEqual({ total: 6, byType: { decision: 2, insight: 3, moc: 1 }, byDomain: { ops: 3, research: 3 }, byStatus: { "(none)": 2, active: 2, done: 2 } });
  expect(stats.modified).toEqual({ last7Days: 2, last30Days: 4 });
  expect(stats.log).toMatchObject({ days: 30, since: "2026-10-06", total: 4, issues: [] });
  expect(stats.log.byType).toMatchObject({ INGEST: 1, LEARN: 2, "(other)": 1, SYNC: 0 });
  const week = vaultStats(f.home, "mine", { now, days: 7 });
  expect(week.log).toMatchObject({ since: "2026-10-29", total: 2 });
  expect(() => vaultStats(f.home, "mine", { days: 0 })).toThrow("days must be an integer 1..3650");
  expect(() => vaultStats(f.home, "missing")).toThrow("run vmem vaults list");
  // A vault without a log reports zero events; MCP and CLI agree with the library and also write nothing.
  rmSync(join(f.vault, "log"));
  const steady = tree(f.vault);
  const [tool, refused] = await mcp(f.home, [["vmem_stats", { vault: "mine" }], ["vmem_stats", { days: 0 }]]);
  expect(tool.notes.total).toBe(6);
  expect(tool.log.total).toBe(0);
  expect(refused.error).toMatchObject({ code: -32602, message: "days: less than 1" });
  const cli = run(["stats", "mine", "--days", "7", "--json"], { VMEM_HOME: f.home });
  expect(cli.code).toBe(0);
  expect(JSON.parse(cli.text)).toMatchObject({ vault: "mine", notes: { total: 6 }, log: { days: 7, total: 0 } });
  expect(tree(f.vault)).toEqual(steady);
  expect(existsSync(join(f.vault, "log.lock"))).toBe(false);
  expect(() => run(["stats", "mine", "--days", "x"], { VMEM_HOME: f.home })).toThrow("--days expects an integer");
  expect(() => run(["stats"], { VMEM_HOME: f.home })).toThrow("requires one vault id");
});

test("#62 status drops the stage field; stats is in help and the manifest as read-only", () => {
  const f = fixture();
  expect(JSON.parse(run(["status", "--json"], { VMEM_HOME: f.home }).text)).not.toHaveProperty("stage");
  expect(run(["stats", "--help"]).text).toBe(commandUsage("stats", textOptions(undefined))!);
  expect(commandUsage("stats")).toContain("vmem stats <vault> [--days 1..3650] [--json]");
  expect(JSON.parse(run(["manifest", "--json"]).text).mcp.tools).toContainEqual({ name: "vmem_stats", readOnly: true });
});

test("#62 vmem_stats is bound to the vault set fixed at MCP startup", async () => {
  const f = fixture(), other = join(f.root, "other");
  writeFileSync(join(f.notes, "one.md"), note("insight", "research"));
  mkdirSync(join(other, "notes"), { recursive: true });
  const server = createVaultMcp(f.home, { VMEM_HOME: f.home });
  expect(await server.handlers.vmem_stats!({ vault: "mine" })).toMatchObject({ notes: { total: 1 } });
  removeVault(f.home, "mine", true);
  addVault(f.home, { id: "mine", path: other, kind: "personal", write: "mcp" });
  expect(await server.handlers.vmem_stats!({ vault: "mine" })).toMatchObject({ refused: true, issues: [{ message: expect.stringContaining("restart the MCP server") }] });
});

/** A vault inside a configured workspace, so a note's `source` paths resolve from the workspace root. */
function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-ratio-"))); roots.push(root);
  const dir = join(root, "workspace"), vault = join(dir, "vault"), notes = join(vault, "notes"), home = join(root, "state");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(dir, "workspace.config.yaml"), "fixture: true\n");
  writeFileSync(join(dir, "project-registry.yaml"), "projects: []\n");
  addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp", registry: join(dir, "project-registry.yaml") });
  return { root, dir, vault, notes, home };
}
const cited = (source: string, type = "insight", domain = "research") =>
  `---\ntype: ${type}\ndomain: ${domain}\nsource: ${source}\ndescription: Synthetic note.\n---\n# Synthetic\n`;

test("#165 part 5: stats add note bytes and words in total and by type and domain", () => {
  const f = fixture(), now = new Date(2026, 10, 4, 12, 0);
  const files: [string, string][] = [
    ["one.md", note("insight", "research", "active")],
    ["two.md", note("insight", "ops")],
    ["three.md", note("decision", "ops", "done")],
  ];
  for (const [name, text] of files) writeFileSync(join(f.notes, name), text);
  const size = (rows: [string, string][]) => ({
    notes: rows.length,
    bytes: rows.reduce((total, [, text]) => total + Buffer.byteLength(text), 0),
    words: rows.reduce((total, [, text]) => total + text.trim().split(/\s+/u).length, 0),
  });
  const stats = vaultStats(f.home, "mine", { now });
  expect(stats.size.total).toEqual(size(files));
  expect(stats.size.byType).toEqual({ decision: size(files.slice(2)), insight: size(files.slice(0, 2)) });
  expect(stats.size.byDomain).toEqual({ ops: size(files.slice(1)), research: size(files.slice(0, 1)) });
});

test("#165 part 5: the note-to-source ratio reads cited workspace files only, skips the rest and writes nothing", async () => {
  const f = workspace(), now = new Date(2026, 10, 4, 12, 0), src = join(f.dir, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "big.txt"), "x".repeat(4000));
  writeFileSync(join(src, "small.txt"), "x".repeat(40));
  writeFileSync(join(src, ".env"), "TOKEN=1\n");
  writeFileSync(join(src, "huge.txt"), "x".repeat(3 * 1024 * 1024));
  const texts = {
    big: cited('["work/src/big.txt"]'), small: cited('["src/small.txt"]'), denied: cited('["src/.env"]'),
    huge: cited('["src/huge.txt"]'), missing: cited('["src/missing.txt"]'), nonfile: cited('["mem:alpha", "https://example.com/a"]'),
    invalid: cited('["src/../escape.txt"]'), none: note("insight", "research"),
  };
  for (const [name, text] of Object.entries(texts)) writeFileSync(join(f.notes, `${name}.md`), text);
  const before = tree(f.dir);
  const stats = vaultStats(f.home, "mine", { now }), ratio = stats.ratio;
  const round3 = (value: number) => Math.round(value * 1000) / 1000;
  // One ratio per note whose sources were readable: the note's own bytes over the bytes it cites.
  const small = Buffer.byteLength(texts.small) / 40, big = Buffer.byteLength(texts.big) / 4000;
  expect(ratio.notes).toBe(2);
  expect(ratio.sources).toBe(2);
  // Skipped: the denylisted, oversized and missing files, the traversing entry, and the memory id and URL.
  expect({ skipped: ratio.skipped, skippedNonFile: ratio.skippedNonFile }).toEqual({ skipped: 6, skippedNonFile: 2 });
  expect(ratio.median).toBe(round3((small + big) / 2));
  expect(ratio.p90).toBe(round3(small));
  expect(ratio.overOne).toBe(1);
  expect(ratio.largest).toEqual([{ path: "small.md", ratio: round3(small) }, { path: "big.md", ratio: round3(big) }]);
  // Every field stays JSON-safe (no Infinity), and MCP, CLI and the library report the same numbers.
  const [tool] = await mcp(f.home, [["vmem_stats", { vault: "mine" }]]);
  const printed = JSON.parse(run(["stats", "mine", "--json"], { VMEM_HOME: f.home }).text);
  const expected = JSON.parse(JSON.stringify({ size: stats.size, ratio }));
  expect(tool.ratio).toEqual(expected.ratio);
  expect({ size: printed.size, ratio: printed.ratio }).toEqual(expected);
  const text = run(["stats", "mine"], { VMEM_HOME: f.home }).text;
  expect(text).toContain(`Note size\n  total  ${stats.size.total.bytes} bytes`);
  expect(text).toContain("Note-to-source ratio\n  notes    2 notes\n  sources  2 files");
  expect(text).toContain("  over 1   1 note\n  skipped  6 source references, 2 not a file\n  largest  small.md 2.65; big.md 0.027");
  expect(tree(f.dir)).toEqual(before);
});

test("#165 part 5: without a registered workspace the ratio reads nothing and says how much it skipped", () => {
  const f = fixture(), now = new Date(2026, 10, 4, 12, 0);
  writeFileSync(join(f.notes, "one.md"), cited('["src/notes.txt"]'));
  const stats = vaultStats(f.home, "mine", { now });
  expect(stats.ratio).toEqual({ notes: 0, sources: 0, skipped: 1, skippedNonFile: 0, truncatedNotes: 0, median: null, p90: null, overOne: 0, largest: [] });
  expect(run(["stats", "mine"], { VMEM_HOME: f.home }).text).toContain("no note cites a readable workspace file; 1 source reference skipped");
});

test("#82 fix: a source counts at its own byte size, not at the size of its decoded text", () => {
  const f = workspace(), src = join(f.dir, "src");
  mkdirSync(src, { recursive: true });
  // Two bytes on disk; decoding the invalid 0x80 as U+FFFD makes the string measure four.
  writeFileSync(join(src, "raw.bin"), Buffer.from([0x41, 0x80]));
  expect(Buffer.byteLength(readFileSync(join(src, "raw.bin"), "utf8"))).toBe(4);
  const text = cited('["src/raw.bin"]');
  writeFileSync(join(f.notes, "raw.md"), text);
  const ratio = vaultStats(f.home, "mine", { now: new Date(2026, 10, 4, 12, 0) }).ratio;
  const round3 = (value: number) => Math.round(value * 1000) / 1000;
  expect({ notes: ratio.notes, sources: ratio.sources, skipped: ratio.skipped }).toEqual({ notes: 1, sources: 1, skipped: 0 });
  // The denominator is the 2 bytes the file holds, not the 4 bytes its decoded text would report.
  expect(ratio.median).toBe(round3(Buffer.byteLength(text) / 2));
  expect(ratio.largest).toEqual([{ path: "raw.md", ratio: round3(Buffer.byteLength(text) / 2) }]);
});

test("#82 fix: a file that would take the source total past the byte cap is left out whole and counted", () => {
  const f = workspace(), src = join(f.dir, "src");
  mkdirSync(src, { recursive: true });
  for (const name of ["a", "b", "c"]) writeFileSync(join(src, `${name}.txt`), "x".repeat(60));
  const text = cited('["src/a.txt", "src/b.txt", "src/c.txt"]'), note = Buffer.byteLength(text);
  writeFileSync(join(f.notes, "three.md"), text);
  const now = new Date(2026, 10, 4, 12, 0), round3 = (value: number) => Math.round(value * 1000) / 1000;
  // 60 + 60 fits a 120-byte cap exactly; the third file would make 180 and is skipped instead of overshooting.
  const at = vaultStats(f.home, "mine", { now, limits: { sources: 10000, bytes: 120 } }).ratio;
  expect({ notes: at.notes, sources: at.sources, skipped: at.skipped }).toEqual({ notes: 1, sources: 2, skipped: 1 });
  expect(at.largest).toEqual([{ path: "three.md", ratio: round3(note / 120) }]);
  // One byte under, no second file fits at all, so the counted total stays inside the cap either way.
  const over = vaultStats(f.home, "mine", { now, limits: { sources: 10000, bytes: 119 } }).ratio;
  expect({ sources: over.sources, skipped: over.skipped }).toEqual({ sources: 1, skipped: 2 });
  expect(over.largest).toEqual([{ path: "three.md", ratio: round3(note / 60) }]);
});

test("#82 fix: sourced notes past the note cap are counted, in the index, the ratio and the text output", () => {
  const f = workspace(), src = join(f.dir, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "note.txt"), "x".repeat(10));
  for (const name of ["a", "b", "c"]) writeFileSync(join(f.notes, `${name}.md`), cited('["src/note.txt"]'));
  const index = new VaultIndex(f.home, { id: "mine", path: f.vault, kind: "personal", write: "mcp" }, [f.vault], { memory: true, reuseCache: false });
  try {
    index.scan();
    const cut = index.noteStats([0, 0], 2);
    expect(cut.sourced.map(entry => entry.path)).toEqual(["a.md", "b.md"]);
    expect(cut.truncatedSourced).toBe(1);
    expect(index.noteStats([0, 0]).truncatedSourced).toBe(0);
  } finally { index.close(); }
  const stats = vaultStats(f.home, "mine", { now: new Date(2026, 10, 4, 12, 0) }), options = textOptions(undefined);
  expect(stats.ratio.truncatedNotes).toBe(0);
  expect(renderStats(stats, options)).not.toContain("past the 10000-note cap");
  expect(renderStats({ ...stats, ratio: { ...stats.ratio, truncatedNotes: 7 } }, options)).toContain("truncated  7 notes past the 10000-note cap");
});

