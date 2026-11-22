/**
 * Text output for people (#114), after agent-hub's CLI conventions: uppercase-header tables sized by display width,
 * aligned field blocks, a wrapped description column and `--color=auto|always|never`. `--json` output never comes
 * through here, and color only adds emphasis: every renderer's text is complete without it.
 */
import type { WriteIssue } from "./write-types.ts";
import { asciiMarkers, cellWidth, markerCell, MARKERS, paint as paintSpans, Report, resolveColor, streamEnv, type MarkerName, type Role } from "@staix/cli-output";

export type Tone = "ok" | "warn" | "fail" | "muted" | "info" | "accent" | "bold";
export type { Role } from "@staix/cli-output";
export type Marker = MarkerName;
export interface TextOptions { color: boolean; columns?: number; ascii?: boolean }
export interface Cell { text: string; tone?: Tone }
export type CellInput = string | number | boolean | null | undefined | Cell;

/** Plain text, no wrapping: the default for library callers and tests. */
export const PLAIN: TextOptions = { color: false };
// Translate vmem's domain-specific cell tones pending STAIxBWLB/cli-output#7; role styling remains in cli-output.
const TONE_ROLES: Record<Tone, Role> = { ok: "success", warn: "warning", fail: "error", muted: "hint", info: "accent", accent: "accent", bold: "header" };
/** A status marker with its state word or finding; padding remains visible without color. */
export function status(name: "ok" | "warn" | "fail" | "unknown" | "pending" | "absent" | "active", text: string, o: TextOptions): string {
  return paintSpans([{ text: markerCell(name, o.ascii === true), role: MARKERS[name].role }, { text: " " }, { text: clean(text), role: MARKERS[name].role }], o.color);
}
export function summary(counts: { failed?: number; warnings?: number; ok?: number; unknown?: number }, o: TextOptions): string {
  return new Report(undefined, o.ascii === true).summary(counts).render(o.color).join("\n");
}
export class UsageError extends Error {}
const COLOR_USAGE = "--color: expected --color=auto, --color=always or --color=never";

/** Removes the one allowed `--color=` flag from args. It may appear anywhere before a `--` separator. */
export function takeColorFlag(args: string[]): { args: string[]; color?: string; ascii?: boolean } {
  const end = args.includes("--") ? args.indexOf("--") : args.length;
  // `--ascii` (standard v1 markers): global like --color, taken off before a `--` separator only.
  const asciiAt = args.slice(0, end).indexOf("--ascii");
  if (asciiAt >= 0) {
    if (args.slice(0, end).filter(arg => arg === "--ascii").length > 1) throw new UsageError("--ascii: given more than once; pass it once");
    const rest = takeColorFlag([...args.slice(0, asciiAt), ...args.slice(asciiAt + 1)]);
    return { ...rest, ascii: true };
  }
  const found = args.slice(0, end).filter(arg => arg === "--color" || arg.startsWith("--color="));
  if (!found.length) return { args };
  if (found.length > 1 || found[0] === "--color") throw new UsageError(`${COLOR_USAGE}, given once`);
  return { args: args.filter((arg, i) => i >= end || arg !== found[0]), color: found[0]!.slice("--color=".length) };
}
/** Terminal width selection is retained pending STAIxBWLB/cli-output#7. */
export function outputWidth(env: { isTTY: boolean; columns?: number; COLUMNS?: string }): number | undefined {
  if (env.isTTY) return env.columns && Number.isFinite(env.columns) && env.columns > 0 ? env.columns : 80;
  return env.COLUMNS && /^[1-9][0-9]*$/.test(env.COLUMNS) ? Number(env.COLUMNS) : undefined;
}
/** Options for a stdout; the default is a non-terminal, so library calls and tests get the same text everywhere. */
export function textOptions(flag: string | undefined, env: NodeJS.ProcessEnv = process.env, stdout: { isTTY?: boolean; columns?: number } = {}, ascii = false): TextOptions {
  const isTTY = stdout.isTTY === true, color = resolveColor(flag, streamEnv(isTTY, env), "vmem");
  if (color instanceof Error) throw new UsageError(COLOR_USAGE);
  const columns = outputWidth({ isTTY, columns: stdout.columns, COLUMNS: env.COLUMNS });
  return { color, ascii: asciiMarkers(env, ascii), ...(columns !== undefined ? { columns } : {}) };
}

const cell = (value: CellInput): Cell => typeof value === "object" && value !== null ? value : { text: value === null || value === undefined ? "" : String(value) };
/** Single-line control-to-space handling is retained pending STAIxBWLB/cli-output#8. */
export const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
export const width = cellWidth;
/** Note and spec bodies printed as is, minus terminal escape sequences (OSC, CSI, C1) and control characters other than tab and newline. */
// Keep complete C1 sequence handling and CR normalization until STAIxBWLB/cli-output#8.
export const stripTerminal = (text: string) => text
  .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]?|\u009b[0-?]*[ -/]*[@-~]?|\u001b[^[\]]?/g, "")
  .replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
export const tone = (text: CellInput, t: Tone): Cell => ({ text: cell(text).text, tone: t });
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Word wrap by display width; a word longer than the width is split by grapheme. */
// Preserve grapheme-safe, unbounded domain layouts pending STAIxBWLB/cli-output#7.
export function wrap(text: string, columns: number | undefined, indent = ""): string[] {
  const flat = clean(text);
  if (columns === undefined) return [indent + flat];
  const room = Math.max(1, columns - width(indent)), lines: string[] = [];
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
// Keep vmem's role-bearing cells and layout pending STAIxBWLB/cli-output#7.
export function table(headers: string[], rows: CellInput[][], o: TextOptions): string {
  return tableParts(headers, rows, o).join("\n");
}
/** Table blocks retain the row boundaries when a cell wraps across several lines. */
export function tableParts(headers: string[], rows: CellInput[][], o: TextOptions): string[] {
  const data = rows.map(row => headers.map((_, i) => { const c = cell(row[i]); return { ...c, text: clean(c.text) }; }));
  const last = headers.length - 1;
  const sizes = headers.map((header, i) => Math.min(i === last ? Infinity : 32, Math.max(width(header), ...data.map(row => width(row[i]!.text)))));
  if (o.columns !== undefined) {
    while (sizes.slice(0, last).reduce((sum, size) => sum + size + 2, 0) + 10 > o.columns) {
      let largest = -1;
      for (let i = 0; i < last; i++) if (sizes[i]! > 4 && (largest < 0 || sizes[i]! > sizes[largest]!)) largest = i;
      if (largest < 0) break;
      sizes[largest]!--;
    }
  }
  const lead = sizes.slice(0, last).reduce((sum, size) => sum + size + 2, 0);
  const lastRoom = o.columns !== undefined && lead + sizes[last]! > o.columns ? Math.max(1, o.columns - lead) : undefined;
  const shorten = (text: string, size: number) => {
    if (width(text) <= size) return text;
    let start = "", end = "";
    const parts = [...graphemes.segment(text)].map(part => part.segment);
    while (parts.length && width(start + "..." + end) < size) {
      const part = parts.shift()!;
      if (width(start + part + "..." + end) > size) break;
      start += part;
      if (parts.length) {
        const tail = parts.pop()!;
        if (width(start + "..." + tail + end) <= size) end = tail + end;
      }
    }
    return start + "..." + end;
  };
  const line = (cells: Cell[], bold = false) => {
    const columns = cells.map((c, i) => {
      if (i === last) return wrap(c.text, lastRoom);
      if (/PATH|^(ID|STATE)$/i.test(headers[i]!)) return [shorten(c.text, sizes[i]!)];
      return width(c.text) <= sizes[i]! ? [c.text] : wrap(c.text, sizes[i]!);
    });
    const height = Math.max(...columns.map(parts => parts.length));
    return Array.from({ length: height }, (_, row) => cells.map((c, i) => {
      const part = columns[i]![row] ?? "";
      return paintSpans([{ text: i === last ? part : pad(part, sizes[i]!), ...(bold ? { role: "key" as const } : c.tone ? { role: TONE_ROLES[c.tone] } : {}) }], o.color);
    }).join("  ").replace(/ +$/, "")).join("\n");
  };
  return [line(headers.map(text => ({ text })), true), ...data.map(row => line(row))];
}
/** `label  value` lines with aligned values, indented by two spaces. Empty values are left out. */
// Keep vmem's key/value layout pending STAIxBWLB/cli-output#7.
export function fields(pairs: [label: string, value: CellInput][], o: TextOptions, indent = "  "): string {
  const shown = pairs.map(([label, value]) => [label, cell(value)] as const).filter(([, value]) => value.text !== "");
  const size = Math.max(0, ...shown.map(([label]) => width(label)));
  const hang = indent + " ".repeat(size + 2);
  return shown.map(([label, value]) => {
    const lines = wrap(value.text, o.columns === undefined ? undefined : o.columns - width(hang));
    return lines.map((text, i) => (i ? hang : indent + pad(label, size) + "  ") + paintSpans([{ text, ...(value.tone ? { role: TONE_ROLES[value.tone] } : {}) }], o.color)).join("\n");
  }).join("\n");
}
export const heading = (text: string, o: TextOptions) => paintSpans([{ text: clean(text), role: "header" }], o.color);
/** Paragraph wrapped to the width, for hints and verdicts. */
export const paragraph = (text: string, o: TextOptions, t?: Tone, indent = "") => wrap(text, o.columns, indent).map(line => paintSpans([{ text: line, ...(t ? { role: TONE_ROLES[t] } : {}) }], o.color)).join("\n");
/** Joins the non-empty blocks with one blank line. */
export const blocks = (...parts: (string | undefined | false)[]) => parts.filter((part): part is string => !!part).join("\n\n");
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Write and validation issues: LEVEL, CODE, PATH and MESSAGE, errors first. */
export function issueTable(issues: readonly WriteIssue[], o: TextOptions): string | undefined {
  if (!issues.length) return undefined;
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return table(["LEVEL", "CODE", "PATH", "MESSAGE"], sorted.map(issue => [tone(`${markerCell(issue.severity === "error" ? "fail" : "warn", o.ascii === true)} ${issue.severity}`, issue.severity === "error" ? "fail" : "warn"), issue.code, issue.path ?? "-", issue.message]), o);
}
/** The command a person runs next, for example to confirm a preview or read the next page. */
export const nextCommand = (label: string, command: string, o: TextOptions) => `${label}: ${paintSpans([{ text: clean(command), role: "accent" }], o.color)}`;
/** Quotes one shell word only when it needs it, so a printed command can be pasted. */
export const shellWord = (word: string) => /^[\p{L}\p{N}_./:=@%+,-]+$/u.test(word) ? word : `'${word.replace(/'/g, `'"'"'`)}'`;
