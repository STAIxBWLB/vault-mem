/**
 * Text output for people (#114), after agent-hub's CLI conventions: uppercase-header tables sized by display width,
 * aligned field blocks, a wrapped description column and `--color=auto|always|never`. `--json` output never comes
 * through here, and color only adds emphasis: every renderer's text is complete without it.
 */
import type { WriteIssue } from "./write-types.ts";

export type Tone = "ok" | "warn" | "fail" | "muted" | "info" | "accent" | "bold";
export interface TextOptions { color: boolean; columns?: number }
export interface Cell { text: string; tone?: Tone }
export type CellInput = string | number | boolean | null | undefined | Cell;

/** Plain text, no wrapping: the default for library callers and tests. */
export const PLAIN: TextOptions = { color: false };
const CODES: Record<Tone, string> = { ok: "32", warn: "33", fail: "31", muted: "2", info: "36", accent: "35", bold: "1" };
const COLOR_USAGE = "--color: expected --color=auto, --color=always or --color=never";

/** Removes the one allowed `--color=` flag from args. It may appear anywhere before a `--` separator. */
export function takeColorFlag(args: string[]): { args: string[]; color?: string } {
  const end = args.includes("--") ? args.indexOf("--") : args.length;
  const found = args.slice(0, end).filter(arg => arg === "--color" || arg.startsWith("--color="));
  if (!found.length) return { args };
  if (found.length > 1 || found[0] === "--color") throw new Error(`${COLOR_USAGE}, given once`);
  return { args: args.filter((arg, i) => i >= end || arg !== found[0]), color: found[0]!.slice("--color=".length) };
}
export function resolveColor(flag: string | undefined, env: { isTTY: boolean; TERM?: string; NO_COLOR?: string }): boolean {
  if (flag === "always") return true;
  if (flag === "never") return false;
  if (flag === undefined || flag === "auto") return env.isTTY && env.TERM !== "dumb" && !env.NO_COLOR;
  throw new Error(COLOR_USAGE);
}
/** Terminal width on a TTY (at least 80), else `COLUMNS` when set, else no wrapping. */
export function outputWidth(env: { isTTY: boolean; columns?: number; COLUMNS?: string }): number | undefined {
  if (env.isTTY) return Math.max(80, env.columns && Number.isFinite(env.columns) ? env.columns : 80);
  return env.COLUMNS && /^[1-9][0-9]*$/.test(env.COLUMNS) ? Number(env.COLUMNS) : undefined;
}
/** Options for the process's stdout. */
export function textOptions(flag: string | undefined, env: NodeJS.ProcessEnv = process.env, stdout: { isTTY?: boolean; columns?: number } = process.stdout): TextOptions {
  const isTTY = stdout.isTTY === true, color = resolveColor(flag, { isTTY, TERM: env.TERM, NO_COLOR: env.NO_COLOR });
  const columns = outputWidth({ isTTY, columns: stdout.columns, COLUMNS: env.COLUMNS });
  return { color, ...(columns !== undefined ? { columns } : {}) };
}

const cell = (value: CellInput): Cell => typeof value === "object" && value !== null ? value : { text: value === null || value === undefined ? "" : String(value) };
/** Control characters (terminal escapes, tabs, newlines) never reach the terminal from data. */
export const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
export const width = (text: string) => Bun.stringWidth(text);
export function paint(text: string, tone: Tone | undefined, o: TextOptions): string {
  return o.color && tone && text ? `\u001b[${CODES[tone]}m${text}\u001b[0m` : text;
}
export const tone = (text: CellInput, t: Tone): Cell => ({ text: cell(text).text, tone: t });
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Word wrap by display width; a word longer than the width is split by grapheme. */
export function wrap(text: string, columns: number | undefined, indent = ""): string[] {
  const flat = clean(text);
  if (columns === undefined) return [indent + flat];
  const room = Math.max(10, columns - width(indent)), lines: string[] = [];
  let line = "";
  for (const word of flat.split(/ +/).filter(Boolean)) {
    const pieces: string[] = [];
    if (width(word) <= room) pieces.push(word);
    else { let piece = ""; for (const { segment } of graphemes.segment(word)) { if (width(piece + segment) > room) { pieces.push(piece); piece = ""; } piece += segment; } if (piece) pieces.push(piece); }
    for (const piece of pieces) {
      if (line && width(line + " " + piece) > room) { lines.push(line); line = ""; }
      line = line ? `${line} ${piece}` : piece;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines.map(value => indent + value);
}
const pad = (text: string, size: number) => text + " ".repeat(Math.max(0, size - width(text)));

/**
 * Table with uppercase headers and two-space gaps. When a width is known and the row is too wide, the last column
 * wraps under itself; with no width (pipes, tests) rows stay on one line.
 */
export function table(headers: string[], rows: CellInput[][], o: TextOptions): string {
  const data = rows.map(row => headers.map((_, i) => { const c = cell(row[i]); return { ...c, text: clean(c.text) }; }));
  const sizes = headers.map((header, i) => Math.max(width(header), ...data.map(row => width(row[i]!.text))));
  const last = headers.length - 1, lead = sizes.slice(0, last).reduce((sum, size) => sum + size + 2, 0);
  const lastRoom = o.columns !== undefined && lead + sizes[last]! > o.columns ? Math.max(20, o.columns - lead) : undefined;
  const line = (cells: Cell[], bold = false) => {
    const tail = wrap(cells[last]!.text, lastRoom);
    const head = cells.slice(0, last).map((c, i) => paint(pad(c.text, sizes[i]!), bold ? "bold" : c.tone, o)).join("  ");
    return tail.map((part, i) => (i ? " ".repeat(lead) : head + (last ? "  " : "")) + paint(part, bold ? "bold" : cells[last]!.tone, o)).join("\n").replace(/ +$/gm, "");
  };
  return [line(headers.map(text => ({ text })), true), ...data.map(row => line(row))].join("\n");
}
/** `label  value` lines with aligned values, indented by two spaces. Empty values are left out. */
export function fields(pairs: [label: string, value: CellInput][], o: TextOptions, indent = "  "): string {
  const shown = pairs.map(([label, value]) => [label, cell(value)] as const).filter(([, value]) => value.text !== "");
  const size = Math.max(0, ...shown.map(([label]) => width(label)));
  const hang = indent + " ".repeat(size + 2);
  return shown.map(([label, value]) => {
    const lines = wrap(value.text, o.columns === undefined ? undefined : o.columns - width(hang));
    return lines.map((text, i) => (i ? hang : indent + pad(label, size) + "  ") + paint(text, value.tone, o)).join("\n");
  }).join("\n");
}
export const heading = (text: string, o: TextOptions) => paint(clean(text), "bold", o);
/** Paragraph wrapped to the width, for hints and verdicts. */
export const paragraph = (text: string, o: TextOptions, t?: Tone, indent = "") => wrap(text, o.columns, indent).map(line => paint(line, t, o)).join("\n");
/** Joins the non-empty blocks with one blank line. */
export const blocks = (...parts: (string | undefined | false)[]) => parts.filter((part): part is string => !!part).join("\n\n");
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Write and validation issues: LEVEL, CODE, PATH and MESSAGE, errors first. */
export function issueTable(issues: readonly WriteIssue[], o: TextOptions): string | undefined {
  if (!issues.length) return undefined;
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return table(["LEVEL", "CODE", "PATH", "MESSAGE"], sorted.map(issue => [tone(issue.severity, issue.severity === "error" ? "fail" : "warn"), issue.code, issue.path ?? "-", issue.message]), o);
}
/** The command a person runs next, for example to confirm a preview or read the next page. */
export const nextCommand = (label: string, command: string, o: TextOptions) => `${label}: ${paint(clean(command), "info", o)}`;
/** Quotes one shell word only when it needs it, so a printed command can be pasted. */
export const shellWord = (word: string) => /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'"'"'`)}'`;
