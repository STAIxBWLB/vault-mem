import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runtimeDigest } from "./release-performance.ts";
/** Historical evidence is refreshed only at the explicit release gate, not on every source edit. */
export function verifyReleaseEvidence(root=resolve(import.meta.dir,"..")):void {
  const read=(file:string)=>JSON.parse(readFileSync(join(root,file),"utf8"));
  const performance=read("docs/evidence/synthetic-performance.json"),parity=read("docs/evidence/external-parity.json");
  if(runtimeDigest(root)!==performance.runtimeDigest)throw new Error("release evidence: stale runtime digest; rerun authorized dgx02 measurement before release");
  const limits:Record<string,number>={mcpIdleRss:100000000,mcpPeakRss:200000000,searchP95:50};
  for(const [name,limit] of Object.entries(limits)){
    const gate=performance.gates?.[name];
    if(!gate || !Number.isFinite(gate.value) || gate.value<0 || gate.value>=limit || gate.limit!==limit || gate.pass!==true)throw new Error("release evidence: failed or missing synthetic gate "+name);
  }
  if(performance.peakSource!=="cgroup-memory.peak"){
    const hwm=Array.isArray(performance.rssSamples)?performance.rssSamples.map((s:{highWaterBytes?:unknown})=>s?.highWaterBytes):[];
    if(hwm.length===0||!hwm.every((v:unknown)=>typeof v==="number"&&Number.isFinite(v)))throw new Error("release evidence: mcpPeakRss unverified: no VmHWM samples");
    const drops=hwm.flatMap((v:number,i:number)=>i>0&&v<hwm[i-1]!?[i]:[]);
    if(drops.length>0)throw new Error(`release evidence: mcpPeakRss unverified: VmHWM decreased ${drops.length} time(s), first at sample ${drops[0]} (${hwm[drops[0]-1]} -> ${hwm[drops[0]]} bytes), so the peak is only a lower bound; re-measure on a host where VmHWM is monotonic, or use a peak source that cannot fall`);
  }
  if(performance.syntheticGatesPass!==true)throw new Error("release evidence: synthetic gates not passed");
  const method=createHash("sha256").update(readFileSync(join(root,"scripts/release-performance.ts"))).update(readFileSync(join(root,"scripts/release-rpc.ts"))).digest("hex");
  if(method!==performance.methodDigest)throw new Error("release evidence: stale measurement method");
  if(!parity.inputsSha256 || Object.keys(parity.inputsSha256).length===0)throw new Error("release evidence: missing external parity inputs");
  for(const [file,digest] of Object.entries(parity.inputsSha256)) {
    if(!/^(?:src|scripts|test)\/[a-zA-Z0-9./-]+$/.test(file)||file.split("/").includes("..")||typeof digest!=="string"||!/^[a-f0-9]{64}$/.test(digest))throw new Error("release evidence: invalid parity digest entry");
    if(createHash("sha256").update(readFileSync(join(root,file))).digest("hex")!==digest)throw new Error("release evidence: stale external parity input "+file);
  }
  console.log("release evidence: runtime, method and external parity bindings match");
}
if(import.meta.main)verifyReleaseEvidence();
