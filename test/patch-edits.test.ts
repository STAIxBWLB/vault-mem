import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { addVault } from "../src/registry.ts";
import { applyWrite, sha256 } from "../src/writer.ts";
import { serveMcp } from "../src/mcp.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";
import { run } from "../src/cli.ts";
import type { PatchEdit, WriteOp } from "../src/write-types.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const note = (body: string) => `---\ntitle: "Old Finding"\ndescription: Synthetic evidence for navigation.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\n---\n# Old Finding\n\n${body}\n\n## Topics\n\n- [[research]]\n`;
const BODY = "| row | value |\n|---|---|\n| one | first |\n| two | second |\n| three | third |\n\nAlpha beta gamma.\n\nDuplicate line.\nDuplicate line.";
function fixture(body = BODY) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-patch-edits-"))); roots.push(root);
  const home = join(root, "state"), vault = join(root, "vault"), notes = join(vault, "notes"); mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
  writeFileSync(join(notes, "old.md"), note(body));
  addVault(home, { id: "test", path: vault, kind: "personal", write: "mcp" });
  const patch = (edits: unknown, extra: Partial<Extract<WriteOp, { op: "patch" }>> = {}, dryRun = false) => applyWrite(home, { vault: "test", operation: { op: "patch", path: "old", edits: edits as PatchEdit[], ...extra }, dryRun }, { env: {} });
  return { root, home, vault, file: join(notes, "old.md"), log: join(vault, "log"), env: { VMEM_HOME: home }, patch };
}
function disk(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) if (lstatSync(join(dir, name)).isFile()) result[name] = readFileSync(join(dir, name), "utf8");
  return result;
}
const logLines = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n").map(line => line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}  /, "")) : [];
async function mcp(home: string, args: Record<string, unknown>) {
  const server = createVaultMcp(home, { VMEM_HOME: home }), input = new PassThrough(), output = new PassThrough(); let text = "";
  output.on("data", chunk => { text += chunk.toString(); });
  const done = serveMcp({ tools: server.tools, handlers: server.handlers, input, output });
  for (const frame of [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vmem_patch", arguments: args } }]) input.write(JSON.stringify(frame) + "\n");
  input.end(); await done;
  const response = JSON.parse(text.trim().split("\n")[1]!);
  return response.error ? { protocolError: response.error.code } : JSON.parse(response.result.content[0].text);
}
// Out of order on purpose; each is located in the original text.
const ROWS: PatchEdit[] = [{ oldString: "| three | third |", newString: "| three | 3 |" }, { oldString: "| one | first |", newString: "| one | 1 |" }, { oldString: "| two | second |", newString: "| two | 2 |" }];
const ROWS_AFTER = note(BODY.replace("first", "1").replace("second", "2").replace("third", "3"));

test("edits apply together against the original text with one receipt and one log event (library, MCP, CLI file and stdin)", async () => {
  const lib = fixture(), result = lib.patch(ROWS, { expectedSha: sha256(readFileSync(lib.file, "utf8")) });
  expect(result).toMatchObject({ ok: true, applied: true, logged: true }); expect(result.changes).toHaveLength(1);
  expect(readFileSync(lib.file, "utf8")).toBe(ROWS_AFTER); expect(logLines(lib.log)).toEqual(["EXTRACT  -  vmem:patch → notes/old.md  — patch"]);
  // A later edit may introduce text an earlier one matches; matching uses the original note only.
  const chained = fixture(); expect(chained.patch([{ oldString: "Alpha", newString: "Alpha beta" }, { oldString: "gamma", newString: "delta" }]).ok).toBe(true);
  expect(readFileSync(chained.file, "utf8")).toContain("Alpha beta beta delta.");
  const viaMcp = fixture(), event = { type: "EXTRACT", project: "-", source: "synthetic:review", note: "three table rows" };
  expect(await mcp(viaMcp.home, { path: "old", edits: ROWS, log: event })).toMatchObject({ ok: true, applied: true, logged: true });
  expect(readFileSync(viaMcp.file, "utf8")).toBe(ROWS_AFTER); expect(logLines(viaMcp.log)).toEqual(["EXTRACT  -  synthetic:review  — three table rows (vmem:agent)"]);
  const viaFile = fixture(), edits = join(viaFile.root, "edits.json"); writeFileSync(edits, JSON.stringify(ROWS));
  const cli = run(["patch", "test", "old", "--edits", edits], viaFile.env);
  expect(cli.code).toBe(0); expect(readFileSync(viaFile.file, "utf8")).toBe(ROWS_AFTER); expect(logLines(viaFile.log)).toHaveLength(1);
  const viaStdin = fixture();
  const child = Bun.spawnSync([process.execPath, "bin/vmem.js", "patch", "test", "old", "--edits", "-", "--json"], { env: { ...process.env, ...viaStdin.env }, stdin: Buffer.from(JSON.stringify(ROWS)), stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0); expect(JSON.parse(child.stdout.toString()).changes).toHaveLength(1); expect(readFileSync(viaStdin.file, "utf8")).toBe(ROWS_AFTER);
});

test("a missing, duplicate or overlapping match, a frontmatter match, a stale SHA or a malformed edit refuses with no change", async () => {
  const f = fixture(), before = disk(f.vault), good = ROWS[0]!;
  const cases: [unknown, Partial<Extract<WriteOp, { op: "patch" }>>, string, string][] = [
    [[good, { oldString: "absent text", newString: "x" }], {}, "V09", "edits[1]: oldString must match exactly once"],
    [[good, { oldString: "Duplicate line.", newString: "x" }], {}, "V09", "edits[1]: oldString must match exactly once"],
    [[{ oldString: "Alpha beta", newString: "x" }, { oldString: "beta gamma", newString: "y" }], {}, "V09", "overlaps another edit"],
    [[good, { oldString: "| one | first |", newString: "x" }, { oldString: "| one |", newString: "y" }], {}, "V09", "overlaps another edit"],
    [[good, { oldString: "type: insight", newString: "type: claim" }], {}, "V01", "edits[1]: patch cannot target frontmatter"],
    [ROWS, { expectedSha: sha256("an older version") }, "V09", "expected SHA mismatch"],
    [[], {}, "V09", "1 to 32 replacements"],
    [Array.from({ length: 33 }, () => good), {}, "V09", "1 to 32 replacements"],
    [[good, { oldString: "| two | second |", newString: "x", extra: 1 }], {}, "V01", "edits[1]: an edit is exactly {oldString, newString}"],
    [[good, { oldString: "", newString: "x" }], {}, "V09", "edits[1]: patch strings must be bounded"],
    [ROWS, { oldString: "Alpha", newString: "x" }, "V01", "either oldString/newString or edits"],
    [undefined, {}, "V01", "either oldString/newString or edits"],
  ];
  for (const [edits, extra, code, message] of cases) {
    const result = f.patch(edits, { ...(edits === undefined ? { edits: undefined } : {}), ...extra });
    expect(result.ok).toBe(false); expect(result.applied).toBe(false);
    expect(result.issues[0]).toMatchObject({ code }); expect(result.issues[0]!.message).toContain(message);
  }
  expect(await mcp(f.home, { path: "old", oldString: "Alpha", newString: "x", edits: ROWS })).toMatchObject({ refused: true, issues: [{ code: "V01" }] });
  expect(await mcp(f.home, { path: "old" })).toMatchObject({ refused: true, issues: [{ code: "V01" }] });
  expect(await mcp(f.home, { path: "old", edits: Array.from({ length: 33 }, () => good) })).toEqual({ protocolError: -32602 });
  expect(await mcp(f.home, { path: "old", edits: [{ ...good, extra: 1 }] })).toEqual({ protocolError: -32602 });
  const edits = join(f.root, "edits.json");
  writeFileSync(edits, JSON.stringify(ROWS)); expect(() => run(["patch", "test", "old", "--edits", edits, "--old", "Alpha"], f.env)).toThrow("patch: use --old/--new or --edits, not both");
  writeFileSync(edits, "{not json"); expect(() => run(["patch", "test", "old", "--edits", edits], f.env)).toThrow("--edits: invalid JSON");
  writeFileSync(edits, JSON.stringify({ edits: ROWS })); expect(() => run(["patch", "test", "old", "--edits", edits], f.env)).toThrow("--edits: expected a JSON array");
  writeFileSync(edits, JSON.stringify([ROWS[0], { oldString: "absent", newString: "x" }])); expect(run(["patch", "test", "old", "--edits", edits], f.env).code).toBe(1);
  rmSync(edits); expect(disk(f.vault)).toEqual(before); expect(existsSync(f.log)).toBe(false);
});

test("the 256 KiB note bound applies to the combined result of all edits", () => {
  const filler = "Synthetic filler sentence for the size bound.\n".repeat(5400), f = fixture(`Marker one.\n\nMarker two.\n\n${filler}`), before = disk(f.vault);
  const grow = (marker: string) => ({ oldString: marker, newString: "z".repeat(8192) });
  const size = Buffer.byteLength(readFileSync(f.file, "utf8"));
  expect(size + 8192).toBeLessThan(256 * 1024); expect(size + 2 * (8192 - 11)).toBeGreaterThan(256 * 1024);
  expect(f.patch([grow("Marker one.")], {}, true).ok).toBe(true);
  expect(f.patch([grow("Marker two.")], {}, true).ok).toBe(true);
  const both = f.patch([grow("Marker one."), grow("Marker two.")]);
  expect(both.ok).toBe(false); expect(both.issues.some(issue => issue.code === "V09")).toBe(true); expect(disk(f.vault)).toEqual(before);
});
