import { loadRegistry } from "./registry.ts";
import { VaultIndex, MAX_NOTE_BYTES } from "./vault-index.ts";
const READ_COMMANDS = new Set(["rebuild", "search", "show", "links"]);
export function isReadCommand(command: string): boolean { return READ_COMMANDS.has(command); }
export function runReadCommand(command: string, args: string[], home: string): { text: string; code: number } {
  const options: Record<string, string | boolean> = {}, positional: string[] = [];
  const allowed = command === "search" ? ["--limit", "--type", "--domain"] : command === "show" ? ["--max-bytes", "--section", "--offset"] : command === "links" ? ["--limit"] : [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    if (Object.hasOwn(options, arg) || (arg !== "--json" && !allowed.includes(arg))) throw new Error(`${command}: unknown or repeated option ${arg}`);
    if (arg === "--json") { options[arg] = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg}: value required`);
    options[arg] = value;
  }
  if (positional.length !== (command === "rebuild" ? 1 : 2)) throw new Error(`${command}: requires vault id${command === "rebuild" ? "" : " and query/target"}`);
  const registry = loadRegistry(home), vault = registry.vaults.find(v => v.id === positional[0]);
  if (!vault) throw new Error(`${command}: unknown vault id`);
  const number = (name: string): number | undefined => {
    if (options[name] === undefined) return undefined;
    if (!/^[0-9]+$/.test(String(options[name]))) throw new Error(`${name}: expected integer`);
    return Number(options[name]);
  };
  const limit = number("--limit"), maxBytes = number("--max-bytes"), offset = number("--offset");
  // Validate bounds before opening or updating a derived cache.
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new Error("limit: expected integer 1..500");
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536)) throw new Error("max-bytes: expected integer 1..65536");
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_NOTE_BYTES)) throw new Error(`offset: expected integer 0..${MAX_NOTE_BYTES}`);
  const section = options["--section"] as string | undefined;
  if (section !== undefined && (!section.trim() || /[\r\n]/.test(section) || Buffer.byteLength(section) > 1024)) throw new Error("section: expected one exact H2 heading <=1024 bytes");
  const index = new VaultIndex(home, vault, registry.vaults.map(v => v.path));
  let result: unknown;
  try {
    const scan = index.scan(command === "rebuild");
    if (command === "rebuild") result = { vault: vault.id, ...scan };
    else if (command === "search") result = index.search(positional[1]!, { limit, type: options["--type"] as string | undefined, domain: options["--domain"] as string | undefined });
    else if (command === "show") result = index.show(positional[1]!, maxBytes, section, offset);
    else if (command === "links") result = index.links(positional[1]!, limit);
    else throw new Error("unknown read command");
  } finally { index.close(); }
  return { text: JSON.stringify(result, null, options["--json"] ? undefined : 2), code: 0 };
}
