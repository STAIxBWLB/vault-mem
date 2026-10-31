import { expect, test } from "bun:test";
import { localDate } from "../src/local-date.ts";

/** Run one fixture case with TZ set before any Date is built; the fixture pins the clock at 2026-10-31T18:00:00Z. */
function inZone(zone: string, mode: string): Record<string, unknown> {
  const result = Bun.spawnSync([process.execPath, "test/fixtures/local-date.ts", mode], { env: { ...process.env, TZ: zone }, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

test("localDate formats the local calendar date, zero-padded", () => {
  expect(localDate(new Date(2026, 0, 2, 0, 5))).toBe("2026-01-02");
  expect(localDate(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
});

test("Asia/Seoul at 03:00 local (18:00Z the day before) names reports 261101, matching the log line date, and L11 uses it", () => {
  const seoul = inZone("Asia/Seoul", "analysis");
  expect(seoul).toMatchObject({ localDate: "2026-11-01", utcDate: "2026-10-31", ok: true });
  expect(seoul.reports).toEqual(["graph-report-261101.md", "graph-trend.md", "lint-report-261101.md", "vault-graph.json"]);
  expect(seoul.logDates).toEqual(["2026-11-01", "2026-11-01"]);
  expect(seoul.trendDate).toBe("2026-11-01");
  // The report written today is zero days old, so L11 (staleness > 7 days) stays empty.
  expect(seoul.l11).toEqual([]);
  // In UTC the same instant is still 31 October.
  const utc = inZone("UTC", "analysis");
  expect(utc.reports).toEqual(["graph-report-261031.md", "graph-trend.md", "lint-report-261031.md", "vault-graph.json"]);
  expect(utc.logDates).toEqual(["2026-10-31", "2026-10-31"]);
});

test("org promotion stamps promoted_at with the local date", () => {
  expect(inZone("Asia/Seoul", "org").promoted_at).toBe("2026-11-01");
  expect(inZone("UTC", "org").promoted_at).toBe("2026-10-31");
});

test("promotion from agent-mem stamps promoted_at with the local date", () => {
  expect(inZone("Asia/Seoul", "promote").promoted_at).toBe("2026-11-01");
  expect(inZone("UTC", "promote").promoted_at).toBe("2026-10-31");
});

test("the skill-candidate report is dated with the local date", () => {
  expect(inZone("Asia/Seoul", "skills").reportDate).toBe("2026-11-01");
  expect(inZone("UTC", "skills").reportDate).toBe("2026-10-31");
});
