import { expect, test } from "bun:test";
import { anchorIndex } from "../src/links.ts";
import { planMerge } from "../src/write-operations.ts";

function note(title: string, body: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: Synthetic merge heading evidence.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\n---\n${body}\n\n## Topics\n\n- [[research]]\n`;
}
function mergeBody(absorb: string): string {
  return planMerge({ op: "merge", keep: "keep", absorb: "absorb" }, new Map([
    ["notes/keep.md", note("Keep Finding", "# Keep Finding\n\nKeep prose.")],
    ["notes/absorb.md", note("Absorb Finding", absorb)],
    ["notes/research.md", "---\ntype: moc\ndescription: Synthetic directory.\n---\n# Research\n"],
  ])).preview.body;
}

for (const fragment of [
  "- list item\n---\n\nList prose.",
  "1. ordered item\n---\n\nList prose.",
  "> quoted item\n---\n\nQuoted prose.",
  "    indented code\n---\n\nCode prose.",
  "\tindented code\n---\n\nCode prose.",
  "`inline code`\n---\n\nCode prose.",
  "Paragraph with `inline code`\n---\n\nCode prose.",
  "- list item\nlazy continuation\n---\n\nList prose.",
  "- list item\n\n  continuation\n---\n\nList prose.",
  "1. ordered item\n\n   continuation\n---\n\nList prose.",
  "```md\nFenced code\n---\n```\n\nCode prose.",
]) test(`merge leaves a non-paragraph Setext candidate unchanged: ${JSON.stringify(fragment.split("\n")[0])}`, () => {
  const body = mergeBody("# Absorb Finding\n\n" + fragment);
  expect(body).toContain(fragment);
  expect(body).not.toContain("### - list item");
  expect(body).not.toContain("### indented code");
  expect(body).not.toContain("### lazy continuation");
});

for (const marker of ["- list item", "1. ordered item", "> quote"]) test(`merge does not reset container ambiguity at an indented ATX heading after ${marker}`, () => {
  const indentation = marker.startsWith("1.") ? "   " : "  ";
  const original = `${marker}\n\n${indentation}## Nested heading\n\n${indentation}continuation\n---`;
  const body = mergeBody("# Absorb Finding\n\n" + original);
  expect(body).toContain(`${indentation}continuation\n---`);
  expect(body).not.toContain("### continuation");
  expect(anchorIndex(original, true).headings.has("continuation")).toBe(false);
});

for (const marker of ["- list item", "1. ordered item", "> quote"]) test(`merge recognizes a clearly exited top-level Setext paragraph after ${marker}`, () => {
  const original = `${marker}\n\nTop-level first line\nTop-level second line\n---`;
  const body = mergeBody("# Absorb Finding\n\n" + original);
  expect(body).toContain("### Top-level first line Top-level second line");
  expect(anchorIndex(original, true).headings.has("top-level first line top-level second line")).toBe(true);
});

test("a block heading outside list content indentation exits the list before a following Setext paragraph", () => {
  const original = "- item\n\n ## Boundary\nEvidence\n---\n\nSelf [[#Evidence]].";
  const body = mergeBody("# Absorb Finding\n\n" + original);
  expect(body).toContain("### Evidence");
  const absorbed = anchorIndex(original, true), kept = anchorIndex("# Keep Finding\n\n## Evidence\n\nKeep self [[#Evidence]].", true);
  expect(absorbed.headings.has("evidence")).toBe(true);
  expect([...absorbed.headings].filter(heading => kept.headings.has(heading))).toEqual(["evidence"]);
});

test("a paragraph following a container ATX can exit without a blank when below its content indentation", () => {
  const original = "- item\n\n  ## Nested heading\nEvidence\n---";
  expect(mergeBody("# Absorb Finding\n\n" + original)).toContain("### Evidence");
  expect(anchorIndex(original, true).headings.has("evidence")).toBe(true);
});

for (const newline of ["\n", "\r\n"]) test(`merge demotes an entire multiline Setext paragraph to one heading (${JSON.stringify(newline)})`, () => {
  const original = ["# Absorb Finding", "", "First heading line", "Second heading line", "---", "", "Preserved prose.", ""].join(newline);
  const body = mergeBody(original);
  expect(body).toContain(`### First heading line Second heading line${newline}`);
  expect(body).not.toContain(`First heading line${newline}### Second heading line`);
  expect(body).toContain(`Preserved prose.${newline}`);
  expect(anchorIndex(original, true).headings.has("first heading line second heading line")).toBe(true);
  expect(anchorIndex(body, true).headings.has("first heading line second heading line")).toBe(true);
  expect(anchorIndex(body, true).headings.has("second heading line")).toBe(false);
});

test("merge drops the entire first multiline Setext H1 while preserving following prose", () => {
  const body = mergeBody("Absorb title first line\nAbsorb title second line\n===\n\nPreserved absorbed paragraph.");
  expect(body).not.toContain("Absorb title first line"); expect(body).not.toContain("Absorb title second line");
  expect(body).toContain("Preserved absorbed paragraph.");
  expect(body).toContain("# Keep Finding");
  expect(body).toContain("## Merged from [[absorb]]");
});

test("merge leaves ambiguous hard-break Setext paragraphs unchanged", () => {
  const paragraph = "Heading first line  \nHeading second line\n---";
  expect(mergeBody("# Absorb Finding\n\n" + paragraph)).toContain(paragraph);
  expect(anchorIndex(paragraph, true).headings.size).toBe(0);
});

test("merge collision anchors use full Setext paragraphs without changing default reader anchor behavior", () => {
  const paragraph = "First heading line\nSecond heading line\n---";
  expect(anchorIndex(paragraph, true).headings).toEqual(new Set(["first heading line second heading line"]));
  expect(anchorIndex(paragraph).headings).toEqual(new Set(["second heading line"]));
  for (const body of ["- list item\n---", "> quote\n---", "    code\n---", "`inline code`\n---"]) expect(anchorIndex(body, true).headings.size).toBe(0);
  expect(anchorIndex("- list item\n---").headings).toEqual(new Set(["- list item"]));
});
