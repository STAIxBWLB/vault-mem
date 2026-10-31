import { MAX_REPORT_BYTES } from "./write-validation.ts";
import type { VaultSpec } from "./config.ts";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry } from "./registry.ts";
import { analysisRead } from "./analysis-input.ts";
import { appendLog } from "./vault-log.ts";
import type { AnalysisSnapshot } from "./analysis-types.ts";
import type { WriteReceipt } from "./write-types.ts";
import { applyWrite, sha256 } from "./writer.ts";
import { analysisInput } from "./analysis-input.ts";
import { lintVault } from "./vault-lint.ts";
import { buildGraph, graphReport } from "./vault-graph.ts";

export interface AnalysisRequest { vault: string; kind: "lint" | "graph"; dryRun?: boolean; channel?: "cli" | "mcp"; today?: string; note?: string; expectedVault?: VaultSpec }
function trend(snapshot: AnalysisSnapshot, nodes: number, edges: number, communities: number, top: string): string {
  const seed = "---\ntype: report\nkind: graph-trend\n---\n\n# Graph Trend (vault layer)\n\n| 빌드 | Nodes | Edges | Communities | Density | Top hub (degree 1위) |\n|---|---|---|---|---|---|\n";
  const source = snapshot.reports["graph-trend.md"] ?? seed;
  const lines = source.trimEnd().split("\n");
  const density = nodes > 1 ? 2*edges/(nodes*(nodes-1)) : 0;
  const row = `| ${snapshot.today} | ${nodes} | ${edges} | ${communities} | ${density.toFixed(4)} | ${top ? `\`${top}\`` : "-"} |`;
  let insert = -1;
  for (const [i,line] of lines.entries()) if (/^\| (?:\d{4}-\d{2}-\d{2}) \|/.test(line) || line.startsWith("|---")) insert = i;
  if (insert < 0) { lines.push("", ...seed.trimEnd().split("\n").slice(-2)); insert = lines.length-1; }
  lines.splice(insert+1,0,row);
  return lines.join("\n")+"\n";
}
export function writeAnalysisReports(home: string, request: AnalysisRequest, env: NodeJS.ProcessEnv = process.env) {
  const {snapshot,vault,config,identity} = analysisInput(home,request.vault,{today:request.today,expectedVault:request.expectedVault});
  const binding = {vault,denyPaths:config.denyPaths ?? [],piiPatterns:config.piiPatterns ?? [],dev:Number(identity.dev),ino:Number(identity.ino)};
  const unchanged = () => {
    const current = loadRegistry(home), stat = lstatSync(vault.path);
    if (JSON.stringify(current) !== JSON.stringify(config) || stat.dev !== identity.dev || stat.ino !== identity.ino || stat.isSymbolicLink()) throw new Error("analysis: vault or policy changed during build");
  };
  const outputs: {path:string;text:string}[] = [];
  let summary: unknown;
  if (request.kind === "lint") {
    const lint = lintVault(snapshot,request.note); summary = {findings:lint.findings,errors:lint.errors,warnings:lint.warnings,summary:lint.summary};
    outputs.push({path:`reports/lint-report-${snapshot.today.slice(2).replaceAll("-","")}.md`,text:lint.markdown+"\n"+lint.summary+"\n"});
  } else {
    const graph = buildGraph(snapshot), communities = new Set(graph.nodes.flatMap(n => n.community === null ? [] : [n.community])).size;
    summary = {nodes:graph.nodes.length,edges:graph.edges.length,communities};
    const top = [...graph.nodes].filter(n => n.type !== "moc").sort((a,b) => b.degree-a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]?.id ?? "";
    outputs.push({path:"reports/vault-graph.json",text:JSON.stringify(graph,null,2)+"\n"},
      {path:`reports/graph-report-${snapshot.today.slice(2).replaceAll("-","")}.md`,text:graphReport(graph,snapshot.today)},
      {path:"reports/graph-trend.md",text:trend(snapshot,graph.nodes.length,graph.edges.length,communities,top)});
  }
  const originals = new Map(outputs.map(out => {
    const name = out.path.slice("reports/".length);
    return [out.path, request.kind === "graph" ? snapshot.reports[name] ?? null : analysisRead(join(vault.path,out.path), MAX_REPORT_BYTES)] as const;
  }));
  unchanged();
  for (const out of outputs) if (analysisRead(join(vault.path,out.path), MAX_REPORT_BYTES) !== originals.get(out.path)) throw new Error("analysis: report changed during build");
  const expectedShas = Object.fromEntries(snapshot.notes.map(n => ["notes/"+n.path.replace(/^notes\//,""),sha256(n.source)]));
  // Preflight every output through the same validation pipeline, before any output is written.
  const previews = outputs.map(out => applyWrite(home,{vault:request.vault,operation:{op:"report",...out},dryRun:true,channel:request.channel,expectedShas,log:false},{env}));
  if (request.dryRun || previews.some(r => !r.ok)) return {ok:previews.every(r => r.ok),applied:false,summary,paths:outputs.map(o => o.path),receipts:previews};
  const receipts: WriteReceipt[] = [];
  for (const out of outputs) {
    unchanged();
    if (analysisRead(join(vault.path,out.path), MAX_REPORT_BYTES) !== originals.get(out.path)) throw new Error("analysis: report changed during build");
    const receipt = applyWrite(home,{vault:request.vault,operation:{op:"report",...out},channel:request.channel,expectedShas,log:false},{env});
    receipts.push(receipt);
    if (!receipt.ok) break;
  }
  const complete = receipts.length === outputs.length && receipts.every(r => r.ok);
  unchanged();
  const log = complete ? appendLog(home,{vault:request.vault,channel:request.channel,event:{type:request.kind === "lint" ? "LINT" : "GRAPH",project:"-",source:"vmem",dest:outputs[0]!.path,note:request.kind === "lint" ? "Vault lint report" : "Vault graph reports"}},{env,binding}) : undefined;
  return {ok:complete && log?.ok === true,applied:receipts.some(r => r.applied),summary,paths:outputs.map(o => o.path),receipts,log};
}
