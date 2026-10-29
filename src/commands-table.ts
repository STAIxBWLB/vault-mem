export const COMMANDS = [
  { name: "rebuild", usage: "rebuild <vault> [--json]", mutates: "cache" },
  { name: "search", usage: "search <vault> <query> [--type TYPE] [--domain DOMAIN] [--limit 1..500] [--json]", mutates: "cache" },
  { name: "show", usage: "show <vault> <target> [--max-bytes 1..65536] [--json]", mutates: "cache" },
  { name: "links", usage: "links <vault> <target> [--limit 1..500] [--json]", mutates: "cache" },
  { name: "status", usage: "status [--json]", mutates: false },
  { name: "doctor", usage: "doctor [--json]", mutates: false },
  { name: "recover", usage: "recover [--confirm] [--json]", mutates: "confirm" },
  { name: "vaults list", usage: "vaults list [--json]", mutates: false },
  { name: "vaults add", usage: "vaults add <id> <absolute-path> --kind personal|org --write mcp|cli|none [--pii allow|deny] [--remote URL] [--registry PATH] [--json]", mutates: true },
  { name: "vaults remove", usage: "vaults remove <id> [--confirm] [--json]", mutates: "confirm" },
] as const;
export function help(): string { return "vmem - vault registry and indexed reads\n\n" + COMMANDS.map(c => `  vmem ${c.usage}`).join("\n") + "\n\n  vmem --help | --version\n"; }
