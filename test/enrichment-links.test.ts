import { expect, test } from "bun:test";
import type { AnalysisSnapshot } from "../src/analysis-types.ts";
import { buildGraph, malformedInferredAnnotation } from "../src/vault-graph.ts";
import { parseProposalOperation, proposalPayloadDigest } from "../src/proposals.ts";
import { validateWrite } from "../src/write-validation.ts";
import { explainGraphPath } from "../src/graph-evidence.ts";

const note = (body: string) => `---\ntype: insight\ndomain: research\ndescription: synthetic\ntopics: []\n---\n${body}`;
const snapshot = (a: string, b = ""): AnalysisSnapshot => ({ notes: [{ path: "a.md", source: note(a) }, { path: "b.md", source: note(b) }], today: "", logPath: "", log: null, registryIds: null, reports: {} });
const tag = (a: string, b = "") => buildGraph(snapshot(a, b)).edges[0]?.confidence_tag;

test("inferred declarations survive graph rebuild and extracted occurrences take precedence", () => {
  const line = "- [[b]] <!-- vmem:inferred -->";
  expect(tag(line)).toBe("INFERRED");
  expect(explainGraphPath(snapshot(line), "a", "b").hops[0]?.edge.confidence_tag).toBe("INFERRED");
  expect(tag(line, "[[a]]")).toBe("EXTRACTED");
  expect(tag(`${line}\n[[b]]`)).toBe("EXTRACTED");
  expect(tag(`${line}\n\`\`\`\n${line}\n\`\`\``)).toBe("EXTRACTED");
  expect(tag("[[b]]")).toBe("EXTRACTED");
});

test("writer rejects malformed markers in prospective notes", () => {
  const vault = { id: "synthetic", path: "/synthetic", kind: "personal" as const, write: "mcp" as const };
  const after = note("[[b]] <!-- vmem:inferred -->");
  const issues = validateWrite([{ path: "notes/a.md", before: null, after }], { vault, config: { vaults: [vault] }, notes: new Map(), operation: { op: "create", path: "notes/a.md", frontmatter: {} } });
  expect(issues.some(issue => issue.code === "V01" && issue.message.includes("malformed inferred"))).toBe(true);
  const before = after, context = { vault, config: { vaults: [vault] }, notes: new Map([["notes/a.md", before]]), operation: { op: "patch" as const, path: "notes/a.md", edits: [{ oldString: "synthetic", newString: "updated" }] } };
  const retained = validateWrite([{ path: "notes/a.md", before, after: before.replace("synthetic", "updated") }], context).filter(issue => issue.message.includes("malformed inferred"));
  expect(retained.map(issue => issue.severity)).toEqual(["warning"]);
  const duplicate = validateWrite([{ path: "notes/a.md", before, after: `${before}\n[[b]] <!-- vmem:inferred -->` }], context).filter(issue => issue.message.includes("malformed inferred"));
  expect(duplicate.map(issue => issue.severity)).toEqual(["warning", "error"]);
});

test("annotation accepts only one visible standalone canonical line", () => {
  expect(malformedInferredAnnotation(note("- [[b]] <!-- vmem:inferred -->"))).toBe(false);
  for (const body of ["[[b]] <!-- vmem:inferred -->", "- [[b|label]] <!-- vmem:inferred -->", "- [[b]] <!-- vmem:inferred --> extra", "- [[B]] <!-- vmem:inferred -->", "```\n- [[b]] <!-- vmem:inferred -->\n```", "`- [[b]] <!-- vmem:inferred -->`", "- [[b]] <!-- vmem:inferred --> <!-- vmem:inferred -->"]) {
    expect(malformedInferredAnnotation(note(body))).toBe(true);
  }
  expect(malformedInferredAnnotation("---\ndescription: vmem:inferred\n---\n")).toBe(true);
});

test("annotation remains bound to the existing exact patch proposal digest", () => {
  const operation = parseProposalOperation({ op: "patch", path: "a", expectedSha: "a".repeat(64), edits: [{ oldString: "## Topics", newString: "- [[b]] <!-- vmem:inferred -->\n\n## Topics" }] });
  expect(operation.path).toBe("notes/a.md");
  expect(proposalPayloadDigest(operation)).not.toBe(proposalPayloadDigest(parseProposalOperation({ ...operation, edits: [{ oldString: "## Topics", newString: "- [[c]] <!-- vmem:inferred -->\n\n## Topics" }] })));
});
