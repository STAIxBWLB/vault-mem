import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AGENT_MARKERS, LOG_TYPES, formatLogEvent } from "../src/log-format.ts";
import type { LogContext, LogEvent } from "../src/log-types.ts";

const vault = { id: "synthetic", path: "/synthetic/vault", kind: "personal" as const, write: "mcp" as const };
const event: LogEvent = { type: "LEARN", project: "synthetic", source: "fixture/source.md", dest: "notes/target.md", note: "Synthetic supporting detail" };
function context(overrides: Partial<LogContext> = {}): LogContext {
  return { vault, config: { vaults: [vault] }, env: {}, now: new Date(2026, 9, 29, 9, 8, 59), ...overrides };
}
function refused(candidate: LogEvent, ctx = context()): void {
  const result = formatLogEvent(candidate, ctx);
  expect(result.line).toBeUndefined();
  expect(result.issues.some(issue => issue.severity === "error")).toBe(true);
}

describe("canonical log formatter", () => {
  test("golden corpus covers every canonical type and passes the reference L09 checks", () => {
    const lines = readFileSync(new URL("./fixtures/log-golden.txt", import.meta.url), "utf8").trimEnd().split("\n");
    // Copied from reference vault-lint/scripts/lint.py LOG_RE and CANONICAL (JavaScript regexp syntax).
    const referenceLog = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\s+(\S+)\s+(.*)$/;
    const canonical = new Set(["INGEST", "ROUTE", "EXTRACT", "CONNECT", "DIGEST", "LEARN", "LINT", "TASK", "GRAPH", "SYNC", "RETHINK", "SOURCE"]);
    expect(lines).toHaveLength(12);
    expect(new Set<string>(LOG_TYPES)).toEqual(canonical);
    for (const [index, type] of LOG_TYPES.entries()) {
      const source = type === "SOURCE";
      const formatted = formatLogEvent({ type, project: "synthetic", source: "fixture/source.md", ...(source ? {} : { dest: `notes/${type.toLowerCase()}.md` }), note: `Synthetic ${type.toLowerCase()} fixture` }, context());
      expect(formatted.issues).toEqual([]);
      expect(formatted.line).toBe(`${lines[index]}\n`);
      const matched = referenceLog.exec(lines[index]!);
      expect(matched).not.toBeNull();
      expect(canonical.has(matched![3]!)).toBe(true);
    }
  });
  test("uses local calendar fields, exactly two spaces, optional destination and one trailing LF", () => {
    expect(formatLogEvent(event, context()).line).toBe("2026-10-29 09:08  LEARN  synthetic  fixture/source.md → notes/target.md  — Synthetic supporting detail\n");
    expect(formatLogEvent({ ...event, project: "-", dest: undefined }, context()).line).toBe("2026-10-29 09:08  LEARN  -  fixture/source.md  — Synthetic supporting detail\n");
    refused(event, context({ now: new Date(Number.NaN) }));
    refused(event, context({ now: "2026-10-29" as unknown as Date }));
    const distant = new Date(2026, 0, 1); distant.setFullYear(10000);
    refused(event, context({ now: distant }));
  });
  test("supports only the exact five nonempty agent markers and MCP attribution", () => {
    expect(AGENT_MARKERS).toEqual(["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"]);
    for (const marker of AGENT_MARKERS) {
      expect(formatLogEvent(event, context({ env: { [marker]: "synthetic-session" } })).line).toEndWith(" (vmem:agent)\n");
      expect(formatLogEvent(event, context({ env: { [marker]: "" } })).line).not.toContain("(vmem:agent)");
    }
    expect(formatLogEvent(event, context({ channel: "mcp", env: {} })).line).toEndWith(" (vmem:agent)\n");
    expect(formatLogEvent(event, context({ channel: "cli", env: { UNSUPPORTED_AGENT: "yes" } })).line).not.toContain("(vmem:agent)");
    expect(formatLogEvent(event, context({ env: { CLAUDECODE: "0" } })).line).toEndWith(" (vmem:agent)\n");
    const previous = process.env.CLAUDECODE;
    try {
      process.env.CLAUDECODE = "synthetic-session";
      const ctx = context(); delete ctx.env;
      expect(formatLogEvent(event, ctx).line).toEndWith(" (vmem:agent)\n");
    } finally { if (previous === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = previous; }
  });
  test("validates canonical types and configured project ids, with '-' always permitted", () => {
    for (const type of ["CREATE", "learn", "UNKNOWN", ""]) refused({ ...event, type });
    for (const project of ["Upper", "bad_id", "../project", "two words", "", "-bad", "project|other"]) refused({ ...event, project });
    refused(event, context({ projectIds: new Set(["different"]) }));
    expect(formatLogEvent(event, context({ projectIds: new Set(["synthetic"]) })).issues).toEqual([]);
    expect(formatLogEvent({ ...event, project: "-" }, context({ projectIds: new Set() })).issues).toEqual([]);
    expect(formatLogEvent({ ...event, project: "abc-123" }, context()).issues).toEqual([]);
  });
  test("rejects separators, controls, empty or non-string fields before returning any line", () => {
    for (const key of ["source", "dest", "note"] as const) {
      for (const value of ["", " ", "leading ", " trailing", "two  spaces", "pipe|value", "split — value", "line\nbreak", "line\rbreak", "tab\tvalue", "C1value", "DELvalue", "line separator", "paragraph separator"]) refused({ ...event, [key]: value });
      for (const value of [null, 3, [], {}]) refused({ ...event, [key]: value } as unknown as LogEvent);
    }
    refused({ ...event, source: "first → second" }); refused({ ...event, dest: "first → second" });
    expect(formatLogEvent({ ...event, note: "A source → destination explanation" }, context()).issues).toEqual([]);
  });
  test("closes runtime event/context options without echoing arbitrary values", () => {
    for (const candidate of [null, [], { ...event, unexpected: "sensitive-extra-value" }, { ...event, type: 42 }]) refused(candidate as unknown as LogEvent);
    for (const ctx of [null, [], { ...context(), unexpected: "sensitive-extra-value" }, context({ channel: "unknown" as "cli" }), context({ env: { CLAUDECODE: true } as unknown as NodeJS.ProcessEnv }), context({ projectIds: [] as unknown as ReadonlySet<string> })]) {
      const result = formatLogEvent(event, ctx as unknown as LogContext);
      expect(result.line).toBeUndefined(); expect(JSON.stringify(result.issues)).not.toContain("sensitive-extra-value");
    }
  });
  test("enforces UTF-8 byte bounds including LF, multibyte text and attribution", () => {
    for (const channel of ["cli", "mcp"] as const) {
      const ctx = context({ channel });
      const overhead = Buffer.byteLength(formatLogEvent({ ...event, note: "x" }, ctx).line!) - 1;
      const room = 1000 - overhead;
      const exact = formatLogEvent({ ...event, note: "a".repeat(room) }, ctx);
      expect(Buffer.byteLength(exact.line!)).toBe(1000);
      refused({ ...event, note: "a".repeat(room + 1) }, ctx);
      const unicode = "가".repeat(Math.floor(room / 3)) + "a".repeat(room % 3);
      expect(Buffer.byteLength(formatLogEvent({ ...event, note: unicode }, ctx).line!)).toBe(1000);
      const overflow = formatLogEvent({ ...event, note: unicode + "가" }, ctx);
      expect(overflow.line).toBeUndefined(); expect(overflow.issues.some(issue => issue.code === "V09")).toBe(true);
    }
  });
  test("screens the full prospective line for secrets and denied PII without exposing matches", () => {
    const secret = `sk-${"a".repeat(20)}`;
    for (const key of ["source", "dest", "note"] as const) {
      const result = formatLogEvent({ ...event, [key]: secret }, context());
      expect(result.line).toBeUndefined(); expect(result.issues.some(issue => issue.code === "V06")).toBe(true);
      expect(JSON.stringify(result.issues)).not.toContain(secret);
    }
    const org = context({ vault: { ...vault, kind: "org" } });
    expect(formatLogEvent(event, org).issues).toEqual([]);
    expect(formatLogEvent(event, org).line).toBeDefined();
    for (const value of ["synthetic@example.test", "+82-10-1234-5678"]) {
      const result = formatLogEvent({ ...event, note: value }, org);
      expect(result.line).toBeUndefined(); expect(result.issues.some(issue => issue.code === "V07")).toBe(true);
    }
    const configured = context({ vault: { ...vault, pii: "deny" }, config: { vaults: [vault], piiPatterns: ["fixture-account-[0-9]+"] } });
    expect(formatLogEvent({ ...event, note: "fixture-account-123" }, configured).issues.some(issue => issue.code === "V07")).toBe(true);
    expect(formatLogEvent({ ...event, note: "synthetic@example.test" }, context()).line).toBeDefined();
  });
});
