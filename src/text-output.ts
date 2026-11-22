/**
 * Text output for people (#114), after agent-hub's CLI conventions: uppercase-header tables sized by display width,
 * aligned field blocks, a wrapped description column and `--color=auto|always|never`. `--json` output never comes
 * through here, and color only adds emphasis: every renderer's text is complete without it.
 */
import { asciiMarkers, cellWidth, resolveColor, streamEnv } from "@staix/cli-output";

export interface TextOptions { color: boolean; columns?: number; ascii?: boolean }
/** Plain text, no wrapping: the default for library callers and tests. */
export const PLAIN: TextOptions = { color: false };
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

/** Single-line control-to-space handling is retained pending STAIxBWLB/cli-output#8. */
export const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
export const width = cellWidth;
/** Note and spec bodies printed as is, minus terminal escape sequences (OSC, CSI, C1) and control characters other than tab and newline. */
// Keep complete C1 sequence handling and CR normalization until STAIxBWLB/cli-output#8.
export const stripTerminal = (text: string) => text
  .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]?|\u009b[0-?]*[ -/]*[@-~]?|\u001b[^[\]]?/g, "")
  .replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
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
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Quotes one shell word only when it needs it, so a printed command can be pasted. */
export const shellWord = (word: string) => /^[\p{L}\p{N}_./:=@%+,-]+$/u.test(word) ? word : `'${word.replace(/'/g, `'"'"'`)}'`;
