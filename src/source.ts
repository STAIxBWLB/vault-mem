import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { VaultSpec } from "./config.ts";
export type SourceValue = string | string[];
export type SourceReference = {kind:"path"|"memory"|"url";value:string};
/** One string is one reference. Joined legacy strings are never silently split. */
export function sourceReferences(value:unknown):SourceReference[]{
  const values=typeof value==="string"?[value]:Array.isArray(value)&&value.length>0&&value.length<=32?value:null;
  if(!values)throw new Error("source must be a string or a nonempty list of at most 32 strings");
  return values.map(item=>{
    if(typeof item!=="string"||!item.trim()||Buffer.byteLength(item)>512||/\p{Cc}/u.test(item))throw new Error("source entries must be nonempty bounded strings without controls");
    const text=item.trim();
    if(text.startsWith("mem:")){
      if(!/^mem:[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(text))throw new Error("source memory id is invalid");
      return {kind:"memory",value:text};
    }
    if(/^[a-zA-Z]:[\\/]/.test(text))throw new Error("source paths must be workspace-relative");
    if(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)){
      if(/\s/.test(text))throw new Error("source URL must be one absolute URL");
      try{const url=new URL(text);if(["http:","https:","ftp:"].includes(url.protocol)&&!url.hostname)throw new Error();}
      catch{throw new Error("source URL is invalid");}
      return {kind:"url",value:text};
    }
    const path=text.startsWith("work/")?text.slice(5):text;
    if(!path||isAbsolute(path)||path.includes("\\")||path.split("/").some(part=>!part||part==="."||part===".."))throw new Error("source paths must be workspace-relative without traversal");
    return {kind:"path",value:path};
  });
}
export function normalizeSource(value:unknown):SourceValue{
  const entries=sourceReferences(value).map(ref=>ref.value);
  return typeof value==="string"?entries[0]!:entries;
}
/** A configured project registry locates its workspace; standalone registries use their directory. */
export function sourceWorkspaceRoot(vault:VaultSpec):string|undefined{
  if(!vault.registry)return undefined;
  const fallback=resolve(dirname(vault.registry));let dir=fallback;
  for(let depth=0;depth<32;depth++){
    if(existsSync(join(dir,"workspace.config.yaml")))return dir;
    const parent=dirname(dir);if(parent===dir)break;dir=parent;
  }
  return fallback;
}
export function missingSourceWarnings(value:unknown,root:string|undefined):string[]{
  if(!root||value===undefined)return [];
  const missing=new Set(sourceReferences(value).filter(ref=>ref.kind==="path"&&!existsSync(resolve(root,ref.value))).map(ref=>ref.value));
  return [...missing].map(path=>`source path does not exist: ${path}`);
}
