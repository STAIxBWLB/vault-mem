import ts from "typescript";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { COMMANDS } from "../src/commands-table.ts";
import { SPEC_COMMANDS } from "../src/spec-command-table.ts";
import { VMEM_TOOL_NAMES } from "../src/mcp-vault.ts";

// Usage: bun scripts/refusal-inventory.ts [src-root] [--baseline FILE] [--prune-baseline]; defaults to ./src and scripts/refusal-inventory.baseline.json.
// Collects the message arguments of UsageError, Refusal and plain Error throws (#303) and checks rule B:
// every `vmem <command> [--flag]` and `vmem_<tool>` a message names exists. Rule A: every message names a continuation,
// carries a `// refusal: <marker>` comment on its throw line or the line above, or is in the shrink-only baseline.

/** Marks a `${...}` hole in a template message; a reference through a hole is not resolved. */
export const HOLE = "\u2039\u203a";
const THROWN = new Set(["UsageError", "Refusal", "Error"]);
/** By-design markers (#303): the next step needs operator knowledge, an action in the world, or a person's authority. */
export const MARKERS = ["operator-knowledge", "world-action", "human-authority"] as const;
export type Marker = typeof MARKERS[number];
export interface Message { file: string; line: number; kind: string; text: string; marker?: Marker }
export interface BaselineEntry { file: string; message: string }
export interface Finding { file: string; line: number; reference: string; reason: string }
export interface Surface { commands: Map<string, Set<string>>; tools: Set<string> }

function textOf(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => HOLE + span.literal.text).join("");
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = textOf(node.left), right = textOf(node.right);
    return left === undefined && right === undefined ? undefined : (left ?? HOLE) + (right ?? HOLE);
  }
  if (ts.isParenthesizedExpression(node)) return textOf(node.expression);
  return undefined;
}
/** Every string in a Refusal argument (its issue messages); the first argument of an Error or UsageError. */
function messagesIn(kind: string, args: readonly ts.Expression[]): string[] {
  if (kind !== "Refusal") { const first = args[0]; const text = first && textOf(first); return text === undefined ? [] : [text]; }
  const found: string[] = [];
  const visit = (node: ts.Node) => { const text = textOf(node); if (text !== undefined) found.push(text); else ts.forEachChild(node, visit); };
  for (const arg of args) visit(arg);
  return found;
}
export function collectMessages(dir: string, base = dir): Message[] {
  const out: Message[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...collectMessages(file, base)); continue; }
    if (!file.endsWith(".ts")) continue;
    const raw = readFileSync(file, "utf8"), lines = raw.split("\n");
    const source = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
    const markerAt = (line: number): Marker | undefined => {
      for (const text of [lines[line - 1], lines[line - 2]]) {
        const found = text?.match(/\/\/\s*refusal:\s*([a-z-]+)/)?.[1];
        if (found) { if (!(MARKERS as readonly string[]).includes(found)) throw new Error(`${file}:${line}: unknown refusal marker ${found}; use one of ${MARKERS.join(", ")}`); return found as Marker; }
      }
      return undefined;
    };
    const visit = (node: ts.Node) => {
      if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression) && ts.isIdentifier(node.expression.expression) && THROWN.has(node.expression.expression.text)) {
        const kind = node.expression.expression.text, line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        for (const text of messagesIn(kind, node.expression.arguments ?? [])) { const marker = markerAt(line); out.push({ file: relative(base, file), line, kind, text, ...(marker ? { marker } : {}) }); }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

/** The commands with the flags their usage accepts; every command takes --help and -h. */
export function knownSurface(): Surface {
  const commands = new Map<string, Set<string>>();
  const add = (name: string, usage: string) => commands.set(name, new Set([...(commands.get(name) ?? []), ...(usage.match(/--[a-z][a-z0-9-]*/g) ?? []), "--help", "-h"]));
  for (const entry of COMMANDS) add(entry.name, entry.usage);
  for (const entry of SPEC_COMMANDS) add(`spec ${entry.command}`, entry.usage);
  add("help", "help [command]");
  // `vmem spec --help` and `vmem specs` print the group's help.
  for (const name of [...commands.keys()]) { const group = name.split(" ")[0]!; if (name.includes(" ") && !commands.has(group)) add(group, ""); }
  return { commands, tools: new Set<string>(VMEM_TOOL_NAMES) };
}

// A `vmem` word names a command when a verb or connective leads to it, or when its next word starts a known command;
// otherwise it is prose ("a valid vmem package").
const LEAD = /(?:^|[\s(])(?:run|use|using|with|see|by|from|to|or|then|via|try|inspect|usage:|e\.g\.|\()\s*$/i;
const CLAUSE_END = /[;,]\s|\.\s|\.$|\)|\s(?:then|and|or|for|to|with|before|after|until|if|when|so)\s/;

export function checkRuleB(messages: readonly Message[], surface: Surface): Finding[] {
  const findings: Finding[] = [];
  const roots = new Set([...surface.commands.keys()].map(name => name.split(" ")[0]!));
  for (const m of messages) {
    for (const match of m.text.matchAll(/\bvmem_[a-z][a-z0-9_]*/g)) if (!surface.tools.has(match[0])) findings.push({ file: m.file, line: m.line, reference: match[0], reason: "no MCP tool of that name" });
    for (const match of m.text.matchAll(/(?<![\w-])vmem (?=\S)/g)) {
      const before = m.text.slice(0, match.index), after = m.text.slice(match.index + match[0].length);
      const end = after.search(CLAUSE_END), clause = end < 0 ? after : after.slice(0, end);
      const words = clause.split(/\s+/).filter(Boolean);
      const first = words[0] ?? "";
      if (!LEAD.test(before) && !roots.has(first)) continue;
      if (first.includes(HOLE)) continue;
      // Longest command name that the leading words spell; a hole in the next word stands for any subcommand.
      let name: string | undefined;
      for (let n = Math.min(3, words.length); n >= 1; n--) { const candidate = words.slice(0, n).join(" "); if (surface.commands.has(candidate)) { name = candidate; break; } }
      if (!name) { findings.push({ file: m.file, line: m.line, reference: `vmem ${words.slice(0, 2).join(" ")}`.trim(), reason: "no command of that name in COMMANDS or SPEC_COMMANDS" }); continue; }
      const rest = words.slice(name.split(" ").length);
      if (rest[0]?.includes(HOLE) && [...surface.commands.keys()].some(c => c.startsWith(`${name} `))) continue;
      const flags = surface.commands.get(name)!;
      for (const flag of rest.join(" ").match(/(?<![\w-])--?[a-z][a-z0-9-]*/g) ?? []) {
        if (flag.startsWith("--") || flag === "-h") { if (!flags.has(flag)) findings.push({ file: m.file, line: m.line, reference: `vmem ${name} ${flag}`, reason: `${name} has no ${flag} option` }); }
      }
    }
  }
  return findings;
}

// A next-step clause follows the cause after "; ", ", then" or ". " and is more than a template hole.
const NEXT_STEP = /(?:;|\.|, then)\s+(?!$)(.+)$/s;
const RULE_ID = /\b[A-Z]{1,4}\d{2,3}\b/;
const NAMES_RETRY = /(?<![\w-])vmem (?=[a-z])|\bvmem_[a-z]/;
/** Rule A: the message names what to do next. A message citing rule ids counts only when it also names the command or tool to retry with. */
export function namesContinuation(text: string): boolean {
  if (RULE_ID.test(text)) return NAMES_RETRY.test(text);
  if (NAMES_RETRY.test(text)) return true;
  const step = text.match(NEXT_STEP)?.[1]?.replaceAll(HOLE, "").trim();
  return !!step && /[a-z]{2}/i.test(step);
}
/** Unnamed messages not covered by a marker or a baseline entry, and baseline entries that match no unnamed message (stale). */
export function checkRuleA(messages: readonly Message[], baseline: readonly BaselineEntry[]): { unnamed: Message[]; stale: BaselineEntry[] } {
  const pool = new Map<string, number>();
  const key = (file: string, message: string) => `${file}\u0000${message}`;
  for (const entry of baseline) pool.set(key(entry.file, entry.message), (pool.get(key(entry.file, entry.message)) ?? 0) + 1);
  const unnamed: Message[] = [];
  for (const m of messages) {
    if (m.marker || namesContinuation(m.text)) continue;
    const k = key(m.file, m.text), left = pool.get(k) ?? 0;
    if (left) pool.set(k, left - 1); else unnamed.push(m);
  }
  const stale: BaselineEntry[] = [];
  for (const entry of baseline) { const k = key(entry.file, entry.message), left = pool.get(k) ?? 0; if (left) { stale.push(entry); pool.set(k, left - 1); } }
  return { unnamed, stale };
}
export function readBaseline(file: string): BaselineEntry[] {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(value) || value.some(e => typeof e?.file !== "string" || typeof e?.message !== "string" || Object.keys(e).length !== 2)) throw new Error(`${file}: expected an array of {file, message}; restore it from git`);
  return value as BaselineEntry[];
}

if (import.meta.main) {
  const args = process.argv.slice(2), flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
  const prune = args.includes("--prune-baseline"); if (prune) args.splice(args.indexOf("--prune-baseline"), 1);
  const baselineFile = flag("--baseline") ?? join(import.meta.dir, "refusal-inventory.baseline.json");
  const root = args[0] ?? "src";
  const messages = collectMessages(root), findings = checkRuleB(messages, knownSurface());
  const references = messages.filter(m => /\bvmem[ _]/.test(m.text)).length;
  if (findings.length) {
    for (const f of findings) console.error(`${join(root, f.file)}:${f.line}: ${f.reference}: ${f.reason}; name an existing command, option or tool`);
    console.error(`refusal-inventory: ${findings.length} rule B finding(s)`);
    process.exit(1);
  }
  const baseline = readBaseline(baselineFile), { unnamed, stale } = checkRuleA(messages, baseline);
  if (prune && stale.length) {
    // Shrink only: pruning drops stale entries and never adds one.
    const drop = [...stale], kept = baseline.filter(e => { const i = drop.findIndex(d => d.file === e.file && d.message === e.message); if (i < 0) return true; drop.splice(i, 1); return false; });
    writeFileSync(baselineFile, JSON.stringify(kept, null, 2) + "\n");
    console.log(`refusal-inventory: pruned ${stale.length} stale baseline entr${stale.length === 1 ? "y" : "ies"}`);
  } else if (stale.length) for (const e of stale) console.error(`${baselineFile}: stale entry ${e.file}: ${JSON.stringify(e.message)}; the message changed or now names a continuation, so remove the entry (bun scripts/refusal-inventory.ts --prune-baseline)`);
  for (const m of unnamed) console.error(`${join(root, m.file)}:${m.line}: ${JSON.stringify(m.text)}: names no continuation; add the next step after "; ", or mark the throw with // refusal: ${MARKERS.join("|")}`);
  if (unnamed.length || (stale.length && !prune)) { console.error(`refusal-inventory: ${unnamed.length} rule A finding(s), ${prune ? 0 : stale.length} stale baseline entr${stale.length === 1 ? "y" : "ies"}`); process.exit(1); }
  console.log(`refusal-inventory: ok (${messages.length} messages, ${references} naming vmem, ${baseline.length - (prune ? stale.length : 0)} baselined)`);
}
