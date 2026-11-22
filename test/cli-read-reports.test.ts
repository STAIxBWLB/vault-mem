import { expect, test } from "bun:test";
import { lintDetails } from "../src/vault-lint.ts";
import { analysisCorpus } from "./fixtures/analysis-corpus.ts";
import { lintText, searchText, showText } from "../src/read-output.ts";
import { renderBrief } from "../src/vault-brief.ts";
import { stripTerminal, width } from "../src/text-output.ts";

const plain = { color: false, ascii: true, columns: 80 };
test("read and analysis reports retain content, ASCII layout and semantic color", () => {
  const hits = [{ path: "synthetic.md", title: "Synthetic title", description: "", type: "method", domain: "", score: 1, snippet: "synthetic excerpt" }];
  const context = { vault: "demo", query: "synthetic", limit: 2 };
  const expected = [" vmem search", "", "> Results", "  Vault:    demo", "  Query:    synthetic", "  Results:  1", "  -  synthetic.md: Synthetic title (method)", "  synthetic excerpt"].join("\n");
  expect(searchText(hits, plain, context)).toBe(expected);
  expect(stripTerminal(searchText(hits, { ...plain, color: true }, context))).toBe(expected);
  const details = lintDetails(analysisCorpus());
  const lint = lintText(details, plain, { vault: "demo" });
  expect(lint).not.toContain(details.report.summary);
  for (const finding of Object.values(details.report.findings).flat()) expect(lint.replace(/\s+/g, " ")).toContain(finding.replace(/\s+/g, " "));
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
  expect(stripTerminal(text)).toContain("matches omitted");
});
