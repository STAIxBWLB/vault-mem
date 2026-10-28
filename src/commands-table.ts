export const COMMANDS = [
  { name: "status", usage: "status [--json]", mutates: false },
  { name: "doctor", usage: "doctor [--json]", mutates: false },
  { name: "vaults list", usage: "vaults list [--json]", mutates: false },
  { name: "vaults add", usage: "vaults add <id> <absolute-path> --kind personal|org --write mcp|cli|none [--pii allow|deny] [--remote URL] [--registry PATH] [--json]", mutates: true },
  { name: "vaults remove", usage: "vaults remove <id> [--confirm] [--json]", mutates: "confirm" },
] as const;
export function help(): string { return "vmem - vault registry foundation\n\n" + COMMANDS.map(c => `  vmem ${c.usage}`).join("\n") + "\n\n  vmem --help | --version\n"; }
