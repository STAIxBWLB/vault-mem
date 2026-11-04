import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { MAX_LOG_CURSOR_GAP, readLogSince } from "../src/vault-log.ts";
import { plugin } from "../src/ui/plugin.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-log-cursor-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, "state");
process.env.VMEM_HOME = home; process.env.AGENTHUB_HOME = join(root, "family");
mkdirSync(join(root, "v", "notes"), { recursive: true });
addVault(home, { id: "v", path: join(root, "v"), kind: "personal", write: "mcp" });
const log = join(root, "v", "log");
const line = (n: number, type = "INGEST") => `2026-11-04 10:${String(n).padStart(2, "0")}  ${type}  synthetic  notes/n${n}.md  — synthetic event ${n}\n`;

test("first call returns the latest rows and a cursor; an append returns only the new rows (#48)", () => {
  writeFileSync(log, "# vault log\n" + line(1) + line(2));
  const first = readLogSince(home, { vault: "v" });
  expect(first.ok).toBe(true); expect(first.reset).toBe(false);
  expect(first.lines).toEqual([line(1).trimEnd(), line(2).trimEnd()]);
  expect(readLogSince(home, { vault: "v", after: first.cursor }).lines).toEqual([]);
  appendFileSync(log, line(3) + line(4, "ROUTE"));
  const next = readLogSince(home, { vault: "v", after: first.cursor });
  expect(next.reset).toBe(false); expect(next.lines).toEqual([line(3).trimEnd(), line(4, "ROUTE").trimEnd()]);
  expect(readLogSince(home, { vault: "v", after: first.cursor, type: "ROUTE" }).lines).toEqual([line(4, "ROUTE").trimEnd()]);
  expect(readLogSince(home, { vault: "v", after: next.cursor }).lines).toEqual([]);
});

test("two identical lines are both returned, across a poll and within one (#48)", () => {
  writeFileSync(log, line(1));
  const a = readLogSince(home, { vault: "v" });
  appendFileSync(log, line(1));
  const b = readLogSince(home, { vault: "v", after: a.cursor });
  expect(b.lines).toEqual([line(1).trimEnd()]);
  appendFileSync(log, line(1) + line(1));
  expect(readLogSince(home, { vault: "v", after: b.cursor }).lines).toEqual([line(1).trimEnd(), line(1).trimEnd()]);
});

test("a partial final line waits for its newline (#48)", () => {
  writeFileSync(log, line(1) + line(2).slice(0, 10));
  const a = readLogSince(home, { vault: "v" });
  expect(a.lines).toEqual([line(1).trimEnd()]);
  appendFileSync(log, line(2).slice(10));
  expect(readLogSince(home, { vault: "v", after: a.cursor }).lines).toEqual([line(2).trimEnd()]);
});

test("a rewritten, truncated, too-far-behind or garbage cursor resets to the latest rows (#48)", () => {
  writeFileSync(log, line(1) + line(2) + line(3));
  const a = readLogSince(home, { vault: "v" });
  writeFileSync(log, line(5) + line(6) + line(7) + line(8)); // rewrite (tidy): longer, different bytes before the cursor
  const r = readLogSince(home, { vault: "v", after: a.cursor });
  expect(r.reset).toBe(true); expect(r.lines).toEqual([5, 6, 7, 8].map(n => line(n).trimEnd()));
  writeFileSync(log, line(9)); // truncation: cursor past the end
  expect(readLogSince(home, { vault: "v", after: r.cursor })).toMatchObject({ reset: true, lines: [line(9).trimEnd()] });
  expect(readLogSince(home, { vault: "v", after: "nonsense" })).toMatchObject({ ok: true, reset: true });
  const c = readLogSince(home, { vault: "v" });
  appendFileSync(log, line(10).repeat(Math.ceil((MAX_LOG_CURSOR_GAP + 1) / line(10).length)));
  const far = readLogSince(home, { vault: "v", after: c.cursor });
  expect(far.reset).toBe(true); expect(far.lines.length).toBe(100);
});

test("the console log snapshot returns rows newest first with cursor and reset (#48)", async () => {
  writeFileSync(log, line(1) + line(2));
  const p = await plugin.open({ home: process.env.AGENTHUB_HOME!, log: () => {} });
  const first = await p.snapshot({ after: 0, panel: "log", vault: "v" }) as { rows: { source: string }[]; cursor: string; reset?: boolean };
  expect(first.rows.map(r => r.source)).toEqual(["notes/n2.md", "notes/n1.md"]); expect(first.reset).toBeUndefined();
  appendFileSync(log, line(3));
  const next = await p.snapshot({ panel: "log", vault: "v", after: first.cursor } as never) as { rows: { source: string }[]; cursor: string };
  expect(next.rows.map(r => r.source)).toEqual(["notes/n3.md"]);
  writeFileSync(log, line(4));
  expect(await p.snapshot({ panel: "log", vault: "v", after: next.cursor } as never)).toMatchObject({ reset: true });
});

test("the shell's numeric poll cursor keeps returning the latest rows (#48)", async () => {
  writeFileSync(log, line(1) + line(2));
  const p = await plugin.open({ home: process.env.AGENTHUB_HOME!, log: () => {} });
  const a = await p.snapshot({ after: 0, panel: "log", vault: "v" }) as { rows: unknown[]; cursor: unknown };
  expect(typeof a.cursor).toBe("string");
  appendFileSync(log, line(3));
  expect((await p.snapshot({ after: 0, panel: "log", vault: "v" }) as { rows: unknown[] }).rows).toHaveLength(3);
});

test("a pending line longer than the tail window keeps the cursor on a line start and is omitted whole (#48)", () => {
  const huge = "x".repeat(300 * 1024);
  writeFileSync(log, huge);
  const a = readLogSince(home, { vault: "v" });
  expect(a.lines).toEqual([]);
  expect(Buffer.from(a.cursor, "base64url").toString().split(".")[1]).toBe("0");
  appendFileSync(log, "tail-of-the-long-line\n" + line(1));
  const b = readLogSince(home, { vault: "v", after: a.cursor });
  expect(b.reset).toBe(false);
  expect(b.lines).toEqual([line(1).trimEnd()]);
  expect(b.warnings).toContain("historical log line over 4096 bytes omitted");
  writeFileSync(log, line(1) + huge);
  const c = readLogSince(home, { vault: "v" });
  expect(Buffer.from(c.cursor, "base64url").toString().split(".")[1]).toBe(String(Buffer.byteLength(line(1))));
  appendFileSync(log, "\n" + line(2));
  expect(readLogSince(home, { vault: "v", after: c.cursor }).lines).toEqual([line(2).trimEnd()]);
});
