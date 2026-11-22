/**
 * Text output for people (#114), after agent-hub's CLI conventions: uppercase-header tables sized by display width,
 * aligned field blocks, a wrapped description column and `--color=auto|always|never`. `--json` output never comes
 * through here, and color only adds emphasis: every renderer's text is complete without it.
 */
import { asciiMarkers, resolveColor, streamEnv, streamWidth } from "@staix/cli-output";

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
/** Options for a stdout; the default is a non-terminal, so library calls and tests get the same text everywhere. */
export function textOptions(flag: string | undefined, env: NodeJS.ProcessEnv = process.env, stdout: { isTTY?: boolean; columns?: number } = {}, ascii = false): TextOptions {
  const isTTY = stdout.isTTY === true, color = resolveColor(flag, streamEnv(isTTY, env), "vmem");
  if (color instanceof Error) throw new UsageError(COLOR_USAGE);
  const columns = streamWidth(isTTY, stdout.columns ?? (isTTY ? 80 : undefined), env);
  return { color, ascii: asciiMarkers(env, ascii), ...(columns !== undefined ? { columns } : {}) };
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Quotes one shell word only when it needs it, so a printed command can be pasted. */
export const shellWord = (word: string) => /^[\p{L}\p{N}_./:=@%+,-]+$/u.test(word) ? word : `'${word.replace(/'/g, `'"'"'`)}'`;
