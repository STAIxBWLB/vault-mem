import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { absolute, readConfig } from "./config.ts";
export interface ResolvedHome { home: string; source: "VMEM_HOME" | "config" | "default" }
export function resolveHome(env: NodeJS.ProcessEnv = process.env): ResolvedHome {
  if (env.VMEM_HOME?.trim()) return { home: resolve(absolute(env.VMEM_HOME, "VMEM_HOME")), source: "VMEM_HOME" };
  const fallback = join(env.AGENTHUB_HOME?.trim() ? absolute(env.AGENTHUB_HOME, "AGENTHUB_HOME") : join(homedir(), ".agenthub"), "vmem");
  const pointer = readConfig(fallback).home;
  return pointer ? { home: resolve(pointer), source: "config" } : { home: fallback, source: "default" };
}
