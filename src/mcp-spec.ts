import { argumentError, type McpHandler, type McpTool } from "./mcp.ts";
import { SPEC_COMMANDS } from "./spec-command-table.ts";
import { executeSpecCommand } from "./spec-commands.ts";
import { validateSpecRepo } from "./spec-validate.ts";
import { resolveHome } from "./home.ts";
import { loadRegistry } from "./registry.ts";
import { PLAIN, type TextOptions } from "./text-output.ts";
import { renderSpec } from "./spec-output.ts";

/** Spec tool definitions; every spec tool is read-only. */
export const specTools = (): McpTool[] => SPEC_COMMANDS.map(item => ({ name: item.name, description: item.description, inputSchema: item.inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));

export function createSpecMcp(home: string, env: NodeJS.ProcessEnv = process.env): { tools: McpTool[]; handlers: Record<string, McpHandler> } {
  const registered = loadRegistry(home).specs ?? [];
  const tools = specTools();
  const handlers: Record<string, McpHandler> = {};
  for (const item of SPEC_COMMANDS) handlers[item.name] = args => {
    const invalid = argumentError(args, item.inputSchema);
    if (invalid) throw new Error(invalid);
    const selected = registered.find(source => source.id === (args.source ?? registered[0]?.id));
    if (!selected) throw new Error("spec source: no matching source in the server's startup registry; pass the source argument with a registered id, or register with vmem specs add and restart the MCP server");
    const current = loadRegistry(home).specs?.find(source => source.id === selected.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(selected)) throw new Error("spec source: registry changed since server startup; restart the MCP server before reading");
    return executeSpecCommand(home, item.command, { ...args, source: selected.id }, env);
  };
  return { tools, handlers };
}

/** Parse with the same bounded field schemas as MCP. --repo deliberately bypasses home resolution. */
export function runSpecCommand(args: string[], env: NodeJS.ProcessEnv = process.env, text: TextOptions = PLAIN): { text: string; code: number } {
  const item = SPEC_COMMANDS.find(entry => entry.command === args[0]);
  if (!item) throw new Error("spec: unknown command; use vmem spec --help");
  const values: Record<string, unknown> = {}, positional: string[] = [];
  const properties = item.inputSchema.properties as Record<string, { type: string }>;
  const flags = new Map(Object.keys(properties).filter(key => key !== "id" && key !== "query").map(key => ["--" + key.replace(/[A-Z]/g, value => "-" + value.toLowerCase()), key]));
  const seen = new Set<string>(); let json = false, repo: string | undefined, positionalOnly = false;
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (positionalOnly || !flag.startsWith("-")) { positional.push(flag); continue; }
    if (flag === "--") { positionalOnly = true; continue; }
    if (seen.has(flag)) throw new Error(`spec ${item.command}: repeated option ${flag}; supply it once (vmem spec ${item.command} --help)`);
    seen.add(flag);
    if (flag === "--json") { json = true; continue; }
    const key = flags.get(flag);
    if (!key && !(flag === "--repo" && item.command === "validate")) throw new Error(`spec ${item.command}: unknown option ${flag}; see vmem spec ${item.command} --help`);
    if (key && properties[key]!.type === "boolean") { values[key] = true; continue; }
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag}: value required; see vmem spec ${item.command} --help`);
    if (flag === "--repo") {
      const invalidPath = argumentError(value, { type: "string", minLength: 1, maxLength: 4096 }, "repo");
      if (invalidPath) throw new Error(`${invalidPath}; supply a checkout path with vmem spec validate --repo PATH`);
      repo = value; continue;
    }
    if (properties[key!]!.type === "integer") {
      if (!/^[0-9]+$/.test(value)) throw new Error(`${flag}: expected integer; see vmem spec ${item.command} --help for its bounds`);
      values[key!] = Number(value);
    } else values[key!] = value;
  }
  const takesId = item.command === "get" || item.command === "graph";
  if (positional.length > (item.command === "validate" ? 0 : 1) || (takesId && positional.length !== 1)) throw new Error(`spec ${item.command}: unexpected targets; use vmem ${item.usage}`);
  if (positional[0] !== undefined) values[takesId ? "id" : "query"] = positional[0];
  const invalid = argumentError(values, item.inputSchema);
  if (invalid) throw new Error(`${invalid}; see vmem spec ${item.command} --help to correct the arguments`);
  if (repo !== undefined && (values.source !== undefined || values.worktree !== undefined)) throw new Error("--repo cannot be combined with --source or --worktree; choose registry-free or registered validation");
  const result = repo !== undefined
    ? validateSpecRepo(repo, { requireFresh: values.requireFresh as boolean | undefined, limit: values.limit as number | undefined, env }).report
    : executeSpecCommand(resolveHome(env).home, item.command, values, env);
  const code = item.command === "validate" && !(result as { ok: boolean }).ok ? 1 : 0;
  return { text: json ? JSON.stringify(result) : renderSpec(item.command, result, text, { args, values, ...(repo !== undefined ? { repo } : {}) }), code };
}
