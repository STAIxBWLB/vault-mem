import { expect, test } from "bun:test";
import { exposureText } from "../src/assertions-command.ts";
import { assertText } from "../src/assert-command.ts";
import { stripTerminal, width } from "../src/text-output.ts";
import type { ExposureReceipt } from "../src/assertion-exposure.ts";

const plain = { color: false, ascii: true, columns: 80 };
test("exposure report has ASCII and color goldens with exactly one summary", () => {
  const receipt: ExposureReceipt = { vault: "demo", clean: true, scanned: { commits: 1, blobs: 2, bytes: 30 }, exposed: [], truncated: null, issues: [] };
  const expected = [" vmem assertions exposure", "", "> Scan", "  Vault:    demo", "  Commits:  1", "  Blobs:    2", "  Bytes:    30", "  Clean:    true", "", "ok 1 ok"].join("\n");
  const text = exposureText(receipt, plain), color = exposureText(receipt, { ...plain, color: true });
  expect(text).toBe(expected); expect(stripTerminal(color)).toBe(expected); expect(color).not.toBe(expected);
  for (const line of text.split("\n")) expect(width(line)).toBeLessThanOrEqual(80);
});
test("assert recovery is a marker list", () => {
  const text = assertText({ ok: false, applied: false, dryRun: false, segment: null, indexUpdated: false, entries: [], issues: [], recovery: ["inspect the segment"] }, plain, { vault: "demo" });
  expect(text).toContain("> Recovery\n  !  inspect the segment"); expect(text).not.toContain("recovery:");
});
