import { parseYamlWithQuotedEscapes } from "./yaml-quoted.ts";
import { randomUUID } from "node:crypto";

/** Preserve Python scalar display and type tests without introducing a YAML runtime dependency. */
export class AnalysisYamlScalar {
  constructor(readonly kind: "timestamp" | "float", readonly text: string, readonly truthy = true) {}
  toString(): string { return this.text; }
}
export class AnalysisYamlUnsupported extends Error {
  constructor(message: string) { super(`analysis YAML: unsupported ${message}`); }
}
export function scalarText(value: unknown): string | undefined { return value instanceof AnalysisYamlScalar ? value.text : undefined; }
export function yamlTruthy(value: unknown): boolean {
  if (value instanceof AnalysisYamlScalar) return value.truthy;
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}
function float(value: number): AnalysisYamlScalar {
  let text: string;
  if (Number.isNaN(value)) text = "nan";
  else if (!Number.isFinite(value)) text = value < 0 ? "-inf" : "inf";
  else if (Object.is(value, -0)) text = "-0.0";
  else {
    const absolute = Math.abs(value);
    text = absolute !== 0 && (absolute < 0.0001 || absolute >= 1e16) ? value.toExponential() : String(value);
    if (text.includes("e")) text = text.replace(/e([+-]?)(\d+)$/, (_, sign: string, exponent: string) => `e${sign || "+"}${exponent.padStart(2,"0")}`);
    else if (!text.includes(".")) text += ".0";
  }
  return new AnalysisYamlScalar("float",text,value !== 0);
}
function integer(value: string): number | bigint {
  const raw = value.replaceAll("_", ""), sign = raw.startsWith("-") ? -1 : 1, unsigned = raw.replace(/^[+-]/, "");
  let number: bigint;
  if (unsigned.includes(":")) number = unsigned.split(":").reduce((n, part) => n * 60n + BigInt(part),0n);
  else if (/^0[0-7]+$/.test(unsigned)) number = BigInt("0o"+unsigned.slice(1));
  else number = BigInt(unsigned);
  number *= BigInt(sign);
  return number >= BigInt(Number.MIN_SAFE_INTEGER) && number <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(number) : number;
}
function timestamp(value: string): AnalysisYamlScalar | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[Tt \t]+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d*))?(?:[ \t]*(Z|([+-])(\d{1,2})(?::(\d{2}))?))?)?$/.exec(value);
  if (!match || (!match[4] && !/^\d{4}-\d{2}-\d{2}$/.test(value))) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = `${match[1]}-${match[2]!.padStart(2,"0")}-${match[3]!.padStart(2,"0")}`;
  const parsed = new Date(date + "T00:00:00Z");
  if (year < 1 || month < 1 || day < 1 || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== date) throw new Error("analysis YAML: invalid timestamp");
  if (!match[4]) return new AnalysisYamlScalar("timestamp",date);
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) throw new Error("analysis YAML: invalid timestamp");
  const fraction = (match[7] ?? "").slice(0,6).padEnd(6,"0");
  let zone = "";
  if (match[8]) {
    const minutes = match[8] === "Z" ? 0 : Number(match[10]) * 60 + Number(match[11] ?? 0);
    if (minutes >= 24*60) throw new Error("analysis YAML: invalid timestamp timezone");
    zone = `${minutes === 0 || match[9] !== "-" ? "+" : "-"}${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`;
  }
  return new AnalysisYamlScalar("timestamp",`${date} ${match[4]!.padStart(2,"0")}:${match[5]}:${match[6]}${Number(fraction) ? "."+fraction : ""}${zone}`);
}
function resolveScalar(value: string): unknown {
  if (/^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/.test(value)) return true;
  if (/^(?:no|No|NO|false|False|FALSE|off|Off|OFF)$/.test(value)) return false;
  if (/^(?:~|null|Null|NULL)$/.test(value)) return null;
  if (/^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/.test(value)) {
    const raw = value.replaceAll("_", "");
    const number = /nan/i.test(raw) ? NaN : /inf/i.test(raw) ? (raw.startsWith("-") ? -Infinity : Infinity)
      : raw.includes(":") ? raw.replace(/^[+-]/,"").split(":").reduce((n,part)=>n*60+Number(part),0)*(raw.startsWith("-")?-1:1) : Number(raw);
    return float(number);
  }
  if (/^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/.test(value)) return integer(value);
  return timestamp(value) ?? value;
}

/** Resolve YAML 1.1 plain scalars, leaving quoted and literal/folded strings byte-for-byte to Bun. */
export function parseAnalysisYaml(source: string): unknown {
  const prefix = `vmem-yaml-${randomUUID()}-`, replacements = new Map<string,unknown>();
  let out = "", offset = 0, flow = 0, blockIndent: number | null = null;
  let lineIndent = 0, effectiveIndent = 0, atLineStart = true, mappingOnLine = false, previousPlain: number | null = null;
  const placeholder = (token: string): string => { const key = prefix+replacements.size; replacements.set(key,resolveScalar(token)); return JSON.stringify(key); };
  while (offset < source.length) {
    if (atLineStart) {
      const end = source.indexOf("\n",offset), line = source.slice(offset,end === -1 ? undefined : end);
      lineIndent = line.match(/^[ \t]*/)![0].length; effectiveIndent = lineIndent;mappingOnLine=false;
      if (blockIndent !== null && (!line.trim() || lineIndent > blockIndent)) { out += line; offset += line.length; if (source[offset] === "\n") { out += "\n";offset++; } continue; }
      blockIndent = null;
      if (previousPlain !== null && line.trim() && !line.trimStart().startsWith("#") && lineIndent > previousPlain && !flow) throw new AnalysisYamlUnsupported("multiline plain scalar (use a quoted or block scalar)");
      if (line.trim() && !line.trimStart().startsWith("#")) previousPlain = null;
      atLineStart = false;
    }
    const character = source[offset]!;
    if (character === "\n") { out += character;offset++;atLineStart = true;continue; }
    if (/[ \t\r]/.test(character)) { out += character;offset++;continue; }
    if (character === "#") { const end = source.indexOf("\n",offset); const stop = end === -1 ? source.length : end; out += source.slice(offset,stop);offset=stop;continue; }
    if (character === '"' || character === "'") {
      const start = offset++, quote = character;
      while (offset < source.length) {
        const next = source[offset++]!;
        if (quote === '"' && next === "\\") { offset++;continue; }
        if (next === quote) { if (quote === "'" && source[offset] === "'") {offset++;continue;} break; }
      }
      out += source.slice(start,offset);continue;
    }
    if (!flow && (character === "|" || character === ">") && /^(?:[|>])(?:[+-][1-9]?|[1-9][+-]?)?[ \t]*(?:#[^\n]*)?\r?(?:\n|$)/.test(source.slice(offset))) {
      const end = source.indexOf("\n",offset), stop = end === -1 ? source.length : end;
      out += source.slice(offset,stop);offset=stop;blockIndent=mappingOnLine ? effectiveIndent : lineIndent;previousPlain=null;continue;
    }
    if (character === "!") throw new AnalysisYamlUnsupported("explicit tags");
    if (character === "?" && /\s/.test(source[offset+1] ?? "\n")) throw new AnalysisYamlUnsupported("complex mapping keys");
    if (character === "&" || character === "*") { const match = /^[&*][^\s,[\]{}]+/.exec(source.slice(offset)); if (!match) throw new Error("analysis YAML: invalid anchor");out+=match[0];offset+=match[0].length;continue; }
    if ("[{".includes(character)) { flow++;out+=character;offset++;previousPlain=null;continue; }
    if ("]}".includes(character)) { flow--;out+=character;offset++;continue; }
    if ((flow && character === ",") || character === ":") { if(character === ":" && !flow)mappingOnLine=true;out+=character;offset++;previousPlain=null;continue; }
    if (!flow && character === "-" && /\s/.test(source[offset+1] ?? "\n")) { out+=character;offset++;effectiveIndent=offset-(source.lastIndexOf("\n",offset-1)+1)+1;previousPlain=null;continue; }
    const start = offset;
    while (offset < source.length) {
      const next = source[offset]!;
      if (next === "\n" || (flow && ",[]{}".includes(next)) || (next === ":" && /[\s,\]}]/.test(source[offset+1] ?? "\n")) || (next === "#" && /\s/.test(source[offset-1] ?? " "))) break;
      offset++;
    }
    if (offset === start) throw new Error("analysis YAML: invalid token");
    const raw = source.slice(start,offset);
    let token = raw.trimEnd(), consumed = offset;
    if (source[offset] === "\n") {
      let cursor=offset, blanks=0;
      while(source[cursor] === "\n") {
        const next=cursor+1, end=source.indexOf("\n",next), line=source.slice(next,end===-1 ? undefined : end), indent=line.match(/^[ \t]*/)![0].length;
        if(!line.trim()) {blanks++;cursor=end===-1 ? source.length : end;continue;}
        if ((!flow && indent <= effectiveIndent) || line.trimStart().startsWith("#") || (flow && /^[,\]}]/.test(line.trimStart()))) break;
        const stop = flow ? line.search(/[,\]}]/) : -1;
        const part=(stop===-1 ? line : line.slice(0,stop)).trim();
        if (!part || /:\s|\s#/.test(part)) break;
        token+=(blanks ? "\n".repeat(blanks) : " ")+part;blanks=0;
        consumed=stop===-1 ? next+line.length : next+stop;
        cursor=consumed;
        if(stop!==-1)break;
      }
    }
    if (token === "---" || token === "..." || token.startsWith("%")) throw new AnalysisYamlUnsupported("document directives or multiple documents");
    out += placeholder(token)+(consumed===offset ? raw.slice(token.length) : "");
    offset=consumed;
    if (!flow && source[offset] !== ":") previousPlain=effectiveIndent;
  }
  let parsed: unknown;
  try { parsed=parseYamlWithQuotedEscapes(out); }
  catch(error) {
    try { parseYamlWithQuotedEscapes(source); } catch { throw error; }
    throw new AnalysisYamlUnsupported("plain scalar layout (use a quoted or block scalar)");
  }
  const active = new Set<object>();
  function restore(value: unknown, depth: number): unknown {
    if (depth > 64) throw new AnalysisYamlUnsupported("nesting deeper than 64 levels");
    if (typeof value === "string") return replacements.has(value) ? replacements.get(value) : value;
    if (value === null || typeof value !== "object") return value;
    if (active.has(value)) throw new AnalysisYamlUnsupported("recursive aliases");
    active.add(value);
    let result: unknown;
    if (Array.isArray(value)) result=value.map(item=>restore(item,depth+1));
    else {
      const mapping: Record<string,unknown> = Object.create(null) as Record<string,unknown>;
      const explicit:[string,unknown][]=[];
      for (const [key,item] of Object.entries(value)) {
        const resolvedKey=restore(key,depth+1);
        if (typeof resolvedKey !== "string") throw new AnalysisYamlUnsupported("non-string mapping keys");
        const restored=restore(item,depth+1);
        if (replacements.get(key)==="<<") {
          const merged=Array.isArray(restored) ? [...restored].reverse() : [restored];
          for(const entry of merged) {
            if(entry===null || typeof entry!=="object" || Array.isArray(entry) || entry instanceof AnalysisYamlScalar)throw new Error("analysis YAML: merge source must be a mapping");
            Object.assign(mapping,entry);
          }
        } else explicit.push([resolvedKey,restored]);
      }
      for(const [key,item] of explicit)mapping[key]=item;
      result=mapping;
    }
    active.delete(value);return result;
  }
  return restore(parsed,0);
}
