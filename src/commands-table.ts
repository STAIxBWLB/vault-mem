export const COMMANDS = [
  { name: "lint", usage: "lint <vault> [--note PATH] [--write] [--dry-run] [--json]", mutates: "write" },
  { name: "graph build", usage: "graph build <vault> [--dry-run] [--json]", mutates: true },
  { name: "graph neighbors", usage: "graph neighbors <vault> <stem> [--hops 1..2] [--limit 1..500] [--json]", mutates: false },
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
  { name: "new", usage: "new <vault> <stem> --type TYPE --domain DOMAIN --topics a,b --description TEXT [--title TEXT] [--source TEXT] [--confidence TEXT] [--status TEXT] [--body file|-] [--extra JSON] [--dry-run] [--json]", mutates: true },
  { name: "patch", usage: "patch <vault> <note> --old TEXT --new TEXT [--expected-sha SHA] [--dry-run] [--json]", mutates: true },
  { name: "append", usage: "append <vault> <note> --section SECTION --markdown TEXT [--expected-sha SHA] [--dry-run] [--json]", mutates: true },
  { name: "frontmatter", usage: "frontmatter <vault> <note> [--set JSON] [--unset key,key] [--expected-sha SHA] [--dry-run] [--json]", mutates: true },
  { name: "link", usage: "link <vault> <from> <to> --relation R [--context TEXT] [--one-way] [--dry-run] [--json]", mutates: true },
  { name: "supersede", usage: "supersede <vault> <old> <next> [--dry-run] [--json]", mutates: true },
  { name: "move", usage: "move <vault> <from> <to> [--confirm --fingerprint SHA] [--dry-run] [--json]", mutates: "confirm" },
  { name: "delete", usage: "delete <vault> <note> [--confirm --fingerprint SHA] [--dry-run] [--json]", mutates: "confirm" },
  { name: "tidy", usage: "tidy <vault> --connections [--confirm --fingerprint SHA] [--dry-run] [--json]", mutates: "confirm" },
  { name: "report", usage: "report <vault> <reports/path|ops/path> --body file|- [--dry-run] [--json]", mutates: true },
  { name: "check", usage: "check <vault> <file|-> [--path stem] [--json]", mutates: false },
  { name: "log tail", usage: "log tail <vault> [--limit 1..200] [--type TYPE] [--json]", mutates: false },
  { name: "log grep", usage: "log grep <vault> <pattern> [--limit 1..200] [--type TYPE] [--json]", mutates: false },
  { name: "log append", usage: "log append <vault> <TYPE> <project> <source> <note> [--dest PATH] [--json]", mutates: true },
  { name: "promote-from-amem", usage: "promote-from-amem <vault> [<mem-id>] [--project KEY|--all-projects] [--limit 1..200] [--stem STEM] [--type TYPE] [--domain DOMAIN] [--topics a,b] [--description TEXT] [--title TEXT] [--body file|-] [--link-to NOTE] [--log-project ID] [--edit] [--confirm --fingerprint SHA] [--json]", mutates: "confirm" },
  { name: "promote", usage: "promote <personal-vault> <note> --to ORG [--topics a,b] [--again] [--log-project ID] [--confirm --fingerprint SHA] [--json]", mutates: "confirm" },
  { name: "sync", usage: "sync <vault> [--message TEXT] [--confirm --fingerprint SHA] [--json]", mutates: "confirm" },
  { name: "mcp", usage: "mcp", mutates: false },
  { name: "setup", usage: "setup <claude|codex|kimi|pi|qwen|jcode|agy|all> [--apply|--undo] [--json]", mutates: "apply" },
  { name: "completion", usage: "completion <bash|zsh|fish>", mutates: false },
] as const;
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
      const cond = d.path.length === 1 ? `__fish_seen_subcommand_from ${d.path[0]}` : `__fish_seen_subcommand_from ${d.path[1]}`;
      for (const flag of Object.keys(d.options)) lines.push(`complete -c vmem -n ${quote(cond)} -l ${flag.slice(2)}`);
    }
    for (const parent of ["vaults", "log", "graph"]) lines.push(`complete -c vmem -n '__fish_seen_subcommand_from ${parent}' -a ${quote(defs.filter(d => d.path[0] === parent).map(d => d.path[1]).join(" "))}`);
    return lines.join("\n") + "\n";
  }
  const cases = defs.map(d => `    ${quote(d.path.join(" "))}) words=${quote(Object.keys(d.options).join(" "))} ;;`);
  const fn = `_vmem() {
  local cur key words
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=($(compgen -W ${quote(top.join(" "))} -- "$cur")); return; fi
  key="\${COMP_WORDS[1]}"
  case "$key" in graph) if [ "$COMP_CWORD" -eq 2 ]; then COMPREPLY=($(compgen -W 'build neighbors' -- "$cur")); return; fi; key="$key \${COMP_WORDS[2]}" ;; vaults|log) if [ "$COMP_CWORD" -eq 2 ]; then COMPREPLY=($(compgen -W "$( [ "$key" = vaults ] && echo 'list add remove' || echo 'tail grep append')" -- "$cur")); return; fi; key="$key \${COMP_WORDS[2]}" ;; esac
  case "$key" in
${cases.join("\n")}
    *) words='' ;;
  esac
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
`;
  return shell === "zsh" ? `autoload -U +X bashcompinit && bashcompinit\n${fn}complete -F _vmem vmem\n` : `${fn}complete -F _vmem vmem\n`;
}
export function help(): string { return "vmem - validated knowledge vaults for agents and people\n\n" + COMMANDS.map(c => `  vmem ${c.usage}`).join("\n") + "\n\n  vmem --help | --version\n"; }
