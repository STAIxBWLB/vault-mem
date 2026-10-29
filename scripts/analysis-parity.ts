import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analysisCorpus } from "../test/fixtures/analysis-corpus.ts";
import { lintVault } from "../src/vault-lint.ts";
import { buildGraph } from "../src/vault-graph.ts";
import { isDeepStrictEqual } from "node:util";
/** Cross-check tools run the unchanged external Python oracle, or a frozen synthetic oracle in CI. */
export function parity(kind:"lint"|"graph", args:string[]) {
  if (args.length && (args[0] !== "--reference" || args.length !== 2)) throw new Error("usage: [--reference /absolute/reference.py]");
  const root = mkdtempSync(join(tmpdir(),"vmem-parity-"));
  try {
    const snapshot=analysisCorpus(join(root,"log"));
    mkdirSync(join(root,"notes"));mkdirSync(join(root,"reports"));
    for (const n of snapshot.notes) writeFileSync(join(root,"notes",n.path),n.source);
    for (const [name,text] of Object.entries(snapshot.reports)) writeFileSync(join(root,"reports",name),text);
    writeFileSync(join(root,"log"),snapshot.log!);
    const graph=buildGraph(snapshot),lint=lintVault(snapshot);
    const normalizeEdges=(edges:{source:string;target:string}[])=>edges.map(e=>[e.source,e.target].sort().join("|")).sort();
    const actual=kind==="lint" ? Object.fromEntries(Object.entries(lint.findings).filter(([code])=>code!=="L13").map(([code,items])=>[code,[...items].sort()])) : {nodes:graph.nodes.map(({community,degree,...node})=>node),edges:normalizeEdges(graph.edges)};
    let expected:unknown;
    if (args[1]) {
      const python=process.env.PYTHON ?? "python3";
      const code=kind==="lint" ? `import importlib.util,json,sys\nfrom pathlib import Path\nfrom datetime import date\ns=importlib.util.spec_from_file_location('oracle',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nv=Path(sys.argv[2]);n=m.scan(v);a,b,c,d,_=m.check_notes(n,{'rise'});e,_=m.check_log(v/'log');f,g,_=m.check_graph(v/'reports',date(2026,8,19));print(json.dumps(dict(zip(['L01','L02','L03','L09','L10','L11','L12'],[sorted(x) for x in [a,b,c,e,d,f,g]])),ensure_ascii=False))` : `import importlib.util,json,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('oracle',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\ng=m.build_graph(m.extract_wiki(Path(sys.argv[2])));print(json.dumps({'nodes':[dict(id=n,**d) for n,d in g.nodes(data=True)],'edges':sorted('|'.join(sorted([u,v])) for u,v in g.edges())},ensure_ascii=False))`;
      const proc=Bun.spawnSync([python,"-c",code,resolve(args[1]),root],{stdout:"pipe",stderr:"pipe"});
      if(proc.exitCode!==0)throw new Error("reference failed: "+proc.stderr.toString());
      expected=JSON.parse(proc.stdout.toString());
      // This artifact contains synthetic metadata/diagnostics only, never real note bodies.
      if(process.env.UPDATE_PARITY==="1") writeFileSync(new URL(`../test/fixtures/analysis/${kind}-oracle.json`,import.meta.url),JSON.stringify(expected,null,2).replaceAll(root,"/fixture")+"\n");
    } else expected=JSON.parse(readFileSync(new URL(`../test/fixtures/analysis/${kind}-oracle.json`,import.meta.url),"utf8").replaceAll("/fixture",root));
    if(!isDeepStrictEqual(actual,expected)) { process.stderr.write(JSON.stringify({actual,expected},null,2)+"\n");throw new Error(`${kind} parity differs`); }
    console.log(`${kind} parity: zero diff (${args[1] ? "external reference" : "frozen synthetic reference"})`);
  }finally{rmSync(root,{recursive:true,force:true});}
}
