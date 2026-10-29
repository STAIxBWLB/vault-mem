import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { VaultIndex } from "../src/vault-index.ts";
import { analysisInput } from "../src/analysis-input.ts";
import { lintVault } from "../src/vault-lint.ts";
import { buildGraph } from "../src/vault-graph.ts";
import graphFixture from "./fixtures/analysis/vault-graph.json";
import { writeAnalysisReports } from "../src/analysis-reports.ts";
import { run } from "../src/cli.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";
import { analysisCorpus } from "./fixtures/analysis-corpus.ts";
const roots:string[]=[];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function fixture(write:"mcp"|"cli"|"none"="mcp") {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"vmem-analysis-"))); roots.push(root);
  const home=join(root,"home"),vault=join(root,"vault"); mkdirSync(join(vault,"notes"),{recursive:true}); mkdirSync(join(vault,"reports"));
  const snapshot=analysisCorpus(join(vault,"log"));
  for (const note of snapshot.notes) writeFileSync(join(vault,"notes",note.path),note.source);
  for (const [name,text] of Object.entries(snapshot.reports)) writeFileSync(join(vault,"reports",name),text);
  writeFileSync(join(vault,"log"),snapshot.log!);
  const registry=join(root,"registry.yaml"); writeFileSync(registry,"projects:\n  - id: rise\n");
  const spec={id:"test",path:vault,kind:"personal" as const,write,registry}; addVault(home,spec);
  return {root,home,vault,spec,snapshot};
}
function disk(root:string): Record<string,string> {
  const out:Record<string,string>={};
  function visit(dir:string,prefix="") { for (const entry of readdirSync(dir,{withFileTypes:true})) { const file=join(dir,entry.name),key=prefix+entry.name; if(entry.isDirectory()) visit(file,key+"/"); else if(entry.isFile()) out[key]=readFileSync(file).toString("base64"); } }
  visit(root);return out;
}
test("lint preserves legacy rule semantics, invalid YAML, fences, project checks and stale/island warnings",()=>{
  const report=lintVault(analysisCorpus());
  expect(report.findings.L01).toHaveLength(4);
  expect(report.findings.L02).toHaveLength(8);
  expect(report.findings.L03).toEqual(["`notes/c.md`: in-link 0, topics 0"]);
  expect(report.findings.L09).toHaveLength(2);expect(report.findings.L10).toHaveLength(2);
  expect(report.findings.L11[0]).toContain("230일");expect(report.findings.L12[0]).toContain("`d`, `e`");
  expect(report.summary).toBe("SUMMARY errors=12 warnings=7");
  expect(report.markdown).toContain("## L02 — 필수 frontmatter / 허용값");
  const only=lintVault(analysisCorpus(),"notes/b.md");expect(only.findings.L01).toHaveLength(1);expect(only.findings.L02).toHaveLength(2);
});
test("analysis snapshot retains invalid rows, updates incrementally and consumers never reopen note files",()=>{
  const f=fixture(),index=new VaultIndex(f.home,f.spec);
  try {
    index.scan(false,{captureInvalidFrontmatter:true});
    const {notes:_,...inputs}=f.snapshot;
    expect(index.analysisSnapshot(inputs).notes).toHaveLength(9);
    const changed=join(f.vault,"notes","invalid.md");writeFileSync(changed,"---\ntype: moc\ndescription: Fixed synthetic\n---\n");
    index.scan(false,{captureInvalidFrontmatter:true});
    const cached=index.analysisSnapshot(inputs);
    rmSync(join(f.vault,"notes"),{recursive:true});
    expect(lintVault(cached).findings.L02).toHaveLength(7);expect(buildGraph(cached).nodes).toHaveLength(9);
  }finally{index.close();}
});
test("lint read and graph/lint dry runs preserve every filesystem byte with no cache/lock creation",()=>{
  const f=fixture(),before=disk(f.root);
  expect(analysisInput(f.home,"test",{today:f.snapshot.today}).snapshot).toEqual(f.snapshot);
  expect(writeAnalysisReports(f.home,{vault:"test",kind:"graph",dryRun:true,today:f.snapshot.today}).ok).toBe(true);
  expect(writeAnalysisReports(f.home,{vault:"test",kind:"lint",dryRun:true,today:f.snapshot.today}).ok).toBe(true);
  run(["lint","test","--json"],{VMEM_HOME:f.home});run(["graph","neighbors","test","a","--hops","2","--limit","3"],{VMEM_HOME:f.home});
  expect(disk(f.root)).toEqual(before);
});
test("build persists consumer-schema artifact, report, append-only trend and GRAPH/LINT events through writer",()=>{
  const f=fixture();
  const first=writeAnalysisReports(f.home,{vault:"test",kind:"graph",today:f.snapshot.today});expect(first.ok).toBe(true);expect(first.applied).toBe(true);
  const graph=JSON.parse(readFileSync(join(f.vault,"reports","vault-graph.json"),"utf8"));
  expect(Array.isArray(graph.edges)).toBe(true);expect(graph.nodes.every((n:{id:unknown;label:unknown;community:unknown})=>typeof n.id === "string" && typeof n.label === "string" && (n.community===null || typeof n.community === "number"))).toBe(true);
  const old=readFileSync(join(f.vault,"reports","graph-report-260101.md"),"utf8");
  expect(old).toBe("# Synthetic old report\n");
  const report=readFileSync(join(f.vault,"reports","graph-report-260819.md"),"utf8");expect(report).toContain("## Communities");expect(report).toContain("## Surprising Connections");
  expect(writeAnalysisReports(f.home,{vault:"test",kind:"graph",today:f.snapshot.today}).ok).toBe(true);
  expect(readFileSync(join(f.vault,"reports","graph-trend.md"),"utf8").match(/\| 2026-08-19 \|/g)).toHaveLength(2);
  expect(writeAnalysisReports(f.home,{vault:"test",kind:"lint",today:f.snapshot.today}).ok).toBe(true);
  const log=readFileSync(join(f.vault,"log"),"utf8");expect(log).toContain("  GRAPH  ");expect(log).toContain("  LINT  ");
  expect(report).not.toContain("A synthetic missing-frontmatter fixture");
});
test("write refusals and symlink reports fail closed; MCP read works for readonly vault",async()=>{
  const f=fixture("none"),before=disk(f.root);
  expect(writeAnalysisReports(f.home,{vault:"test",kind:"graph",today:f.snapshot.today}).ok).toBe(false);expect(disk(f.root)).toEqual(before);
  const mcp=createVaultMcp(f.home);expect(mcp.tools.some(t=>t.name==="vmem_graph_neighbors")).toBe(true);
  const result=await mcp.handlers.vmem_graph_neighbors!({vault:"test",path:"a",hops:1,limit:2});expect(result).toBeDefined();
  const g=fixture();rmSync(join(g.vault,"reports","vault-graph.json"));symlinkSync(join(g.root,"registry.yaml"),join(g.vault,"reports","vault-graph.json"));
  expect(()=>analysisInput(g.home,"test")).toThrow();
});
test("frozen reference oracles remain zero-diff for lint and graph",()=>{
  for(const script of ["scripts/lint-parity.ts","scripts/graph-parity.ts"]) {
    const proc=Bun.spawnSync([process.execPath,script],{stdout:"pipe",stderr:"pipe"});
    expect(proc.stderr.toString()).toBe("");expect(proc.exitCode).toBe(0);expect(proc.stdout.toString()).toContain("zero diff");
  }
});
test("cached analysis survives unchanged invalid YAML without rereading note sources",()=>{
  const f=fixture(),persistent=new VaultIndex(f.home,f.spec);
  try{persistent.scan(false,{captureInvalidFrontmatter:true});}finally{persistent.close();}
  const before=disk(f.root),memory=new VaultIndex(f.home,f.spec,[f.vault],{memory:true});
  try{
    expect(memory.scan(false,{captureInvalidFrontmatter:true}).changed).toBe(0);
    const {notes:_,...inputs}=f.snapshot;
    expect(memory.analysisSnapshot(inputs)).toEqual(f.snapshot);
  }finally{memory.close();}
  expect(disk(f.root)).toEqual(before);
});
test("MCP analysis refuses a registry rebound after server startup",async()=>{
  const f=fixture(),other=fixture();
  const server=createVaultMcp(f.home);
  writeFileSync(join(f.home,"vmem.config.json"),JSON.stringify({vaults:[{...f.spec,path:other.vault}]}));
  const before=disk(other.root);
  const result=await server.handlers.vmem_graph_neighbors!({vault:"test",path:"a",hops:1,limit:2}) as {refused?:boolean};
  expect(result.refused).toBe(true);expect(disk(other.root)).toEqual(before);
});
test("lint --write preserves nonzero exit for error findings and L13 rejects invalid filenames",()=>{
  const f=fixture();
  expect(run(["lint","test","--write","--dry-run"],{VMEM_HOME:f.home}).code).toBe(1);
  const snapshot=analysisCorpus();snapshot.notes.push({path:"Bad_Name.md",source:"---\ntype: moc\ndescription: Synthetic\n---\n"});
  expect(lintVault(snapshot).findings.L13).toHaveLength(1);
});
test("log failure is reported separately from persisted graph reports",()=>{
  const f=fixture();writeFileSync(join(f.vault,"log.lock"),"foreign lock\n");
  const result=writeAnalysisReports(f.home,{vault:"test",kind:"graph",today:f.snapshot.today});
  expect(result.ok).toBe(false);expect(result.applied).toBe(true);
  expect(JSON.parse(readFileSync(join(f.vault,"reports","vault-graph.json"),"utf8")).nodes).toHaveLength(9);
  expect(readFileSync(join(f.vault,"log.lock"),"utf8")).toBe("foreign lock\n");
  expect(readFileSync(join(f.vault,"log"),"utf8")).toBe(f.snapshot.log!);
});

test("published synthetic consumer fixture stays in sync with the builder",()=>{
  const built: unknown = JSON.parse(JSON.stringify(buildGraph(analysisCorpus())));
  expect(built).toEqual(graphFixture);
});
test("report snapshot binding refuses registry rebind and preserves concurrent trend history",()=>{
  for(const mode of ["rebind","trend"]) {
    const f=fixture(),other=fixture();
    const trend=join(f.vault,"reports","graph-trend.md");writeFileSync(trend,"# Synthetic original history\n");
    const before=disk(other.root),artifact=readFileSync(join(f.vault,"reports","vault-graph.json"),"utf8");
    const child=Bun.spawnSync([process.execPath,"test/fixtures/analysis-race.ts",f.home,f.vault,other.vault,mode],{stdout:"pipe",stderr:"pipe"});
    expect(child.stderr.toString()).toBe("");expect(child.exitCode).toBe(0);expect(JSON.parse(child.stdout.toString())).toEqual({injected:true,threw:true});
    expect(disk(other.root)).toEqual(before);expect(readFileSync(join(f.vault,"reports","vault-graph.json"),"utf8")).toBe(artifact);
    if(mode==="trend")expect(readFileSync(trend,"utf8")).toContain("Concurrent build history preserved.");
  }
});
