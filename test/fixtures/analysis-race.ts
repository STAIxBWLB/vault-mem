import { mock } from "bun:test";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import * as input from "../../src/analysis-input.ts";
const [home,vault,other,mode] = process.argv.slice(2);
if(!home || !vault || !other || !mode)throw new Error("fixture arguments required");
const original = input.analysisInput;
let injected = false;
mock.module("../../src/analysis-input.ts",()=>({...input,analysisInput:(...args:Parameters<typeof original>)=>{
  const result=original(...args);
  if(!injected) {
    injected=true;
    if(mode==="rebind") {
      const file=join(home,"vmem.config.json"),config=JSON.parse(readFileSync(file,"utf8"));config.vaults[0].path=other;writeFileSync(file,JSON.stringify(config));
    } else appendFileSync(join(vault,"reports","graph-trend.md"),"\nConcurrent build history preserved.\n");
  }
  return result;
}}));
const {writeAnalysisReports}=await import("../../src/analysis-reports.ts");
try {const result=writeAnalysisReports(home,{vault:"test",kind:"graph",today:"2026-08-19"});console.log(JSON.stringify({injected,threw:false,ok:result.ok}));}
catch {console.log(JSON.stringify({injected,threw:true}));}
