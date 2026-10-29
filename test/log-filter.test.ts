import { expect, test } from "bun:test";
import { compileLogFilter } from "../src/log-filter.ts";
test("bounded grep subset matches ordinary regex semantics without backtracking", () => {
  for (const pattern of ["", "EXTRACT|CONNECT", "^EXTRACT$", "^a+$", "a*b?c", "[a-z]+", "[^a]+$", "\\d+\\s\\w?", "가+", "a\\|b", "a.*z", "^$", "^a|b$"]) {
    const match = compileLogFilter(pattern), reference = new RegExp(pattern, "u");
    for (const text of ["", "EXTRACT", "CONNECT", "X EXTRACT Y", "aaabc", "abc", "123 a", "가가", "a|b", "a to z", "ab", "b", "a\nb"]) expect(match(text)).toBe(reference.test(text));
  }
});
test("unsafe/unsupported groups, backreferences and invalid syntax are refused", () => {
  for (const pattern of ["(a+)+$", "(a)\\1", "a{1,3}", "(?=a)", "[", "a**", "\\bword", "a".repeat(257)]) expect(() => compileLogFilter(pattern)).toThrow();
  expect(compileLogFilter("a*a*a*a*a*b$")("a".repeat(4090) + "!")).toBe(false);
});
