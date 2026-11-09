import { SPEC_COMMANDS, type SpecCommand } from "./spec-command-table.ts";
import { version } from "../package.json";
import { paint, paragraph, width, wrap, type TextOptions } from "./text-output.ts";
/** One-line help per spec command; the longer SPEC_COMMANDS descriptions are the MCP tool descriptions. */
const SPEC_HELP: Record<SpecCommand, string> = {
  get: "read a spec's metadata, links and freshness; optionally page its body",
  graph: "read a bounded slice of the spec graph",
  grep: "search specs by terms or literal text with metadata filters",
  validate: "validate specs and report errors, warnings and freshness",
  update: "update spec frontmatter with validation, policy and expected SHA guards",
  create: "create a screened, validated spec with ordered metadata and type headings",
};
/** Help sections in print order; every COMMANDS entry names one. */
export const HELP_SECTIONS = ["Registry", "Read", "Write", "Log", "Analysis", "Promotion and sync", "Design specs", "Setup"] as const;
interface CommandEntry { name: string; usage: string; mutates: boolean | string; section: typeof HELP_SECTIONS[number]; description: string }
export const COMMANDS = [
  ...SPEC_COMMANDS.map(item => ({ name: `spec ${item.command}`, usage: item.usage, mutates: item.command === "update" || item.command === "create", section: "Design specs" as const, description: SPEC_HELP[item.command] })),
  { name: "lint", usage: "lint <vault> [--note PATH] [--write] [--dry-run] [--json]", mutates: "write", section: "Analysis", description: "lint links, schema, filenames and the log; --write saves a screened report" },
  { name: "graph build", usage: "graph build <vault> [--workspace] [--dry-run] [--json]", mutates: true, section: "Analysis", description: "build the vault graph, or the workspace graph with --workspace, under reports/" },
  { name: "graph neighbors", usage: "graph neighbors <vault> <stem> [--hops 1..2] [--limit 1..500] [--relation REL] [--json]", mutates: false, section: "Analysis", description: "read a note's graph neighborhood up to two hops, optionally over one link relation" },
  { name: "skills mine", usage: "skills mine <vault> [--days N] [--project KEY|--all-projects] [--vocab DIR] [--skills DIR] [--min-size N] [--min-novelty X] [--json]", mutates: false, section: "Analysis", description: "rank repeated work patterns in agent memory as new-skill candidates" },
  { name: "rebuild", usage: "rebuild <vault> [--json]", mutates: "cache", section: "Read", description: "rebuild the derived search index from the vault files" },
  { name: "search", usage: "search <vault> <query> [--type TYPE] [--domain DOMAIN] [--limit 1..500] [--json]", mutates: "cache", section: "Read", description: "full-text search notes, optionally by type and domain" },
  { name: "show", usage: "show <vault> <target> [--section TEXT] [--offset 0..2097152] [--max-bytes 1..65536] [--json]", mutates: "cache", section: "Read", description: "print a note's fields and body, paged by section, offset and size" },
  { name: "links", usage: "links <vault> <target> [--limit 1..500] [--json]", mutates: "cache", section: "Read", description: "list a note's outgoing, dead and incoming links" },
  { name: "status", usage: "status [--json]", mutates: false, section: "Registry", description: "show the home, registered vaults and spec sources, and vault health" },
  { name: "doctor", usage: "doctor [--json]", mutates: false, section: "Registry", description: "check vault paths, remotes, project registries, pending tidy and spec sources; exits 1 when unhealthy" },
  { name: "recover", usage: "recover [--confirm] [--json]", mutates: "confirm", section: "Registry", description: "preview, then remove with --confirm, a stale registry lock and leftover temporary files" },
  { name: "vaults list", usage: "vaults list [--json]", mutates: false, section: "Registry", description: "list registered vaults with kind, write policy and effective PII policy" },
  { name: "vaults add", usage: "vaults add <id> <absolute-path> --kind personal|org --write mcp|cli|none [--pii allow|deny] [--remote URL] [--registry PATH] [--json]", mutates: true, section: "Registry", description: "register a vault directory that contains notes/" },
  { name: "vaults remove", usage: "vaults remove <id> [--confirm] [--json]", mutates: "confirm", section: "Registry", description: "preview, then unregister with --confirm, a vault; its files stay on disk" },
  { name: "vaults pii", usage: "vaults pii <id> [--set allow|deny|JSON] [--confirm] [--json]", mutates: "confirm", section: "Registry", description: "show a vault's PII policy, or preview a new one and apply it with --confirm" },
  { name: "specs list", usage: "specs list [--json]", mutates: false, section: "Registry", description: "list registered spec sources" },
  { name: "specs add", usage: "specs add <id> <absolute-path> [--write mcp|cli|none] [--pii allow|deny] [--json]", mutates: true, section: "Registry", description: "register a git repository root as a spec source" },
  { name: "specs remove", usage: "specs remove <id> [--confirm] [--json]", mutates: "confirm", section: "Registry", description: "preview, then unregister with --confirm, a spec source; the repository stays" },
  { name: "new", usage: "new <vault> <stem> --type TYPE --domain DOMAIN --topics a,b --description TEXT [--title TEXT] [--source TEXT|JSON] [--confidence TEXT] [--status TEXT] [--body file|-] [--extra JSON] [--log JSON] [--dry-run] [--json]", mutates: true, section: "Write", description: "create a validated note" },
  { name: "patch", usage: "patch <vault> <note> [--old TEXT --new TEXT] [--edits file|-] [--expected-sha SHA] [--log JSON] [--dry-run] [--json]", mutates: true, section: "Write", description: "replace exact text in a note, or several replacements at once" },
  { name: "append", usage: "append <vault> <note> --section SECTION --markdown TEXT [--expected-sha SHA] [--log JSON] [--dry-run] [--json]", mutates: true, section: "Write", description: "append markdown under a section of a note" },
  { name: "frontmatter", usage: "frontmatter <vault> <note> [--set JSON] [--unset key,key] [--expected-sha SHA] [--log JSON] [--dry-run] [--json]", mutates: true, section: "Write", description: "set or unset frontmatter keys of a note" },
  { name: "link", usage: "link <vault> <from> <to> --relation R [--context TEXT] [--one-way] [--log JSON] [--dry-run] [--json]", mutates: true, section: "Write", description: "add a typed link between two notes, both ways unless --one-way" },
  { name: "supersede", usage: "supersede <vault> <old> <next> [--log JSON] [--dry-run] [--json]", mutates: true, section: "Write", description: "mark a note superseded by a newer one and link them" },
  { name: "move", usage: "move <vault> <from> <to> [--confirm --fingerprint SHA] [--log JSON] [--dry-run] [--json]", mutates: "confirm", section: "Write", description: "preview, then confirm with the fingerprint, a note move that rewrites links" },
  { name: "delete", usage: "delete <vault> <note> [--confirm --fingerprint SHA] [--log JSON] [--dry-run] [--json]", mutates: "confirm", section: "Write", description: "preview backlinks, then confirm with the fingerprint, a note deletion" },
  { name: "tidy", usage: "tidy <vault> [--connections] [--escapes] [--enums] [--keys] [--sources] [--topics] [--secrets] [--log] [--all] [--map file] [--confirm --fingerprint SHA] [--dry-run] [--json]", mutates: "confirm", section: "Write", description: "preview, then confirm with the fingerprint, migration tidy of notes and the log" },
  { name: "report", usage: "report <vault> <reports/path|ops/path> --body file|- [--log JSON] [--dry-run] [--json]", mutates: true, section: "Write", description: "write a screened file under reports/ or ops/" },
  { name: "check", usage: "check <vault> <file|-> [--path stem] [--json]", mutates: false, section: "Read", description: "validate a note file or stdin without writing it" },
  { name: "log tail", usage: "log tail <vault> [--limit 1..200] [--type TYPE] [--json]", mutates: false, section: "Log", description: "print the latest log events" },
  { name: "log grep", usage: "log grep <vault> <pattern> [--limit 1..200] [--type TYPE] [--json]", mutates: false, section: "Log", description: "search log events by pattern" },
  { name: "log append", usage: "log append <vault> <TYPE> <project> <source> <note> [--dest PATH] [--json]", mutates: true, section: "Log", description: "append one event to the vault log" },
  { name: "promote-from-amem", usage: "promote-from-amem <vault> [<mem-id>] [--project KEY|--all-projects] [--limit 1..200] [--stem STEM] [--type TYPE] [--domain DOMAIN] [--topics a,b] [--description TEXT] [--title TEXT] [--body file|-] [--link-to NOTE] [--log-project ID] [--edit] [--confirm --fingerprint SHA] [--json]", mutates: "confirm", section: "Promotion and sync", description: "list agent-mem candidates, or preview and confirm one as a note" },
  { name: "promote", usage: "promote <personal-vault> <note> --to ORG [--topics a,b] [--again] [--log-project ID] [--confirm --fingerprint SHA] [--json]", mutates: "confirm", section: "Promotion and sync", description: "preview, then confirm, copying a personal note into an org vault clone" },
  { name: "sync", usage: "sync <vault> [--message TEXT] [--confirm --fingerprint SHA] [--json]", mutates: "confirm", section: "Promotion and sync", description: "preview, then confirm, committing and pushing a vault to its remote" },
  { name: "mcp", usage: "mcp", mutates: false, section: "Setup", description: "serve the vmem MCP tools on stdio" },
  { name: "setup", usage: "setup <claude|codex|kimi|pi|qwen|jcode|agy|all> [--root PATH] [--apply|--undo] [--json]", mutates: "apply", section: "Setup", description: "preview, apply or undo the vmem MCP entry in agent hosts" },
  { name: "manifest", usage: "manifest [--json]", mutates: false, section: "Setup", description: "print the package version, MCP tools and command names" },
  { name: "completion", usage: "completion <bash|zsh|fish>", mutates: false, section: "Setup", description: "print a shell completion script built from this table" },
  { name: "stats", usage: "stats <vault> [--days 1..3650] [--json]", mutates: false, section: "Read", description: "count notes by type, domain and status, recent edits and log events" },
] as const satisfies readonly CommandEntry[];
const RELATIONS = ["supports", "contradicts", "extends", "applies-to", "context-for"] as const;
const LOG_EVENT_TYPES = ["INGEST", "ROUTE", "EXTRACT", "CONNECT", "DIGEST", "LEARN", "LINT", "TASK", "GRAPH", "SYNC", "RETHINK", "SOURCE"] as const;
const VALUE = /^--[a-z-]+ (?!\.\.\.)([A-Z]|[a-z0-9.|,-]+|file\|-|JSON|SHA|URL|PATH|TEXT)/;
export interface CompletionDefinition { path: string[]; options: Record<string, { value?: string | string[] }>; args: string[] }
/** Completion metadata derived from the usage strings, so help and completion cannot drift. */
export function completionDefinitions(): CompletionDefinition[] {
  return COMMANDS.map(command => {
    const words = command.name.split(" "), usage = command.usage.slice(command.name.length).trim();
    const options: CompletionDefinition["options"] = {}, args: string[] = [];
    for (const match of usage.matchAll(/--[a-z-]+(?: (?:[A-Za-z0-9.|,/][A-Za-z0-9.|,/-]*|-(?![-\w])))?|<([^>]+)>/g)) {
      if (match[1] !== undefined) { args.push(match[1]); continue; }
      const [flag, value] = match[0].split(" ") as [string, string | undefined];
      if (Object.hasOwn(options, flag)) continue;
      const nextFlag = value?.startsWith("--");
      options[flag] = value && !nextFlag && VALUE.test(match[0]) ? { value: /^[a-z]+(\|[a-z]+)+$/.test(value) ? value.split("|") : value } : {};
    }
    if (!["mcp", "completion"].includes(command.name)) options["--json"] ??= {};
    if (options["--relation"]) options["--relation"] = { value: [...RELATIONS] };
    if (command.name.startsWith("log ") && options["--type"]) options["--type"] = { value: [...LOG_EVENT_TYPES] };
    return { path: words, options, args };
  });
}
/** Static completion script. Lists subcommands, then the options of the typed command. */
export function completionScript(shell: string): string {
  if (!["bash", "zsh", "fish"].includes(shell)) throw new Error("completion: use bash, zsh or fish");
  const defs = completionDefinitions(), top = [...new Set(defs.map(d => d.path[0]!))].sort();
  const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
  if (shell === "fish") {
    const lines = [`complete -c vmem -f`, `complete -c vmem -n '__fish_use_subcommand' -a ${quote(top.join(" "))}`];
    for (const d of defs) {
      const cond = d.path.length === 1 ? `__fish_seen_subcommand_from ${d.path[0]}` : `__fish_seen_subcommand_from ${d.path[0]}; and __fish_seen_subcommand_from ${d.path[1]}`;
      for (const flag of Object.keys(d.options)) lines.push(`complete -c vmem -n ${quote(cond)} -l ${flag.slice(2)}`);
    }
    for (const parent of ["vaults", "specs", "spec", "log", "graph", "skills"]) lines.push(`complete -c vmem -n '__fish_seen_subcommand_from ${parent}; and test (commandline -opc)[2] = ${parent}' -a ${quote(defs.filter(d => d.path[0] === parent).map(d => d.path[1]).join(" "))}`);
    return lines.join("\n") + "\n";
  }
  const cases = defs.map(d => `    ${quote(d.path.join(" "))}) words=${quote(Object.keys(d.options).join(" "))} ;;`);
  const fn = `_vmem() {
  local cur key words
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=($(compgen -W ${quote(top.join(" "))} -- "$cur")); return; fi
  key="\${COMP_WORDS[1]}"
  case "$key" in spec) if [ "$COMP_CWORD" -eq 2 ]; then COMPREPLY=($(compgen -W '${SPEC_COMMANDS.map(item => item.command).join(" ")}' -- "$cur")); return; fi; key="$key \${COMP_WORDS[2]}" ;; graph) if [ "$COMP_CWORD" -eq 2 ]; then COMPREPLY=($(compgen -W 'build neighbors' -- "$cur")); return; fi; key="$key \${COMP_WORDS[2]}" ;; skills) if [ "$COMP_CWORD" -eq 2 ]; then COMPREPLY=($(compgen -W 'mine' -- "$cur")); return; fi; key="$key \${COMP_WORDS[2]}" ;; specs) if [ "$COMP_CWORD" -eq 2 ]; then COMPREPLY=($(compgen -W 'list add remove' -- "$cur")); return; fi; key="$key \${COMP_WORDS[2]}" ;; vaults|log) if [ "$COMP_CWORD" -eq 2 ]; then COMPREPLY=($(compgen -W "$( [ "$key" = vaults ] && echo 'list add remove' || echo 'tail grep append')" -- "$cur")); return; fi; key="$key \${COMP_WORDS[2]}" ;; esac
  case "$key" in
${cases.join("\n")}
    *) words='' ;;
  esac
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
`;
  return shell === "zsh" ? `autoload -U +X bashcompinit && bashcompinit\n${fn}complete -F _vmem vmem\n` : `${fn}complete -F _vmem vmem\n`;
}
const DESCRIPTION = 34;
/** Help lines that are not commands of their own, so completion and the manifest leave them out. */
const EXTRA_HELP = [
  { name: "help", section: "Setup", usage: "help [command]", description: "this help, or one command's entries; also <command> --help and -h" },
  { name: "--version", section: "Setup", usage: "--version", description: "print the installed version" },
] as const;
const OUTPUT_NOTE = "Output is text for people; --json prints the compact JSON object for scripts (every command but mcp and completion). --color=auto|always|never sets color: auto colors a terminal unless NO_COLOR is set or TERM is dumb.";
/** Usage at 2 spaces and the description at column 34, wrapped to the width (at most 100); a long usage puts its description below. */
function entryLines(entry: { usage: string; description: string }, o: TextOptions): string[] {
  const columns = o.columns === undefined ? undefined : Math.min(100, o.columns);
  const usage = wrap(`vmem ${entry.usage}`, columns === undefined ? undefined : columns - 4);
  const description = wrap(entry.description, columns === undefined ? undefined : columns - DESCRIPTION);
  const lines = [`  ${usage[0]}`];
  if (usage.length === 1 && width(lines[0]!) + 2 <= DESCRIPTION) lines[0] += " ".repeat(DESCRIPTION - width(lines[0]!)) + description.shift();
  return [...lines, ...usage.slice(1).map(line => `    ${line}`), ...description.map(line => " ".repeat(DESCRIPTION) + line)];
}
function sectionsText(entries: readonly { section: string; usage: string; description: string }[], o: TextOptions): string {
  return HELP_SECTIONS.map(section => entries.filter(entry => entry.section === section)).filter(group => group.length)
    .map(group => [paint(group[0]!.section, "bold", o), ...group.flatMap(entry => entryLines(entry, o))].join("\n")).join("\n\n");
}
/** `vmem help`: the tagline, then every command by section with its description. */
export function help(o: TextOptions = { color: false }): string {
  return [paragraph(`vmem ${version}: validated knowledge vaults for agents and people`, o), sectionsText([...COMMANDS, ...EXTRA_HELP], o),
    paint("Output", "bold", o) + "\n" + paragraph(OUTPUT_NOTE, o, undefined, "  ")].join("\n\n");
}
/** `vmem help <command>` and `<command> --help`: the entries of that command or command group, or undefined when none match. */
export function commandUsage(name: string, o: TextOptions = { color: false }): string | undefined {
  const entries = [...COMMANDS, ...EXTRA_HELP].filter(entry => entry.name === name || entry.name.startsWith(name + " "));
  return entries.length ? sectionsText(entries, o) : undefined;
}
