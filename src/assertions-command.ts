/** CLI surface for the shared assertion read provider. */
import { readAssertions } from "./assertion-read.ts";
import { blocks, clean, heading, status, table, UsageError, type TextOptions } from "./text-output.ts";

export function runAssertionsCommand(args: string[], home: string, env: NodeJS.ProcessEnv, text: TextOptions): { text: string; code: number } {
  const positional: string[] = [], flags: Record<string, string | boolean> = {};
  const values = ["--subject", "--relation", "--at", "--as-of", "--limit", "--cursor"];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (!word.startsWith("-")) { positional.push(word); continue; }
    if (Object.hasOwn(flags, word) || ![...values, "--history", "--json"].includes(word)) throw new UsageError(`assertions: unknown or repeated option: ${word}`);
    if (!values.includes(word)) { flags[word] = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new UsageError(`${word}: value required`);
    flags[word] = value;
  }
  if (positional.length !== 1) throw new UsageError("assertions: requires one vault id; run vmem help assertions");
  const limit = flags["--limit"];
  if (typeof limit === "string" && !/^[1-9][0-9]*$/.test(limit)) throw new UsageError("--limit: expected an integer from 1 to 100");
  const result = readAssertions(home, { vault: positional[0]!,
    ...(typeof flags["--subject"] === "string" ? { subject: flags["--subject"] } : {}),
    ...(typeof flags["--relation"] === "string" ? { relation: flags["--relation"] } : {}),
    ...(typeof flags["--at"] === "string" ? { at: flags["--at"] } : {}),
    ...(typeof flags["--as-of"] === "string" ? { asOf: flags["--as-of"] } : {}),
    ...(typeof limit === "string" ? { limit: Number(limit) } : {}),
    ...(typeof flags["--cursor"] === "string" ? { cursor: flags["--cursor"] } : {}),
    ...(flags["--history"] === true ? { history: true } : {}) }, { env });
  if (flags["--json"]) return { text: JSON.stringify(result), code: 0 };
  const rows = result.items.map(item => [clean(item.subject), clean(item.relation), item.answer ?? "-", typeof item.value === "string" ? clean(item.value) : item.value ? "withheld" : "-", item.id]);
  return { text: blocks(heading(`Assertions in ${clean(result.vault)}`, text), table(["SUBJECT", "RELATION", "ANSWER", "VALUE", "ID"], rows, text),
    result.truncated ? status("pending", `more results: rerun with --cursor ${result.continuation}`, text) : status("ok", `${result.items.length} assertion(s) shown`, text),
    result.coverage.untrusted.length ? status("warn", `${result.coverage.untrusted.length} untrusted journal segment(s); inspect assertions/`, text) : undefined), code: 0 };
}
