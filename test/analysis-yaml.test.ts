import { expect, test } from "bun:test";
import { AnalysisYamlScalar, AnalysisYamlUnsupported, parseAnalysisYaml, scalarText, yamlTruthy } from "../src/analysis-yaml.ts";

test("YAML1.1 plain booleans, octal, exponent strings and flow arrays",()=>{
  const values=parseAnalysisYaml("description: off\nconfidence: on\nvalues: [yes, NO, true, False, 010, 0x10, 0b10, 1e3, 1.0e3, 1.0e+3, 1:20, 1:20.5, null, ~]\n") as Record<string,unknown>;
  expect(values.description).toBe(false);expect(values.confidence).toBe(true);
  const list=values.values as unknown[];
  expect(list.slice(0,9)).toEqual([true,false,true,false,8,16,2,"1e3","1.0e3"]);
  expect(scalarText(list[9])).toBe("1000.0");expect(list[10]).toBe(80);expect(scalarText(list[11])).toBe("80.5");expect(list.slice(12)).toEqual([null,null]);
});
test("quoted, escaped, multiline quoted, literal and folded strings keep their text",()=>{
  const values=parseAnalysisYaml(`a: "off"\nb: 'on'\nc: "escape \\"yes\\""\nd: |\n  off\n  yes: 010\ne: >-\n  on\n  1e3\nf: ["yes", '010', {value: off}]\ng: "a\n  quoted line"\nh: plain text # comment\n`) as Record<string,unknown>;
  expect(values.a).toBe("off");expect(values.b).toBe("on");expect(values.c).toBe('escape "yes"');
  expect(values.d).toBe("off\nyes: 010\n");expect(values.e).toBe("on 1e3");
  expect(values.f).toEqual(["yes","010",{value:false}]);expect(values.g).toBe("a quoted line");expect(values.h).toBe("plain text");
});
test("timestamps retain Python display and are not strings",()=>{
  const values=parseAnalysisYaml("date: 2026-10-29\nzulu: 2001-12-14t21:59:43.10Z\nzone: 2001-1-2 3:04:05 -5:30\nplain: 2026-1-2\n") as Record<string,unknown>;
  expect(values.date).toBeInstanceOf(AnalysisYamlScalar);expect(scalarText(values.date)).toBe("2026-10-29");
  expect(scalarText(values.zulu)).toBe("2001-12-14 21:59:43.100000+00:00");expect(scalarText(values.zone)).toBe("2001-01-02 03:04:05-05:30");expect(values.plain).toBe("2026-1-2");
});
test("float truth and Python formatting distinguish integer-valued floats",()=>{
  const values=parseAnalysisYaml("values: [0.0, -0.0, .nan, .inf, -.Inf, 0.00001, 10000000000000000.0]\n") as {values:unknown[]};
  expect(values.values.map(scalarText)).toEqual(["0.0","-0.0","nan","inf","-inf","1e-05","1e+16"]);
  expect(values.values.map(yamlTruthy)).toEqual([false,false,true,true,true,true,true]);
});
test("block collections and ordinary aliases retain structure",()=>{
  expect(parseAnalysisYaml("items:\n  - key: yes\n    other: off\n  - [010, on]\nanchor: &x [off, yes]\ncopy: *x\n")).toEqual({items:[{key:true,other:false},[8,true]],anchor:[false,true],copy:[false,true]});
  expect(parseAnalysisYaml("items:\n  - key: |\n      off\n    other: off\n  - |\n    yes\n")).toEqual({items:[{key:"off\n",other:false},"yes\n"]});
});
test("unsupported constructs fail explicitly instead of silently changing meanings",()=>{
  for(const source of ["value: !!str yes\n","? [a,b]\n: value\n","a: &a [*a]\n"])
    expect(()=>parseAnalysisYaml(source)).toThrow(AnalysisYamlUnsupported);
});
test("multiline plain scalars, large integers and YAML merge precedence match Python",()=>{
  expect(parseAnalysisYaml("value: first\n  continuation\n\n  final\nnext: yes\n")).toEqual({value:"first continuation\nfinal",next:true});
  expect(parseAnalysisYaml("value: [first\n  continuation, yes]\n")).toEqual({value:["first continuation",true]});
  expect(parseAnalysisYaml("value: 999999999999999999999999\n")).toEqual({value:999999999999999999999999n});
  expect(parseAnalysisYaml("a: &a {x: yes, shared: first}\nb: &b {y: off, shared: second}\nc: {explicit: off, <<: [*a, *b], shared: explicit}\nd: {shared: explicit, <<: *a}\ne: {'<<': literal}\n")).toEqual({a:{x:true,shared:"first"},b:{y:false,shared:"second"},c:{y:false,x:true,shared:"explicit",explicit:false},d:{x:true,shared:"explicit"},e:{"<<":"literal"}});
});
