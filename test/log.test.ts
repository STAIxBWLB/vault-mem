import { afterEach, expect, test } from "bun:test";
import { existsSync, ftruncateSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logBinding, appendLog, readLog, LOG_LOCK, MAX_LOG_READ_BYTES, MAX_LOG_RESULT_BYTES } from "../src/vault-log.ts";
import { formatLogEvent } from "../src/log-format.ts";
import { addVault } from "../src/registry.ts";
import { applyWrite } from "../src/writer.ts";
import { run } from "../src/cli.ts";
import type { LogEvent } from "../src/log-types.ts";
const roots: string[] = [];
const event: LogEvent = { type: "EXTRACT", project: "-", source: "synthetic:source", dest: "notes/result.md", note: "A synthetic event" };
const fixed = new Date(2026, 9, 29, 9, 32);
function fixture(write: "mcp" | "cli" | "none" = "mcp", kind: "personal" | "org" = "personal", registry?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-log-"))); roots.push(root);
  const home = join(root, "state"), vault = join(root, "vault"), notes = join(vault, "notes"); mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
  writeFileSync(join(notes, "old.md"), "---\ntitle: Old Finding\ndescription: A distinct supporting observation.\ntype: insight\ndomain: research\ntopics: ['[[research]]']\n---\n# Old Finding\nOriginal text.\n## Topics\n- [[research]]\n");
  const registryFile = registry === undefined ? undefined : join(root, "registry.yaml"); if (registryFile) writeFileSync(registryFile, registry!);
  const spec = { id: "test", path: vault, kind, write, ...(registryFile ? { registry: registryFile } : {}) };
  addVault(home, spec);
  return { root, home, vault, notes, spec, file: join(vault, "log"), env: { VMEM_HOME: home } };
}
function line(f: ReturnType<typeof fixture>, value: LogEvent = event): string { return formatLogEvent(value, { vault: f.spec, config: { vaults: [f.spec] }, env: {}, now: fixed }).line!; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("append persists exact canonical bytes, agent attribution and plain CLI events", () => {
  const f = fixture();
  const result = appendLog(f.home, { vault: "test", event }, { env: {}, now: fixed });
  expect(result).toEqual({ ok: true, appended: true, synced: true, bytesWritten: Buffer.byteLength(line(f)), issues: [] });
  expect(readFileSync(f.file, "utf8")).toBe(line(f)); expect(existsSync(join(f.vault, LOG_LOCK))).toBe(false);
  expect(run(["log", "append", "test", "CONNECT", "-", "notes/old.md", "Synthetic relation", "--dest", "notes/result.md"], f.env).code).toBe(0);
  expect(readFileSync(f.file, "utf8").split("\n")[1]).not.toContain("(vmem:agent)");
  expect(run(["log", "append", "test", "LEARN", "-", "synthetic:input", "Synthetic learning"], { ...f.env, CODEX_THREAD_ID: "synthetic" }).code).toBe(0);
  expect(readFileSync(f.file, "utf8").split("\n")[2]).toEndWith(" (vmem:agent)");
  const mcp = appendLog(f.home, { vault: "test", event, channel: "mcp" }, { env: {}, now: fixed }); expect(mcp.ok).toBe(true);
  expect(readFileSync(f.file, "utf8").split("\n")[3]).toEndWith(" (vmem:agent)");
});
test("append refusals precede file creation and preserve existing bytes", () => {
  const f = fixture(), beforeConfig = readFileSync(join(f.home, "vmem.config.json"));
  for (const invalid of [{ ...event, type: "BOGUS" }, { ...event, project: "Invalid" }, { ...event, note: "bad  separator" }, { ...event, source: "bad\nsource" }, { ...event, note: "x".repeat(1001) }, { ...event, note: `sk-${"a".repeat(24)}` }]) {
    expect(appendLog(f.home, { vault: "test", event: invalid }, { env: {} }).ok).toBe(false);
    expect(existsSync(f.file)).toBe(false); expect(existsSync(join(f.vault, LOG_LOCK))).toBe(false);
  }
  expect(readFileSync(join(f.home, "vmem.config.json"))).toEqual(beforeConfig);
  writeFileSync(f.file, line(f)); const before = readFileSync(f.file);
  expect(appendLog(f.home, { vault: "test", event: { ...event, note: "bad|field" } }).ok).toBe(false); expect(readFileSync(f.file)).toEqual(before);
  const org = fixture("mcp", "org"); expect(appendLog(org.home, { vault: "test", event }, { env: {}, now: fixed }).ok).toBe(true);
  expect(appendLog(org.home, { vault: "test", event: { ...event, note: "synthetic@example.test" } }, { env: {}, now: fixed }).issues.some(issue => issue.code === "V07")).toBe(true);
});
test("project registry checks bounded YAML with nested ids and fails closed on unknown/malformed configuration", () => {
  const f = fixture("mcp", "personal", "projects:\n  - id: synthetic\n    sub_projects:\n      - id: nested-project\n");
  for (const project of ["synthetic", "nested-project", "-"]) expect(appendLog(f.home, { vault: "test", event: { ...event, project } }, { env: {} }).ok).toBe(true);
  const before = readFileSync(f.file); expect(appendLog(f.home, { vault: "test", event: { ...event, project: "unknown-project" } }).ok).toBe(false); expect(readFileSync(f.file)).toEqual(before);
  for (const registry of ["projects: [", "projects: missing-array", "projects:\n  - id: duplicated\n  - id: duplicated\n", "projects:\n  - id: Invalid\n"]) {
    writeFileSync(join(f.root, "registry.yaml"), registry); expect(appendLog(f.home, { vault: "test", event }).ok).toBe(false); expect(readFileSync(f.file)).toEqual(before);
  }
});
test("readers skip blanks/comments, bound tail/filter results and keep all data-line counts", () => {
  const f = fixture(); writeFileSync(f.file, "# Synthetic header\n\n  # indented comment\n");
  for (const [type, note] of [["EXTRACT", "First"], ["CONNECT", "Second"], ["EXTRACT", "Third"]]) expect(appendLog(f.home, { vault: "test", event: { ...event, type: type!, note: note! } }, { env: {}, now: fixed }).ok).toBe(true);
  const tail = readLog(f.home, { vault: "test", limit: 2 }); expect(tail.ok).toBe(true); expect(tail.dataLines).toBe(3); expect(tail.lines).toHaveLength(2); expect(tail.lines[0]).toEndWith("Second");
  const filtered = readLog(f.home, { vault: "test", grep: "First|Third", type: "EXTRACT", limit: 1 }); expect(filtered.lines).toHaveLength(1); expect(filtered.lines[0]).toEndWith("Third");
  expect(JSON.parse(run(["log", "grep", "test", "Second", "--json"], f.env).text).lines).toHaveLength(1);
  for (const limit of [0, -1, 201, 1.5, NaN]) expect(readLog(f.home, { vault: "test", limit }).ok).toBe(false);
  expect(readLog(f.home, { vault: "test", grep: "[" }).ok).toBe(false); expect(readLog(f.home, { vault: "test", type: "BOGUS" }).ok).toBe(false);
});
test("large-log warning, incomplete/oversized legacy lines and result byte bounds are explicit", () => {
  const f = fixture(); writeFileSync(f.file, line(f).repeat(20001));
  const large = readLog(f.home, { vault: "test", limit: 1 }); expect(large.ok).toBe(true); expect(large.dataLines).toBe(20001); expect(large.lines).toHaveLength(1); expect(large.warnings.some(warning => warning.includes("20000"))).toBe(true);
  writeFileSync(f.file, line(f) + "x".repeat(5000) + "\nunfinished");
  const legacy = readLog(f.home, { vault: "test" }); expect(legacy.lines).toEqual([line(f).trimEnd()]); expect(legacy.dataLines).toBe(3); expect(legacy.warnings).toHaveLength(2);
  writeFileSync(f.file, (`2026-10-29 09:32  EXTRACT  -  x  — ${'"'.repeat(3900)}\n`).repeat(200));
  const bounded = readLog(f.home, { vault: "test", limit: 200 }); expect(bounded.ok).toBe(true); expect(Buffer.byteLength(JSON.stringify(bounded.lines))).toBeLessThanOrEqual(MAX_LOG_RESULT_BYTES); expect(bounded.lines.length).toBeLessThan(200);
  const fd = openSync(f.file, "w"); ftruncateSync(fd, MAX_LOG_READ_BYTES + 1); closeSync(fd);
  expect(readLog(f.home, { vault: "test" }).issues.some(issue => issue.code === "LOG_SIZE")).toBe(true);
});
test("missing logs remain absent; read-only/CLI policies and symlink/incomplete tails refuse safely", () => {
  const f = fixture("none"); expect(readLog(f.home, { vault: "test" })).toMatchObject({ ok: true, lines: [], dataLines: 0 }); expect(existsSync(f.file)).toBe(false);
  expect(appendLog(f.home, { vault: "test", event }).issues[0]!.code).toBe("POLICY"); expect(existsSync(f.file)).toBe(false);
  const cli = fixture("cli"); expect(appendLog(cli.home, { vault: "test", event, channel: "mcp" }).ok).toBe(false); expect(appendLog(cli.home, { vault: "test", event, channel: "cli" }, { env: {} }).ok).toBe(true);
  const linked = fixture(), target = join(linked.root, "outside"); writeFileSync(target, "untouched\n"); symlinkSync(target, linked.file);
  expect(appendLog(linked.home, { vault: "test", event }).ok).toBe(false); expect(readLog(linked.home, { vault: "test" }).ok).toBe(false); expect(readFileSync(target, "utf8")).toBe("untouched\n");
  const incomplete = fixture(); writeFileSync(incomplete.file, "unfinished"); expect(appendLog(incomplete.home, { vault: "test", event }).ok).toBe(false); expect(readFileSync(incomplete.file, "utf8")).toBe("unfinished");
  for (const args of [["log", "tail", "test", "extra"], ["log", "append", "test", "EXTRACT"], ["log", "tail", "test", "--confirm"], ["log", "grep", "test", "x", "--limit", "1e2"]]) expect(() => run(args, f.env)).toThrow();
});
test("two concurrent appenders preserve one intact canonical event per write", async () => {
  const f = fixture();
  const children = ["first", "second"].map(prefix => Bun.spawn([process.execPath, "test/fixtures/log-worker.ts", f.home, "test", prefix, "16"], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(async child => ({ code: await child.exited, text: await new Response(child.stdout).text(), error: await new Response(child.stderr).text() })));
  for (const result of results) { expect(result.code).toBe(0); expect(JSON.parse(result.text)).toEqual({ ok: true, count: 16 }); }
  const lines = readFileSync(f.file, "utf8").trimEnd().split("\n"); expect(lines).toHaveLength(32); expect(new Set(lines.map(line => line.split("  ")[3])).size).toBe(32);
  expect(lines.every(line => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}  EXTRACT  -  (first|second):\d+  — Synthetic event \d+ \(vmem:agent\)$/.test(line))).toBe(true); expect(existsSync(join(f.vault, LOG_LOCK))).toBe(false);
});
test("append uses one write; short/throw/flush/close/cleanup fault receipts match actual file state", () => {
  for (const mode of ["one-write", "write", "short", "partial-throw", "post-throw", "fsync", "close", "cleanup"]) {
    const f = fixture(), before = line(f); writeFileSync(f.file, before);
    const child = Bun.spawnSync([process.execPath, "test/fixtures/log-fault.ts", f.home, f.vault, mode], { stdout: "pipe", stderr: "pipe" }); expect(child.exitCode).toBe(0);
    const { result, writes, syncs } = JSON.parse(child.stdout.toString()); expect(writes).toBe(1);
    const actual = readFileSync(f.file, "utf8");
    if (["write", "short", "partial-throw"].includes(mode)) { expect(result.ok).toBe(false); expect(result.appended).toBe(false); expect(actual).toBe(before); }
    else { expect(result.appended).toBe(true); expect(actual.trimEnd().split("\n")).toHaveLength(2); expect(actual.endsWith("\n")).toBe(true); }
    if (mode === "one-write") { expect(result.ok).toBe(true); expect(syncs).toBe(1); expect(result.synced).toBe(true); }
    if (["post-throw", "fsync"].includes(mode)) { expect(result.ok).toBe(false); expect(result.synced).toBe(false); }
    if (["short", "partial-throw"].includes(mode)) expect(result.rolledBack).toBe(true);
    expect(existsSync(join(f.vault, LOG_LOCK))).toBe(mode === "cleanup");
  }
});
test("writer receipt separates committed note success from missing/unflushed log, and previews never append", () => {
  const f = fixture(), operation = { op: "patch" as const, path: "old", oldString: "Original text.", newString: "Persisted text." };
  expect(applyWrite(f.home, { vault: "test", operation, dryRun: true }, { env: { CODEX_THREAD_ID: "synthetic" } }).ok).toBe(true); expect(existsSync(f.file)).toBe(false);
  const result = applyWrite(f.home, { vault: "test", operation }, { env: { CODEX_THREAD_ID: "synthetic" } }); expect(result.ok).toBe(true); expect(result.logged).toBe(true); expect(result.log).toMatchObject({ appended: true, synced: true }); expect(readFileSync(f.file, "utf8")).toContain(" (vmem:agent)\n");
  const refused = fixture(); mkdirSync(refused.file);
  const failed = applyWrite(refused.home, { vault: "test", operation }, { env: {} }); expect(failed.ok).toBe(true); expect(failed.applied).toBe(true); expect(failed.logged).toBe(false); expect(failed.log?.ok).toBe(false); expect(readFileSync(join(refused.notes, "old.md"), "utf8")).toContain("Persisted text.");
  const flushed = fixture(); writeFileSync(flushed.file, line(flushed));
  const child = Bun.spawnSync([process.execPath, "test/fixtures/log-fault.ts", flushed.home, flushed.vault, "writer-flush"], { stdout: "pipe", stderr: "pipe" }); expect(child.exitCode).toBe(0);
  const output = JSON.parse(child.stdout.toString()); expect(output.result).toMatchObject({ ok: true, applied: true, logged: false, log: { ok: false, appended: true, synced: false } }); expect(readFileSync(flushed.file, "utf8").trimEnd().split("\n")).toHaveLength(2);
  const override = fixture();
  const screened = applyWrite(override.home, { vault: "test", operation, log: { ...event, note: `sk-${"x".repeat(24)}` } }, { env: {} }); expect(screened.ok).toBe(true); expect(screened.logged).toBe(false); expect(screened.log?.issues.some(issue => issue.code === "V06")).toBe(true); expect(existsSync(override.file)).toBe(false);
  const cliFailure = fixture(); mkdirSync(cliFailure.file); const cli = run(["patch", "test", "old", "--old", "Original text.", "--new", "Persisted text."], cliFailure.env); expect(cli.code).toBe(1); expect(JSON.parse(cli.text)).toMatchObject({ ok: true, applied: true, logged: false });
});

test("rotation/removal cannot claim current log persistence, and partial rollback preserves foreign tail bytes", () => {
  for (const mode of ["rotate", "remove", "short-external"]) {
    const f = fixture(), before = line(f); writeFileSync(f.file, before);
    const child = Bun.spawnSync([process.execPath, "test/fixtures/log-fault.ts", f.home, f.vault, mode], { stdout: "pipe", stderr: "pipe" }); expect(child.exitCode).toBe(0);
    const { result, writes } = JSON.parse(child.stdout.toString()); expect(writes).toBe(1); expect(result.ok).toBe(false); expect(existsSync(join(f.vault, LOG_LOCK))).toBe(false);
    if (mode === "short-external") { expect(result.rolledBack).toBeUndefined(); expect(readFileSync(f.file, "utf8")).toBe(before + "ZZZZZZZ"); }
    else { expect(result.appended).toBeNull(); expect(result.synced).toBe(false); expect(result.issues.some((issue: { code: string }) => issue.code === "LOG_DRIFT")).toBe(true); }
    if (mode === "rotate") { expect(readFileSync(f.file, "utf8")).toBe("replacement\n"); expect(readFileSync(join(f.vault, "rotated-log"), "utf8").trimEnd().split("\n")).toHaveLength(2); }
  }
});
test("registry rebinding after note commit cannot log the mutation into another vault", () => {
  const f = fixture(), rebound = join(f.root, "other-vault"); mkdirSync(join(rebound, "notes"), { recursive: true });
  const child = Bun.spawnSync([process.execPath, "test/fixtures/log-fault.ts", f.home, f.vault, "writer-rebind", rebound], { stdout: "pipe", stderr: "pipe" }); expect(child.exitCode).toBe(0);
  const { result, writes } = JSON.parse(child.stdout.toString()); expect(writes).toBe(0); expect(result).toMatchObject({ ok: true, applied: true, logged: false, log: { ok: false, appended: false } });
  expect(result.log.issues.some((issue: { code: string }) => issue.code === "LOG_DRIFT")).toBe(true); expect(readFileSync(join(f.notes, "old.md"), "utf8")).toContain("Persisted text.");
  expect(existsSync(f.file)).toBe(false); expect(existsSync(join(rebound, "log"))).toBe(false);
});
test("grep refuses catastrophic regex syntax and safely evaluates repeated atom quantifiers", () => {
  const f = fixture(); writeFileSync(f.file, "a".repeat(4000) + "!\n");
  expect(readLog(f.home, { vault: "test", grep: "(a+)+$" })).toMatchObject({ ok: false, lines: [] });
  expect(readLog(f.home, { vault: "test", grep: "a*a*a*a*a*b$" })).toMatchObject({ ok: true, lines: [] });
});

test("a bound append reports any re-registration as LOG_DRIFT before policy and path checks", () => {
  for (const change of [{ write: "none" }, { path: "/nonexistent-vmem-rebind" }]) {
    const f = fixture(), config = JSON.parse(readFileSync(join(f.home, "vmem.config.json"), "utf8"));
    const binding = logBinding(structuredClone(config.vaults[0]), config);
    Object.assign(config.vaults[0], change); writeFileSync(join(f.home, "vmem.config.json"), JSON.stringify(config));
    const receipt = appendLog(f.home, { vault: "test", event: { type: "EXTRACT", project: "-", source: "synthetic:source", note: "Synthetic event" } }, { env: {}, binding });
    expect(receipt.ok).toBe(false); expect(receipt.issues.map(i => i.code)).toEqual(["LOG_DRIFT"]);
  }
});
