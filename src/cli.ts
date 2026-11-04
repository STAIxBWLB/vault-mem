import { runSpecCommand, specTools } from "./mcp-spec.ts";
import { tidyVault, TIDY_RULES } from "./tidy.ts";
import { originCheck } from "./sync.ts";
import { registryIds } from "./vault-log.ts";
import { runAnalysisCommand } from "./analysis-commands.ts";
import { runLogCommand } from "./log-commands.ts";
import { runOrgCommand } from "./org-commands.ts";
import { isWriteCommand, runWriteCommand } from "./write-commands.ts";
import { isReadCommand, runReadCommand } from "./read-commands.ts";
import { version } from "../package.json";
import { COMMANDS, commandUsage, completionScript, help } from "./commands-table.ts";
import { VMEM_TOOL_NAMES, vaultTools } from "./mcp-vault.ts";
import { CONFIG_VERSION, effectiveDomains } from "./config.ts";
import { runSetup, type SetupMode } from "./setup.ts";
import { resolveHome } from "./home.ts";
import { addVault, addSpec, removeSpec, specStatus, effectivePii, loadRegistry, recoverRegistry, registryStatus, removeVault, setVaultPii } from "./registry.ts";
import { piiPolicy } from "./pii.ts";
import { vaultStats } from "./vault-stats.ts";
import { PLAIN, shellWord, takeColorFlag, textOptions, type TextOptions } from "./text-output.ts";
import { renderDoctor, renderManifest, renderRecover, renderRemove, renderSetup, renderSpecAdd, renderSpecsList, renderStats, renderStatus, renderVaultAdd, renderVaultPii, renderVaultsList, type StatusResult } from "./cli-output.ts";
function parse(args: string[], allowed: string[], values: string[]) {
  const flags: Record<string, string | boolean> = {}, positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (!word.startsWith("-")) { positional.push(word); continue; }
    if (!allowed.includes(word) || word in flags) throw new Error(`unknown or repeated option: ${word}`);
    if (values.includes(word)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${word}: value required`);
      flags[word] = value;
    } else flags[word] = true;
  }
  return { flags, positional };
}
/** `vmem help <command>` and `<command> --help|-h`: that command's help entries. */
function commandHelp(args: string[], o: TextOptions): string | undefined {
  if (args[0] === "help" && args.length > 1) {
    const name = args.slice(1).join(" ");
    const text = commandUsage(name, o);
    if (!text) throw new Error(`help: unknown command ${name}; run vmem help for the command list`);
    return text;
  }
  if (args.includes("--")) return undefined;
  if (!["--help", "-h"].includes(args.at(-1) ?? "")) return undefined;
  const name = args.slice(0, -1).join(" ");
  if (!name) return undefined;
  return commandUsage(name, o);
}
/** Where the text goes; library callers and tests default to a non-terminal, `main` passes the real stdout. */
export interface Stdout { isTTY?: boolean; columns?: number }
/** Runs one command; `--color=auto|always|never` is taken off first and decides the text options for `stdout`. */
export function run(args: string[], env: NodeJS.ProcessEnv = process.env, stdout: Stdout = {}): { text: string; code: number } {
  const taken = takeColorFlag(args);
  return runWith(taken.args, env, textOptions(taken.color, env, stdout));
}
function runWith(args: string[], env: NodeJS.ProcessEnv, text: TextOptions = PLAIN): { text: string; code: number } {
  if (!args.length || (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!))) return { text: help(text), code: 0 };
  const usage = commandHelp(args, text);
  if (usage) return { text: usage, code: 0 };
  if (args.length === 1 && args[0] === "--version") return { text: version, code: 0 };
  if (args[0] === "manifest") {
    const { flags, positional } = parse(args.slice(1), ["--json"], []);
    if (positional.length) throw new Error("manifest: unexpected arguments");
    // Read-only tools are published as { name, readOnly: true } so installers can approve them without a hard-coded list.
    const readOnly = new Set([...vaultTools([]), ...specTools()].filter(t => t.annotations.readOnlyHint).map(t => t.name));
    const tools = VMEM_TOOL_NAMES.map(name => readOnly.has(name) ? { name, readOnly: true } : name);
    const manifest = { name: "@staix/vault-mem", version, configVersion: CONFIG_VERSION, mcp: { server: "vmem", tools }, commands: COMMANDS.map(c => c.name) };
    return { text: flags["--json"] ? JSON.stringify(manifest) : renderManifest(manifest, text), code: 0 };
  }
  if (args[0] === "setup") {
    const { flags, positional } = parse(args.slice(1), ["--apply", "--undo", "--json", "--root"], ["--root"]);
    if (positional.length !== 1 || (flags["--apply"] && flags["--undo"])) throw new Error("setup: requires one target and at most one of --apply/--undo");
    const mode: SetupMode = flags["--apply"] ? "apply" : flags["--undo"] ? "undo" : "dry-run";
    const report = runSetup(positional[0]!, mode, { home: resolveHome(env).home, env, ...(typeof flags["--root"] === "string" ? { root: flags["--root"] } : {}) });
    const apply = ["vmem", "setup", positional[0]!, "--apply", ...(typeof flags["--root"] === "string" ? ["--root", flags["--root"]] : [])].map(shellWord).join(" ");
    return { text: flags["--json"] ? JSON.stringify(report) : renderSetup(report, text, apply), code: [...report.actions, report.console].some(a => a?.change === "refused") ? 1 : 0 };
  }
  if (args[0] === "completion") {
    if (args.length !== 2) throw new Error("completion: requires bash, zsh or fish");
    return { text: completionScript(args[1]!).trimEnd(), code: 0 };
  }
  if (args[0] === "spec") return runSpecCommand(args.slice(1), env, text);
  if (args[0] === "lint" || args[0] === "graph") return runAnalysisCommand(args[0],args.slice(1),resolveHome(env).home,env,text);
  if (args[0] === "promote" || args[0] === "sync") return runOrgCommand(args[0], args.slice(1), resolveHome(env).home, env, text);
  if (args[0] === "log") return runLogCommand(args.slice(1), resolveHome(env).home, env, text);
  if (isWriteCommand(args[0]!)) return runWriteCommand(args[0]!, args.slice(1), resolveHome(env).home, env, text);
  if (isReadCommand(args[0]!)) return runReadCommand(args[0]!, args.slice(1), resolveHome(env).home, text);
  const group = args[0] === "vaults" || args[0] === "specs";
  const command = group ? `${args[0]} ${args[1] ?? ""}` : args[0];
  const tail = args.slice(group ? 2 : 1);
  const options = command === "vaults add" ? ["--kind", "--write", "--pii", "--remote", "--registry"] : command === "vaults pii" ? ["--set"] : command === "specs add" ? ["--write", "--pii"] : command === "stats" ? ["--days"] : [];
  const { flags, positional } = parse(tail, ["--json", ...options, ...(command === "vaults remove" || command === "specs remove" || command === "vaults pii" || command === "recover" ? ["--confirm"] : [])], options);
  const home = resolveHome(env);
  let result: unknown, code = 0, render: () => string;
  switch (command) {
    case "status": case "doctor": {
      if (positional.length) throw new Error(`${command}: unexpected arguments`);
      const config = loadRegistry(home.home);
      const vaults = registryStatus(home.home).map(vault => {
        if (command !== "doctor" || !vault.healthy) return { ...vault, checks: undefined };
        const checks: Record<string, { ok: boolean; issue?: string }> = {};
        if (vault.remote) {
          try {
            const checked = originCheck(vault.path, vault.remote, env);
            checks.remote = { ok: checked.ok, ...(checked.issue ? { issue: checked.issue } : {}) };
          } catch (error) { checks.remote = { ok: false, issue: error instanceof Error ? error.message : "git failed" }; }
        }
        if (vault.registry) {
          try { registryIds(vault.registry, config.denyPaths); checks.registry = { ok: true }; }
          catch (error) { checks.registry = { ok: false, issue: error instanceof Error ? error.message : "cannot read project registry" }; }
        }
        let preview: ReturnType<typeof tidyVault> | undefined;
        try {
          if (vault.write !== "none") preview = tidyVault(home.home, { vault: vault.id, rules: [...TIDY_RULES] }, { env, validate: false });
        } catch (error) { checks.tidy = { ok: false, issue: error instanceof Error ? error.message : "cannot preview migration tidy" }; }
        if (preview && !preview.ok) {
          const failures = preview.issues.filter(issue => issue.code !== "POLICY" && issue.code !== "PII_POLICY");
          if (failures.length) checks.tidy = { ok: false, issue: failures.map(issue => `${issue.code}: ${issue.message}`).join("; ") };
        }
        const unparsable = preview?.reported.filter(item => item.message.startsWith("unparsable note skipped")).map(item => item.path) ?? [];
        const tidy = preview?.ok && (preview.notes.length || unparsable.length || Object.values(preview.counts).some(count => count > 0))
          ? { pending: preview.counts, notes: preview.notes.length, unparsable, hint: `Run vmem tidy ${vault.id} --all, then confirm its preview fingerprint to apply the migration.` }
          : undefined;
        return { ...vault, checks: Object.keys(checks).length ? checks : undefined, ...(tidy ? { tidy } : {}) };
      });
      const sources = command === "doctor" && config.specs !== undefined ? specStatus(home.home, env) : undefined;
      const healthy = vaults.every(v => v.healthy && (!v.checks || Object.values(v.checks).every(check => check.ok))) && (!sources || sources.every(source => source.healthy));
      const status: StatusResult = { ...home, version, healthy, vaults, ...(config.specs !== undefined ? { specs: sources ?? config.specs } : {}) };
      result = status;
      render = () => command === "doctor" ? renderDoctor(status, text) : renderStatus(status, text);
      if (command === "doctor" && !healthy) code = 1;
      break;
    }
    case "stats": {
      if (positional.length !== 1) throw new Error("stats: requires one vault id; use vmem stats <vault> [--days 1..3650]");
      const days = flags["--days"];
      if (days !== undefined && !/^[0-9]+$/.test(String(days))) throw new Error("stats: --days expects an integer 1..3650; omit it for the 30-day default");
      const stats = vaultStats(home.home, positional[0]!, days === undefined ? {} : { days: Number(days) });
      result = stats; render = () => renderStats(stats, text);
      if (stats.log.issues.length) code = 1;
      break;
    }
    case "recover": {
      if (positional.length) throw new Error("recover: unexpected arguments");
      const report = recoverRegistry(home.home, flags["--confirm"] === true);
      result = report; render = () => renderRecover(report, text);
      if (report.blocked) code = 1;
      break;
    }
    case "specs list": {
      if (positional.length) throw new Error("specs list: unexpected targets; use vmem specs list [--json]");
      const specs = loadRegistry(home.home).specs ?? [];
      result = specs; render = () => renderSpecsList(specs, text);
      break;
    }
    case "specs add": {
      if (positional.length !== 2) throw new Error("specs add: requires id and absolute repository root; use vmem specs add <id> <absolute-path> [--write mcp|cli|none] [--pii allow|deny]");
      const value: Record<string, unknown> = { id: positional[0], path: positional[1] };
      for (const option of options) if (flags[option] !== undefined) value[option.slice(2)] = flags[option];
      const added = { applied: true, spec: addSpec(home.home, value, env) };
      result = added; render = () => renderSpecAdd(added, text);
      break;
    }
    case "specs remove": {
      if (positional.length !== 1) throw new Error("specs remove: requires one id; use vmem specs list, then vmem specs remove <id> [--confirm]");
      const removed = removeSpec(home.home, positional[0]!, flags["--confirm"] === true);
      result = removed; render = () => renderRemove("specs", removed, text);
      break;
    }
    case "vaults list": {
      if (positional.length) throw new Error("vaults list: unexpected arguments");
      const vaults = loadRegistry(home.home).vaults.map(v => ({ ...v, domains: effectiveDomains(v), pii: effectivePii(v), piiPolicy: piiPolicy(v) }));
      result = vaults; render = () => renderVaultsList(vaults, text);
      break;
    }
    case "vaults add": {
      if (positional.length !== 2) throw new Error("vaults add: requires id and absolute path");
      const value: Record<string, unknown> = { id: positional[0], path: positional[1] };
      for (const option of options) if (flags[option] !== undefined) value[option.slice(2)] = flags[option];
      const added = { applied: true, vault: addVault(home.home, value) };
      result = added; render = () => renderVaultAdd(added, text);
      break;
    }
    case "vaults pii": {
      if (positional.length !== 1) throw new Error("vaults pii: requires id");
      const raw = flags["--set"];
      if (raw === undefined && flags["--confirm"] === true) throw new Error("vaults pii: --confirm requires --set");
      let value: unknown;
      if (typeof raw === "string") { if (raw === "allow" || raw === "deny") value = raw; else { try { value = JSON.parse(raw); } catch { throw new Error("vaults pii: --set expects allow, deny or a JSON policy object"); } } }
      const pii = setVaultPii(home.home, positional[0]!, value, flags["--confirm"] === true);
      const confirm = typeof raw === "string" ? ["vmem", "vaults", "pii", positional[0]!, "--set", raw, "--confirm"].map(shellWord).join(" ") : undefined;
      result = pii; render = () => renderVaultPii(pii, text, confirm);
      break;
    }
    case "vaults remove": {
      if (positional.length !== 1) throw new Error("vaults remove: requires id");
      const removed = removeVault(home.home, positional[0]!, flags["--confirm"] === true);
      result = removed; render = () => renderRemove("vaults", removed, text);
      break;
    }
    default: throw new Error(`unknown command: ${command}; use --help`);
  }
  return { text: flags["--json"] ? JSON.stringify(result) : render(), code };
}
/**
 * `vmem mcp`: the vault set is fixed now; stdout carries protocol frames only. Every module a tool handler
 * loads lazily, the agent-mem root included, is loaded here at start, so an install replaced under a running
 * server never mixes two versions in one process.
 */
export async function runMcp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [{ serveMcp }, { createVaultMcp }, , , , seam] = await Promise.all([import("./mcp.ts"), import("./mcp-vault.ts"),
    import("./promote.ts"), import("./org-promote.ts"), import("./skills-mine.ts"), import("./amem/seam.ts")]);
  await seam.preloadAmem();
  const server = createVaultMcp(resolveHome(env).home, env);
  await serveMcp({ tools: server.tools, handlers: server.handlers, name: "vmem", version });
}
/** Async commands. Only `promote-from-amem` and `skills mine` load the agent-mem seam, and only when they run. */
export async function runAsync(argv: string[], env: NodeJS.ProcessEnv = process.env, io: { stdinIsTTY?: boolean; stdout?: Stdout } = {}): Promise<{ text: string; code: number }> {
  const taken = takeColorFlag(argv), args = taken.args, text = textOptions(taken.color, env, io.stdout ?? {});
  const usage = commandHelp(args, text);
  if (usage) return { text: usage, code: 0 };
  if (args[0] === "skills") {
    const { runSkillsCommand } = await import("./skills-mine.ts");
    return runSkillsCommand(args.slice(1), resolveHome(env).home, env, text);
  }
  if (args[0] !== "promote-from-amem") return runWith(args, env, text);
  const { runPromoteCommand } = await import("./promote-command.ts");
  return runPromoteCommand(args.slice(1), resolveHome(env).home, env, io, text);
}
export async function mainAsync(args: string[]): Promise<number> {
  try { const output = await runAsync(args, process.env, { stdinIsTTY: process.stdin.isTTY === true, stdout: process.stdout }); console.log(output.text); return output.code; }
  catch (error) { console.error(`vmem: ${error instanceof Error ? error.message : "operation failed"}`); return 1; }
}
export function main(args: string[]): number {
  try { const output = run(args, process.env, process.stdout); console.log(output.text); return output.code; }
  catch (error) { console.error(`vmem: ${error instanceof Error ? error.message : "operation failed"}`); return 1; }
}
