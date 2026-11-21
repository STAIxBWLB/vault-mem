import { expect, test } from "bun:test";
import type { AnalysisSnapshot } from "../src/analysis-types.ts";
import { buildGraph } from "../src/vault-graph.ts";
import { validateWrite } from "../src/write-validation.ts";
import { explainGraphPath } from "../src/graph-evidence.ts";
import { lintVault } from "../src/vault-lint.ts";

const note = (body: string, inferred = "[]") => `---\ntype: insight\ndomain: research\ndescription: synthetic\ntopics: []\ninferred_links: ${inferred}\n---\n${body}`;
const snapshot = (a: string, b = note("")): AnalysisSnapshot => ({ notes: [{ path: "a.md", source: a }, { path: "b.md", source: b }], today: "2026-01-01", logPath: "log.md", log: "", registryIds: null, reports: {} });
const tag = (a: string, b?: string) => buildGraph(snapshot(a, b)).edges[0]?.confidence_tag;

test("plain body links use their source's inferred list and inferred occurrences take precedence", () => {
  const inferred = note("[[b]]", "[b]");
  expect(tag(inferred)).toBe("INFERRED");
  expect(explainGraphPath(snapshot(inferred), "a", "b").hops[0]?.edge.confidence_tag).toBe("INFERRED");
  expect(tag(note("[[b]]"))).toBe("EXTRACTED");
  expect(tag(note("```\n[[b]]\n```", "[b]"))).toBe("EXTRACTED");
  expect(tag(note("`[[b]]`", "[b]"))).toBe("EXTRACTED");
  expect(tag(inferred, note("[[a]]"))).toBe("INFERRED");
  expect(tag(note("[[b]]\n`[[b]]`", "[b]"))).toBe("INFERRED");
  expect(tag(note("[[b]]", "[B]"))).toBe("EXTRACTED");
  expect(tag(note("[[b]]", '["[[b]]"]'))).toBe("EXTRACTED");
});

test("orphan inferred list entries are lint warnings, not write refusals", () => {
  const after = note("no link", "[b]");
  expect(lintVault(snapshot(after)).findings.L19).toHaveLength(1);
  expect(lintVault(snapshot(note("[[b]]", "[b]"))).findings.L19).toHaveLength(0);
  expect(lintVault(snapshot(note("```\n[[b]]\n```\n`[[b]]`", "[b]"))).findings.L19).toHaveLength(1);
  const vault = { id: "synthetic", path: "/synthetic", kind: "personal" as const, write: "mcp" as const };
  const issues = validateWrite([{ path: "notes/a.md", before: null, after }], { vault, config: { vaults: [vault] }, notes: new Map(), operation: { op: "create", path: "notes/a.md", frontmatter: {} } });
  expect(issues.some(issue => issue.message.includes("inferred"))).toBe(false);
});

test("marker mentions in prose and code do not cause write refusals", () => {
  const after = note("<!-- vmem:inferred -->\n```\n- [[B]] <!-- vmem:inferred -->\n```\n`<!-- vmem:inferred -->`");
  const vault = { id: "synthetic", path: "/synthetic", kind: "personal" as const, write: "mcp" as const };
  const issues = validateWrite([{ path: "notes/a.md", before: null, after }], { vault, config: { vaults: [vault] }, notes: new Map(), operation: { op: "create", path: "notes/a.md", frontmatter: {} } });
  expect(issues.some(issue => issue.message.includes("inferred"))).toBe(false);
});

test("inferred_links schema accepts bounded canonical stems", () => {
  const vault = { id: "synthetic", path: "/synthetic", kind: "personal" as const, write: "mcp" as const };
  const check = (after: string) => validateWrite([{ path: "notes/a.md", before: null, after }], { vault, config: { vaults: [vault] }, notes: new Map(), operation: { op: "create", path: "notes/a.md", frontmatter: {} } }).filter(issue => issue.code === "V01" && issue.message.includes("inferred_links"));
  expect(check(note("", "[b]"))).toHaveLength(0);
  for (const value of ["b", "[B]", '["[[b]]"]', `[${Array(1001).fill("b").join(", ")}]`]) expect(check(note("", value))).toHaveLength(1);
  expect(Object.hasOwn(lintVault(snapshot(note("").replace("inferred_links: []\n", ""), note("").replace("inferred_links: []\n", ""))).findings, "L19")).toBe(false);
});
