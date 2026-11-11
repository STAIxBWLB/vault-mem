import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { unenforceablePii, type VaultSpec } from "./config.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { loadRegistry } from "./registry.ts";
import { VaultIndex, type BriefPointer } from "./vault-index.ts";
import { screenContent, screenMetadata } from "./write-validation.ts";

export interface VaultBrief { vault: string; lines: string[]; omitted: number; bytes: number }
export interface BriefRequest { vault: string; intent: string; paths?: string[]; bytes?: number }
export function briefText(result: VaultBrief): string { return [...result.lines, `${result.omitted} matches omitted`].join("\n"); }
function sized(vault: string, lines: string[], omitted: number): VaultBrief {
  const result = { vault, lines, omitted, bytes: 0 };
  for (let i = 0; i < 4; i++) {
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes === result.bytes) break;
    result.bytes = bytes;
  }
  return result;
}
const flat = (value: string) => value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
/** Metadata pointers only. The normal metadata refresh is the only source-reading/cache-writing phase. */
export function vaultBrief(home: string, request: BriefRequest, expectedVault?: VaultSpec): VaultBrief {
  const { vault: id, intent, paths = [], bytes = 1024 } = request;
  if (typeof intent !== "string" || !intent.trim() || Buffer.byteLength(intent) > 1024) throw new Error("brief: intent must contain 1..1024 UTF-8 bytes; use --for with a shorter task description");
  if (!Number.isSafeInteger(bytes) || bytes < 256 || bytes > 4096) throw new Error("brief: bytes must be an integer 256..4096; choose a supported byte cap");
  if (!Array.isArray(paths) || paths.length > 16 || paths.some(p => typeof p !== "string" || !p.trim() || Buffer.byteLength(p) > 1024 || /\p{Cc}/u.test(p))) throw new Error("brief: paths must be at most 16 nonempty hints of at most 1024 bytes without control characters; remove control characters, shorten or remove path hints");
  const words = [...new Set([intent, ...paths.map(p => p.split(/[\\/]/).at(-1)!.replace(/\.[^.]+$/, ""))].flatMap(value => value.normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? []))];
  if (!words.length) throw new Error("brief: intent and path basenames contain no searchable letters or digits; provide words containing letters or digits");
  if (words.length > 32 || Buffer.byteLength(words.join(" ")) > 4096) throw new Error("brief: expected 1..32 searchable words within 4096 bytes; shorten the intent or path basenames");
  const config = loadRegistry(home), vault = config.vaults.find(v => v.id === id);
  if (!vault) throw new Error("brief: unknown vault id; choose a registered id from vmem vaults list");
  if (expectedVault && !isDeepStrictEqual(vault, expectedVault)) throw new Error("brief: vault binding changed since MCP startup; restart the MCP server before reading");
  if (unenforceablePii(vault)) throw new Error("brief: vault PII policy cannot be enforced by this version; inspect vmem doctor and update the client or policy");
  const denied = (file: string) => isDenied(file, config.denyPaths ?? []) || isDenied(canonicalPath(file), config.denyPaths ?? []);
  if (denied(vault.path) || denied(join(vault.path, "notes"))) throw new Error("brief: vault or notes directory is denied; choose an allowed registered vault");
  const index = new VaultIndex(home, vault, config.vaults.map(v => v.path));
  try {
    index.scan(false, { denyPaths: config.denyPaths ?? [] });
    const ranked = index.briefMatches(words), direct = new Set(ranked.map(row => row.path));
    // Count every attempt, including oversized or screened metadata, and pass the remaining bytes into SQL.
    const cache = new Map<string, BriefPointer | undefined>(); let remaining = 256 * 1024, attempts = 0;
    const load = (path: string) => {
      if (cache.has(path)) return cache.get(path);
      if (denied(join(vault.path, "notes", path))) { cache.set(path, undefined); return undefined; }
      if (attempts >= 512 || remaining <= 0) return undefined;
      attempts++;
      let pointer = index.briefPointer(path, Math.min(4096, remaining));
      if (pointer) {
        remaining -= pointer.bytes;
        const text = [pointer.path, pointer.title, pointer.type, pointer.description].join("\n");
        if (/[\p{Cc}\p{Zl}\p{Zp}|]/u.test(pointer.path) || screenMetadata({ title: pointer.title, type: pointer.type, description: pointer.description }, { vault, config }, pointer.path).length || screenContent(text, vault, config).length || screenContent(flat(text), vault, config).length) pointer = undefined;
      }
      cache.set(path, pointer); return pointer;
    };
    const seeds: string[] = [];
    for (const row of ranked) { if (load(row.path)) seeds.push(row.path); if (seeds.length === 5 || attempts >= 512 || remaining <= 0) break; }
    const neighbors = index.briefNeighbors(seeds).filter(path => !direct.has(path));
    const order = [...new Set([...seeds, ...neighbors, ...ranked.map(row => row.path)])];
    const lines: string[] = [];
    for (const path of order) {
      const pointer = load(path);
      if (!pointer) continue;
      const line = `${direct.has(path) ? "" : "[neighbor] "}notes/${pointer.path} | ${flat(pointer.title)} | ${flat(pointer.type)} | ${flat(pointer.description)}`;
      if (screenContent(line, vault, config).length) continue;
      const candidate = sized(vault.id, [...lines, line], order.length - lines.length - 1);
      if (candidate.bytes <= bytes && Buffer.byteLength(briefText(candidate)) + 1 <= bytes) lines.push(line);
    }
    return sized(vault.id, lines, order.length - lines.length);
  } finally { index.close(); }
}

export function runBriefCommand(args: string[], home: string): { text: string; code: number } {
  const paths: string[] = [], positional: string[] = []; let intent: string | undefined, bytes: number | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    if (arg === "--json" && !json) { json = true; continue; }
    if (!["--for", "--paths", "--bytes"].includes(arg)) throw new Error(`brief: unknown or repeated option ${arg}; run vmem brief --help`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`brief: ${arg} requires a value; run vmem brief --help`);
    if (arg === "--paths") paths.push(value);
    else if (arg === "--for" && intent === undefined) intent = value;
    else if (arg === "--bytes" && bytes === undefined && /^[0-9]+$/.test(value)) bytes = Number(value);
    else throw new Error(`brief: repeated option or invalid value for ${arg}; run vmem brief --help`);
  }
  if (positional.length !== 1 || intent === undefined) throw new Error("brief: requires one registered vault and --for intent; run vmem brief --help");
  const result = vaultBrief(home, { vault: positional[0]!, intent, paths, bytes });
  return { text: json ? JSON.stringify(result) : briefText(result), code: 0 };
}
