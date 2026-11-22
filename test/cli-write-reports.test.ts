import { expect, test } from "bun:test";
import { renderPromote, renderWriteReceipt } from "../src/write-output.ts";
import { stripTerminal, width } from "../src/text-output.ts";
import type { WriteReceipt } from "../src/write-types.ts";
import type { PromoteResult } from "../src/promote.ts";

const plain = { color: false, ascii: true, columns: 80 };
const context = { argv: ["move", "demo", "old", "new"], positional: ["demo", "old", "new"] };
test("write preview has ASCII and color goldens, problems first, and a complete confirmation", () => {
  const receipt: WriteReceipt = { ok: true, applied: false, preview: true, indexUpdated: false, fingerprint: "f".repeat(64), issues: [{ code: "W01", severity: "warning", message: "synthetic warning" }], changes: [{ path: "notes/old.md", beforeSha: "a", sha256: null, bytes: 0 }, { path: "notes/new.md", beforeSha: null, sha256: "b", bytes: 10 }] };
  const expected = [" vmem move", "", "> Problems", "  !  W01: synthetic warning", "", "> Result", "  ~  dry run: would move notes/old.md to notes/new.md", "", "> Changes", "  -  notes/old.md: delete, 0 bytes, sha256 -", "  -  notes/new.md: create, 10 bytes, sha256 b", "", "> Log", "  written on confirm", `    -> vmem move demo old new --confirm --fingerprint ${"f".repeat(64)}`].join("\n");
  const text = renderWriteReceipt(receipt, plain, context), color = renderWriteReceipt(receipt, { ...plain, color: true }, context);
  expect(text).toBe(expected); expect(stripTerminal(color)).toBe(expected); expect(color).not.toBe(expected);
  for (const line of text.split("\n")) if (!line.trimStart().startsWith("->")) expect(width(line)).toBeLessThanOrEqual(80);
});
test("check has one summary and an edited preview does not invent a confirmation path", () => {
  const check: WriteReceipt = { ok: false, applied: false, indexUpdated: false, issues: [{ code: "V01", severity: "error", message: "invalid" }], changes: [] };
  const text = renderWriteReceipt(check, plain, { argv: ["check", "demo", "-"], positional: ["demo", "-"] });
  expect(text.split("\n").at(-1)).toBe("x 1 failed"); expect(text).not.toContain("fail: the note has");
  const promotion: PromoteResult = { ok: true, action: "create", applied: false, preview: true, id: "0".repeat(32), path: "notes/new.md", text: "synthetic draft", fingerprint: "f".repeat(64), issues: [], linked: null };
  const edited = renderPromote(promotion, plain, { argv: ["promote-from-amem", "demo", "0".repeat(32), "--edit"], positional: ["demo", "0".repeat(32)] }, true);
  expect(edited).not.toContain("<file>"); expect(edited).not.toContain("--confirm --fingerprint"); expect(edited).toContain("--json");
});
