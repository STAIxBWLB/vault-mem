import { analysisInput } from "./analysis-input.ts";
import { lintDetails } from "./vault-lint.ts";
import { analysisWriteText, lintText, neighborsText } from "./read-output.ts";
import { buildGraph, graphNeighbors } from "./vault-graph.ts";
import { writeAnalysisReports } from "./analysis-reports.ts";
import { PLAIN, type TextOptions } from "./text-output.ts";

export function runAnalysisCommand(command: string, args: string[], home: string, env: NodeJS.ProcessEnv = process.env, text: TextOptions = PLAIN): { text: string; code: number } {
  const values: Record<string,string> = {}, flags = new Set<string>(), positional: string[] = [];
  for (let i=0;i<args.length;i++) {
    const word = args[i]!;
    if (!word.startsWith("-")) { positional.push(word); continue; }
    if (word in values || flags.has(word)) throw new Error("analysis: repeated option");
    if (["--json","--dry-run","--write","--workspace"].includes(word)) flags.add(word);
    else if (["--note","--hops","--limit","--relation"].includes(word)) { const value = args[++i]; if (!value || value.startsWith("--")) throw new Error(`${word}: requires value`); values[word]=value; }
    else throw new Error(`analysis: unknown option ${word}`);
  }
  if (command === "lint") {
    if (positional.length !== 1 || values["--hops"] || values["--limit"] || values["--relation"] || flags.has("--workspace")) throw new Error("lint: requires one vault id");
    if (flags.has("--write")) { const result = writeAnalysisReports(home,{vault:positional[0]!,kind:"lint",note:values["--note"],dryRun:flags.has("--dry-run")},env); return {text:flags.has("--json") ? JSON.stringify(result) : analysisWriteText(result,text,{kind:"lint",dryRun:flags.has("--dry-run")}),code:result.ok && (result.summary as {errors?:number}).errors === 0 ? 0 : 1}; }
    const {snapshot} = analysisInput(home,positional[0]!);
    const details = lintDetails(snapshot,values["--note"]), report = details.report;
    return {text:flags.has("--json") ? JSON.stringify(report) : lintText(details,text,{vault:positional[0]!,note:values["--note"]}),code:report.errors ? 1 : 0};
  }
  const action = positional.shift();
  if (values["--note"] || flags.has("--write")) throw new Error("graph: unsupported option");
  if (action === "build") {
    if (positional.length !== 1 || values["--hops"] || values["--limit"] || values["--relation"]) throw new Error("graph build: requires one vault id");
    const result = writeAnalysisReports(home,{vault:positional[0]!,kind:"graph",workspace:flags.has("--workspace"),dryRun:flags.has("--dry-run")},env);
    return {text:flags.has("--json") ? JSON.stringify(result) : analysisWriteText(result,text,{kind:"graph",dryRun:flags.has("--dry-run")}),code:result.ok ? 0 : 1};
  }
  if (action !== "neighbors" || positional.length !== 2 || flags.has("--workspace")) throw new Error("graph: use build <vault> or neighbors <vault> <stem>");
  const hops = Number(values["--hops"] ?? 1), limit = Number(values["--limit"] ?? 50);
  if ((hops !== 1 && hops !== 2) || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("graph neighbors: hops 1..2, limit 1..500");
  const {snapshot} = analysisInput(home,positional[0]!);
  const result = graphNeighbors(buildGraph(snapshot),positional[1]!,hops,limit,values["--relation"]);
  return {text:flags.has("--json") ? JSON.stringify(result) : neighborsText(result,text,{vault:positional[0]!,limit,relation:values["--relation"]}),code:0};
}
