import { expect, test } from "bun:test";
import { percentile, validateCgroup, mcpPeakGate } from "../scripts/release-performance.ts";
import { releaseRpc } from "../scripts/release-rpc.ts";
import { verifyReleaseParity } from "../scripts/release-parity.ts";
test("release parity fixture is byte-identical, links resolve, incremental index equals rebuild twice against Python oracles",()=>{verifyReleaseParity();});
test("reported p95 uses nearest rank and invalid samples cannot create passing evidence",()=>{
  expect(percentile(Array.from({length:100},(_,i)=>i+1),.95)).toBe(95);
  expect(percentile([7,1,4],.95)).toBe(7);
  for(const values of [[],[NaN],[Infinity],[-1]])expect(()=>percentile(values,.95)).toThrow();
  for(const quantile of [0,NaN,Infinity,1.1])expect(()=>percentile([1],quantile)).toThrow();
});

test("readiness MCP cleanup bounds a child that stays alive after stdin closes",async()=>{
  const rpc=releaseRpc([process.execPath,"-e","process.on('SIGTERM',()=>{}); for await(const _ of Bun.stdin.stream()){}; setInterval(()=>{},1000)"],process.env,200);
  await expect(rpc.close()).rejects.toThrow("shutdown timeout");
  expect(await rpc.child.exited).toBeNumber();
},5000);
test("recorded external parity evidence has valid shape without pinning current source",async()=>{
  const {readFileSync}=await import("node:fs");
  const evidence=JSON.parse(readFileSync(new URL("../docs/evidence/external-parity.json",import.meta.url),"utf8"));
  for(const [file,digest] of Object.entries(evidence.inputsSha256)){expect(file).toMatch(/^(src|scripts|test)\//);expect(typeof digest).toBe("string");expect(String(digest)).toMatch(/^[a-f0-9]{64}$/);}
  expect(evidence.rounds).toHaveLength(2);expect(typeof evidence.referencesRetired).toBe("boolean");expect(typeof evidence.privateCorpus).toBe("string");
});
test("recorded synthetic performance evidence has internally consistent samples without pinning current source",async()=>{
  const {readFileSync}=await import("node:fs");
  const evidence=JSON.parse(readFileSync(new URL("../docs/evidence/synthetic-performance.json",import.meta.url),"utf8"));
  expect(evidence.runtimeDigest).toMatch(/^[a-f0-9]{64}$/);expect(evidence.methodDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(evidence.corpus.notes).toBe(5000);expect(evidence.searchMs).toHaveLength(30);expect(percentile(evidence.searchMs,.95)).toBe(evidence.gates.searchP95.value);
  expect(evidence.rssSamples.length).toBeGreaterThan(0);
  if(evidence.peakSource==="cgroup-memory.peak"){
    expect(evidence.peakCgroup).toBe("delegated/mcp");
    expect(evidence.gates.mcpPeakRss.value).toBeGreaterThan(0);
  }else expect(evidence.gates.mcpPeakRss.value).toBe(Math.max(...evidence.rssSamples.flatMap((s:{rssBytes:number;highWaterBytes:number})=>[s.rssBytes,s.highWaterBytes])));
  expect(typeof evidence.representativePrivateWrite.status).toBe("string");expect(typeof evidence.releaseReady).toBe("boolean");
});

test("explicit release gate rejects stale runtime, method, parity and non-monotonic peak evidence on an isolated candidate",async()=>{
  const {verifyReleaseEvidence}=await import("../scripts/release-evidence.ts"),{runtimeDigest}=await import("../scripts/release-performance.ts"),{createHash}=await import("node:crypto"),fs=await import("node:fs"),{join}=await import("node:path"),{tmpdir}=await import("node:os");
  const root=fs.mkdtempSync(join(tmpdir(),"vmem-freshness-"));
  try{
    for(const dir of ["src","bin","scripts","docs/evidence"])fs.mkdirSync(join(root,dir),{recursive:true});
    const files={"package.json":'{"version":"0.1.0"}',"src/example.ts":"synthetic runtime","bin/vmem.js":"synthetic bootstrap","scripts/release-performance.ts":"synthetic measurement","scripts/release-rpc.ts":"synthetic protocol"};
    for(const [file,text] of Object.entries(files))fs.writeFileSync(join(root,file),text);
    const digest=(s:string)=>createHash("sha256").update(s).digest("hex");
    fs.writeFileSync(join(root,"docs/evidence/synthetic-performance.json"),JSON.stringify({runtimeDigest:runtimeDigest(root),methodDigest:digest(files["scripts/release-performance.ts"]+files["scripts/release-rpc.ts"]),syntheticGatesPass:true,gates:{mcpIdleRss:{value:1,limit:100000000,pass:true},mcpPeakRss:{value:2,limit:200000000,pass:true},searchP95:{value:1,limit:50,pass:true}},rssSamples:[{highWaterBytes:1},{highWaterBytes:2}]}));
    fs.writeFileSync(join(root,"docs/evidence/external-parity.json"),JSON.stringify({inputsSha256:{"src/example.ts":digest(files["src/example.ts"])}}));
    verifyReleaseEvidence(root);
    const evidencePath=join(root,"docs/evidence/synthetic-performance.json"),good=fs.readFileSync(evidencePath,"utf8");
    fs.writeFileSync(evidencePath,good.replace('"rssSamples":[{"highWaterBytes":1},{"highWaterBytes":2}]','"rssSamples":[{"highWaterBytes":5},{"highWaterBytes":3},{"highWaterBytes":4},{"highWaterBytes":2}]'));
    expect(()=>verifyReleaseEvidence(root)).toThrow("mcpPeakRss unverified: VmHWM decreased 2 time(s), first at sample 1 (5 -> 3 bytes), so the peak is only a lower bound; re-measure on a host where VmHWM is monotonic, or use a peak source that cannot fall");
    fs.writeFileSync(evidencePath,good.replace('"rssSamples":[{"highWaterBytes":1},{"highWaterBytes":2}]','"rssSamples":[]'));expect(()=>verifyReleaseEvidence(root)).toThrow("no VmHWM samples");
    const cgroupEvidence=JSON.parse(good);
    cgroupEvidence.peakSource="cgroup-memory.peak";
    cgroupEvidence.peakCgroup="delegated/mcp";
    cgroupEvidence.rssSamples=[{highWaterBytes:5},{highWaterBytes:3}];
    fs.writeFileSync(evidencePath,JSON.stringify(cgroupEvidence));
    verifyReleaseEvidence(root);
    cgroupEvidence.peakSource="proc-VmHWM";
    fs.writeFileSync(evidencePath,JSON.stringify(cgroupEvidence));
    expect(()=>verifyReleaseEvidence(root)).toThrow("VmHWM decreased");
    cgroupEvidence.peakSource="cgroup-memory.peak";
    delete cgroupEvidence.gates.mcpPeakRss.pass;
    fs.writeFileSync(evidencePath,JSON.stringify(cgroupEvidence));
    expect(()=>verifyReleaseEvidence(root)).toThrow("failed or missing synthetic gate mcpPeakRss");
    fs.writeFileSync(evidencePath,good);
    fs.writeFileSync(join(root,"package.json"),'{"version":"0.2.0"}');expect(()=>verifyReleaseEvidence(root)).toThrow("stale runtime");fs.writeFileSync(join(root,"package.json"),files["package.json"]);
    fs.writeFileSync(join(root,"scripts/release-rpc.ts"),"changed method");expect(()=>verifyReleaseEvidence(root)).toThrow("stale measurement");fs.writeFileSync(join(root,"scripts/release-rpc.ts"),files["scripts/release-rpc.ts"]);
    fs.writeFileSync(join(root,"docs/evidence/external-parity.json"),JSON.stringify({inputsSha256:{"src/example.ts":"0".repeat(64)}}));expect(()=>verifyReleaseEvidence(root)).toThrow("stale external parity");
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test("MCP peak gate requires charged peak and sampled RSS peak both below 200 MB",()=>{
  const limit=200000000;
  expect(mcpPeakGate(limit-1,limit-1)).toEqual({value:limit-1,limit,unit:"bytes",pass:true});
  for(const [charged,sampled] of [[1,limit],[1,limit+1],[limit,1],[limit+1,1],[limit,limit]]){
    const gate=mcpPeakGate(charged!,sampled!);
    expect(gate.value).toBe(charged!);
    expect(gate.pass).toBe(false);
  }
});

test("release cgroup delegation preconditions name the cause and remote runner recovery",async()=>{
  const fs=await import("node:fs"),{join}=await import("node:path"),{tmpdir}=await import("node:os");
  const root=fs.mkdtempSync(join(tmpdir(),"vmem-cgroup-precondition-"));
  const refuse=(input:string|undefined,cause:string)=>{
    expect(()=>validateCgroup(input)).toThrow(cause);
    expect(()=>validateCgroup(input)).toThrow("remote_dev.py run --cgroup <path> -- <cmd>");
  };
  try{
    refuse(undefined,"REMOTE_DEV_CGROUP is missing");
    refuse(join(root,"absent"),"ENOENT");
    const file=join(root,"plain-file");fs.writeFileSync(file,"synthetic");refuse(file,"not a directory");
    const delegated=join(root,"delegated");fs.mkdirSync(delegated);
    fs.writeFileSync(join(delegated,"cgroup.subtree_control"),"cpu pids");
    refuse(delegated,"memory is not enabled");
    fs.chmodSync(delegated,0o555);
    try{refuse(delegated,"not writable");}finally{fs.chmodSync(delegated,0o755);}
    fs.writeFileSync(join(delegated,"cgroup.subtree_control"),"cpu memory pids\n");
    expect(validateCgroup(delegated)).toBe(fs.realpathSync(delegated));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
