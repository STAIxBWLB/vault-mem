import { cellWidth } from "@staix/cli-output";
import { COMMANDS, FLAG_DESCRIPTIONS, commandFlags, commandUsage, flagDescription, help } from "../src/commands-table.ts";

// Usage: bun scripts/help-lint.ts. The help lint of #312 T2 over the command table; part of `bun run check`.
// Checks: summary form and limit; an example on every command with arguments; no help line over 80 columns on a pipe
// (with and without COLUMNS); every flag described; no description naming a flag no command has; examples that resolve
// against the dispatch table (the command and each flag must exist in that command's usage).

export interface LintEntry { name: string; usage: string; summary: string; examples: readonly string[] }
const GLOBAL = new Set(["--color", "--ascii"]);

export function helpLint(entries: readonly LintEntry[] = COMMANDS, descriptions: Record<string, string> = FLAG_DESCRIPTIONS, render = true): string[] {
  const problems: string[] = [];
  const nameWidth = Math.max(...entries.map(e => cellWidth(e.name)));
  const room = 80 - 2 - nameWidth - 2;
  for (const e of entries) {
    const where = `${e.name}:`;
    if (!e.summary) problems.push(`${where} no summary`);
    if (cellWidth(e.summary) > room) problems.push(`${where} summary is ${cellWidth(e.summary)} cells, over ${room} beside the widest name`);
    if (/[;]|\.$/.test(e.summary)) problems.push(`${where} summary has a semicolon or a trailing period`);
    if (/[^\x20-\x7e]/.test(e.summary)) problems.push(`${where} summary is not ASCII`);
    if (!/^[a-z]+\b/.test(e.summary) || /^(a|an|the|this|full-text)\b/.test(e.summary)) problems.push(`${where} summary does not start with an imperative verb`);
    const takesArgs = /<[^>]+>/.test(e.usage.slice(e.name.length));
    if (takesArgs && !e.examples.length) problems.push(`${where} takes arguments but has no example`);
    if (e.examples.length > 2) problems.push(`${where} more than two examples`);
    for (const { flag } of commandFlags(e)) if (!flagDescription(e.name, flag, descriptions)) problems.push(`${where} flag ${flag} has no description`);
    for (const { flag } of commandFlags(e)) {
      const text = flagDescription(e.name, flag, descriptions) ?? "";
      if (!["--json", "--color"].includes(flag) && cellWidth(text) > 46) problems.push(`${where} ${flag} description is ${cellWidth(text)} cells, over 46`);
    }
    const own = new Set(commandFlags(e).map(f => f.flag));
    for (const example of e.examples) {
      if (!example.startsWith(`vmem ${e.name}`) || (example.length > `vmem ${e.name}`.length && example[`vmem ${e.name}`.length] !== " ")) { problems.push(`${where} example does not run vmem ${e.name}: ${example}`); continue; }
      const longest = [...entries].filter(c => example === `vmem ${c.name}` || example.startsWith(`vmem ${c.name} `)).sort((a, b) => b.name.length - a.name.length)[0];
      if (longest?.name !== e.name) problems.push(`${where} example resolves to ${longest?.name ?? "no command"}: ${example}`);
      for (const flag of example.match(/(?<=\s)--[a-z][a-z0-9-]*/g) ?? []) if (!own.has(flag)) problems.push(`${where} example uses ${flag}, which ${e.name} does not take`);
    }
  }
  // A description key must name a flag some command takes (or a global flag), and a scoped key a real command.
  const allFlags = new Set([...entries.flatMap(e => commandFlags(e).map(f => f.flag)), ...GLOBAL]);
  const prefixes = new Set(entries.flatMap(e => e.name.split(" ").map((_, i, w) => w.slice(0, i + 1).join(" "))));
  for (const key of Object.keys(descriptions)) {
    const words = key.split(" "), flag = words.at(-1)!, scope = words.slice(0, -1).join(" ");
    if (!allFlags.has(flag)) problems.push(`FLAG_DESCRIPTIONS ${key}: names no flag of any command`);
    else if (scope && (!prefixes.has(scope) || !entries.some(e => (e.name === scope || e.name.startsWith(`${scope} `)) && commandFlags(e).some(f => f.flag === flag)))) problems.push(`FLAG_DESCRIPTIONS ${key}: no command under ${scope} takes ${flag}`);
    for (const named of descriptions[key]!.match(/--[a-z][a-z0-9-]*/g) ?? []) if (!allFlags.has(named)) problems.push(`FLAG_DESCRIPTIONS ${key}: names missing flag ${named}`);
  }
  if (render) {
    const views: [string, string][] = [];
    for (const columns of [undefined, 80]) {
      const o = { color: false, ...(columns ? { columns } : {}) };
      views.push([`help${columns ? " COLUMNS=80" : ""}`, help(o)]);
      for (const e of [...entries, { name: "help" }, { name: "--version" }]) views.push([`help ${e.name}${columns ? " COLUMNS=80" : ""}`, commandUsage(e.name, o) ?? ""]);
    }
    for (const [view, text] of views) for (const line of text.split("\n")) if (cellWidth(line) > 80) problems.push(`${view}: line of ${cellWidth(line)} cells: ${line.slice(0, 60)}`);
  }
  return problems;
}

if (import.meta.main) {
  const problems = helpLint();
  if (problems.length) {
    for (const p of problems) console.error(`help-lint: ${p}; fix the entry in src/commands-table.ts or src/spec-command-table.ts`);
    console.error(`help-lint: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`help-lint: ok (${COMMANDS.length} commands)`);
}
