import { randomUUID } from "node:crypto";

const SHORT_ESCAPES: Record<string,string> = {
  "0":"\0",a:"\x07",b:"\b",t:"\t","\t":"\t",n:"\n",v:"\v",f:"\f",r:"\r",e:"\x1b",
  " ":" ",'"':'"',"/":"/","\\":"\\",N:"",_:" ",L:" ",P:" ",
};
function lineBreak(source:string,offset:number):{value:string;end:number}|null {
  const character=source[offset];
  if(character === "\r")return {value:"\n",end:offset+(source[offset+1] === "\n" ? 2 : 1)};
  if(character === "\n" || character === "")return {value:"\n",end:offset+1};
  if(character === " " || character === " ")return {value:character,end:offset+1};
  return null;
}
function continuation(source:string,offset:number):{breaks:string;end:number} {
  let breaks="";
  for(;;) {
    while(source[offset] === " " || source[offset] === "\t")offset++;
    const next=lineBreak(source,offset);
    if(!next)return {breaks,end:offset};
    breaks+=next.value;offset=next.end;
  }
}
/** Decode one YAML double-quoted scalar, including YAML's line folding and escaped continuations. */
function doubleQuoted(source:string,start:number):{value:string;end:number} {
  let value="",offset=start+1;
  while(offset<source.length) {
    const character=source[offset]!;
    if(character === '"')return {value,end:offset+1};
    if(character === "\\") {
      const escape=source[++offset];
      if(escape === undefined)throw new Error("YAML: incomplete quoted escape");
      if(Object.hasOwn(SHORT_ESCAPES,escape)) {value+=SHORT_ESCAPES[escape]!;offset++;continue;}
      const digits=escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : 0;
      if(digits) {
        const hex=source.slice(offset+1,offset+digits+1);
        if(hex.length!==digits || !/^[0-9a-fA-F]+$/.test(hex))throw new Error("YAML: invalid quoted Unicode escape");
        const scalar=Number.parseInt(hex,16);
        if(scalar>0x10ffff)throw new Error("YAML: quoted Unicode escape outside range");
        value+=String.fromCodePoint(scalar);offset+=digits+1;continue;
      }
      const escapedBreak=lineBreak(source,offset);
      if(escapedBreak) {const next=continuation(source,escapedBreak.end);value+=next.breaks;offset=next.end;continue;}
      throw new Error("YAML: unknown quoted escape");
    }
    if(character === " " || character === "\t") {
      const first=offset;
      while(source[offset] === " " || source[offset] === "\t")offset++;
      if(!lineBreak(source,offset))value+=source.slice(first,offset);
      continue;
    }
    const nextBreak=lineBreak(source,offset);
    if(nextBreak) {
      const next=continuation(source,nextBreak.end);
      value+=nextBreak.value!=="\n" ? nextBreak.value+next.breaks : next.breaks || " ";
      offset=next.end;continue;
    }
    // These raw characters are not YAML-printable; explicitly escaped controls above remain valid.
    const code=character.charCodeAt(0),next=source.charCodeAt(offset+1),previous=source.charCodeAt(offset-1);
    if(code<32 || (code>=127 && code<=159) || code===65534 || code===65535
      || (code>=55296 && code<=56319 && !(next>=56320 && next<=57343))
      || (code>=56320 && code<=57343 && !(previous>=55296 && previous<=56319)))throw new Error("YAML: non-printable quoted character");
    value+=character;offset++;
  }
  throw new Error("YAML: unterminated quoted scalar");
}

/**
 * Parse structural YAML with Bun, replacing only double-quoted scalar nodes in its semantic input.
 * Original source and byte offsets remain the caller's property. Opaque scalars also avoid asking
 * older Bun YAML versions to parse decoded control characters or unsupported Unicode escapes.
 */
export function parseYamlWithQuotedEscapes(source:string):unknown {
  const prefix=`vmem-quoted-${randomUUID()}-`,values=new Map<string,string>();
  const replacements:{start:number;end:number;token:string}[]=[];
  let offset=0,lineStart=0,flow=0,nodeStart=true,blockIndent:number|null=null;
  let effectiveIndent=0,mappingOnLine=false,plain=false,plainIndent=0;
  while(offset<source.length) {
    if(offset===lineStart) {
      const end=source.indexOf("\n",offset),line=source.slice(offset,end===-1 ? undefined : end),indent=line.match(/^[ \t]*/)![0].length;
      if(blockIndent!==null && (!line.trim() || indent>blockIndent)) {offset=end===-1 ? source.length : end+1;lineStart=offset;continue;}
      blockIndent=null;effectiveIndent=indent;mappingOnLine=false;
      if(!flow && line.trim() && indent<=plainIndent)plain=false;
      nodeStart=!plain;
    }
    const character=source[offset]!;
    if(character === "\n") {offset++;lineStart=offset;continue;}
    if(/[ \t\r]/.test(character)) {offset++;continue;}
    if(character === "#" && (offset===lineStart || /\s/.test(source[offset-1]!))) {
      const end=source.indexOf("\n",offset);offset=end===-1 ? source.length : end;plain=false;continue;
    }
    if(nodeStart && character === '"') {
      const decoded=doubleQuoted(source,offset),token=prefix+values.size;
      values.set(token,decoded.value);replacements.push({start:offset,end:decoded.end,token:JSON.stringify(token)});
      offset=decoded.end;lineStart=source.lastIndexOf("\n",offset-1)+1;nodeStart=false;plain=false;continue;
    }
    if(nodeStart && character === "'") {
      offset++;
      while(offset<source.length) {
        if(source[offset++]!=="'")continue;
        if(source[offset] === "'") {offset++;continue;}
        break;
      }
      lineStart=source.lastIndexOf("\n",offset-1)+1;nodeStart=false;plain=false;continue;
    }
    if(nodeStart && !flow && (character === "|" || character === ">") && /^[|>](?:[+-][1-9]?|[1-9][+-]?)?[ \t]*(?:#[^\r\n]*)?\r?(?:\n|$)/.test(source.slice(offset))) {
      blockIndent=mappingOnLine ? effectiveIndent : lineStart===offset ? 0 : source.slice(lineStart).match(/^[ \t]*/)![0].length;
      const end=source.indexOf("\n",offset);offset=end===-1 ? source.length : end;plain=false;continue;
    }
    if(nodeStart && (character === "&" || character === "!")) {
      const prefix=/^[&!][^\s,[\]{}]*/.exec(source.slice(offset))![0];offset+=prefix.length;continue;
    }
    if(nodeStart && (character === "[" || character === "{")) {flow++;offset++;nodeStart=true;plain=false;continue;}
    if(flow && (character === "]" || character === "}")) {flow--;offset++;nodeStart=false;plain=false;continue;}
    if(flow && character === ",") {offset++;nodeStart=true;plain=false;continue;}
    if(character === ":" && (!plain || /[\s,[\]{}]/.test(source[offset+1] ?? "\n"))) {
      if(!flow)mappingOnLine=true;offset++;nodeStart=true;plain=false;continue;
    }
    if(nodeStart && character === "-" && /\s/.test(source[offset+1] ?? "\n")) {offset++;effectiveIndent=offset-lineStart+1;continue;}
    if(nodeStart && character === "?" && /\s/.test(source[offset+1] ?? "\n")) {offset++;continue;}
    if(!plain)plainIndent=effectiveIndent;
    nodeStart=false;plain=true;offset++;
  }
  let normalized="",copied=0;
  for(const replacement of replacements) {normalized+=source.slice(copied,replacement.start)+replacement.token;copied=replacement.end;}
  normalized+=source.slice(copied);
  const parsed:unknown=Bun.YAML.parse(normalized),seen=new WeakMap<object,unknown>();
  function restore(value:unknown):unknown {
    if(typeof value === "string")return values.get(value) ?? value;
    if(value===null || typeof value!=="object")return value;
    const previous=seen.get(value);if(previous!==undefined)return previous;
    if(Array.isArray(value)) {const array:unknown[]=[];seen.set(value,array);for(const item of value)array.push(restore(item));return array;}
    const result:Record<string,unknown>=Object.create(Object.getPrototypeOf(value)) as Record<string,unknown>;seen.set(value,result);
    for(const [key,item] of Object.entries(value)) {
      const decoded=values.get(key) ?? key;
      if(Object.hasOwn(result,decoded))throw new Error("YAML: duplicate decoded mapping key");
      Object.defineProperty(result,decoded,{value:restore(item),enumerable:true,writable:true,configurable:true});
    }
    return result;
  }
  return restore(parsed);
}
