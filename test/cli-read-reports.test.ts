import { terminalText } from "@staix/cli-output";
import { expect, test } from "bun:test";
import { lintDetails } from "../src/vault-lint.ts";
import { analysisCorpus } from "./fixtures/analysis-corpus.ts";
import { lintText, searchText, showText } from "../src/read-output.ts";
import { renderMineText, type MineResult } from "../src/skills-mine.ts";
import { renderBrief } from "../src/vault-brief.ts";
import { cellWidth as width } from "@staix/cli-output";

const plain = { color: false, ascii: true, columns: 80 };
test("read and analysis reports retain content, ASCII layout and semantic color", () => {
  const hits = [{ path: "synthetic.md", title: "Synthetic title", description: "", type: "method", domain: "", score: 1, snippet: "synthetic excerpt" }];
  const context = { vault: "demo", query: "synthetic", limit: 2 };
  const expected = [" vmem search", "", "> Results", "  Vault:    demo", "  Query:    synthetic", "  Results:  1", "  -  synthetic.md: Synthetic title (method)", "  synthetic excerpt"].join("\n");
  expect(searchText(hits, plain, context)).toBe(expected);
  const colored = searchText(hits, { ...plain, color: true }, context);
  expect(terminalText(colored)).toBe(expected);
  expect(colored).not.toBe(expected);
  const details = lintDetails(analysisCorpus());
  const original = JSON.stringify(details.report);
  const lint = lintText(details, plain, { vault: "demo" });
  expect(JSON.stringify(details.report)).toBe(original);
  expect(lint).not.toContain(details.report.summary);
  expect(lint).not.toContain("`");
  expect(details.report.markdown).toContain("`");
  expect(JSON.stringify(details.report)).toContain("`");
  for (const finding of Object.values(details.report.findings).flat()) expect(lint.replace(/\s+/g, " ")).toContain(finding.replaceAll("`", "").replace(/\s+/g, " "));
  expect(lint.split("\n").at(-1)).toContain("failed");
  const note = "# Synthetic\n\nBody line.\n## Heading\nMore.";
  const show = showText({ path: "synthetic.md", hash: "abcdef0123456789", content: note, truncated: false }, plain, { vault: "demo", target: "synthetic" });
  expect(show.endsWith(note)).toBe(true);
  for (const text of [expected, lint, show]) for (const line of text.split("\n")) if (!line.trimStart().startsWith("->") && !line.startsWith("#") && !line.startsWith("Body")) expect(width(line)).toBeLessThanOrEqual(80);
});

test("brief preserves byte cap including color and only reports omitted matches when nonzero", () => {
  const empty = { vault: "demo", lines: [], omitted: 0, bytes: 0 };
  expect(renderBrief(empty, plain, 256)).not.toContain("omitted");
  const large = { ...empty, lines: ["notes/a.md | " + "a".repeat(180), "notes/b.md | " + "b".repeat(180)] };
  const text = renderBrief(large, { ...plain, color: true }, 256);
  expect(Buffer.byteLength(text) + 1).toBeLessThanOrEqual(256);
  expect(terminalText(text)).toContain("matches omitted");
});


test("skills mine human report has ASCII and color without changing Markdown", () => {
  const result: MineResult = { vault: "demo", days: 30, since: "2026-01-01", projects: [], records: { curated: 0, capture: 0, vault: 0 }, dropped: { synthetic: 0, overCap: 0, secret: 0, policy: 0, oversized: 0, duplicate: 0, unreadable: 0, truncatedCapture: 0, malformedRecord: 0, recordOutsideWindow: 0, recordOutsideCapped: 0, recordOutsideUnavailable: 0 }, graph: { nodes: 0, edges: 0, communities: 0, partitioner: "leiden" }, godNodes: [], candidates: [], rejected: { below3: 0, detailed: [] }, surprising: [], report: "# Original Markdown\n" };
  const text = renderMineText(result, plain), colored = renderMineText(result, { ...plain, color: true });
  expect(text).toContain("> Candidates");
  expect(text).not.toContain("# Original Markdown");
  expect(result.report).toBe("# Original Markdown\n");
  expect(terminalText(colored)).toBe(text);
  expect(colored).not.toBe(text);
  for (const line of text.split("\n")) expect(width(line)).toBeLessThanOrEqual(80);
});
