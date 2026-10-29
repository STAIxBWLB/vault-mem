import { expect, test } from "bun:test";
import { percentile } from "../scripts/release-performance.ts";
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
  expect(evidence.rssSamples.length).toBeGreaterThan(0);expect(evidence.gates.mcpPeakRss.value).toBe(Math.max(...evidence.rssSamples.map((s:{highWaterBytes:number})=>s.highWaterBytes)));
  expect(typeof evidence.representativePrivateWrite.status).toBe("string");expect(typeof evidence.releaseReady).toBe("boolean");
});

test("explicit release gate rejects stale runtime, method and parity evidence on an isolated candidate",async()=>{
  const {verifyReleaseEvidence}=await import("../scripts/release-evidence.ts"),{runtimeDigest}=await import("../scripts/release-performance.ts"),{createHash}=await import("node:crypto"),fs=await import("node:fs"),{join}=await import("node:path"),{tmpdir}=await import("node:os");
  const root=fs.mkdtempSync(join(tmpdir(),"vmem-freshness-"));
  try{
    for(const dir of ["src","bin","scripts","docs/evidence"])fs.mkdirSync(join(root,dir),{recursive:true});
    const files={"package.json":'{"version":"0.1.0"}',"src/example.ts":"synthetic runtime","bin/vmem.js":"synthetic bootstrap","scripts/release-performance.ts":"synthetic measurement","scripts/release-rpc.ts":"synthetic protocol"};
    for(const [file,text] of Object.entries(files))fs.writeFileSync(join(root,file),text);
    const digest=(s:string)=>createHash("sha256").update(s).digest("hex");
    fs.writeFileSync(join(root,"docs/evidence/synthetic-performance.json"),JSON.stringify({runtimeDigest:runtimeDigest(root),methodDigest:digest(files["scripts/release-performance.ts"]+files["scripts/release-rpc.ts"]),syntheticGatesPass:true,gates:{mcpIdleRss:{value:1,limit:100000000,pass:true},mcpPeakRss:{value:2,limit:200000000,pass:true},searchP95:{value:1,limit:50,pass:true}}}));
    fs.writeFileSync(join(root,"docs/evidence/external-parity.json"),JSON.stringify({inputsSha256:{"src/example.ts":digest(files["src/example.ts"])}}));
    verifyReleaseEvidence(root);
    fs.writeFileSync(join(root,"package.json"),'{"version":"0.2.0"}');expect(()=>verifyReleaseEvidence(root)).toThrow("stale runtime");fs.writeFileSync(join(root,"package.json"),files["package.json"]);
    fs.writeFileSync(join(root,"scripts/release-rpc.ts"),"changed method");expect(()=>verifyReleaseEvidence(root)).toThrow("stale measurement");fs.writeFileSync(join(root,"scripts/release-rpc.ts"),files["scripts/release-rpc.ts"]);
    fs.writeFileSync(join(root,"docs/evidence/external-parity.json"),JSON.stringify({inputsSha256:{"src/example.ts":"0".repeat(64)}}));expect(()=>verifyReleaseEvidence(root)).toThrow("stale external parity");
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
