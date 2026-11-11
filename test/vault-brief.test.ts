import { Database } from "bun:sqlite";
import { VaultIndex } from "../src/vault-index.ts";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { CONFIG_FILE, type VaultSpec } from "../src/config.ts";
import { run } from "../src/cli.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";
import { validArguments } from "../src/mcp.ts";
import { briefText, vaultBrief } from "../src/vault-brief.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const BODY_CANARY = "BODY_CANARY_NEVER_SHIP_FULL_NOTE_PROSE";
function fixture(pii: VaultSpec["pii"] = "allow") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-brief-"))); roots.push(root);
  const home = join(root, "state"), vault = join(root, "vault"), notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true });
  const spec = addVault(home, { id: "mine", path: vault, kind: "personal", write: "none", pii });
  const configFile = join(home, CONFIG_FILE);
  const note = (stem: string, title: string, description = "Public navigation pointer.", body = "", type = "method") => {
    const source = "---\n" + Object.entries({ title, description, type, domain: "research" }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") + `\n---\n# ${stem}\n\n${body}\n\n${BODY_CANARY}\n`;
    writeFileSync(join(notes, `${stem}.md`), source);
    return `notes/${stem}.md`;
  };
  const configure = (update: (config: Record<string, unknown>) => void) => {
    const config = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    update(config); writeFileSync(configFile, JSON.stringify(config));
  };
  const env = { HOME: root, VMEM_HOME: home, AGENTHUB_HOME: join(root, "family"), AMEM_HOME: join(root, "memory"), PATH: process.env.PATH };
  return { root, home, vault, notes, spec, configFile, note, configure, env };
}
function pathOf(line: string): string { return line.replace(/^\[neighbor\] /, "").split(" | ")[0]!; }
function paths(result: ReturnType<typeof vaultBrief>): string[] { return result.lines.map(pathOf); }
function checkBounds(result: ReturnType<typeof vaultBrief>, cap: number) {
  const json = JSON.stringify(result), text = briefText(result);
  expect(result.bytes).toBe(Buffer.byteLength(json));
  expect(result.bytes).toBeLessThanOrEqual(cap); expect(Buffer.byteLength(text)).toBeLessThanOrEqual(cap);
  expect(text.endsWith(`${result.omitted} matches omitted`)).toBe(true);
  expect(result.lines.every(line => !/[\p{Cc}]/u.test(line))).toBe(true);
  expect(json).not.toContain(BODY_CANARY); expect(text).not.toContain(BODY_CANARY);
  expect(Object.keys(result).sort()).toEqual(["bytes", "lines", "omitted", "vault"]);
}
function contentFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files[file.slice(root.length + 1)] = readFileSync(file).toString("base64");
    }
  };
  visit(root); return files;
}

test("#206 AC1: ranked direct pointers precede true incoming/outgoing one-hop neighbours and never contain bodies", () => {
  const f = fixture();
  f.note("anchor", "Lantern navigation", "Primary lantern pointer.", "[[outgoing]]");
  f.note("outgoing", "Linked method", "One outgoing edge.", "[[two-hop]]");
  f.note("incoming", "Incoming method", "One incoming edge.", "[[anchor]]");
  f.note("two-hop", "Beyond the frontier", "Only a second-hop edge.");
  f.note("unrelated", "Unrelated item", "No route to the anchor.");
  const result = vaultBrief(f.home, { vault: "mine", intent: "lantern", bytes: 4096 });
  expect(result.lines[0]).toBe("notes/anchor.md | Lantern navigation | method | Primary lantern pointer.");
  expect(paths(result).slice(1).sort()).toEqual(["notes/incoming.md", "notes/outgoing.md"]);
  expect(result.lines.slice(1).every(line => line.startsWith("[neighbor] "))).toBe(true);
  expect(new Set(paths(result)).size).toBe(result.lines.length);
  expect(result.omitted).toBe(0); checkBounds(result, 4096);
});

test("#206 one-hop neighbours follow the first five safe hits and precede the remaining direct matches", () => {
  const f = fixture();
  for (let n = 0; n < 8; n++) f.note(`direct-${n}`, `Topneedle ${n}`, "An equally ranked direct match.", "[[shared-neighbor]]");
  f.note("shared-neighbor", "Shared graph context", "A single neighbour reached from every anchor.");
  const result = vaultBrief(f.home, { vault: "mine", intent: "topneedle", bytes: 4096 });
  expect(result.lines).toHaveLength(9);
  expect(result.lines.slice(0, 5).every(line => !line.startsWith("[neighbor] "))).toBe(true);
  expect(result.lines[5]!.startsWith("[neighbor] ")).toBe(true); expect(pathOf(result.lines[5]!)).toBe("notes/shared-neighbor.md");
  expect(result.lines.slice(6).every(line => !line.startsWith("[neighbor] "))).toBe(true);
  expect(new Set(paths(result)).size).toBe(9); expect(result.omitted).toBe(0); checkBounds(result, 4096);
});

test("#206 intent words and path basenames are literal OR alternatives, not an all-terms query", () => {
  const f = fixture();
  f.note("anchor", "Lantern route", "An intent match.");
  f.note("agenda", "Agenda handoff", "A path-hint match.");
  const intent = "lantern absentword";
  const result = vaultBrief(f.home, { vault: "mine", intent, paths: ["src/agenda.ts"], bytes: 4096 });
  expect(paths(result).sort()).toEqual(["notes/agenda.md", "notes/anchor.md"]);
  expect(JSON.stringify(result)).not.toContain(intent); expect(JSON.stringify(result)).not.toContain("src/agenda.ts");
  expect(() => vaultBrief(f.home, { vault: "mine", intent: 'lantern OR "absentword"', bytes: 4096 })).not.toThrow();
  checkBounds(result, 4096);
});

test("#206 AC2: both byte bounds drop whole lines and count all unique omitted candidate paths", () => {
  const f = fixture(), count = 24;
  const titles = new Map<string, string>();
  for (let n = 0; n < count; n++) {
    const stem = `bounded-${String(n).padStart(2, "0")}`, title = `Capneedle "quoted" ${n} 한글😀`;
    f.note(stem, title, "한글😀 ".repeat(24)); titles.set(`notes/${stem}.md`, title);
  }
  f.note("too-large", "Capneedle " + "한글😀".repeat(2000), "Oversized metadata must not be clipped into a pointer.");
  for (const cap of [256, 4096]) {
    const result = vaultBrief(f.home, { vault: "mine", intent: "capneedle", bytes: cap });
    checkBounds(result, cap); expect(result.omitted).toBe(count + 1 - result.lines.length);
    expect(result.omitted).toBeGreaterThan(0); expect(paths(result)).not.toContain("notes/too-large.md");
    for (const line of result.lines) expect(line).toContain(` | ${titles.get(pathOf(line))} | method | `);
  }
});

test("#206 byte accounting includes JSON escapes and every emitted pointer remains one line", () => {
  const f = fixture();
  f.note("escaped", 'Escapeneedle "quoted" 한글😀', `Safe line\nnext\tcolumn ${String.fromCharCode(1)} tail.`);
  f.note("plain", "Escapeneedle plain", "An ordinary pointer remains available.");
  for (const bytes of [256, 4096]) {
    const result = vaultBrief(f.home, { vault: "mine", intent: "escapeneedle", bytes });
    checkBounds(result, bytes); expect(result.omitted).toBe(2 - result.lines.length);
    expect(paths(result)).toContain("notes/plain.md");
  }
});

test("#206 AC3: Korean particles and compounds match while a strong title match ranks first", () => {
  const f = fixture();
  f.note("strong", "사업단 운영", "직접 관련된 운영 기준.");
  f.note("particle", "현장 운영", "정기 점검 기록.", "사업단은 매주 점검한다.");
  f.note("compound", "해외 협력", "협력 절차 기록.", "해외사업단 업무를 기록한다.");
  const result = vaultBrief(f.home, { vault: "mine", intent: "사업단", bytes: 4096 });
  expect(paths(result)[0]).toBe("notes/strong.md");
  expect(paths(result).sort()).toEqual(["notes/compound.md", "notes/particle.md", "notes/strong.md"]);
  expect(result.omitted).toBe(0); checkBounds(result, 4096);
});

test("#206 AC4: metadata warnings, errors, secrets and screened neighbours are omitted and counted", () => {
  const f = fixture({ email: { notes: "warn", log: "allow" }, phone: "deny", custom: "warn" });
  f.configure(config => { config.piiPatterns = ["BRIEF_PRIVATE_VALUE"]; });
  f.note("safe", "Kite safe", "Public pointer.", "[[private-neighbor]]");
  f.note("email-title", "Kite owner@example.invalid", "A screened title.");
  f.note("phone-desc", "Kite phone", "Contact +82 10 1234 5678.");
  f.note("custom-desc", "Kite custom", "BRIEF_PRIVATE_VALUE");
  f.note("secret-desc", "Kite credential", "password=synthetic-value");
  f.note("body-only", "Kite body", "Safe pointer metadata.", "password=synthetic-value");
  f.note("private-neighbor", "Contact owner@example.invalid", "A screened one-hop neighbour.");
  const result = vaultBrief(f.home, { vault: "mine", intent: "kite", bytes: 4096 });
  expect(paths(result).sort()).toEqual(["notes/body-only.md", "notes/safe.md"]);
  expect(result.omitted).toBe(5);
  const output = JSON.stringify(result) + briefText(result);
  for (const privateValue of ["owner@example.invalid", "+82 10 1234 5678", "BRIEF_PRIVATE_VALUE", "password=synthetic-value", "private-neighbor", "secret-desc"]) expect(output).not.toContain(privateValue);
  checkBounds(result, 4096);
});

test("#206 AC4: deny changes hide warm-cache rows and denied files are not opened by the next scan", () => {
  const f = fixture();
  f.note("visible", "Warmneedle visible"); f.note("denied", "Warmneedle denied");
  expect(paths(vaultBrief(f.home, { vault: "mine", intent: "warmneedle", bytes: 4096 }))).toContain("notes/denied.md");
  const denied = join(f.notes, "denied.md");
  f.configure(config => { config.denyPaths = [denied]; });
  // Make the warm row stale as well: output-only filtering cannot pass by avoiding an unchanged-file read.
  writeFileSync(denied, "---\ntitle: [broken\n---\nDenied read canary.\n");
  const moduleUrl = new URL("../src/vault-brief.ts", import.meta.url).href;
  const code = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    const original = { ...fs };
    mock.module("node:fs", () => ({ ...original, openSync: (...args) => {
      if (String(args[0]) === ${JSON.stringify(denied)}) throw new Error("denied note was opened");
      return original.openSync(...args);
    } }));
    const { vaultBrief } = await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify(vaultBrief(${JSON.stringify(f.home)}, { vault: "mine", intent: "warmneedle", bytes: 4096 })));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", code], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 10000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const result = JSON.parse(child.stdout.toString()) as ReturnType<typeof vaultBrief>;
  expect(paths(result)).toEqual(["notes/visible.md"]); expect(JSON.stringify(result)).not.toContain("notes/denied.md");
  checkBounds(result, 4096);
});

test("#206 CLI, direct API and read-only MCP return the same capped result, including the default personal vault", async () => {
  const f = fixture(); f.note("anchor", "Lantern route", "Synthetic command parity.");
  const team = join(f.root, "team"); mkdirSync(join(team, "notes"), { recursive: true });
  f.configure(config => { config.vaults = []; });
  addVault(f.home, { id: "team", path: team, kind: "org", write: "none" }); addVault(f.home, f.spec);
  const args = { vault: "mine", intent: "lantern", paths: ["src/route.ts"], bytes: 256 };
  const expected = vaultBrief(f.home, args);
  const cli = run(["brief", "mine", "--for", "lantern", "--paths", "src/route.ts", "--bytes", "256", "--json"], f.env);
  expect(cli.code).toBe(0); expect(JSON.parse(cli.text)).toEqual(expected);
  const human = run(["brief", "mine", "--for", "lantern", "--paths", "src/route.ts", "--bytes", "256"], f.env);
  expect(human.code).toBe(0); expect(human.text).toBe(briefText(expected));
  const mcp = createVaultMcp(f.home, f.env), tool = mcp.tools.find(tool => tool.name === "vmem_brief");
  expect(tool).toBeDefined(); expect(tool!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  expect(await mcp.handlers.vmem_brief!(args)).toEqual(expected);
  expect(await mcp.handlers.vmem_brief!({ intent: "lantern", paths: ["src/route.ts"], bytes: 256 })).toEqual(expected);
  expect(validArguments({ intent: "lantern" }, tool!.inputSchema)).toBe(true);
  for (const invalid of [{}, { intent: "" }, { intent: "x".repeat(1025) }, { intent: "x", bytes: 255 }, { intent: "x", bytes: 4097 }, { intent: "x", paths: Array(17).fill("x") }, { intent: "x", paths: ["x".repeat(1025)] }, { intent: "x", body: true }]) expect(validArguments(invalid, tool!.inputSchema)).toBe(false);
  const defaultResult = vaultBrief(f.home, { vault: "mine", intent: "lantern" });
  expect(defaultResult).toEqual(vaultBrief(f.home, { vault: "mine", intent: "lantern", bytes: 1024 }));
  checkBounds(defaultResult, 1024);
  expect(() => vaultBrief(f.home, { vault: "absent", intent: "lantern" })).toThrow();
  expect(await mcp.handlers.vmem_brief!({ vault: "absent", intent: "lantern" })).toMatchObject({ refused: true });
});

test("#206 direct and CLI inputs enforce UTF-8 and aggregate search bounds without echoing rejected query text", () => {
  const f = fixture(); f.note("plain", "Bounded pointer");
  for (const bytes of [255, 4097, 256.5, NaN, Infinity]) expect(() => vaultBrief(f.home, { vault: "mine", intent: "x", bytes })).toThrow();
  for (const intent of ["", "   ", "x".repeat(1025), "가".repeat(342), Array.from({ length: 33 }, (_, n) => `word${n}`).join(" ")]) expect(() => vaultBrief(f.home, { vault: "mine", intent })).toThrow();
  for (const hint of [Array(17).fill("x"), ["x".repeat(1025)], ["가".repeat(342)], ["a", "b", "c", "d"].map(letter => letter.repeat(1024))]) expect(() => vaultBrief(f.home, { vault: "mine", intent: "z", paths: hint })).toThrow();
  expect(() => vaultBrief(f.home, { vault: "mine", intent: "x".repeat(1024), paths: [] })).not.toThrow();
  expect(() => vaultBrief(f.home, { vault: "mine", intent: "가".repeat(341) })).not.toThrow();
  expect(() => vaultBrief(f.home, { vault: "mine", intent: "x", paths: Array.from({ length: 16 }, (_, n) => `src/path${n}.ts`) })).not.toThrow();
  expect(() => vaultBrief(f.home, { vault: "mine", intent: Array.from({ length: 32 }, (_, n) => `word${n}`).join(" ") })).not.toThrow();
  for (const argv of [["brief", "mine"], ["brief", "mine", "--for", "x", "--bytes", "255"], ["brief", "mine", "--for", "x", "--unknown"]]) expect(() => run(argv, f.env)).toThrow();
  const rejected = "PRIVATE_QUERY_CANARY_".repeat(100);
  let failure: unknown;
  try { vaultBrief(f.home, { vault: "mine", intent: rejected }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain(rejected);
});

test("#206 brief leaves vault content and registry bytes unchanged while only derived caches may refresh", async () => {
  const f = fixture(); f.note("anchor", "Lantern pointer", "Read-only evidence.");
  for (const dir of ["self", "templates", ".obsidian"]) { mkdirSync(join(f.vault, dir)); writeFileSync(join(f.vault, dir, "sentinel"), "Unrelated synthetic contents.\n"); }
  writeFileSync(join(f.vault, "log"), "Synthetic existing log bytes.\n");
  const before = contentFiles(f.vault), config = readFileSync(f.configFile);
  vaultBrief(f.home, { vault: "mine", intent: "lantern" });
  run(["brief", "mine", "--for", "lantern", "--json"], f.env);
  await createVaultMcp(f.home, f.env).handlers.vmem_brief!({ intent: "lantern" });
  expect(contentFiles(f.vault)).toEqual(before); expect(readFileSync(f.configFile)).toEqual(config);
});


test("#206 restricted refresh preserves shared notes and links without a brief/search reindex cycle", () => {
  const f = fixture();
  f.note("visible", "Sharedcache visible", "Allowed pointer.", "[[denied]]");
  f.note("denied", "Sharedcache denied", "Denied cached pointer.", "[[visible]]");
  const index = new VaultIndex(f.home, f.spec);
  const snapshot = () => {
    const db = new Database(index.file, { readonly: true });
    try { return { notes: db.query("SELECT path,hash,metadata,title,description FROM notes ORDER BY path").all(), links: db.query("SELECT source,ordinal,data FROM links ORDER BY source,ordinal").all(), analysis: db.query("SELECT path,hash,metadata FROM analysis_notes ORDER BY path").all() }; }
    finally { db.close(); }
  };
  try {
    index.scan(); const before = snapshot();
    f.configure(config => { config.denyPaths = [join(f.notes, "denied.md")]; });
    const brief = vaultBrief(f.home, { vault: "mine", intent: "sharedcache", bytes: 4096 });
    expect(JSON.stringify(brief)).not.toContain("notes/denied.md");
    expect(snapshot()).toEqual(before);
    expect(index.scan()).toMatchObject({ changed: 0, removed: 0 });
    expect(snapshot()).toEqual(before);
    expect(index.links("visible").some(link => link.resolved === "denied.md")).toBe(true);
    expect(index.scan(false, { denyPaths: [join(f.notes, "denied.md")] })).toMatchObject({ changed: 0, removed: 0 });
    expect(snapshot()).toEqual(before);
  } finally { index.close(); }
});

test("#206 a new denied file remains unindexed until an unrestricted reader refreshes it", () => {
  const f = fixture(); f.note("visible", "Sharedcache visible");
  const index = new VaultIndex(f.home, f.spec);
  try {
    index.scan(); f.note("new-denied", "Sharedcache denied newcomer");
    f.configure(config => { config.denyPaths = [join(f.notes, "new-denied.md")]; });
    const brief = vaultBrief(f.home, { vault: "mine", intent: "sharedcache", bytes: 4096 });
    expect(JSON.stringify(brief)).not.toContain("new-denied");
    expect(index.search("sharedcache").map(row => row.path)).toEqual(["visible.md"]);
    expect(index.scan()).toMatchObject({ changed: 1, removed: 0 });
    expect(index.search("sharedcache").map(row => row.path)).toContain("new-denied.md");
    expect(index.scan()).toMatchObject({ changed: 0, removed: 0 });
  } finally { index.close(); }
});


test("#206 refused intents and hints name their actual cause and correction", async () => {
  const f = fixture();
  expect(() => vaultBrief(f.home, { vault: "mine", intent: "!!!" })).toThrow("provide words containing letters or digits");
  expect(() => run(["brief", "mine", "--for", "!!!"], f.env)).toThrow("no searchable letters or digits");
  expect(() => vaultBrief(f.home, { vault: "mine", intent: "query", paths: ["src/bad\nname.ts"] })).toThrow("remove control characters");
  expect(await createVaultMcp(f.home, f.env).handlers.vmem_brief!({ intent: "query", paths: ["src/bad\nname.ts"] })).toMatchObject({ refused: true, issues: [{ message: expect.stringContaining("control characters") }] });
});

test("#206 denied cached metadata is never fetched or charged against the allowed pointer budget", () => {
  const f = fixture();
  for (let n = 0; n < 513; n++) f.note(`a-denied-${String(n).padStart(3, "0")}`, "Budgetneedle", "Same metadata.");
  f.note("z-visible", "Budgetneedle", "Same metadata.");
  const index = new VaultIndex(f.home, f.spec);
  try { index.scan(); } finally { index.close(); }
  f.configure(config => { config.denyPaths = [join(f.notes, "a-denied-*")]; });
  const real = VaultIndex.prototype.briefPointer, seen: string[] = [];
  const spy = spyOn(VaultIndex.prototype, "briefPointer").mockImplementation(function(this: VaultIndex, path: string, maximum: number) {
    seen.push(path);
    if (path.startsWith("a-denied-")) throw new Error("denied metadata crossed into JavaScript");
    return real.call(this, path, maximum);
  });
  try {
    const brief = vaultBrief(f.home, { vault: "mine", intent: "budgetneedle", bytes: 4096 });
    expect(paths(brief)).toEqual(["notes/z-visible.md"]);
    expect(seen).toEqual(["z-visible.md"]);
  } finally { spy.mockRestore(); }
});

test("#206 a restricted rebuild refuses before clearing FTS or changing shared link rows", () => {
  const f = fixture(); f.note("visible", "Rebuildneedle", "Visible.", "[[denied]]"); f.note("denied", "Rebuildneedle", "Denied.");
  const index = new VaultIndex(f.home, f.spec);
  const state = () => {
    const db = new Database(index.file, { readonly: true });
    try { return { notes: db.query("SELECT * FROM notes ORDER BY path").all(), fts: db.query("SELECT * FROM fts ORDER BY path").all(), grams: db.query("SELECT * FROM grams ORDER BY path").all(), links: db.query("SELECT * FROM links ORDER BY source,ordinal").all() }; }
    finally { db.close(); }
  };
  try {
    index.scan(); const before = state();
    expect(() => index.scan(true, { denyPaths: [join(f.notes, "denied.md")] })).toThrow("rebuild cannot use denyPaths");
    expect(state()).toEqual(before);
    expect(index.scan()).toMatchObject({ changed: 0, removed: 0 });
    expect(index.search("rebuildneedle").map(row => row.path).sort()).toEqual(["denied.md", "visible.md"]);
    expect(index.links("visible").some(link => link.resolved === "denied.md")).toBe(true);
  } finally { index.close(); }
});

test("#206 ranking overflow refuses with the actual filtered search command as its recovery step", () => {
  const f = fixture(), index = new VaultIndex(f.home, f.spec);
  const db = new Database(index.file);
  try {
    const insert = db.query("INSERT INTO fts(path,title,description,body) VALUES (?,?,?,?)");
    db.transaction(() => { for (let n = 0; n < 10001; n++) insert.run(`overflow-${n}.md`, "Overflowneedle", "", ""); })();
    expect(() => index.briefMatches(["overflowneedle"])).toThrow("vmem search with --type/--domain filters");
  } finally { db.close(); index.close(); }
});
