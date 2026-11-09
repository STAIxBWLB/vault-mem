import { expect, test } from "bun:test";
import { resolveLinks } from "../src/links.ts";
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
  "Setext title\n===\n\nPreserved prose.",
  "First heading line\nSecond heading line\n---\n\nPreserved prose.",
  "- list item\n---\n\nList prose.",
  "1. ordered item\n---\n\nList prose.",
  "> quoted item\n---\n\nQuoted prose.",
  "    indented code\n---\n\nCode prose.",
  "\tindented code\n---\n\nCode prose.",
  "`inline code`\n---\n\nCode prose.",
  "Paragraph with `inline code`\n---\n\nCode prose.",
  "- list item\n\n  continuation\n---\n\nList prose.",
  "1. ordered item\n\n   continuation\n---\n\nList prose.",
  "Heading first line  \nHeading second line\n---",
]) test(`merge leaves Setext text byte-unchanged: ${JSON.stringify(fragment.split("\n")[0])}`, () => {
  expect(mergeBody("# Absorb Finding\n\n" + fragment)).toContain(fragment);
});

for (const newline of ["\n", "\r\n"]) test(`a leading multiline Setext H1 is retained (${JSON.stringify(newline)})`, () => {
  const original = ["Absorb title first line", "Absorb title second line", "===", "", "Preserved absorbed paragraph."].join(newline);
  expect(mergeBody(original)).toContain(original);
});

test("merge removes exactly the first nonblank leading ATX H1 and demotes a later H1", () => {
  const body = mergeBody("\n \n# Absorb Finding\n\nPreserved absorbed paragraph.\n\n# Later Heading\n\nLater prose.");
  expect(body).not.toMatch(/^# Absorb Finding$/m);
  expect(body).not.toContain("Absorb Finding");
  expect(body).toContain("Preserved absorbed paragraph.");
  expect(body).toContain("## Later Heading\n\nLater prose.");
  expect(body).toContain("# Keep Finding");
  expect(body).toContain("## Merged from [[absorb]]");
});

test("a later H1 after prose is demoted rather than removed", () => {
  const body = mergeBody("Introductory prose comes first.\n\n# Absorb Finding\n\nAbsorbed prose.");
  expect(body).toContain("Introductory prose comes first.");
  expect(body).toContain("## Absorb Finding\n\nAbsorbed prose.");
});

for (const indent of ["", "   "]) test(`merge preserves a conservative raw HTML block with ${indent.length}-space indentation`, () => {
  const raw = `${indent}<div>\n# raw HTML text\n</div>`;
  const body = mergeBody("# Absorb Finding\n\n" + raw + "\n\n## Visible Section\n\nVisible prose.");
  expect(body).toContain(raw);
  expect(body).toContain("### Visible Section\n\nVisible prose.");
});

test("a raw HTML block ends only at the next blank line and prevents dropping a later H1", () => {
  const raw = "<div>\n# raw HTML text\n</div>\n## Still raw";
  const body = mergeBody(raw + "\n\n# Later Heading\n\nLater prose.");
  expect(body).toContain(raw);
  expect(body).toContain("## Later Heading\n\nLater prose.");
});

for (const raw of ["```md\n# Code heading\n## Code section\n```", "`inline code\n# Inline-code heading\n`", "    # Indented code heading", "\t# Tab code heading"]) test(`merge preserves code ATX text: ${JSON.stringify(raw.split("\n")[0])}`, () => {
  const body = mergeBody(raw + "\n\n# Later Heading\n\nLater prose.");
  expect(body).toContain(raw);
  expect(body).toContain("## Later Heading\n\nLater prose.");
});

test("visible ATX headings demote one level while H6 stays H6", () => {
  const body = mergeBody("# Absorb Finding\n\n## Evidence\n\n### Detail\n\n###### Deep\n\nProse.");
  expect(body).toContain("### Evidence"); expect(body).toContain("#### Detail");
  expect(body).toContain("###### Deep"); expect(body).not.toContain("####### Deep");
});

test("default reader Setext anchor behavior remains unchanged", () => {
  const links = resolveLinks([
    { path: "absorb.md", title: "Absorb", aliases: [], body: "First heading line\nSecond heading line\n---" },
    { path: "ref.md", title: "Ref", aliases: [], body: "[[absorb#Second heading line]] [[absorb#First heading line Second heading line]]" },
  ]).filter(link => link.source === "ref.md");
  expect(links[0]).toMatchObject({ resolved: "absorb.md", reason: null });
  expect(links[1]).toMatchObject({ resolved: null, reason: "missing-heading" });
});
