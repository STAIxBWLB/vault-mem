import { promoteToOrg } from "./org-promote.ts";
import { syncVault } from "./sync.ts";

function parse(command: string, args: string[], values: string[], booleans: string[]) {
  const flags: Record<string, string | boolean> = {}, positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (Object.hasOwn(flags, arg) || (!values.includes(arg) && !booleans.includes(arg))) throw new Error(`${command}: unknown or repeated option ${arg}`);
    if (booleans.includes(arg)) { flags[arg] = true; continue; }
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg}: value required`);
    flags[arg] = value;
  }
  return { flags, positional, value: (name: string) => typeof flags[name] === "string" ? flags[name] as string : undefined };
}
/** `vmem promote <vault> <note> --to <org>` and `vmem sync <vault>`: both preview unless `--confirm --fingerprint`. */
export function runOrgCommand(command: string, args: string[], home: string, env: NodeJS.ProcessEnv): { text: string; code: number } {
  if (command === "promote") {
    const { flags, positional, value } = parse(command, args, ["--to", "--topics", "--fingerprint", "--log-project"], ["--again", "--confirm", "--json"]);
    if (positional.length !== 2 || !value("--to")) throw new Error("promote: requires personal vault id, note and --to <org vault>");
    const result = promoteToOrg(home, { from: positional[0]!, note: positional[1]!, to: value("--to")!, again: flags["--again"] === true, confirm: flags["--confirm"] === true,
      ...(value("--topics") ? { topics: value("--topics")!.split(",").map(t => t.trim()).filter(Boolean) } : {}),
      ...(value("--fingerprint") ? { fingerprint: value("--fingerprint") } : {}), ...(value("--log-project") ? { logProject: value("--log-project") } : {}), channel: "cli" }, { env });
    return { text: JSON.stringify(result, null, flags["--json"] ? undefined : 2), code: result.ok ? 0 : 1 };
  }
  const { flags, positional, value } = parse(command, args, ["--fingerprint", "--message"], ["--confirm", "--json"]);
  if (positional.length !== 1) throw new Error("sync: requires vault id");
  const result = syncVault(home, { vault: positional[0]!, confirm: flags["--confirm"] === true, ...(value("--fingerprint") ? { fingerprint: value("--fingerprint") } : {}), ...(value("--message") ? { message: value("--message") } : {}) }, { env });
  return { text: JSON.stringify(result, null, flags["--json"] ? undefined : 2), code: result.ok ? 0 : 1 };
}
