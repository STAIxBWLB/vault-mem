import { tidyVault, TIDY_RULES } from "./tidy.ts";
import { originCheck } from "./sync.ts";
import { registryIds } from "./vault-log.ts";
import { runAnalysisCommand } from "./analysis-commands.ts";
import { runLogCommand } from "./log-commands.ts";
import { runOrgCommand } from "./org-commands.ts";
import { isWriteCommand, runWriteCommand } from "./write-commands.ts";
import { isReadCommand, runReadCommand } from "./read-commands.ts";
import { version } from "../package.json";
import { COMMANDS, completionScript, help } from "./commands-table.ts";
import { VMEM_TOOL_NAMES } from "./mcp-vault.ts";
import { CONFIG_VERSION } from "./config.ts";
import { runSetup, type SetupMode } from "./setup.ts";
import { resolveHome } from "./home.ts";
import { addVault, effectivePii, loadRegistry, recoverRegistry, registryStatus, removeVault, setVaultPii } from "./registry.ts";
import { piiPolicy } from "./pii.ts";
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
export function run(args: string[], env: NodeJS.ProcessEnv = process.env): { text: string; code: number } {
  if (!args.length || (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!))) return { text: help(), code: 0 };
  if (args.length === 1 && args[0] === "--version") return { text: version, code: 0 };
  if (args[0] === "manifest") {
    const { flags, positional } = parse(args.slice(1), ["--json"], []);
    if (positional.length) throw new Error("manifest: unexpected arguments");
    const manifest = { name: "@staix/vault-mem", version, configVersion: CONFIG_VERSION, mcp: { server: "vmem", tools: [...VMEM_TOOL_NAMES] }, commands: COMMANDS.map(c => c.name) };
    return { text: JSON.stringify(manifest, null, flags["--json"] ? undefined : 2), code: 0 };
  }
  if (args[0] === "setup") {
    const { flags, positional } = parse(args.slice(1), ["--apply", "--undo", "--json", "--root"], ["--root"]);
    if (positional.length !== 1 || (flags["--apply"] && flags["--undo"])) throw new Error("setup: requires one target and at most one of --apply/--undo");
    const mode: SetupMode = flags["--apply"] ? "apply" : flags["--undo"] ? "undo" : "dry-run";
    const report = runSetup(positional[0]!, mode, { home: resolveHome(env).home, env, ...(typeof flags["--root"] === "string" ? { root: flags["--root"] } : {}) });
    return { text: JSON.stringify(report, null, flags["--json"] ? undefined : 2), code: [...report.actions, report.console].some(a => a?.change === "refused") ? 1 : 0 };
  }
  if (args[0] === "completion") {
    if (args.length !== 2) throw new Error("completion: requires bash, zsh or fish");
    return { text: completionScript(args[1]!).trimEnd(), code: 0 };
  }
  if (args[0] === "lint" || args[0] === "graph") return runAnalysisCommand(args[0],args.slice(1),resolveHome(env).home,env);
  if (args[0] === "promote" || args[0] === "sync") return runOrgCommand(args[0], args.slice(1), resolveHome(env).home, env);
  if (args[0] === "log") return runLogCommand(args.slice(1), resolveHome(env).home, env);
  if (isWriteCommand(args[0]!)) return runWriteCommand(args[0]!, args.slice(1), resolveHome(env).home, env);
  if (isReadCommand(args[0]!)) return runReadCommand(args[0]!, args.slice(1), resolveHome(env).home);
  const command = args[0] === "vaults" ? `vaults ${args[1] ?? ""}` : args[0];
  const tail = args.slice(args[0] === "vaults" ? 2 : 1);
  const options = command === "vaults add" ? ["--kind", "--write", "--pii", "--remote", "--registry"] : command === "vaults pii" ? ["--set"] : [];
  const { flags, positional } = parse(tail, ["--json", ...options, ...(command === "vaults remove" || command === "vaults pii" || command === "recover" ? ["--confirm"] : [])], options);
  const home = resolveHome(env);
  let result: unknown, code = 0;
  switch (command) {
    case "status": case "doctor": {
      if (positional.length) throw new Error(`${command}: unexpected arguments`);
      const config = command === "doctor" ? loadRegistry(home.home) : undefined;
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
          try { registryIds(vault.registry, config!.denyPaths); checks.registry = { ok: true }; }
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
      const healthy = vaults.every(v => v.healthy && (!v.checks || Object.values(v.checks).every(check => check.ok)));
      result = { ...home, version, stage: "foundation", healthy, vaults };
      if (command === "doctor" && !healthy) code = 1;
      break;
    }
    case "recover":
      if (positional.length) throw new Error("recover: unexpected arguments");
      result = recoverRegistry(home.home, flags["--confirm"] === true);
      if ((result as { blocked?: string }).blocked) code = 1;
      break;
    case "vaults list":
      if (positional.length) throw new Error("vaults list: unexpected arguments");
      result = loadRegistry(home.home).vaults.map(v => ({ ...v, pii: effectivePii(v), piiPolicy: piiPolicy(v) }));
      break;
    case "vaults add": {
      if (positional.length !== 2) throw new Error("vaults add: requires id and absolute path");
      const value: Record<string, unknown> = { id: positional[0], path: positional[1] };
      for (const option of options) if (flags[option] !== undefined) value[option.slice(2)] = flags[option];
      result = { applied: true, vault: addVault(home.home, value) };
      break;
    }
    case "vaults pii": {
      if (positional.length !== 1) throw new Error("vaults pii: requires id");
      const raw = flags["--set"];
      if (raw === undefined && flags["--confirm"] === true) throw new Error("vaults pii: --confirm requires --set");
      let value: unknown;
      if (typeof raw === "string") { if (raw === "allow" || raw === "deny") value = raw; else { try { value = JSON.parse(raw); } catch { throw new Error("vaults pii: --set expects allow, deny or a JSON policy object"); } } }
      result = setVaultPii(home.home, positional[0]!, value, flags["--confirm"] === true);
      break;
    }
    case "vaults remove":
      if (positional.length !== 1) throw new Error("vaults remove: requires id");
      result = removeVault(home.home, positional[0]!, flags["--confirm"] === true);
      break;
    default: throw new Error(`unknown command: ${command}; use --help`);
  }
  return { text: JSON.stringify(result, null, flags["--json"] ? undefined : 2), code };
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
export async function runAsync(args: string[], env: NodeJS.ProcessEnv = process.env, io: { stdinIsTTY?: boolean } = {}): Promise<{ text: string; code: number }> {
  if (args[0] === "skills") {
    const { runSkillsCommand } = await import("./skills-mine.ts");
    return runSkillsCommand(args.slice(1), resolveHome(env).home, env);
  }
  if (args[0] !== "promote-from-amem") return run(args, env);
  const { runPromoteCommand } = await import("./promote-command.ts");
  return runPromoteCommand(args.slice(1), resolveHome(env).home, env, io);
}
export async function mainAsync(args: string[]): Promise<number> {
  try { const output = await runAsync(args, process.env, { stdinIsTTY: process.stdin.isTTY === true }); console.log(output.text); return output.code; }
  catch (error) { console.error(`vmem: ${error instanceof Error ? error.message : "operation failed"}`); return 1; }
}
export function main(args: string[]): number {
  try { const output = run(args); console.log(output.text); return output.code; }
  catch (error) { console.error(`vmem: ${error instanceof Error ? error.message : "operation failed"}`); return 1; }
}
