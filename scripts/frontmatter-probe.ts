import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, lstatSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseFrontmatter, emitFrontmatter } from "../src/frontmatter.ts";
/** Local read-only probe. Aggregate counters/hash only; never output names, contents or parser messages. */
export function probeFrontmatter(vault:string,output:string){
  const root=realpathSync(vault),notes=join(root,"notes");
  const candidate=(file:string):string=>{try{return realpathSync(file);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;const parent=dirname(file);if(parent===file)throw error;return join(candidate(parent),basename(file));}};
  const target=resolve(output),rel=relative(root,candidate(target));
  if(!rel || (rel!==".."&&!rel.startsWith("../")&&!isAbsolute(rel)))throw new Error("probe: result must stay outside the vault");if(realpathSync(notes)!==notes)throw new Error("probe: notes directory must be plain");
  const files=readdirSync(notes,{withFileTypes:true}).filter(entry=>entry.isFile()&&entry.name.endsWith(".md")).map(entry=>entry.name).sort();
  if(files.length>10000)throw new Error("probe: note count exceeds bound");
  let parsed=0,parseFailures=0,roundTripDiffs=0,readFailures=0,unstable=0,bytes=0;
  const digest=createHash("sha256"),seen=new Map<string,string>();
  const stamp=(stat:ReturnType<typeof fstatSync>)=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(":");
  for(const file of files){
    let fd:number|undefined;
    try{
      fd=openSync(join(notes,file),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const before=fstatSync(fd);if(!before.isFile()||before.size>2*1024*1024)throw new Error("bound");
      bytes+=before.size;if(bytes>64*1024*1024)throw new Error("aggregate bound");
      const buffer=Buffer.alloc(before.size+1);let size=0;
      while(size<buffer.length){const count=readSync(fd,buffer,size,buffer.length-size,null);size+=count;if(!count)break;}
      const raw=buffer.subarray(0,size),after=fstatSync(fd);seen.set(file,stamp(after));
      if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs){unstable++;continue;}
      digest.update(file+"\n").update(createHash("sha256").update(raw).digest());
      try{const doc=parseFrontmatter(raw.toString("utf8"));parsed++;if(!Buffer.from(emitFrontmatter(doc)).equals(raw))roundTripDiffs++;}catch{parseFailures++;}
    }catch{readFailures++;}
    finally{if(fd!==undefined)closeSync(fd);}
  }
  const afterFiles=readdirSync(notes,{withFileTypes:true}).filter(entry=>entry.isFile()&&entry.name.endsWith(".md")).map(entry=>entry.name).sort();
  if(JSON.stringify(files)!==JSON.stringify(afterFiles))unstable++;
  for(const [file,expected] of seen)try{const current=lstatSync(join(notes,file));if(!current.isFile()||current.isSymbolicLink()||stamp(current)!==expected)unstable++;}catch{unstable++;}
  const report={schema:1,measuredAt:new Date().toISOString(),notes:files.length,parsed,parseFailures,roundTripDiffs,readFailures,unstable,snapshotSha256:digest.digest("hex"),contentIncluded:false,ok:parsed===files.length&&parseFailures===0&&roundTripDiffs===0&&readFailures===0&&unstable===0};
  mkdirSync(dirname(target),{recursive:true,mode:0o700});
  const resultFd=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);try{writeFileSync(resultFd,JSON.stringify(report,null,2)+"\n");}finally{closeSync(resultFd);}console.log(JSON.stringify(report));return report;
}
if(import.meta.main){const [flag,vault,out,output]=process.argv.slice(2);if(flag!=="--vault"||out!=="--output"||!vault||!output)throw new Error("usage: --vault PATH --output PRIVATE-COUNTS.json");if(!probeFrontmatter(vault,output).ok)process.exitCode=1;}
