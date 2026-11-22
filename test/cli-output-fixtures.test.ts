import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorLine, markerCell, Report, resolveColor, type MarkerName } from "@staix/cli-output";

// Read the installed package's fixtures, so the pinned release is the source of truth.
const root = join(dirname(fileURLToPath(import.meta.resolve("@staix/cli-output"))), "..", "fixtures", "v1");
const colors = await Bun.file(join(root, "color.json")).json() as any[];
const markers = await Bun.file(join(root, "markers.json")).json() as any[];
const errors = await Bun.file(join(root, "error-line.json")).json() as any[];
for (const item of colors) test(`package color fixture ${item.id}`, () => {
  const actual = resolveColor(item.flag, item.env, item.tool ?? "tool");
  if (item.expectedError !== undefined) expect(actual).toEqual(new Error(item.expectedError)); else expect(actual).toBe(item.expected);
});
for (const item of markers) test(`package marker fixture ${item.id}`, () => {
  expect(markerCell(item.name as MarkerName, false)).toBe(item.utf8);
  expect(markerCell(item.name as MarkerName, true)).toBe(item.ascii);
});
for (const item of errors) test(`package error fixture ${item.id}`, () => expect(errorLine(item.tool, item.what, item.why, item.options)).toEqual(item.expected));
for (const file of readdirSync(join(root, "report")).filter(name => name.endsWith(".json"))) {
  const fixture = await Bun.file(join(root, "report", file)).json() as any;
  test(`package report fixture ${fixture.id}`, () => {
    const report = new Report(fixture.input.columns ?? undefined, fixture.input.ascii);
    for (const op of fixture.input.operations) switch (op.op) {
      case "header": report.header(op.tool, op.name, op.context); break;
      case "section": report.section(op.name, op.count); break;
      case "kv": report.kv(op.rows); break;
      case "bullet": report.bullet(op.marker, op.text, op.nested); break;
      case "next": report.next(op.command); break;
      case "table": report.table(op.head, op.rows, op.flexible); break;
      case "summary": report.summary(op.counts); break;
      default: throw new Error(`unknown package fixture operation ${op.op}`);
    }
    expect(report.render(false)).toEqual(fixture.plain); expect(report.render(true)).toEqual(fixture.colored);
  });
}
