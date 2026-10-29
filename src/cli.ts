import { isReadCommand, runReadCommand } from "./read-commands.ts";
import { version } from "../package.json";
import { help } from "./commands-table.ts";
import { resolveHome } from "./home.ts";
import { addVault, effectivePii, loadRegistry, recoverRegistry, registryStatus, removeVault } from "./registry.ts";
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
  if (isReadCommand(args[0]!)) return runReadCommand(args[0]!, args.slice(1), resolveHome(env).home);
  const command = args[0] === "vaults" ? `vaults ${args[1] ?? ""}` : args[0];
  const tail = args.slice(args[0] === "vaults" ? 2 : 1);
  const options = command === "vaults add" ? ["--kind", "--write", "--pii", "--remote", "--registry"] : [];
  const { flags, positional } = parse(tail, ["--json", ...options, ...(command === "vaults remove" || command === "recover" ? ["--confirm"] : [])], options);
  const home = resolveHome(env);
  let result: unknown, code = 0;
  switch (command) {
    case "status": case "doctor": {
      if (positional.length) throw new Error(`${command}: unexpected arguments`);
      const vaults = registryStatus(home.home), healthy = vaults.every(v => v.healthy);
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
      result = loadRegistry(home.home).vaults.map(v => ({ ...v, pii: effectivePii(v) }));
      break;
    case "vaults add": {
      if (positional.length !== 2) throw new Error("vaults add: requires id and absolute path");
      const value: Record<string, unknown> = { id: positional[0], path: positional[1] };
      for (const option of options) if (flags[option] !== undefined) value[option.slice(2)] = flags[option];
      result = { applied: true, vault: addVault(home.home, value) };
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
export function main(args: string[]): number {
  try { const output = run(args); console.log(output.text); return output.code; }
  catch (error) { console.error(`vmem: ${error instanceof Error ? error.message : "operation failed"}`); return 1; }
}
