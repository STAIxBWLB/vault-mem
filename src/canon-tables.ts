import { join } from "node:path";
import type { CanonTableSpec, VaultSpec } from "./config.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { proseLines } from "./links.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { MAX_NOTE_BYTES } from "./vault-index.ts";

export interface CanonRowMatch { path: string; line: number; key: string; row: string }
interface IndexedRow { path: string; line: number; row: string; keys: string[] }
interface KeyRow { row: number; key: string; length: number; alias: number }
interface Pattern { length: number; rows: KeyRow[] }
interface State { next: Map<string, number>; fail: number; output: number; patterns: number[] }
interface Automaton { states: State[]; patterns: Pattern[] }
export interface CanonRowIndex { readonly rows: readonly IndexedRow[]; readonly warnings: readonly string[]; readonly exact: Automaton; readonly latin: Automaton }
const TABLES = 16, TOTAL_BYTES = 8 * 1024 * 1024, ROWS = 20000, KEYS = 40000, KEY_BYTES = 256 * 1024;
const token = (character: string | undefined) => character !== undefined && /[\p{L}\p{N}\p{M}_]/u.test(character);
const latin = (key: string) => /\p{Script=Latin}/u.test(key);
const foldLatin = (value: string) => value.replace(/\p{Script=Latin}/gu, character => character.toLowerCase());
const state = (): State => ({ next: new Map(), fail: 0, output: 0, patterns: [] });

/** Split only actual table pipes, keeping escaped pipes, wiki aliases and code spans in their cells. */
function cells(line: string): string[] | undefined {
  if (line.length > 32768 || !line.includes("|")) return undefined;
  const result: string[] = []; let cell = "", wiki = false, code = 0, pipes = 0;
  for (let i = 0; i < line.length; i++) {
    const character = line[i]!;
    if (character === "\\" && i + 1 < line.length) { cell += line[++i]!; continue; }
    if (character === "`") {
      let end = i + 1; while (line[end] === "`") end++;
      const size = end - i; if (!code) code = size; else if (code === size) code = 0;
      cell += line.slice(i, end); i = end - 1; continue;
    }
    if (!code && line.slice(i, i + 2) === "[[") { wiki = true; cell += "[["; i++; continue; }
    if (!code && wiki && line.slice(i, i + 2) === "]]") { wiki = false; cell += "]]"; i++; continue; }
    if (character === "|" && !code && !wiki) { result.push(cell.trim()); cell = ""; pipes++; }
    else cell += character;
    if (result.length > 64) return undefined;
  }
  if (!pipes || wiki || code) return undefined;
  result.push(cell.trim());
  if (line.trimStart().startsWith("|")) result.shift();
  if (line.trimEnd().endsWith("|") && result.at(-1) === "") result.pop();
  return result.length ? result : undefined;
}
const separator = (row: string[]) => row.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
function aliases(cell: string): string[] {
  if (cell.length > 2048) return [];
  const plain = cell.replace(/\[\[([^\]]+)\]\]/g, (_, address: string) => {
    const [target = "", label] = address.split("|");
    const key = target.split("#")[0]!;
    return label ? `${key} / ${label}` : key;
  }).replace(/\*\*|`+/g, "");
  const parts: string[] = [];
  const base = plain.replace(/\(([^()]*)\)/g, (_, inner: string) => { parts.push(inner); return " "; });
  const found = new Set<string>();
  for (const part of [base, ...parts]) for (const value of part.split(/\s+\/\s+|,/)) {
    const key = value.trim().replace(/\s+/g, " ");
    const size = [...key].length;
    if (size >= 2 && size <= 256 && !/[\p{Cc}]/u.test(key)) found.add(key);
    if (found.size === 16) return [...found];
  }
  return [...found];
}
function tableRows(path: string, source: string, keyColumn: number, maximum: number): IndexedRow[] {
  const document = parseFrontmatter(source), lines = proseLines(document.body);
  const offset = document.frontmatter?.split("\n").length ?? 1;
  const result: IndexedRow[] = []; let columns = 0;
  for (let i = 0; i < lines.length && result.length < maximum; i++) {
    const row = cells(lines[i]!);
    if (!row) { columns = 0; continue; }
    const next = cells(lines[i + 1] ?? "");
    if (next && next.length === row.length && separator(next)) { columns = row.length; i++; continue; }
    if (!columns || separator(row) || keyColumn > columns || keyColumn > row.length) continue;
    const keys = aliases(row[keyColumn - 1]!);
    if (keys.length) result.push({ path, line: offset + i, row: [...lines[i]!.trim()].slice(0, 200).join(""), keys });
  }
  return result;
}
function automaton(rows: readonly IndexedRow[], folded: boolean): Automaton {
  const states = [state()], patterns: Pattern[] = [], byKey = new Map<string, number>();
  for (const [row, entry] of rows.entries()) for (const [alias, key] of entry.keys.entries()) {
    if (latin(key) !== folded) continue;
    const value = folded ? foldLatin(key) : key;
    const existing = byKey.get(value);
    const reference = { row, key, length: [...key].length, alias };
    if (existing !== undefined) { patterns[existing]!.rows.push(reference); continue; }
    let at = 0;
    for (const character of value) {
      let next = states[at]!.next.get(character);
      if (next === undefined) { next = states.length; states[at]!.next.set(character, next); states.push(state()); }
      at = next;
    }
    const id = patterns.length; byKey.set(value, id); patterns.push({ length: [...value].length, rows: [reference] }); states[at]!.patterns.push(id);
  }
  const queue = [...states[0]!.next.values()];
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]!;
    for (const [character, next] of states[at]!.next) {
      let fallback = states[at]!.fail;
      while (fallback && !states[fallback]!.next.has(character)) fallback = states[fallback]!.fail;
      states[next]!.fail = states[fallback]!.next.get(character) ?? 0;
      const failed = states[next]!.fail;
      states[next]!.output = states[failed]!.patterns.length ? failed : states[failed]!.output;
      queue.push(next);
    }
  }
  return { states, patterns };
}

/** Parse bounded configured inputs only. Missing or malformed advisory tables never block promotion. */
export function indexCanonRows(tables: readonly CanonTableSpec[], read: (path: string, maximum: number) => string | undefined): CanonRowIndex {
  const rows: IndexedRow[] = [], warnings = new Set<string>(); let remaining = TOTAL_BYTES, keys = 0, keyBytes = 0;
  const warn = (path: string, cause: string) => warnings.add(`canonTables: ${path} not read (${cause}); check the configured note, permissions and denyPaths, repair the header or reduce configured tables, then retry preview`);
  for (const table of tables.slice(0, TABLES)) {
    if (remaining <= 0 || rows.length >= ROWS || keys >= KEYS || keyBytes >= KEY_BYTES) { warn(table.path, "aggregate read or row-index budget exhausted"); continue; }
    const maximum = Math.min(MAX_NOTE_BYTES, remaining); let source: string | undefined;
    try { source = read(table.path, maximum); }
    catch (error) {
      const code = (error as { code?: unknown })?.code;
      warn(table.path, code === "CANON_DENIED" ? "denied by path policy" : code === "V09" ? "note exceeds remaining read budget" : code === "EACCES" || code === "EPERM" ? "permission denied" : "reader unavailable");
      continue;
    }
    if (typeof source !== "string") { warn(table.path, "note missing or unavailable in the current index"); continue; }
    const bytes = Buffer.byteLength(source); remaining -= Math.min(bytes, maximum);
    if (bytes > maximum || !Number.isInteger(table.keyColumn ?? 1) || (table.keyColumn ?? 1) < 1) { warn(table.path, "note exceeds read budget or keyColumn is invalid"); continue; }
    try {
      const capacity = ROWS - rows.length, parsed = tableRows(table.path, source, table.keyColumn ?? 1, capacity);
      let limited = parsed.length === capacity;
      for (const row of parsed) {
        const kept: string[] = [];
        for (const key of row.keys) {
          const size = Buffer.byteLength(key);
          if (keys >= KEYS || keyBytes + size > KEY_BYTES) { limited = true; break; }
          keys++; keyBytes += size; kept.push(key);
        }
        if (kept.length) rows.push({ ...row, keys: kept });
      }
      if (limited) warnings.add(`canonTables: ${table.path} index budget reached; additional rows or aliases may be omitted; split the table or reduce configured tables and retry preview`);
    } catch { warn(table.path, "frontmatter is not parseable"); }
  }
  return { rows, warnings: [...warnings], exact: automaton(rows, false), latin: automaton(rows, true) };
}
function find(machine: Automaton, text: string, best: Map<number, KeyRow>): void {
  if (!machine.patterns.length) return;
  const input = [...text], seen = new Set<number>(); let at = 0;
  for (let i = 0; i < input.length; i++) {
    const character = input[i]!;
    while (at && !machine.states[at]!.next.has(character)) at = machine.states[at]!.fail;
    at = machine.states[at]!.next.get(character) ?? 0;
    if (token(input[i + 1])) continue;
    for (let output = at; output; output = machine.states[output]!.output) for (const id of machine.states[output]!.patterns) {
      if (seen.has(id)) continue;
      const pattern = machine.patterns[id]!, start = i + 1 - pattern.length;
      if (token(input[start - 1]) || token(input[i + 1])) continue;
      seen.add(id);
      for (const row of pattern.rows) {
        const previous = best.get(row.row);
        if (!previous || row.length > previous.length || row.length === previous.length && row.alias < previous.alias) best.set(row.row, row);
      }
    }
    if (seen.size === machine.patterns.length) return;
  }
}
/** Whole-token matching is linear in draft length; repeated mentions do not duplicate rows. */
export function matchCanonRows(index: CanonRowIndex, draft: string): CanonRowMatch[] {
  if (typeof draft !== "string" || Buffer.byteLength(draft) > MAX_NOTE_BYTES) return [];
  const best = new Map<number, KeyRow>();
  find(index.exact, draft, best); find(index.latin, foldLatin(draft), best);
  return [...best.values()].sort((a, b) => b.length - a.length || a.row - b.row).slice(0, 5).map(match => {
    const row = index.rows[match.row]!; return { path: row.path, line: row.line, key: match.key, row: row.row };
  });
}
/** Reuse an already-open vault index; never rescan or read an arbitrary filesystem path. */
export function canonRowsForVault(index: { noteSource(path: string, maxBytes: number): string | undefined }, vault: VaultSpec, denyPaths: readonly string[]): CanonRowIndex {
  const denied = [...denyPaths];
  return indexCanonRows(vault.canonTables ?? [], (path, maximum) => {
    const file = join(vault.path, path);
    if (isDenied(file, denied) || isDenied(canonicalPath(file), denied)) throw Object.assign(new Error("canonical table denied"), { code: "CANON_DENIED" });
    return index.noteSource(path, maximum);
  });
}
