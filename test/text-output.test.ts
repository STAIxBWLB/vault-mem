import { expect, test } from "bun:test";
import { fields, issueTable, outputWidth, paint, PLAIN, resolveColor, shellWord, table, takeColorFlag, textOptions, tone, wrap } from "../src/text-output.ts";
import { run } from "../src/cli.ts";

test("#114 AC2: --color is taken once from anywhere before --, and auto follows the TTY, NO_COLOR and TERM", () => {
  expect(takeColorFlag(["status", "--color=never", "--json"])).toEqual({ args: ["status", "--json"], color: "never" });
  expect(takeColorFlag(["show", "v", "--", "--color=always"])).toEqual({ args: ["show", "v", "--", "--color=always"] });
  expect(() => takeColorFlag(["status", "--color"])).toThrow("--color=auto");
  expect(() => takeColorFlag(["status", "--color=never", "--color=always"])).toThrow("given once");
  expect(resolveColor("always", { isTTY: false })).toBe(true);
  expect(resolveColor("never", { isTTY: true })).toBe(false);
  expect(resolveColor(undefined, { isTTY: true })).toBe(true);
  expect(resolveColor("auto", { isTTY: true, NO_COLOR: "1" })).toBe(false);
  expect(resolveColor(undefined, { isTTY: true, TERM: "dumb" })).toBe(false);
  expect(resolveColor(undefined, { isTTY: false })).toBe(false);
  expect(() => resolveColor("sometimes", { isTTY: true })).toThrow("--color=auto");
  expect(textOptions("always", {}, { isTTY: false })).toEqual({ color: true });
  expect(outputWidth({ isTTY: true, columns: 60 })).toBe(80);
  expect(outputWidth({ isTTY: false, COLUMNS: "100" })).toBe(100);
  expect(outputWidth({ isTTY: false })).toBeUndefined();
  expect(() => run(["--version", "--color=sometimes"])).toThrow("--color=auto");
});

test("tables size columns by display width, wrap the last column only when a width is known, and strip control characters", () => {
  const rows = [["사업단", "ok", "한글 제목"], ["notes/a.md", tone("fail", "fail"), "x\u001b[31my"]];
  expect(table(["PATH", "LEVEL", "TITLE"], rows, PLAIN)).toBe(["PATH        LEVEL  TITLE", "사업단      ok     한글 제목", "notes/a.md  fail   x [31my"].join("\n"));
  const wrapped = table(["A", "B"], [["x", "one two three four five six"]], { color: false, columns: 23 }).split("\n");
  expect(wrapped).toEqual(["A  B", "x  one two three four", "   five six"]);
  expect(paint("ok", "ok", { color: true })).toBe("\u001b[32mok\u001b[0m");
  expect(table(["A"], [[tone("ok", "ok")]], { color: true })).toContain("\u001b[32mok\u001b[0m");
});

test("fields align labels, skip empty values and hang wrapped values; issues sort errors first", () => {
  expect(fields([["vault", "personal"], ["remote", ""], ["write policy", "mcp"]], PLAIN)).toBe("  vault         personal\n  write policy  mcp");
  expect(fields([["note", "alpha beta gamma delta"]], { color: false, columns: 20 })).toBe("  note  alpha beta\n        gamma delta");
  expect(wrap("abcdefghijklmnop", 10)).toEqual(["abcdefghij", "klmnop"]);
  expect(issueTable([{ code: "V02", severity: "warning", message: "w" }, { code: "V01", severity: "error", path: "notes/a.md", message: "e" }], PLAIN))
    .toBe(["LEVEL    CODE  PATH        MESSAGE", "error    V01   notes/a.md  e", "warning  V02   -           w"].join("\n"));
  expect(issueTable([], PLAIN)).toBeUndefined();
  expect(shellWord("notes/a.md")).toBe("notes/a.md");
  expect(shellWord("it's here")).toBe(`'it'"'"'s here'`);
});
