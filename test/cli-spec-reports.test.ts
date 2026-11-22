import { terminalText } from "@staix/cli-output";
import { expect, test } from "bun:test";
import { offsetCommand, renderSpecGet, renderSpecValidate, type SpecGetResult, type SpecValidateResult } from "../src/spec-output.ts";
import { cellWidth as width } from "@staix/cli-output";

const plain = { color: false, ascii: true, columns: 80 };
test("spec validation uses section colors, problems first and one summary", () => {
  const input: SpecValidateResult = { source: "demo", ok: false, errors: 1, warnings: 0, truncated: false, items: [{ code: "missing", severity: "error", path: "SPEC.md", message: "synthetic finding" }], diagnostics: [{ code: "skipped_path", path: "skip.md", message: "skipped" }], freshness: [] };
  const expected = [" vmem spec validate", "", "> Findings", "  x  missing: SPEC.md: synthetic finding", "", "> Discovery", "  -  skipped_path: skip.md: skipped", "", "> Scope", "  Source:  demo", "", "x 1 failed"].join("\n");
  const text = renderSpecValidate(input, plain, { args: ["validate"], values: {} });
  const color = renderSpecValidate(input, { ...plain, color: true }, { args: ["validate"], values: {} });
  expect(text).toBe(expected); expect(terminalText(color)).toBe(expected); expect(color).not.toBe(expected);
  for (const line of text.split("\n")) expect(width(line)).toBeLessThanOrEqual(80);
});
test("spec body remains intact and offset stays before a query separator", () => {
  const body = "# Synthetic\n\n## Scope\nBody line.";
  const input: SpecGetResult = { source: "demo", worktree: "/fixture", id: "root", path: "SPEC.md", sha256: "a", frontmatter: { title: "Root" }, links: [], backlinks: [], children: [], freshness: null, freshnessIssues: [], truncated: false, totals: { links: 0, backlinks: 0, children: 0 }, body };
  const text = renderSpecGet(input, plain, { args: ["get", "root", "--body"], values: {} });
  expect(text.endsWith(body)).toBe(true);
  expect(offsetCommand(["grep", "--literal", "--offset", "2", "--", "a b"], 4)).toBe("vmem spec grep --literal --offset 4 -- 'a b'");
});
