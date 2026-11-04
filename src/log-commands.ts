import { appendLog, readLog } from "./vault-log.ts";
import type { LogEvent } from "./log-types.ts";
import { PLAIN, type TextOptions } from "./text-output.ts";
import { logAppendText, logReadText } from "./read-output.ts";
export function runLogCommand(args: string[], home: string, env: NodeJS.ProcessEnv = process.env, text: TextOptions = PLAIN): { text: string; code: number } {
  const command = args[0];
  if (!["tail", "grep", "append"].includes(command ?? "")) throw new Error("log: use tail, grep or append");
  const positional: string[] = [], flags: Record<string, string | boolean> = {};
  const values = command === "append" ? ["--dest"] : ["--limit", "--type"];
  for (let i = 1; i < args.length; i++) {
    const word = args[i]!;
    if (!word.startsWith("--")) { positional.push(word); continue; }
    if (Object.hasOwn(flags, word) || (word !== "--json" && !values.includes(word))) throw new Error(`log ${command}: unknown or repeated option: ${word}`);
    if (word === "--json") flags[word] = true;
    else {
      const value = args[++i]; if (value === undefined || value.startsWith("--")) throw new Error("log: option value required");
      flags[word] = value;
    }
  }
  let result, out: (o: TextOptions) => string;
  if (command === "append") {
    if (positional.length !== 5) throw new Error("log append: requires vault, TYPE, project, source and note");
    const [vault, type, project, source, note] = positional as [string, string, string, string, string];
    const event: LogEvent = { type, project, source, note, ...(typeof flags["--dest"] === "string" ? { dest: flags["--dest"] } : {}) };
    const receipt = result = appendLog(home, { vault, event, channel: "cli" }, { env });
    out = o => logAppendText(receipt, o, { vault, type });
  } else {
    if (positional.length !== (command === "grep" ? 2 : 1)) throw new Error(`log ${command}: requires vault${command === "grep" ? " and pattern" : ""}`);
    const value = flags["--limit"];
    if (value !== undefined && (typeof value !== "string" || !/^[0-9]+$/.test(value))) throw new Error("log limit: expected integer 1..200");
    const read = result = readLog(home, { vault: positional[0]!, ...(value !== undefined ? { limit: Number(value) } : {}), ...(command === "grep" ? { grep: positional[1] } : {}), ...(typeof flags["--type"] === "string" ? { type: flags["--type"] } : {}) });
    const type = typeof flags["--type"] === "string" ? flags["--type"] : undefined;
    out = o => logReadText(read, o, { command: command as "tail" | "grep", vault: positional[0]!, ...(command === "grep" ? { pattern: positional[1]! } : {}), limit: value !== undefined ? Number(value) : 50, ...(type ? { type } : {}) });
  }
  return { text: flags["--json"] ? JSON.stringify(result) : out(text), code: result.ok ? 0 : 1 };
}
