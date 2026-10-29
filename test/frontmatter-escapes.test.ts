import { expect, test } from "bun:test";
import { emitFrontmatter, parseFrontmatter } from "../src/frontmatter.ts";

test("YAML hexadecimal Unicode escapes decode in scalars, sequences, maps and quoted keys without changing source",()=>{
  const source=String.raw`---
"\u0074itle": "\uD55C\uAE00 \U0001F680 \x41"
description: "\u00E9clair"
items: ["\x42", {"\u006bey": "\U0001F30D"}]
---
Synthetic body.
`;
  const parsed=parseFrontmatter(source);
  expect(parsed.data).toEqual({title:"한글 🚀 A",description:"éclair",items:["B",{key:"🌍"}]});
  expect(emitFrontmatter(parsed)).toBe(source);
  expect(emitFrontmatter(parsed,{title:"한글 🚀 A"})).toBe(source);
  const changed=emitFrontmatter(parsed,{title:"제주 🌋",items:["한글","éclair"]});
  expect(changed).toContain('"title": "제주 🌋"');
  expect(changed).toContain('"items": ["한글","éclair"]');
  expect(changed).toContain(String.raw`description: "\u00E9clair"`);
  expect(changed).not.toContain(String.raw`"title": "\u`);
  expect(parseFrontmatter(changed).data.title).toBe("제주 🌋");
});

test("all standard YAML double-quoted short escapes have PyYAML-compatible semantics",()=>{
  const source=String.raw`---
value: "\0\a\b\t\n\v\f\r\e\ \"\/\\\N\_\L\P"
tab: "a\	b"
---
`;
  const parsed=parseFrontmatter(source);
  expect(parsed.data.value).toBe('\0\x07\b\t\n\v\f\r\x1b "/\\   ');
  expect(parsed.data.tab).toBe("a\tb");
  expect(emitFrontmatter(parsed)).toBe(source);
});

test("escaped newlines and ordinary folded lines preserve raw LF and CRLF byte-for-byte",()=>{
  const cases:[string,string][]=[
    ['value: "first\\\n  second"\n',"firstsecond"],
    ['value: "first\\\n\n  second"\n',"first\nsecond"],
    ['value: "first\n  second"\n',"first second"],
    ['value: "first  \n\n\n  second"\n',"first\n\nsecond"],
    ['value: "first\\\r\n  second"\r\n',"firstsecond"],
  ];
  for(const [yaml,expected] of cases) {
    const newline=yaml.includes("\r\n") ? "\r\n" : "\n",source="---"+newline+yaml+"---"+newline+"Body";
    const parsed=parseFrontmatter(source);expect(parsed.data.value).toBe(expected);
    expect(Buffer.from(emitFrontmatter(parsed))).toEqual(Buffer.from(source));
  }
});

test("single quotes, plain text, comments and literal/folded blocks do not interpret backslashes",()=>{
  const source=String.raw`---
single: '\uD55C'
plain: prefix "quoted \uD55C"
multiline: a plain
  "continuation \uD55C"
literal: |
  "\uD55C"
folded: >-
  "\uD55C"
metadata:
  - literal: |
      "\uD55C"
    actual: "\uD55C"
alias: &quoted "\uD55C"
copy: *quoted
# "\uD55C" is only a comment
---
`;
  const parsed=parseFrontmatter(source);
  expect(parsed.data.single).toBe(String.raw`\uD55C`);
  expect(parsed.data.plain).toBe(String.raw`prefix "quoted \uD55C"`);
  expect(parsed.data.multiline).toBe(String.raw`a plain "continuation \uD55C"`);
  expect(parsed.data.literal).toBe(String.raw`"\uD55C"`+"\n");
  expect(parsed.data.folded).toBe(String.raw`"\uD55C"`);
  expect(parsed.data.metadata).toEqual([{literal:String.raw`"\uD55C"`+"\n",actual:"한"}]);
  expect(parsed.data.alias).toBe("한");expect(parsed.data.copy).toBe("한");
  expect(emitFrontmatter(parsed)).toBe(source);
});

test("escaped slashes, escaped backslashes and escaped quotes decode exactly once",()=>{
  const source=String.raw`---
url: "https:\/\/example.test\/한글"
text: "literal \\uD55C and \"quoted\""
---
`;
  const parsed=parseFrontmatter(source);
  expect(parsed.data.url).toBe("https://example.test/한글");
  expect(parsed.data.text).toBe(String.raw`literal \uD55C and "quoted"`);
  expect(emitFrontmatter(parsed)).toBe(source);
});

test("bad escapes, out-of-range Unicode and decoded duplicate keys are refused without revealing contents",()=>{
  for(const yaml of [String.raw`value: "\q private"`,String.raw`value: "\u123"`,String.raw`value: "\xG0"`,String.raw`value: "\U00110000"`,String.raw`title: one
"\u0074itle": two`]) {
    expect(()=>parseFrontmatter(`---\n${yaml}\n---\n`)).toThrow("frontmatter:");
  }
});
