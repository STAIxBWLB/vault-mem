/**
 * Subprocess fixture for local-date tests: `TZ=<zone> bun test/fixtures/local-date.ts <case>`.
 * The clock is pinned to 2026-10-31T18:00:00Z, which is 2026-11-01 03:00 in Asia/Seoul and still 2026-10-31 in UTC.
 * Prints one JSON line of observed dates; every input is synthetic.
 */
import { setSystemTime } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTANT = new Date("2026-10-31T18:00:00Z");
setSystemTime(INSTANT);
const { localDate } = await import("../../src/local-date.ts");
const { addVault } = await import("../../src/registry.ts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-local-date-")));
const plainEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"].includes(key)));
const moc = "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n";
const note = (title: string, body: string) => `---\ntitle: ${JSON.stringify(title)}\ndescription: Synthetic evidence for navigation.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\n---\n# ${title}\n\n${body}\n\n## Relevant Notes\n\n## Topics\n\n- [[research]]\n`;
function vault(name: string): string {
  const path = join(root, name);
  mkdirSync(join(path, "notes"), { recursive: true });
  writeFileSync(join(path, "notes", "research.md"), moc);
  return path;
}
const home = join(root, "state"), env = { ...plainEnv, VMEM_HOME: home };
const out: Record<string, unknown> = { localDate: localDate(), utcDate: INSTANT.toISOString().slice(0, 10) };
try {
  const mode = process.argv[2];
  if (mode === "analysis") {
    const path = vault("personal");
    // A graph report dated today (local) keeps L11 quiet only if lint uses the same local date.
    addVault(home, { id: "personal", path, kind: "personal", write: "mcp" });
    const { writeAnalysisReports } = await import("../../src/analysis-reports.ts");
    const graph = writeAnalysisReports(home, { vault: "personal", kind: "graph" }, env);
    const lint = writeAnalysisReports(home, { vault: "personal", kind: "lint" }, env);
    const { analysisInput } = await import("../../src/analysis-input.ts");
    const { lintVault } = await import("../../src/vault-lint.ts");
    const findings = lintVault(analysisInput(home, "personal").snapshot).findings;
    const log = readFileSync(join(path, "log"), "utf8").trimEnd().split("\n");
    const trend = readFileSync(join(path, "reports", "graph-trend.md"), "utf8").trimEnd().split("\n").at(-1)!;
    Object.assign(out, {
      ok: graph.ok && lint.ok, reports: readdirSync(join(path, "reports")).sort(), logDates: log.map(line => line.slice(0, 10)),
      trendDate: trend.split("|")[1]!.trim(), l11: findings.L11,
    });
  } else if (mode === "org") {
    const personal = vault("personal"), org = vault("org");
    writeFileSync(join(personal, "notes", "shared-method.md"), note("Shared Method", "Uses [[research]]."));
    addVault(home, { id: "personal", path: personal, kind: "personal", write: "mcp" });
    addVault(home, { id: "team", path: org, kind: "org", write: "cli" });
    const { promoteToOrg } = await import("../../src/org-promote.ts");
    const preview = promoteToOrg(home, { from: "personal", note: "shared-method", to: "team" }, { env });
    out.preview = { ok: preview.ok, issues: preview.issues?.map(i => i.code) }; out.promoted_at = /promoted_at"?: "?(\d{4}-\d{2}-\d{2})/.exec(preview.text ?? "")?.[1] ?? null;
  } else if (mode === "promote") {
    const { draftNote } = await import("../../src/promote.ts");
    const draft = draftNote({ id: "a".repeat(32), project: "x", kind: "decision", title: "Synthetic", text: "Synthetic decision text for the fixture.", about: [], at: INSTANT.toISOString() }, {});
    out.promoted_at = draft.frontmatter.promoted_at;
  } else if (mode === "skills") {
    const path = vault("personal");
    addVault(home, { id: "personal", path, kind: "personal", write: "mcp" });
    const { mineSkills } = await import("../../src/skills-mine.ts");
    const result = await mineSkills(home, { vault: "personal", env: { ...env, AMEM_HOME: join(root, "no-memory") } });
    out.reportDate = /^# Skill Candidates \((\d{4}-\d{2}-\d{2})/.exec(result.report)?.[1] ?? null;
  } else throw new Error("unknown case");
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(JSON.stringify(out));
