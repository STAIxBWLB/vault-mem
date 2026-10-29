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
test("recorded external parity evidence remains bound to the same code and fixture snapshot",async()=>{
  const {createHash}=await import("node:crypto"),{readFileSync}=await import("node:fs");
  const evidence=JSON.parse(readFileSync(new URL("../docs/evidence/external-parity.json",import.meta.url),"utf8"));
  for(const [file,digest] of Object.entries(evidence.inputsSha256)){if(typeof digest!=="string")throw new Error("invalid evidence digest");expect(createHash("sha256").update(readFileSync(new URL("../"+file,import.meta.url))).digest("hex")).toBe(digest);}
  expect(evidence.rounds).toHaveLength(2);expect(evidence.referencesRetired).toBe(false);expect(evidence.privateCorpus).toBe("unverified");
});
test("synthetic performance evidence is runtime-bound and cannot pass from stale or missing telemetry",async()=>{
  const {runtimeDigest}=await import("../scripts/release-performance.ts"),{createHash}=await import("node:crypto"),{readFileSync}=await import("node:fs"),{resolve}=await import("node:path");
  const root=resolve(import.meta.dir,".."),evidence=JSON.parse(readFileSync(new URL("../docs/evidence/synthetic-performance.json",import.meta.url),"utf8"));
  expect(runtimeDigest(root)).toBe(evidence.runtimeDigest);
  expect(createHash("sha256").update(readFileSync(new URL("../scripts/release-performance.ts",import.meta.url))).update(readFileSync(new URL("../scripts/release-rpc.ts",import.meta.url))).digest("hex")).toBe(evidence.methodDigest);
  expect(evidence.corpus.notes).toBe(5000);expect(evidence.searchMs).toHaveLength(30);expect(percentile(evidence.searchMs,.95)).toBe(evidence.gates.searchP95.value);
  expect(evidence.rssSamples.length).toBeGreaterThan(0);expect(evidence.gates.mcpPeakRss.value).toBe(Math.max(...evidence.rssSamples.map((s:{highWaterBytes:number})=>s.highWaterBytes)));
  expect(evidence.representativePrivateWrite.status).toBe("unverified");expect(evidence.releaseReady).toBe(false);
});
