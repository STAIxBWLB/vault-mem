import { loadRegistry } from "./registry.ts";
import { VaultIndex, MAX_NOTE_BYTES } from "./vault-index.ts";
import { PLAIN, UsageError, type TextOptions } from "./text-output.ts";
import { linksText, rebuildText, searchText, showText } from "./read-output.ts";
import { CHANGES_PAGE_LIMIT, HISTORY_PAGE_LIMIT, changesText, historyText, readChanges, readHistory, readRevision, revisionText } from "./vault-history.ts";
import type { NoteReadResult, SearchResult } from "./vault-index.ts";
import { evidenceReport } from "./evidence.ts";
import { evidenceText } from "./read-output.ts";
const READ_COMMANDS = new Set(["rebuild", "search", "show", "links", "evidence", "history", "changes"]);
export function isReadCommand(command: string): boolean { return READ_COMMANDS.has(command); }
export function runReadCommand(command: string, args: string[], home: string, text: TextOptions = PLAIN): { text: string; code: number } {
  const options: Record<string, string | boolean> = {}, positional: string[] = [];
  const allowed = command === "search" ? ["--limit", "--type", "--domain"] : command === "show" ? ["--max-bytes", "--section", "--offset", "--revision"]
    : command === "links" ? ["--limit"] : command === "history" ? ["--limit", "--cursor"] : command === "changes" ? ["--from", "--to", "--limit", "--cursor"] : [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    if (Object.hasOwn(options, arg) || (arg !== "--json" && !allowed.includes(arg))) throw new UsageError(`${command}: unknown or repeated option ${arg}`);
    if (arg === "--json") { options[arg] = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new UsageError(`${arg}: value required`);
    options[arg] = value;
  }
  const expected = command === "rebuild" || command === "changes" ? 1 : 2;
  if (positional.length !== expected) throw new UsageError(`${command}: requires vault id${command === "rebuild" ? "" : command === "changes" ? " and --from/--to" : " and query/target"}`);
  const registry = loadRegistry(home), vault = registry.vaults.find(v => v.id === positional[0]);
  if (!vault) throw new Error(`${command}: unknown vault id`);
  // Evidence reads the note and its sources directly: no index cache, lock or write.
  if (command === "evidence") {
    const report = evidenceReport(vault, positional[1]!, registry.denyPaths ?? []);
    return { text: options["--json"] ? JSON.stringify(report) : evidenceText(report, text), code: 0 };
  }
  const number = (name: string): number | undefined => {
    if (options[name] === undefined) return undefined;
    if (!/^[0-9]+$/.test(String(options[name]))) throw new UsageError(`${name}: expected integer`);
    return Number(options[name]);
  };
  const limit = number("--limit"), maxBytes = number("--max-bytes"), offset = number("--offset");
  // Validate bounds before opening or updating a derived cache.
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new UsageError("limit: expected integer 1..500");
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536)) throw new UsageError("max-bytes: expected integer 1..65536");
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_NOTE_BYTES)) throw new UsageError(`offset: expected integer 0..${MAX_NOTE_BYTES}`);
  const section = options["--section"] as string | undefined;
  if (section !== undefined && (!section.trim() || /[\r\n]/.test(section) || Buffer.byteLength(section) > 1024)) throw new UsageError("section: expected one exact H2 heading <=1024 bytes");
  const cursor = options["--cursor"] as string | undefined, revision = options["--revision"] as string | undefined;
  const denyPaths = registry.denyPaths ?? [];
  if (command === "history") {
    if (limit !== undefined && limit > HISTORY_PAGE_LIMIT) throw new UsageError(`limit: expected integer 1..${HISTORY_PAGE_LIMIT} for history`);
    const result = readHistory({ vault, home, denyPaths, note: positional[1]!, ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) });
    if (options["--json"]) return { text: JSON.stringify(result), code: 0 };
    return { text: historyText(result, text, { vault: vault.id, note: positional[1]!, ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) }), code: 0 };
  }
  if (command === "changes") {
    const from = options["--from"], to = options["--to"];
    if (typeof from !== "string" || typeof to !== "string") throw new UsageError("changes: requires one vault id plus --from and --to, e.g. vmem changes demo --from <oid> --to <oid>");
    if (limit !== undefined && limit > CHANGES_PAGE_LIMIT) throw new UsageError(`limit: expected integer 1..${CHANGES_PAGE_LIMIT} for changes`);
    const result = readChanges({ vault, home, denyPaths, from, to, ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) });
    if (options["--json"]) return { text: JSON.stringify(result), code: 0 };
    return { text: changesText(result, text, { vault: vault.id, from, to, ...(limit !== undefined ? { limit } : {}) }), code: 0 };
  }
  if (command === "show" && revision !== undefined) {
    const result = readRevision({ vault, home, denyPaths, note: positional[1]!, revision,
      ...(maxBytes !== undefined ? { maxBytes } : {}), ...(offset !== undefined ? { offset } : {}), ...(section !== undefined ? { section } : {}) });
    if (options["--json"]) return { text: JSON.stringify(result), code: 0 };
    return { text: revisionText(result, text, { vault: vault.id, note: positional[1]!, revision, ...(maxBytes !== undefined ? { maxBytes } : {}) }), code: 0 };
  }
  const index = new VaultIndex(home, vault, registry.vaults.map(v => v.path));
  let result: unknown;
  try {
    const scan = index.scan(command === "rebuild");
    if (command === "rebuild") result = { vault: vault.id, ...scan };
    else if (command === "search") result = index.search(positional[1]!, { limit, type: options["--type"] as string | undefined, domain: options["--domain"] as string | undefined });
    else if (command === "show") result = index.show(positional[1]!, maxBytes, section, offset);
    else if (command === "links") result = index.links(positional[1]!, limit);
    else throw new UsageError("unknown read command");
  } finally { index.close(); }
  if (options["--json"]) return { text: JSON.stringify(result), code: 0 };
  const vaultId = vault.id, target = positional[1]!;
  const out = command === "rebuild" ? rebuildText(result as Parameters<typeof rebuildText>[0], text)
    : command === "search" ? searchText(result as SearchResult[], text, { vault: vaultId, query: target, limit: limit ?? 50, type: options["--type"] as string | undefined, domain: options["--domain"] as string | undefined })
    : command === "show" ? showText(result as NoteReadResult, text, { vault: vaultId, target, maxBytes })
    : linksText(result as Parameters<typeof linksText>[0], text, { vault: vaultId, target, limit: limit ?? 50 });
  return { text: out, code: 0 };
}
