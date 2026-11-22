import { cellWidth, paint, Report, wrap as wrapCells } from "@staix/cli-output";
import { SPEC_COMMANDS, type SpecCommand } from "./spec-command-table.ts";
import { version } from "../package.json";
import type { TextOptions } from "./text-output.ts";
/** One-line help per spec command; the longer SPEC_COMMANDS descriptions are the MCP tool descriptions. */
/** Overview summaries and examples for the spec commands. */
const SPEC_SUMMARY: Record<SpecCommand, [string, string[]]> = {
  get: ["read a spec's metadata, links and freshness", ["vmem spec get root", "vmem spec get root --body --max-bytes 4096"]],
  graph: ["read a bounded slice of the spec graph", ["vmem spec graph root --direction subtree --depth 2"]],
  grep: ["search specs by terms or literal text", ["vmem spec grep freshness --type module"]],
  validate: ["validate specs and report freshness", ["vmem spec validate --require-fresh", "vmem spec validate --repo /home/me/app"]],
  create: ["create a screened, validated spec", ["vmem spec create docs/specs/cache.md --id cache --type module --title Cache"]],
  update: ["update spec frontmatter with guards", ["vmem spec update cache --set '{\"status\":\"active\"}'"]],
  delete: ["preview, then confirm, deleting a spec", ["vmem spec delete cache"]],
};
const SPEC_HELP: Record<SpecCommand, string> = {
  get: "read a spec's metadata, links and freshness; optionally page its body",
  graph: "read a bounded slice of the spec graph",
  grep: "search specs by terms or literal text with metadata filters",
  validate: "validate specs and report errors, warnings and freshness",
  update: "update spec frontmatter with validation, policy and expected SHA guards",
  create: "create a screened, validated spec with ordered metadata and type headings",
  delete: "preview backlinks and children, then confirm a spec deletion with its fingerprint",
};
/** Help sections in print order; every COMMANDS entry names one. */
export const HELP_SECTIONS = ["Registry", "Read", "Write", "Log", "Analysis", "Promotion and sync", "Design specs", "Setup"] as const;
/**
 * `usage` is the usage line (alternative forms joined by " | ", printed one per line); `summary` the overview phrase;
 * `description` the long text printed under Details; `examples` complete commands for a command that takes arguments.
 */
interface CommandEntry { name: string; usage: string; mutates: boolean | string; section: typeof HELP_SECTIONS[number]; description: string; summary: string; examples: readonly string[] }
export const COMMANDS = [
  ...SPEC_COMMANDS.map(item => ({ name: `spec ${item.command}`, usage: item.usage, mutates: ["create", "update", "delete"].includes(item.command), section: "Design specs" as const, description: SPEC_HELP[item.command], summary: SPEC_SUMMARY[item.command][0], examples: SPEC_SUMMARY[item.command][1] })),
  { name: "proposal submit", usage: "proposal submit <vault> <file|-> [--agent-label TEXT] [--json]", mutates: true, section: "Write", description: "screen and save one create or exact-patch proposal from JSON", summary: "screen and save one note proposal from JSON", examples: ["vmem proposal submit personal proposal.json"] },
  { name: "proposal list", usage: "proposal list <vault> [--state STATE] [--limit 1..100] [--after ID] [--json]", mutates: false, section: "Read", description: "list screened proposal summaries, pending by default", summary: "list screened proposals, pending by default", examples: ["vmem proposal list personal --state pending"] },
  { name: "proposal show", usage: "proposal show <vault> <id> [--offset N] [--max-bytes 1..16384] [--json]", mutates: false, section: "Read", description: "read a screened proposal operation in bounded pages", summary: "read one screened proposal in bounded pages", examples: ["vmem proposal show personal \"$ID\""] },
  { name: "proposal apply", usage: "proposal apply <vault> <id> [--confirm --fingerprint SHA] [--json]", mutates: "confirm", section: "Write", description: "preview or confirm a proposal using the current writer plan", summary: "preview, then confirm, applying a proposal", examples: ["vmem proposal apply personal \"$ID\""] },
  { name: "proposal reject", usage: "proposal reject <vault> <id> --reason TEXT [--confirm --fingerprint SHA] [--json]", mutates: "confirm", section: "Write", description: "preview or confirm a rejection without changing the vault", summary: "preview, then confirm, rejecting a proposal", examples: ["vmem proposal reject personal \"$ID\" --reason duplicate"] },
  { name: "proposal reconcile", usage: "proposal reconcile <vault> <id> [--confirm --fingerprint SHA] [--json]", mutates: "confirm", section: "Write", description: "preview or confirm receipt-backed reconciliation of an uncertain apply", summary: "reconcile an uncertain proposal apply from its receipt", examples: ["vmem proposal reconcile personal \"$ID\""] },
  { name: "lint", usage: "lint <vault> [--note PATH] [--write] [--dry-run] [--json]", mutates: "write", section: "Analysis", description: "lint links, schema, filenames and the log; --write saves a screened report", summary: "lint links, schema, filenames and the log", examples: ["vmem lint personal", "vmem lint personal --write"] },
  { name: "graph build", usage: "graph build <vault> [--workspace] [--dry-run] [--json]", mutates: true, section: "Analysis", description: "build the vault graph, or the workspace graph with --workspace, under reports/", summary: "build the vault or workspace graph under reports/", examples: ["vmem graph build personal", "vmem graph build personal --workspace --dry-run"] },
  { name: "graph neighbors", usage: "graph neighbors <vault> <stem> [--hops 1..2] [--limit 1..500] [--relation REL] [--json]", mutates: false, section: "Analysis", description: "read a note's graph neighborhood up to two hops, optionally over one link relation", summary: "read a note's graph neighborhood up to two hops", examples: ["vmem graph neighbors personal example-finding --hops 2"] },
  { name: "graph path", usage: "graph path <vault> <from> <to> [--max-hops 1..6] [--relation REL] [--via-hubs] [--json]", mutates: false, section: "Analysis", description: "read the shortest link path between two notes, skipping MOC/bu hubs unless --via-hubs", summary: "read the shortest link path between two notes", examples: ["vmem graph path personal example-finding other-finding"] },
  { name: "graph explain", usage: "graph explain <vault> <from> <to> [--max-hops 1..6] [--relation REL] [--via-hubs] [--json]", mutates: false, section: "Analysis", description: "explain each hop of the shortest path by its source link occurrences; structural only", summary: "explain each hop of the shortest path by its links", examples: ["vmem graph explain personal example-finding other-finding"] },
  { name: "skills export", usage: "skills export <dir> [--json]", mutates: true, section: "Setup", description: "export self-contained vmem skills to a directory", summary: "export self-contained vmem skills to a directory", examples: ["vmem skills export ./vmem-skills"] },
  { name: "skills mine", usage: "skills mine <vault> [--days N] [--project KEY|--all-projects] [--vocab DIR] [--skills DIR]... [--min-size N] [--min-novelty 0..1] [--json]", mutates: false, section: "Analysis", description: "rank repeated work patterns in agent memory as new-skill candidates", summary: "rank repeated work patterns as new-skill candidates", examples: ["vmem skills mine personal --days 30"] },
  { name: "rebuild", usage: "rebuild <vault> [--json]", mutates: "cache", section: "Read", description: "rebuild the derived search index from the vault files", summary: "rebuild the derived search index from the vault files", examples: ["vmem rebuild personal"] },
  { name: "brief", usage: "brief <vault> --for INTENT [--paths PATH]... [--bytes 256..4096] [--json]", mutates: "cache", section: "Read", description: "rank screened note pointers and one-hop neighbors within a byte cap", summary: "rank note pointers for an intent within a byte cap", examples: ["vmem brief personal --for release-checklist --bytes 1024"] },
  { name: "search", usage: "search <vault> <query> [--type TYPE] [--domain DOMAIN] [--limit 1..500] [--json]", mutates: "cache", section: "Read", description: "full-text search notes, optionally by type and domain", summary: "search notes by full text, type and domain", examples: ["vmem search personal lanterns", "vmem search personal lanterns --type insight --limit 20"] },
  { name: "show", usage: "show <vault> <target> [--revision OID] [--section TEXT] [--offset 0..2097152] [--max-bytes 1..65536] [--json]", mutates: "cache", section: "Read", description: "print a note's fields and body, paged by section, offset and size, or one historical Git blob with --revision", summary: "print a note's fields and body, or a past revision", examples: ["vmem show personal example-finding", "vmem show personal example-finding --section Evidence"] },
  { name: "assertions", usage: "assertions <vault> [--subject SUBJECT] [--relation REL] [--at DATE] [--as-of INSTANT|DATE] [--history] [--limit N] [--cursor CURSOR] [--json]", mutates: false, section: "Read", description: "read verified temporal assertions with current policy and bounded pages", summary: "read verified temporal assertions in bounded pages", examples: ["vmem assertions personal --subject notes/example-finding.md"] },
  { name: "assertions purge", usage: "assertions purge <vault> <assertion-id> --reason TEXT [--confirm --fingerprint SHA] [--json]", mutates: "confirm", section: "Write", description: "preview, then confirm with the fingerprint, removal of one assertion's payloads from the journal", summary: "preview, then confirm, purging one assertion's payloads", examples: ["vmem assertions purge personal a:0001:12 --reason privacy"] },
  { name: "assertions exposure", usage: "assertions exposure <vault> [<assertion-id>] [--replace-file PATH] [--json]", mutates: false, section: "Read", description: "report purged payloads still reachable in Git history, and write a git-filter-repo replace file on request", summary: "report purged payloads still reachable in Git", examples: ["vmem assertions exposure personal"] },
  { name: "evidence", usage: "evidence <vault> <note> [--json]", mutates: false, section: "Read", description: "verify a note's evidence quotes against same-vault source notes; read-only, no cache", summary: "verify a note's evidence quotes against source notes", examples: ["vmem evidence personal example-finding"] },
  { name: "links", usage: "links <vault> <target> [--limit 1..500] [--json]", mutates: "cache", section: "Read", description: "list a note's outgoing, dead and incoming links", summary: "list a note's outgoing, dead and incoming links", examples: ["vmem links personal example-finding"] },
  { name: "history", usage: "history <vault> <note> [--limit 1..100] [--cursor CURSOR] [--json]", mutates: false, section: "Read", description: "list one note path's Git snapshot revisions newest first, pinned to the HEAD the page started from", summary: "list one note's Git snapshot revisions, newest first", examples: ["vmem history personal example-finding --limit 10"] },
  { name: "changes", usage: "changes <vault> --from OID --to OID [--limit 1..500] [--cursor CURSOR] [--json]", mutates: false, section: "Read", description: "compare two pinned Git snapshots over notes/ with before/after blob ids and status", summary: "compare two Git snapshots of notes/", examples: ["vmem changes personal --from \"$FROM\" --to \"$TO\""] },
  { name: "status", usage: "status [--json]", mutates: false, section: "Registry", description: "show the home, registered vaults and spec sources, and vault health", summary: "show the home, vaults, spec sources and vault health", examples: [] },
  { name: "settings", usage: "settings <vault> [--set JSON] [--confirm --fingerprint SHA] [--json]", mutates: "confirm", section: "Registry", description: "read settings or preview and confirm a settings change", summary: "read settings, or preview and confirm a change", examples: ["vmem settings personal"] },
  { name: "doctor", usage: "doctor [--json]", mutates: false, section: "Registry", description: "check vault paths, remotes, project registries, pending tidy and spec sources; exits 1 when unhealthy", summary: "check vaults, remotes, registries and spec sources", examples: [] },
  { name: "recover", usage: "recover [--confirm] [--json]", mutates: "confirm", section: "Registry", description: "preview, then remove with --confirm, a stale registry lock and leftover temporary files", summary: "preview, then remove, a stale lock and temporary files", examples: [] },
  { name: "vaults list", usage: "vaults list [--json]", mutates: false, section: "Registry", description: "list registered vaults with kind, write policy and effective PII policy", summary: "list registered vaults with their policies", examples: [] },
  { name: "vaults add", usage: "vaults add <id> <absolute-path> --kind personal|org --write mcp|cli|none [--pii allow|deny] [--remote URL] [--registry PATH] [--json]", mutates: true, section: "Registry", description: "register a vault directory that contains notes/", summary: "register a vault directory that contains notes/", examples: ["vmem vaults add personal /home/me/vault --kind personal --write mcp"] },
  { name: "vaults remove", usage: "vaults remove <id> [--confirm] [--json]", mutates: "confirm", section: "Registry", description: "preview, then unregister with --confirm, a vault; its files stay on disk", summary: "preview, then unregister, a vault and keep its files", examples: ["vmem vaults remove personal"] },
  { name: "vaults pii", usage: "vaults pii <id> [--set allow|deny|JSON] [--confirm] [--json]", mutates: "confirm", section: "Registry", description: "show a vault's PII policy, or preview a new one and apply it with --confirm", summary: "show or change a vault's PII policy", examples: ["vmem vaults pii personal", "vmem vaults pii personal --set deny"] },
  { name: "specs list", usage: "specs list [--json]", mutates: false, section: "Registry", description: "list registered spec sources", summary: "list registered spec sources", examples: [] },
  { name: "specs add", usage: "specs add <id> <absolute-path> [--write mcp|cli|none] [--pii allow|deny] [--json]", mutates: true, section: "Registry", description: "register a git repository root as a spec source", summary: "register a git repository root as a spec source", examples: ["vmem specs add app /home/me/app"] },
  { name: "specs remove", usage: "specs remove <id> [--confirm] [--json]", mutates: "confirm", section: "Registry", description: "preview, then unregister with --confirm, a spec source; the repository stays", summary: "preview, then unregister, a spec source", examples: ["vmem specs remove app"] },
  { name: "new", usage: "new <vault> <stem> --type TYPE --domain DOMAIN --topics A,B --description TEXT [--title TEXT] [--source TEXT|JSON] [--confidence TEXT] [--status TEXT] [--body FILE|-] [--extra JSON] [--log JSON] [--dry-run] [--json]", mutates: true, section: "Write", description: "create a validated note", summary: "create a validated note", examples: ["vmem new personal idea --type insight --domain ml --topics ml --description x"] },
  { name: "patch", usage: "patch <vault> <note> [--old TEXT --new TEXT] [--edits FILE|-] [--expected-sha SHA] [--log JSON] [--dry-run] [--json]", mutates: true, section: "Write", description: "replace exact text in a note, or several replacements at once", summary: "replace exact text in a note", examples: ["vmem patch personal idea --old draft --new final"] },
  { name: "append", usage: "append <vault> <note> --section SECTION --markdown TEXT [--expected-sha SHA] [--log JSON] [--dry-run] [--json]", mutates: true, section: "Write", description: "append markdown under a section of a note", summary: "append markdown under a section of a note", examples: ["vmem append personal idea --section Evidence --markdown Checked"] },
  { name: "frontmatter", usage: "frontmatter <vault> <note> [--set JSON] [--unset A,B] [--expected-sha SHA] [--log JSON] [--dry-run] [--json]", mutates: true, section: "Write", description: "set or unset frontmatter keys of a note", summary: "set or unset frontmatter keys of a note", examples: ["vmem frontmatter personal idea --set '{\"status\":\"active\"}'"] },
  { name: "link", usage: "link <vault> <from> <to> --relation REL [--context TEXT] [--one-way] [--log JSON] [--dry-run] [--json]", mutates: true, section: "Write", description: "add a typed link between two notes, both ways unless --one-way", summary: "add a typed link between two notes", examples: ["vmem link personal idea other-idea --relation supports"] },
  { name: "supersede", usage: "supersede <vault> <old> <next> [--log JSON] [--dry-run] [--json]", mutates: true, section: "Write", description: "mark a note superseded by a newer one and link them", summary: "mark a note superseded by a newer one and link them", examples: ["vmem supersede personal old-idea new-idea"] },
  { name: "merge", usage: "merge <vault> <keep> <absorb> [--confirm --fingerprint SHA] [--log JSON] [--dry-run] [--json]", mutates: "confirm", section: "Write", description: "preview merged content and inbound links, then confirm to merge notes and supersede the absorbed note", summary: "preview, then confirm, merging one note into another", examples: ["vmem merge personal keep-idea absorbed-idea"] },
  { name: "move", usage: "move <vault> <from> <to> [--confirm --fingerprint SHA] [--log JSON] [--dry-run] [--json]", mutates: "confirm", section: "Write", description: "preview, then confirm with the fingerprint, a note move that rewrites links", summary: "preview, then confirm, moving a note and its links", examples: ["vmem move personal old-name new-name"] },
  { name: "delete", usage: "delete <vault> <note> [--confirm --fingerprint SHA] [--log JSON] [--dry-run] [--json]", mutates: "confirm", section: "Write", description: "preview backlinks, then confirm with the fingerprint, a note deletion", summary: "preview, then confirm, deleting a note", examples: ["vmem delete personal idea"] },
  { name: "tidy", usage: "tidy <vault> [--connections] [--escapes] [--enums] [--keys] [--sources] [--topics] [--secrets] [--log] [--all] [--map FILE] [--confirm --fingerprint SHA] [--dry-run] [--json]", mutates: "confirm", section: "Write", description: "preview, then confirm with the fingerprint, migration tidy of notes and the log", summary: "preview, then confirm, tidying notes and the log", examples: ["vmem tidy personal --all"] },
  { name: "report", usage: "report <vault> <reports/path|ops/path> --body FILE|- [--log JSON] [--dry-run] [--json]", mutates: true, section: "Write", description: "write a screened file under reports/ or ops/", summary: "write a screened file under reports/ or ops/", examples: ["vmem report personal reports/weekly.md --body weekly.md"] },
  { name: "assert", usage: "assert <vault> --batch FILE|- [--dry-run] [--log JSON] [--json]", mutates: true, section: "Write", description: "append a validated batch of temporal assertions to the vault's assertions/ journal; writes no note", summary: "append a validated batch of temporal assertions", examples: ["vmem assert personal --batch assertions.json --dry-run"] },
  { name: "check", usage: "check <vault> <file|-> [--path STEM] [--json]", mutates: false, section: "Read", description: "validate a note file or stdin without writing it", summary: "validate a note file or stdin without writing it", examples: ["vmem check personal draft.md"] },
  { name: "log tail", usage: "log tail <vault> [--limit 1..200] [--type TYPE] [--json]", mutates: false, section: "Log", description: "print the latest log events", summary: "print the latest log events", examples: ["vmem log tail personal --limit 20"] },
  { name: "log grep", usage: "log grep <vault> <pattern> [--limit 1..200] [--type TYPE] [--json]", mutates: false, section: "Log", description: "search log events by pattern", summary: "search log events by pattern", examples: ["vmem log grep personal release"] },
  { name: "log append", usage: "log append <vault> <type> <project> <source> <note> [--dest PATH] [--json]", mutates: true, section: "Log", description: "append one event to the vault log", summary: "append one event to the vault log", examples: ["vmem log append personal LEARN - notes/idea.md idea"] },
  { name: "promote-from-amem", usage: "promote-from-amem <vault> [<mem-id>] [--project KEY|--all-projects] [--limit 1..200] [--stem STEM] [--type TYPE] [--domain DOMAIN] [--topics A,B] [--description TEXT] [--title TEXT] [--body FILE|-] [--link-to NOTE] [--log-project ID] [--edit] [--confirm --fingerprint SHA] [--json]", mutates: "confirm", section: "Promotion and sync", description: "list agent-mem candidates, or preview and confirm one as a note", summary: "list agent-mem candidates, or promote one to a note", examples: ["vmem promote-from-amem personal", "vmem promote-from-amem personal mem:0123456789abcdef0123456789abcdef"] },
  { name: "promote", usage: "promote <personal-vault> <note> --to ORG [--topics A,B] [--again] [--log-project ID] [--confirm --fingerprint SHA] [--json]", mutates: "confirm", section: "Promotion and sync", description: "preview, then confirm, copying a personal note into an org vault clone", summary: "preview, then confirm, copying a note to an org vault", examples: ["vmem promote personal idea --to team"] },
  { name: "sync", usage: "sync <vault> [--message TEXT] [--confirm --fingerprint SHA] [--json]", mutates: "confirm", section: "Promotion and sync", description: "preview, then confirm, committing and pushing a vault to its remote", summary: "preview, then confirm, committing and pushing a vault", examples: ["vmem sync personal --message weekly"] },
  { name: "mcp", usage: "mcp", mutates: false, section: "Setup", description: "serve the vmem MCP tools on stdio", summary: "serve the vmem MCP tools on stdio", examples: [] },
  { name: "setup", usage: "setup <claude|codex|kimi|pi|qwen|jcode|agy|all> [--root PATH] [--apply|--undo] [--json]", mutates: "apply", section: "Setup", description: "preview, apply or undo the vmem MCP entry in agent hosts", summary: "preview, apply or undo vmem in agent hosts", examples: ["vmem setup claude", "vmem setup all --apply"] },
  { name: "manifest", usage: "manifest [--json]", mutates: false, section: "Setup", description: "print the package version, MCP tools and command names", summary: "print the package version, MCP tools and commands", examples: [] },
  { name: "completion", usage: "completion <bash|zsh|fish>", mutates: false, section: "Setup", description: "print a shell completion script built from this table", summary: "print a shell completion script", examples: ["vmem completion zsh"] },
  { name: "stats", usage: "stats <vault> [--days 1..3650] [--json]", mutates: false, section: "Read", description: "count notes by type, domain and status, note size and note-to-source ratio, recent edits and log events", summary: "count notes, sizes, recent edits and log events", examples: ["vmem stats personal --days 30"] },
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
  case "$key" in spec) if [ "$COMP_CWORD" -eq 2 ]; then COMPREPLY=($(compgen -W '${SPEC_COMMANDS.map(item => item.command).join(" ")}' -- "$cur")); return; fi; key="$key \${COMP_WORDS[2]}" ;; graph) if [ "$COMP_CWORD" -eq 2 ]; then COMPREPLY=($(compgen -W 'build neighbors path explain' -- "$cur")); return; fi; key="$key \${COMP_WORDS[2]}" ;; skills) if [ "$COMP_CWORD" -eq 2 ]; then COMPREPLY=($(compgen -W 'mine export' -- "$cur")); return; fi; key="$key \${COMP_WORDS[2]}" ;; specs) if [ "$COMP_CWORD" -eq 2 ]; then COMPREPLY=($(compgen -W 'list add remove' -- "$cur")); return; fi; key="$key \${COMP_WORDS[2]}" ;; vaults|log) if [ "$COMP_CWORD" -eq 2 ]; then COMPREPLY=($(compgen -W "$( [ "$key" = vaults ] && echo 'list add remove' || echo 'tail grep append')" -- "$cur")); return; fi; key="$key \${COMP_WORDS[2]}" ;; esac
  case "$key" in
${cases.join("\n")}
    *) words='' ;;
  esac
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
`;
  return shell === "zsh" ? `autoload -U +X bashcompinit && bashcompinit\n${fn}complete -F _vmem vmem\n` : `${fn}complete -F _vmem vmem\n`;
}
/** Help lines that are not commands of their own, so completion and the manifest leave them out. */
const EXTRA_HELP = [
  { name: "help", section: "Setup", usage: "help [<command>]", summary: "print this help or one command's help", description: "this help, or one command's help; also <command> --help and -h", examples: ["vmem help search"] },
  { name: "--version", section: "Setup", usage: "--version", summary: "print the installed version", description: "print the installed version", examples: [] },
] as const;
/** Global options every command takes; their lines appear in each command's Flags. */
const GLOBAL_FLAGS = ["--color", "--ascii"] as const;
const OUTPUT_NOTE = "Output is text for people; --json prints the compact JSON object for scripts (every command but mcp and completion). --color=always or --color=never forces color; with --color=auto (the default) NO_COLOR turns color off, then FORCE_COLOR or CLICOLOR_FORCE (not 0) turns it on, then FORCE_COLOR=0 or CLICOLOR=0 turns it off, otherwise a terminal is colored unless TERM is dumb. Markers are ASCII with --ascii or when the locale (LC_ALL, LC_CTYPE, LANG) is not UTF-8.";
/**
 * One line per flag, keyed by the flag or by `<command> <flag>` where a command uses it for something else.
 * At most 46 cells each (`--json` and `--color` excepted); the help lint fails a flag with no line or a line naming no flag.
 */
export const FLAG_DESCRIPTIONS: Record<string, string> = {
  "--json": "print compact JSON for scripts and agents",
  "--color": "color text: auto (default), always or never",
  "--ascii": "print ASCII markers instead of symbols",
  "--add": "JSON of list values to add",
  "--after": "the cursor a previous page returned",
  "--again": "promote a note already promoted before",
  "--agent-label": "a label naming the submitting agent",
  "--all": "run every tidy rule",
  "--all-projects": "read every agent-mem project",
  "--apply": "write the host entries",
  "--as-of": "read the journal as recorded at this time",
  "--at": "the civil day the assertion must hold",
  "--batch": "JSON batch file, or - for stdin",
  "--body": "body file, or - for stdin",
  "spec get --body": "include the spec body in bounded pages",
  "--bytes": "byte cap of the brief",
  "--confidence": "frontmatter confidence value",
  "--confirm": "apply the previewed change",
  "--connections": "tidy rule: repair connection lists",
  "--context": "one line of context for the link",
  "--covers": "JSON list of files the spec covers",
  "--covers-path": "only specs covering this file",
  "--cursor": "the cursor a previous page returned",
  "--days": "look back this many days",
  "--depends-on": "spec ids this spec depends on",
  "spec create --depends-on": "JSON list of spec ids it depends on",
  "--depth": "graph depth to read",
  "--description": "frontmatter description",
  "--dest": "destination path of the event",
  "--direction": "which part of the graph to read",
  "--domain": "frontmatter domain",
  "search --domain": "only notes of this domain",
  "--dry-run": "check and preview without writing",
  "--edge": "only edges of this kind",
  "--edit": "edit the draft in $VISUAL or $EDITOR first",
  "--edits": "JSON replacements file, or - for stdin",
  "--enums": "tidy rule: map enum values",
  "--escapes": "tidy rule: repair escaped values",
  "--expected-sha": "refuse unless the file has this SHA-256",
  "--extra": "JSON object of extra frontmatter keys",
  "--fingerprint": "the fingerprint the preview printed",
  "--for": "the task intent to rank notes for",
  "--from": "full commit id of the older snapshot",
  "--history": "list every revision, not only current ones",
  "--hops": "neighborhood depth",
  "--id": "spec id",
  "--implements": "JSON list of spec ids it implements",
  "--keys": "tidy rule: drop or rename unknown keys",
  "--kind": "vault kind",
  "--limit": "maximum number of rows",
  "--link-to": "link an existing note instead of creating",
  "--literal": "match the query as literal text",
  "--log": "JSON log event replacing the default",
  "tidy --log": "tidy rule: redact secrets in the log",
  "--log-project": "registry project id for the log event",
  "--map": "JSON file mapping enum values and keys",
  "--markdown": "markdown text to append",
  "--max-bytes": "page size in bytes",
  "--max-hops": "longest path to search",
  "--message": "commit message",
  "--min-novelty": "minimum novelty of a candidate",
  "--min-size": "minimum records in a candidate",
  "--new": "replacement text",
  "--note": "lint only this note",
  "--offset": "byte offset of the page",
  "spec grep --offset": "skip this many matches",
  "--old": "exact text to replace",
  "--one-way": "link from the first note only",
  "--parent": "parent spec id",
  "spec grep --parent": "only children of this spec",
  "--path": "validate as this note stem",
  "--paths": "workspace files the task touches",
  "spec create --paths": "JSON list of paths the spec governs",
  "--pii": "PII policy",
  "--project": "agent-mem project key",
  "--reason": "why, recorded with the decision",
  "--references": "JSON list of spec ids it references",
  "--registry": "project registry file",
  "--relation": "link relation",
  "--remote": "git remote URL",
  "--remove": "JSON of list values to remove",
  "--replace-file": "write a git-filter-repo replace file",
  "--repo": "validate a checkout that is not registered",
  "--require-fresh": "fail when a spec is stale",
  "--revision": "read the note at this Git commit",
  "--root": "absolute install root to register",
  "--secrets": "tidy rule: redact secrets in notes",
  "--section": "only this H2 section",
  "append --section": "the H2 section to append under",
  "--set": "JSON of keys to set",
  "vaults pii --set": "allow, deny or a JSON policy",
  "--skills": "skill directory to compare with",
  "--source": "frontmatter source, text or JSON",
  "spec --source": "registered spec source id",
  "--sources": "tidy rule: normalize sources",
  "--state": "proposal state",
  "--status": "frontmatter status",
  "spec grep --status": "only specs with this status",
  "--stem": "note stem to create",
  "--subject": "only assertions about this subject",
  "--superseded-by": "spec id that replaces this one",
  "--tag": "only specs with this tag",
  "--tags": "JSON list of tags",
  "--title": "title",
  "--to": "full commit id of the newer snapshot",
  "promote --to": "org vault id",
  "--topics": "comma-separated topic stems",
  "tidy --topics": "tidy rule: normalize topics",
  "--type": "note type",
  "log --type": "only events of this type",
  "spec --type": "spec type",
  "--undo": "remove the host entries",
  "--unset": "comma-separated keys to remove",
  "spec update --unset": "JSON list of keys to remove",
  "--verified-against": "commit the spec was verified against",
  "--via-hubs": "allow paths through MOC and bu hubs",
  "--vocab": "vocabulary directory",
  "--workspace": "build the workspace graph instead",
  "--worktree": "read the spec from this worktree",
  "--write": "write a screened report under reports/",
  "vaults --write": "write policy",
  "specs --write": "write policy",
};
/** The line for `flag` of `command`: the command's own key, then its first word's, then the flag's. */
export function flagDescription(command: string, flag: string, table: Record<string, string> = FLAG_DESCRIPTIONS): string | undefined {
  const words = command.split(" ");
  for (let n = words.length; n >= 1; n--) { const key = `${words.slice(0, n).join(" ")} ${flag}`; if (Object.hasOwn(table, key)) return table[key]; }
  return Object.hasOwn(table, flag) ? table[flag] : undefined;
}
type HelpEntry = { name: string; section: string; usage: string; summary: string; description: string; examples: readonly string[] };
const allEntries = (): HelpEntry[] => [...COMMANDS, ...EXTRA_HELP];
/** Usage forms, one per line. */
export const usageForms = (entry: { usage: string }): string[] => entry.usage.split(" | ").map(form => `vmem ${form}`);
/** Each flag of a command with the value shape its usage writes, in usage order, then the global flags. */
export function commandFlags(entry: { name: string; usage: string }): { label: string; flag: string }[] {
  const seen = new Map<string, string>();
  for (const match of entry.usage.replace(/\|--/g, " --").matchAll(/--[a-z][a-z0-9-]*(?: (?!--)(?:[A-Z][A-Z0-9_.,|-]*|[a-z0-9.]+\.\.[a-z0-9.]+|[a-z]+(?:\|[a-z]+)+|-)(?:\|[A-Z]+)?)?/g)) {
    const [flag] = match[0].split(" ") as [string];
    if (!seen.has(flag)) seen.set(flag, match[0]);
  }
  const out = [...seen].map(([flag, label]) => ({ flag, label }));
  if (entry.name !== "mcp") out.push({ flag: "--color", label: "--color=auto|always|never" }, { flag: "--ascii", label: "--ascii" });
  return out;
}
// Help always fits 80 columns, also on a pipe without COLUMNS (standard v1 Help); a narrower terminal narrows it.
const textColumns = (o: TextOptions) => Math.min(80, o.columns ?? 80);
const emit = (report: Report, o: TextOptions) => report.render(o.color).join("\n");
/** A usage form packed into lines of at most `columns` cells, never breaking inside a <...> or [...] group; later lines hang by 4. */
export function wrapUsage(form: string, columns: number): string[] {
  const groups: string[] = [];
  let depth = 0, current = "";
  for (const char of form) {
    if (char === " " && depth === 0) { if (current) groups.push(current); current = ""; continue; }
    if (char === "[" || char === "<") depth++;
    if (char === "]" || char === ">") depth = Math.max(0, depth - 1);
    current += char;
  }
  if (current) groups.push(current);
  const lines: string[] = [];
  let line = "";
  for (const group of groups) {
    const candidate = line ? `${line} ${group}` : (lines.length ? `    ${group}` : group);
    if (line && cellWidth(candidate) > columns) { lines.push(line); line = `    ${group}`; } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}
/** `vmem help`: the tagline, then `  <name>  <summary>` in two aligned columns per group, then the output note. */
export function help(o: TextOptions = { color: false }): string {
  const columns = textColumns(o), entries = allEntries();
  const nameWidth = Math.max(...entries.map(entry => cellWidth(entry.name)));
  const report = new Report(columns, o.ascii === true).header("vmem", version, "validated knowledge vaults for agents and people");
  for (const section of HELP_SECTIONS) {
    const group = entries.filter(entry => entry.section === section);
    if (!group.length) continue;
    report.section(section);
    report.append(group.map(entry => [{ text: "  " }, { text: entry.name.padEnd(nameWidth + 2 - (cellWidth(entry.name) - entry.name.length)), role: "accent" as const }, { text: entry.summary }]));
  }
  report.section("Output").note(OUTPUT_NOTE, "value");
  report.section("More").note("Run 'vmem help <command>' for a command's usage, flags and examples.", "value");
  return emit(report, o);
}
/** One command's help: Usage, Description, Flags, Examples and Details; empty sections are left out. */
function entryHelp(entry: HelpEntry, o: TextOptions): string {
  const columns = textColumns(o), report = new Report(columns, o.ascii === true).header("vmem", entry.name);
  report.section("Usage");
  for (const form of usageForms(entry)) for (const line of wrapUsage(form, columns - 2)) report.append([[{ text: "  " }, { text: line, role: "accent" }]]);
  report.section("Description").note(entry.summary.charAt(0).toUpperCase() + entry.summary.slice(1) + ".", "value");
  const flags = entry.name === "--version" || entry.name === "help" ? [] : commandFlags(entry);
  if (flags.length) {
    const labelWidth = Math.min(28, Math.max(...flags.map(f => cellWidth(f.label))));
    report.section("Flags", String(flags.length));
    for (const { flag, label } of flags) {
      const text = wrapCells(flagDescription(entry.name, flag) ?? "", columns - labelWidth - 4, 0), indent = " ".repeat(labelWidth + 4);
      if (cellWidth(label) > labelWidth) report.append([[{ text: "  " }, { text: label, role: "key" }]]);
      else report.append([[{ text: "  " }, { text: label + " ".repeat(labelWidth - cellWidth(label) + 2), role: "key" }, { text: text.shift() ?? "" }]]);
      report.append(text.map(line => [{ text: indent }, { text: line }]));
    }
  }
  if (entry.examples.length) { report.section("Examples"); for (const example of entry.examples) report.append([[{ text: "  " }, { text: example, role: "accent" }]]); }
  if (entry.description && entry.description !== entry.summary) report.section("Details").note(entry.description.charAt(0).toUpperCase() + entry.description.slice(1) + (/[.)]$/.test(entry.description) ? "" : "."), "value");
  return emit(report, o);
}
/** `vmem help <command>` and `<command> --help`: that command's help, or each matching command's for a group; undefined when none match. */
export function commandUsage(name: string, o: TextOptions = { color: false }): string | undefined {
  const exact = allEntries().find(entry => entry.name === name);
  if (exact) return entryHelp(exact, o);
  const group = allEntries().filter(entry => entry.name.startsWith(name + " "));
  if (!group.length) return undefined;
  const nameWidth = Math.max(...group.map(entry => cellWidth(entry.name)));
  const report = new Report(textColumns(o), o.ascii === true).header("vmem", name).section("Commands");
  report.append(group.map(entry => [{ text: "  " }, { text: entry.name.padEnd(nameWidth + 2), role: "accent" as const }, { text: entry.summary }]));
  report.section("More").note(`Run 'vmem help ${group[0]!.name}' for one command's usage, flags and examples.`, "value");
  return emit(report, o);
}
/** The usage line after a usage error: the usage wrapped within the width (80 on a pipe), else the short form. */
export function usageLines(name: string | undefined, columns: number | undefined): string[] {
  const entry = name === undefined ? undefined : allEntries().find(item => item.name === name);
  if (!entry) return ["Usage: vmem <command> [args]"];
  const width = Math.min(80, columns ?? 80);
  const forms = usageForms(entry).map(form => `Usage: ${form}`);
  const wrapped = forms.flatMap(form => wrapUsage(form, width));
  if (wrapped.length <= 4) return wrapped;
  return [`Usage: vmem ${entry.name} ${entry.usage.slice(entry.name.length).split(" ").filter(word => /^<|^\[<[^-]/.test(word)).join(" ")} [flags]`.replace(/\s+/g, " ").trimEnd()];
}
