import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { run } from "../src/cli.ts";
import { addVault } from "../src/registry.ts";
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
  expect(run(["stats", "--help"]).text).toBe("Usage: vmem stats <vault> [--days 1..3650] [--json]");
  expect(JSON.parse(run(["manifest", "--json"]).text).mcp.tools).toContainEqual({ name: "vmem_stats", readOnly: true });
});
