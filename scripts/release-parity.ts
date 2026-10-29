import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { parseFrontmatter, emitFrontmatter } from "../src/frontmatter.ts";
import { VaultIndex } from "../src/vault-index.ts";
import { addVault } from "../src/registry.ts";
import { lintVault } from "../src/vault-lint.ts";
import { analysisInput } from "../src/analysis-input.ts";
import { parity } from "./analysis-parity.ts";
import { runtimeDigest } from "./release-performance.ts";
function check(value:unknown,message:string):asserts value{if(!value)throw new Error("release parity: "+message);}
function indexed(index:VaultIndex){const db=new Database(index.file,{readonly:true});try{return {fts:db.query("SELECT path,title,description,body FROM fts ORDER BY path").all(),notes:db.query("SELECT path,hash,title,description,body,type,domain,aliases,source FROM notes ORDER BY path").all(),links:db.query("SELECT data FROM links ORDER BY source,ordinal").all()};}finally{db.close();}}
export function verifyReleaseParity(options:{lintReference?:string;graphReference?:string;output?:string}={}):void {
  const repo=resolve(import.meta.dir,".."),root=realpathSync(mkdtempSync(join(tmpdir(),"vmem-release-parity-"))),home=join(root,"state"),vault=join(root,"vault"),notes=join(vault,"notes");
  mkdirSync(notes,{recursive:true});
  try{
    const hash=createHash("sha256"),files=readdirSync(join(repo,"test/fixtures/release/notes")).sort();
    for(const file of files){const bytes=readFileSync(join(repo,"test/fixtures/release/notes",file)),source=bytes.toString("utf8");check(Buffer.from(emitFrontmatter(parseFrontmatter(source))).equals(bytes),"frontmatter bytes changed");hash.update(file+"\n").update(bytes);writeFileSync(join(notes,file),bytes);}
    const spec={id:"fixture",path:vault,kind:"personal" as const,write:"mcp" as const};addVault(home,spec);
    const index=new VaultIndex(home,spec),steps:string[]=[];
    try{
      index.scan();
      check(files.every(file=>index.links(file).every(link=>link.resolved!==null)),"fixture link did not resolve");
      const initial=lintVault(analysisInput(home,"fixture").snapshot);check(initial.errors===0,"fixture has frontmatter/link errors");
      const actions:[string,()=>void][]=[
        ["baseline",()=>{}],
        ["create",()=>writeFileSync(join(notes,"temporary.md"),'---\ntype: moc\ndescription: Synthetic temporary note.\n---\n[[research]]\n')],
        ["edit",()=>writeFileSync(join(notes,"temporary.md"),'---\ntype: moc\ndescription: Synthetic changed note.\n---\n[[method]]\n')],
        ["rename",()=>renameSync(join(notes,"temporary.md"),join(notes,"renamed.md"))],
        ["delete",()=>rmSync(join(notes,"renamed.md"))],
      ];
      for(const [name,action] of actions){action();index.scan();const clean=new VaultIndex(join(root,"clean-"+name),spec);try{clean.scan(true);check(isDeepStrictEqual(indexed(index),indexed(clean)),"incremental/rebuild mismatch: "+name);steps.push(name);}finally{clean.close();}}
    }finally{index.close();}
    const rounds=[];
    for(let run=1;run<=2;run++){parity("lint",options.lintReference?["--reference",options.lintReference]:[]);parity("graph",options.graphReference?["--reference",options.graphReference]:[]);rounds.push({run,lint:"zero-diff",graph:"zero-diff"});}
    const report={schema:1,measuredAt:new Date().toISOString(),runtimeDigest:runtimeDigest(repo),fixtureDigest:hash.digest("hex"),frontmatter:{files:files.length,roundTrip:"byte-identical"},incrementalIndex:{matchesCleanRebuild:steps},references:{lint:options.lintReference?"external Python":"frozen synthetic Python oracle",graph:options.graphReference?"external Python":"frozen synthetic Python oracle",retired:false},rounds,obsidian:{syntaxAndLinks:"pass",nativeApplication:"unverified",reason:"Provider fixture checks do not prove native badges/rendering"},consumer:{schema:"nodes/edges fixture tested",nativeConsumer:"unverified in this run"},privateCorpus:"unverified"};
    if(options.output){mkdirSync(resolve(options.output,".."),{recursive:true});writeFileSync(options.output,JSON.stringify(report,null,2)+"\n");}
    console.log("VMEM_PARITY="+JSON.stringify(report));
  }finally{rmSync(root,{recursive:true,force:true});}
}
if(import.meta.main){const args=process.argv.slice(2),options:Parameters<typeof verifyReleaseParity>[0]={};for(let i=0;i<args.length;i++){const value=args[++i];if(!value)throw new Error("parity option value required");const key=args[i-1];if(key==="--lint-reference")options.lintReference=value;else if(key==="--graph-reference")options.graphReference=value;else if(key==="--output")options.output=value;else throw new Error("unknown parity option");}verifyReleaseParity(options);}
