import { expect, test } from "bun:test";
import { percentile } from "../scripts/release-performance.ts";
import { releaseRpc } from "../scripts/release-rpc.ts";
import { verifyReleaseParity } from "../scripts/release-parity.ts";
test("release parity fixture is byte-identical, links resolve, incremental index equals rebuild twice against Python oracles",()=>{verifyReleaseParity();});
test("reported p95 uses nearest rank and invalid samples cannot create passing evidence",()=>{
  expect(percentile(Array.from({length:100},(_,i)=>i+1),.95)).toBe(95);
  expect(percentile([7,1,4],.95)).toBe(7);
  for(const values of [[],[NaN],[Infinity],[-1]])expect(()=>percentile(values,.95)).toThrow();
});

test("readiness MCP cleanup bounds a child that stays alive after stdin closes",async()=>{
  const rpc=releaseRpc([process.execPath,"-e","process.on('SIGTERM',()=>{}); for await(const _ of Bun.stdin.stream()){}; setInterval(()=>{},1000)"],process.env,200);
  await expect(rpc.close()).rejects.toThrow("shutdown timeout");
  expect(await rpc.child.exited).toBeNumber();
},5000);
test("recorded external parity evidence remains bound to the same code and fixture snapshot",async()=>{
  const {createHash}=await import("node:crypto"),{readFileSync}=await import("node:fs");
  const evidence=JSON.parse(readFileSync(new URL("../docs/evidence/external-parity.json",import.meta.url),"utf8"));
  for(const [file,digest] of Object.entries(evidence.inputsSha256))expect(createHash("sha256").update(readFileSync(new URL("../"+file,import.meta.url))).digest("hex")).toBe(digest);
  expect(evidence.rounds).toHaveLength(2);expect(evidence.referencesRetired).toBe(false);expect(evidence.privateCorpus).toBe("unverified");
});
