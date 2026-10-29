import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { releaseRpc } from "./release-rpc.ts";
export function percentile(samples:number[],quantile:number):number {
  if(!samples.length || samples.some(n=>!Number.isFinite(n)||n<0) || !Number.isFinite(quantile) || quantile<=0 || quantile>1)throw new Error("invalid percentile samples");
  return [...samples].sort((a,b)=>a-b)[Math.ceil(quantile*samples.length)-1]!;
}
export function runtimeDigest(root:string):string {
  const hash=createHash("sha256"),files:string[]=["package.json"];
  function walk(dir:string){for(const entry of readdirSync(join(root,dir),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)){const file=dir+"/"+entry.name;if(entry.isDirectory())walk(file);else if(entry.isFile())files.push(file);else throw new Error("runtime source must be plain");}}
  walk("src");walk("bin");for(const file of files.sort()){hash.update(file+"\n");hash.update(readFileSync(join(root,file)));hash.update("\n");}return hash.digest("hex");
}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export async function measureReleasePerformance(output:string):Promise<boolean>{
  if(process.platform!=="linux")throw new Error("release measurements run on the authorized Linux dgx02 container only");
  const repo=resolve(import.meta.dir,".."),root=realpathSync(mkdtempSync(join(tmpdir(),"vmem-perf-"))),vault=join(root,"vault"),home=join(root,"state"),notes=join(vault,"notes");
  const env={...process.env,VMEM_HOME:home,AMEM_HOME:join(root,"amem"),CODEX_THREAD_ID:"synthetic-release-benchmark"};
  let rpc:ReturnType<typeof releaseRpc>|undefined,timer:ReturnType<typeof setInterval>|undefined;
  const command=(args:string[])=>{const r=Bun.spawnSync([process.execPath,"--smol",join(repo,"bin/vmem.js"),...args],{cwd:root,env,stdout:"pipe",stderr:"pipe",timeout:120000});if(r.exitCode!==0)throw new Error("synthetic benchmark command failed: "+args[0]);return r.stdout.toString();};
  try{
    mkdirSync(notes,{recursive:true});
    writeFileSync(join(notes,"research.md"),'---\ntype: moc\ndescription: Synthetic benchmark navigation.\n---\n# Research\n');
    for(let i=0;i<4999;i++){
      const id=String(i).padStart(4,"0"),next=String((i+1)%4999).padStart(4,"0");
      writeFileSync(join(notes,`finding-${id}.md`),`---\ntitle: Synthetic Finding ${id}\ntype: insight\ndomain: research\ndescription: Synthetic benchmark observation ${id}.\ntopics: ["[[research]]"]\n---\n# Synthetic Finding ${id}\n\nSynthetic marker${id} evidence. Revision 0.\n\n## Connections\n\n- [[finding-${next}]]\n\n## Topics\n\n- [[research]]\n`);
    }
    command(["vaults","add","bench",vault,"--kind","personal","--write","mcp"]);command(["rebuild","bench"]);
    rpc=releaseRpc([process.execPath,"--smol",join(repo,"bin/vmem.js"),"mcp"],env);
    const rssSamples:{phase:string;rssBytes:number;highWaterBytes:number}[]=[];let phase="startup",peak=0;
    const sample=()=>{try{const status=readFileSync(`/proc/${rpc!.child.pid}/status`,"utf8"),rss=Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1])*1024,hwm=Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1])*1024;if(Number.isFinite(rss)&&Number.isFinite(hwm)){rssSamples.push({phase,rssBytes:rss,highWaterBytes:hwm});peak=Math.max(peak,hwm);}}catch{/* Process exit is handled by RPC client. */}};
    timer=setInterval(sample,20);sample();await rpc.initialize();await rpc.request("tools/list");phase="idle";await pause(300);sample();
    const idle=Math.max(...rssSamples.filter(s=>s.phase==="idle").map(s=>s.rssBytes));
    if(!Number.isFinite(idle)||idle<=0||peak<=0)throw new Error("RSS telemetry unavailable");
    const search:number[]=[];phase="search";
    for(let i=0;i<35;i++){
      const query="marker"+String((i*137)%4999).padStart(4,"0"),start=performance.now();
      const result=await rpc.request("tools/call",{name:"vmem_search",arguments:{vault:"bench",query,limit:10}}),elapsed=performance.now()-start;
      const payload=JSON.parse(result.content[0].text);if(!payload.hits?.length)throw new Error("synthetic search returned no hit");if(i>=5)search.push(elapsed);sample();
    }
    phase="post-search";sample();clearInterval(timer);timer=undefined;await rpc.close();rpc=undefined;
    const writes:number[]=[];
    for(let i=0;i<5;i++){const start=performance.now(),result=JSON.parse(command(["patch","bench","finding-0000","--old",`Revision ${i}.`,"--new",`Revision ${i+1}.`,"--json"]));if(!result.ok||!result.applied||!result.logged)throw new Error("synthetic write failed");writes.push(performance.now()-start);}
    const revision=Bun.spawnSync(["git","rev-parse","HEAD"],{cwd:repo,stdout:"pipe",stderr:"pipe"}).stdout.toString().trim();
    const optional=(file:string)=>{try{return readFileSync(file,"utf8").trim();}catch{return "unavailable";}};
    const gates={mcpIdleRss:{value:idle,limit:100000000,unit:"bytes",pass:idle<100000000},mcpPeakRss:{value:peak,limit:200000000,unit:"bytes",pass:peak<200000000},searchP95:{value:percentile(search,.95),limit:50,unit:"ms",pass:percentile(search,.95)<50}};
    const report={schema:1,measuredAt:new Date().toISOString(),revision,runtimeDigest:runtimeDigest(repo),methodDigest:createHash("sha256").update(readFileSync(join(repo,"scripts/release-performance.ts"))).update(readFileSync(join(repo,"scripts/release-rpc.ts"))).digest("hex"),corpus:{kind:"synthetic",notes:5000,generator:"release-performance.ts",bodiesPrivate:false},environment:{bun:Bun.version,os:process.platform,osRelease:release(),arch:process.arch,cpu:cpus()[0]?.model,cpuCount:cpus().length,cpuQuota:optional("/sys/fs/cgroup/cpu.max"),memoryLimit:optional("/sys/fs/cgroup/memory.max")},method:{search:"Sequential MCP tools/call round-trip including metadata refresh and JSON transport; 5 warmups,30 measured queries, prebuilt derived index",rss:"/proc VmRSS sampled every20ms; peak uses kernel VmHWM, including startup and all measured searches; decimal MB gates",write:"Diagnostic synthetic CLI patch round-trip including startup, validation,index and log;5 measured calls; not representative private-vault acceptance",p95:"nearest rank: sorted[ceil(0.95*N)-1]"},gates,searchMs:search,syntheticWriteMs:writes,syntheticWriteP95:percentile(writes,.95),rssSamples,representativePrivateWrite:{status:"unverified",limitMs:150,reason:"No authorized representative private corpus measurement performed"},syntheticGatesPass:Object.values(gates).every(g=>g.pass),releaseReady:false};
    mkdirSync(resolve(output,".."),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+"\n");console.log("VMEM_PERFORMANCE="+JSON.stringify(report));return report.syntheticGatesPass;
  }finally{if(timer)clearInterval(timer);await rpc?.stop();rmSync(root,{recursive:true,force:true});}
}
if(import.meta.main){const args=process.argv.slice(2);if(args.length!==2||args[0]!=="--output")throw new Error("usage: --output <synthetic-evidence.json>");if(!await measureReleasePerformance(resolve(args[1]!)))process.exitCode=1;}
