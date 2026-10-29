import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, SETUP_TARGETS } from "../src/setup.ts";
import { completionDefinitions, completionScript, COMMANDS } from "../src/commands-table.ts";
import { run } from "../src/cli.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const entry = { command: "/opt/bun/bin/bun", args: ["--smol", "/opt/vmem/bin/vmem.js", "mcp"] };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-setup-"))); roots.push(root);
  const home = join(root, "home"), state = join(root, "state"), work = join(root, "work"); mkdirSync(home); mkdirSync(work);
  const env = { HOME: home, VMEM_HOME: state };
  const files: Record<string, string> = {
    claude: join(home, ".claude.json"), codex: join(home, ".codex", "config.toml"), kimi: join(home, ".kimi-code", "mcp.json"),
    pi: join(home, ".pi", "agent", "mcp.json"), qwen: join(home, ".qwen", "settings.json"), jcode: join(home, ".jcode", "mcp.json"), agy: join(work, ".agents", "mcp_config.json"),
  };
  const setup = (target: string, mode: "dry-run" | "apply" | "undo") => runSetup(target, mode, { home: state, env, cwd: work, entry });
  return { root, home, state, work, env, files, setup };
}
const seed: Record<string, string> = {
  claude: `{\n  "theme": "dark",\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n`,
  codex: `# user comment\nmodel = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n\n[profiles.fast]\nmodel = "mini"\n`,
  kimi: `{"mcpServers":{"other":{"command":"x"}}}`,
  pi: `{"mcpServers":{}}`,
  qwen: `{"hooks":{"Stop":[]},"mcpServers":{"other":{"command":"x"}}}`,
  jcode: `{"servers":{"other":{"command":"x"}}}`,
  agy: `{"mcpServers":{"other":{"command":"x"}}}`,
};
const parse = (target: string, text: string) => target === "codex" ? Bun.TOML.parse(text) as any : JSON.parse(text);
const servers = (target: string, doc: any) => target === "codex" ? doc.mcp_servers : target === "jcode" ? doc.servers : doc.mcpServers;

test("every host format: dry-run writes nothing, apply is idempotent and keeps unrelated entries, undo restores bytes", () => {
  for (const target of SETUP_TARGETS) {
    const f = fixture(), file = f.files[target]!;
    mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, seed[target]!);
    const dry = f.setup(target, "dry-run");
    expect(dry.actions).toEqual([{ target, file, change: "add" }]);
    expect(readFileSync(file, "utf8")).toBe(seed[target]!);
    expect(existsSync(f.state)).toBe(false);
    expect(f.setup(target, "apply").applied).toBe(true);
    const applied = readFileSync(file, "utf8"), doc = parse(target, applied);
    expect(servers(target, doc).vmem, target).toEqual(entry);
    if (target !== "pi") expect(servers(target, doc).other).toEqual({ command: "x" });
    if (target === "codex") { expect(applied.startsWith(seed.codex!.trimEnd())).toBe(true); expect(doc.profiles.fast.model).toBe("mini"); }
    if (target === "claude") expect(doc.theme).toBe("dark");
    expect(f.setup(target, "apply")).toMatchObject({ applied: false, actions: [{ change: "unchanged" }] });
    expect(readFileSync(file, "utf8")).toBe(applied);
    expect(f.setup(target, "undo").actions[0]!.change).toBe("remove");
    const restored = readFileSync(file, "utf8");
    expect(servers(target, parse(target, restored))?.vmem).toBeUndefined();
    if (target === "codex") expect(restored).toBe(seed.codex!);
    else expect(parse(target, restored)).toEqual(JSON.parse(seed[target]!));
    expect(f.setup(target, "undo").actions[0]).toMatchObject({ change: "none", reason: "no setup receipt" });
  }
});

test("apply creates missing files and undo removes only what setup created", () => {
  const f = fixture();
  f.setup("jcode", "apply");
  expect(JSON.parse(readFileSync(f.files.jcode!, "utf8"))).toEqual({ servers: { vmem: entry } });
  f.setup("jcode", "undo");
  expect(existsSync(f.files.jcode!)).toBe(false);
  f.setup("codex", "apply");
  writeFileSync(f.files.codex!, readFileSync(f.files.codex!, "utf8") + "\n[tools]\nweb = true\n");
  f.setup("codex", "undo");
  expect(Bun.TOML.parse(readFileSync(f.files.codex!, "utf8"))).toEqual({ tools: { web: true } });
});

test("undo restores a prior vmem entry and never clobbers a later user edit", () => {
  const f = fixture(), file = f.files.claude!;
  const prior = { command: "/old/bun", args: ["old"] };
  writeFileSync(file, JSON.stringify({ mcpServers: { vmem: prior } }));
  expect(f.setup("claude", "dry-run").actions[0]!.change).toBe("replace");
  f.setup("claude", "apply");
  expect(f.setup("claude", "undo").actions[0]!.change).toBe("restore");
  expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.vmem).toEqual(prior);
  f.setup("claude", "apply");
  const edited = { command: "/user/bun", args: ["mine"] };
  writeFileSync(file, JSON.stringify({ mcpServers: { vmem: edited } }));
  const report = f.setup("claude", "undo");
  expect(report.actions[0]).toMatchObject({ change: "refused" });
  expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.vmem).toEqual(edited);
  // A TOML prior entry is restored byte for byte.
  const toml = `[mcp_servers.vmem]\ncommand = "/old" # keep\nargs = []\n`;
  mkdirSync(join(f.files.codex!, ".."), { recursive: true }); writeFileSync(f.files.codex!, toml);
  f.setup("codex", "apply"); f.setup("codex", "undo");
  expect(readFileSync(f.files.codex!, "utf8")).toBe(toml);
});

test("all covers user hosts, malformed and linked configs are refused without writes", () => {
  const f = fixture();
  mkdirSync(join(f.files.kimi!, ".."), { recursive: true }); writeFileSync(f.files.kimi!, "{ trailing, }");
  const report = f.setup("all", "apply");
  expect(report.actions.map(a => a.target)).toEqual(SETUP_TARGETS.filter(t => t !== "agy"));
  expect(report.actions.find(a => a.target === "kimi")).toMatchObject({ change: "refused" });
  expect(readFileSync(f.files.kimi!, "utf8")).toBe("{ trailing, }");
  expect(report.actions.filter(a => a.change === "add")).toHaveLength(5);
  expect(existsSync(f.files.agy!)).toBe(false);
  expect(report.notes.join(" ")).toContain("No console plugin manifest");
  expect(readdirSync(join(f.state, "setup")).map(name => name.replace(/-[0-9a-f]{16}\.json$/, "")).sort()).toEqual(["claude", "codex", "jcode", "pi", "qwen"]);
  expect(() => f.setup("cursor", "apply")).toThrow("unknown target");
});

test("CLI setup is non-TTY, dry-run by default, exits 1 on refusal", () => {
  const f = fixture();
  const result = Bun.spawnSync([process.execPath, "bin/vmem.js", "setup", "jcode", "--json"], { env: { ...process.env, ...f.env, CLAUDECODE: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ mode: "dry-run", applied: false, actions: [{ target: "jcode", change: "add" }] });
  expect(existsSync(f.files.jcode!)).toBe(false);
  expect(() => run(["setup", "jcode", "--apply", "--undo"], f.env)).toThrow();
  mkdirSync(join(f.files.jcode!, ".."), { recursive: true }); writeFileSync(f.files.jcode!, "nope");
  expect(run(["setup", "jcode", "--apply"], f.env).code).toBe(1);
});

test("help and completion share one command table", () => {
  const help = run(["--help"]).text;
  for (const command of COMMANDS) expect(help).toContain(`vmem ${command.usage}`);
  const defs = completionDefinitions();
  expect(defs.map(d => d.path.join(" "))).toEqual(COMMANDS.map(c => c.name));
  expect(defs.find(d => d.path.join(" ") === "vaults add")!.options["--write"]).toEqual({ value: ["mcp", "cli", "none"] });
  expect(defs.find(d => d.path.join(" ") === "move")!.options).toHaveProperty("--fingerprint");
  for (const shell of ["bash", "zsh", "fish"]) {
    const script = completionScript(shell);
    for (const command of COMMANDS) expect(script).toContain(command.name.split(" ").at(-1)!);
  }
  const bash = Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(completionScript("bash")), stdout: "pipe", stderr: "pipe" });
  expect(bash.exitCode).toBe(0);
  expect(() => completionScript("pwsh")).toThrow();
});

test("host profiles sharing VMEM_HOME keep separate receipts", () => {
  const f = fixture(), a = join(f.root, "codex-a"), b = join(f.root, "codex-b");
  const prior = `[mcp_servers.vmem]\ncommand = "/a/old"\nargs = []\n`;
  mkdirSync(a); mkdirSync(b); writeFileSync(join(a, "config.toml"), prior);
  const as = (dir: string, mode: "apply" | "undo") => runSetup("codex", mode, { home: f.state, env: { ...f.env, CODEX_HOME: dir }, cwd: f.work, entry });
  as(a, "apply"); as(b, "apply");
  expect(as(b, "undo").actions[0]!.change).toBe("remove");
  expect(existsSync(join(b, "config.toml"))).toBe(false);
  expect(as(a, "undo").actions[0]!.change).toBe("restore");
  expect(readFileSync(join(a, "config.toml"), "utf8")).toBe(prior);
});

// Permission faults cannot be injected as root, where chmod does not restrict writes.
test.skipIf(process.getuid?.() === 0)("receipt is written before the host file; a failed host write leaves both recoverable", () => {
  const f = fixture(), dir = join(f.home, ".jcode"); mkdirSync(dir);
  writeFileSync(f.files.jcode!, `{"servers":{"other":{"command":"x"}}}`);
  chmodSync(dir, 0o500);
  try {
    const report = f.setup("jcode", "apply");
    expect(report.actions[0]!.change).toBe("refused");
    expect(JSON.parse(readFileSync(f.files.jcode!, "utf8")).servers.vmem).toBeUndefined();
    expect(existsSync(join(f.state, "setup")) ? readdirSync(join(f.state, "setup")).filter(n => n.endsWith(".json")) : []).toEqual([]);
  } finally { chmodSync(dir, 0o700); }
  // A receipt that cannot be written blocks apply before the host file is touched.
  const g = fixture(); mkdirSync(join(g.files.jcode!, "..")); writeFileSync(g.files.jcode!, `{"servers":{}}`);
  const receipts = join(g.state, "setup"); mkdirSync(receipts, { recursive: true }); chmodSync(receipts, 0o500);
  try {
    expect(g.setup("jcode", "apply").actions[0]!.change).toBe("refused");
    expect(readFileSync(g.files.jcode!, "utf8")).toBe(`{"servers":{}}`);
  } finally { chmodSync(receipts, 0o700); }
  expect(g.setup("jcode", "apply").actions[0]!.change).toBe("add");
});

test("TOML subtables of the entry are collected even when separated by another table", () => {
  const f = fixture(), file = f.files.codex!;
  const source = `[mcp_servers.vmem]\ncommand = "/old"\nargs = []\n\n[other]\nkeep = 1\n\n[mcp_servers.vmem.env]\nTOKEN_PATH = "/x"\n`;
  mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, source);
  expect(f.setup("codex", "apply").actions[0]!.change).toBe("replace");
  const doc = Bun.TOML.parse(readFileSync(file, "utf8")) as any;
  expect(doc.mcp_servers.vmem).toEqual(entry);
  expect(doc.other).toEqual({ keep: 1 });
  expect(f.setup("codex", "undo").actions[0]!.change).toBe("restore");
  const restored = Bun.TOML.parse(readFileSync(file, "utf8")) as any;
  expect(restored).toEqual(Bun.TOML.parse(source));
});

test("blank-line runs outside the vmem tables survive apply and undo byte for byte", () => {
  const f = fixture(), file = f.files.codex!;
  mkdirSync(join(file, ".."), { recursive: true });
  for (const source of [
    `model = "gpt"\n\n\n[profiles.a]\nx = 1\n\n\n\n[profiles.b]\ny = 2\n`,
    `model = "gpt"\n\n\n[mcp_servers.vmem]\ncommand = "/old"\nargs = []\n\n\n[other]\nkeep = 1\n\n[mcp_servers.vmem.env]\nA = "1"\n\n\n[tail]\nz = 3\n`,
  ]) {
    writeFileSync(file, source);
    f.setup("codex", "apply");
    const applied = readFileSync(file, "utf8");
    expect(applied).toContain(`model = "gpt"\n\n\n`);
    if (source.includes("[profiles.a]")) expect(applied.startsWith(source)).toBe(true);
    else expect(applied).toContain(`[other]\nkeep = 1\n\n\n[tail]`);
    f.setup("codex", "undo");
    if (source.includes("[profiles.a]")) expect(readFileSync(file, "utf8")).toBe(source);
    else expect(Bun.TOML.parse(readFileSync(file, "utf8"))).toEqual(Bun.TOML.parse(source));
  }
});
