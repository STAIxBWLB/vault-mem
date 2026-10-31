import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

/** Hosts whose MCP configuration `vmem setup` can register; `all` covers every user-level host (not agy). */
export const SETUP_TARGETS = ["claude", "codex", "kimi", "pi", "qwen", "jcode", "agy"] as const;
export type SetupTarget = typeof SETUP_TARGETS[number];
export type SetupMode = "dry-run" | "apply" | "undo";
export const SERVER_NAME = "vmem";
const MAX_HOST_CONFIG = 4 * 1024 * 1024;
export interface McpEntry { command: string; args: string[] }
interface HostFile { target: SetupTarget; file: string; format: "json" | "toml"; key: string }
export interface SetupAction { target: SetupTarget; file: string; change: "add" | "replace" | "unchanged" | "restore" | "remove" | "refused" | "none"; reason?: string }
export interface ConsoleAction { file: string; module: string; change: "add" | "replace" | "unchanged" | "remove" | "none" | "refused"; reason?: string }
export interface SetupReport { mode: SetupMode; applied: boolean; entry: McpEntry; actions: SetupAction[]; console?: ConsoleAction; notes: string[] }
interface Receipt { version: 1; target: SetupTarget; file: string; existed: boolean; keyExisted?: boolean; prior: unknown; priorToml?: string[]; installed: McpEntry }

function hosts(env: NodeJS.ProcessEnv, cwd: string): Record<SetupTarget, HostFile> {
  const home = env.HOME?.trim() || homedir();
  const dir = (key: string, fallback: string) => {
    const value = env[key]?.trim();
    if (!value) return join(home, fallback);
    if (!isAbsolute(value)) throw new Error(`setup: ${key} must be absolute`);
    return resolve(value);
  };
  const claude = env.CLAUDE_CONFIG_DIR?.trim() ? join(dir("CLAUDE_CONFIG_DIR", ".claude"), ".claude.json") : join(home, ".claude.json");
  return {
    claude: { target: "claude", file: claude, format: "json", key: "mcpServers" },
    codex: { target: "codex", file: join(dir("CODEX_HOME", ".codex"), "config.toml"), format: "toml", key: "mcp_servers" },
    kimi: { target: "kimi", file: join(dir("KIMI_CODE_HOME", ".kimi-code"), "mcp.json"), format: "json", key: "mcpServers" },
    pi: { target: "pi", file: join(dir("PI_CODING_AGENT_DIR", ".pi/agent"), "mcp.json"), format: "json", key: "mcpServers" },
    qwen: { target: "qwen", file: join(dir("QWEN_HOME", ".qwen"), "settings.json"), format: "json", key: "mcpServers" },
    jcode: { target: "jcode", file: join(dir("JCODE_HOME", ".jcode"), "mcp.json"), format: "json", key: "servers" },
    agy: { target: "agy", file: join(resolve(cwd), ".agents", "mcp_config.json"), format: "json", key: "mcpServers" },
  };
}
function readText(file: string): string | null {
  let stat;
  try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile()) throw new Error(`${file}: expected a plain file (links are refused)`);
  if (stat.size > MAX_HOST_CONFIG) throw new Error(`${file}: exceeds 4 MiB`);
  return readFileSync(file, "utf8");
}
function atomicWrite(file: string, text: string | null): void {
  if (text === null) { unlinkSync(file); return; }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try { mode = statSync(file).mode & 0o777; } catch { /* new file */ }
  const temp = join(dirname(file), `.${SERVER_NAME}-setup-${randomUUID()}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, file); } catch (error) { try { unlinkSync(temp); } catch { /* best effort */ } throw error; }
}
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected an object`);
  return value as Record<string, unknown>;
};

// TOML: edit only the `[mcp_servers.vmem]` table (and its subtables) textually so unrelated bytes stay identical.
const tomlHeader = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;
/** Every table owned by the entry (`[mcp_servers.vmem]` and any `[mcp_servers.vmem.*]`), wherever it appears. */
function tomlSpans(lines: string[]): [number, number][] {
  const own = (name: string) => {
    const key = name.replace(/\s*\.\s*/g, ".").replace(/"vmem"/g, SERVER_NAME);
    return key === `mcp_servers.${SERVER_NAME}` || key.startsWith(`mcp_servers.${SERVER_NAME}.`);
  };
  const spans: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    const header = i < lines.length ? tomlHeader.exec(lines[i]!) : null;
    if (i < lines.length && !header) continue;
    if (start >= 0) {
      let stop = i;
      while (stop > start && lines[stop - 1]!.trim() === "") stop--;
      spans.push([start, stop]); start = -1;
    }
    if (header && own(header[1]!)) start = i;
  }
  return spans;
}
function tomlString(value: string): string { return JSON.stringify(value); }
function readEntry(host: HostFile, text: string | null): unknown {
  if (text === null) return undefined;
  if (host.format === "toml") {
    const doc = record(Bun.TOML.parse(text), host.file);
    return doc.mcp_servers === undefined ? undefined : record(doc.mcp_servers, `${host.file} mcp_servers`)[SERVER_NAME];
  }
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { throw new Error(`${host.file}: not strict JSON; edit it by hand or fix it first`); }
  const servers = record(doc, host.file)[host.key];
  return servers === undefined ? undefined : record(servers, `${host.file} ${host.key}`)[SERVER_NAME];
}
function tomlBlock(text: string | null): string[] | undefined {
  const lines = text ? text.split(/\r?\n/) : [], spans = tomlSpans(lines);
  return spans.length ? spans.flatMap(([start, stop]) => lines.slice(start, stop)) : undefined;
}
/** Replace the vmem entry. TOML takes either an entry value or the exact prior block lines to restore. */
function putEntry(host: HostFile, text: string | null, value: unknown, rawToml?: string[], keepKey = false): string | null {
  if (host.format === "toml") {
    const source = text ?? "", newline = source.includes("\r\n") ? "\r\n" : "\n";
    const lines = source.length ? source.split(/\r?\n/) : [];
    const spans = tomlSpans(lines);
    let block: string[] = rawToml ?? [];
    if (!rawToml && value !== undefined) {
      const entry = record(value, "entry");
      block = [`[mcp_servers.${SERVER_NAME}]`, ...Object.entries(entry).map(([key, v]) => `${key} = ${Array.isArray(v) ? `[${v.map(item => tomlString(String(item))).join(", ")}]` : typeof v === "string" ? tomlString(v) : JSON.stringify(v)}`)];
    }
    if (spans.length) {
      // Remove every owned table (last first so indexes stay valid), then insert at the first one.
      // A later removed table also takes the blank separator just above it; blank runs elsewhere are untouched.
      for (const [start, stop] of [...spans].reverse()) {
        let from = start;
        if (start !== spans[0]![0]) while (from > 0 && lines[from - 1]!.trim() === "") from--;
        lines.splice(from, stop - from);
      }
      lines.splice(spans[0]![0], 0, ...block);
    } else if (block.length) {
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      if (lines.length) lines.push("");
      lines.push(...block);
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    const out = lines.length ? lines.join(newline) + newline : "";
    Bun.TOML.parse(out); // never publish a file the host cannot parse
    return out;
  }
  const doc = text === null ? {} : record(JSON.parse(text), host.file);
  const servers = { ...record(doc[host.key] ?? {}, `${host.file} ${host.key}`) };
  if (value === undefined) delete servers[SERVER_NAME]; else servers[SERVER_NAME] = value;
  if (Object.keys(servers).length || keepKey) doc[host.key] = servers; else delete doc[host.key];
  const indent = text && /\n(\t| +)"/.exec(text)?.[1] || "  ";
  return JSON.stringify(doc, null, indent) + "\n";
}
function hasKey(host: HostFile, text: string | null): boolean {
  if (text === null) return false;
  const doc = host.format === "toml" ? Bun.TOML.parse(text) as Record<string, unknown> : JSON.parse(text) as Record<string, unknown>;
  return Object.hasOwn(doc, host.key);
}
/** One receipt per host configuration file, so host profiles sharing VMEM_HOME never share a receipt. */
function receiptFile(home: string, target: SetupTarget, file: string): string {
  return join(home, "setup", `${target}-${createHash("sha256").update(resolve(file)).digest("hex").slice(0, 16)}.json`);
}
function readReceipt(file: string): Receipt | undefined {
  const text = readText(file);
  if (text === null) return undefined;
  const value = JSON.parse(text) as Receipt;
  if (value?.version !== 1 || typeof value.file !== "string") throw new Error(`${file}: unreadable setup receipt`);
  return value;
}
/** The PATH `bun` when it runs the same binary: a versioned real path (e.g. Homebrew Cellar) disappears on upgrade. */
export function stableRuntime(execPath: string = process.execPath, onPath: string | null = Bun.which("bun")): string {
  if (!onPath || !isAbsolute(onPath)) return execPath;
  try { return realpathSync(onPath) === realpathSync(execPath) ? onPath : execPath; } catch { return execPath; }
}
export function defaultEntry(): McpEntry {
  return { command: stableRuntime(), args: ["--smol", fileURLToPath(new URL("../bin/vmem.js", import.meta.url)), "mcp"] };
}
/**
 * Plan, apply or undo vmem MCP registration. Dry-run writes nothing. Apply is idempotent, edits only
 * the `vmem` server entry and records the prior value. Undo restores that prior value only while the
 * entry is still the one setup installed; a later user edit is left alone and reported as refused.
 */
export function runSetup(target: string, mode: SetupMode, options: { home: string; env?: NodeJS.ProcessEnv; cwd?: string; entry?: McpEntry }): SetupReport {
  const env = options.env ?? process.env, entry = options.entry ?? defaultEntry();
  if (target !== "all" && !(SETUP_TARGETS as readonly string[]).includes(target)) throw new Error(`setup: unknown target ${target}; use ${SETUP_TARGETS.join("|")}|all`);
  if (!isAbsolute(entry.command) || entry.args.some(arg => arg.includes("\0"))) throw new Error("setup: MCP command must be absolute");
  const table = hosts(env, options.cwd ?? process.cwd());
  const targets = target === "all" ? SETUP_TARGETS.filter(t => t !== "agy") : [target as SetupTarget];
  const report: SetupReport = { mode, applied: false, entry, actions: [], notes: [
    "Registers the stdio server `vmem mcp`; restart the host session to load it.",
    "Writes the acon console plugin manifest ($AGENTHUB_HOME/console/plugins/vmem.json); re-run setup after upgrading vmem.",
  ] };
  if (target === "all") report.notes.push("`all` covers user-level hosts; run `vmem setup agy` inside a workspace for Antigravity.");
  for (const name of targets) {
    const host = table[name], receiptPath = receiptFile(options.home, name, host.file);
    const action: SetupAction = { target: name, file: host.file, change: "none" };
    report.actions.push(action);
    try {
      const text = readText(host.file), current = readEntry(host, text), receipt = readReceipt(receiptPath);
      if (receipt && resolve(receipt.file) !== resolve(host.file)) throw new Error(`${receiptPath}: receipt belongs to ${receipt.file}, not ${host.file}`);
      if (mode === "undo") {
        if (!receipt) { action.change = "none"; action.reason = "no setup receipt"; continue; }
        if (current !== undefined && !isDeepStrictEqual(current, receipt.installed)) { action.change = "refused"; action.reason = "vmem entry changed after setup; left as is"; continue; }
        if (current === undefined) { action.change = "none"; action.reason = "vmem entry already absent; nothing restored"; unlinkSync(receiptPath); continue; }
        action.change = receipt.prior === undefined || receipt.prior === null ? "remove" : "restore";
        {
          let next = current === undefined ? text : putEntry(host, text, receipt.prior ?? undefined, receipt.priorToml, receipt.keyExisted === true);
          // A file setup created is removed again only when nothing else was added to it.
          if (!receipt.existed && next !== null && readEntry(host, next) === undefined && isDeepStrictEqual(host.format === "toml" ? Bun.TOML.parse(next) : JSON.parse(next), {})) next = null;
          if (next !== text && (next !== null || text !== null)) atomicWrite(host.file, next);
          unlinkSync(receiptPath);
        }
        continue;
      }
      if (isDeepStrictEqual(current, entry)) { action.change = "unchanged"; continue; }
      action.change = current === undefined ? "add" : "replace";
      if (mode === "apply") {
        const next = putEntry(host, text, entry);
        // Keep the original prior value across repeated applies.
        const prior: Receipt = receipt ?? { version: 1, target: name, file: host.file, existed: text !== null, keyExisted: hasKey(host, text), prior: current ?? null, ...(host.format === "toml" && current !== undefined ? { priorToml: tomlBlock(text) } : {}), installed: entry };
        // The receipt is durable before the host file changes; a failed host write rolls the receipt back.
        const previousReceipt = readText(receiptPath);
        atomicWrite(receiptPath, JSON.stringify({ ...prior, installed: entry }, null, 2) + "\n");
        try { atomicWrite(host.file, next); }
        catch (error) {
          try { atomicWrite(receiptPath, previousReceipt); }
          catch { throw new Error(`${error instanceof Error ? error.message : "host write failed"}; host unchanged, stale receipt kept at ${receiptPath}`); }
          throw error;
        }
      }
    } catch (error) {
      action.change = "refused"; action.reason = error instanceof Error ? error.message : "setup failed";
    }
  }
  report.console = consoleManifest(mode, env);
  report.applied = mode !== "dry-run" && [...report.actions, report.console].some(a => !["none", "unchanged", "refused"].includes(a.change));
  return report;
}

/** The acon plugin manifest: `{api, tool, module, sha256}` in the family home, dir 0700 and file 0600 as acon requires. */
export function consoleManifest(mode: SetupMode, env: NodeJS.ProcessEnv = process.env): ConsoleAction {
  const family = env.AGENTHUB_HOME?.trim() ? resolve(env.AGENTHUB_HOME) : join(env.HOME?.trim() || homedir(), ".agenthub");
  const dir = join(family, "console", "plugins"), file = join(dir, "vmem.json");
  const module = fileURLToPath(new URL("./ui/plugin.ts", import.meta.url));
  const action: ConsoleAction = { file, module, change: "none" };
  try {
    const next = { api: 1, tool: "vmem", module, sha256: createHash("sha256").update(readFileSync(module)).digest("hex") };
    // Apply acon's own loader rules (agent-console scanPlugins): the directory and manifest must be real, owned by you
    // and not writable by others. Kinds and owners are refused here; modes are fixed on apply.
    for (const [path, kind] of [[dir, "directory"], [file, "file"]] as const) {
      let info;
      try { info = lstatSync(path); } catch { continue; }
      if (kind === "directory" ? !info.isDirectory() : !info.isFile()) throw new Error(`${path}: acon needs a real ${kind}, not a link or other entry`);
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${path}: owned by another user; acon refuses it`);
    }
    const text = readText(file);
    const current = text === null ? undefined : JSON.parse(text) as Record<string, unknown>;
    if (mode === "undo") {
      if (!current) { action.reason = "no manifest"; return action; }
      if (current.module !== module) { action.change = "refused"; action.reason = "manifest points at another vmem install; left as is"; return action; }
      unlinkSync(file); action.change = "remove"; return action;
    }
    const loose = (path: string, want: number) => { try { return (lstatSync(path).mode & 0o777) !== want; } catch { return false; } };
    const modesOk = !loose(dir, 0o700) && !loose(file, 0o600);
    if (isDeepStrictEqual(current, next) && modesOk) { action.change = "unchanged"; return action; }
    action.change = current ? "replace" : "add";
    if (!modesOk) action.reason = "permissions: plugin directory 0700, manifest 0600";
    if (mode === "apply") {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      atomicWrite(file, JSON.stringify(next, null, 2) + "\n");
      chmodSync(file, 0o600);
    }
  } catch (error) {
    action.change = "refused"; action.reason = error instanceof Error ? error.message : "manifest write failed";
  }
  return action;
}
