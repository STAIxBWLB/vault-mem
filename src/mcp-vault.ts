import { analysisInput } from "./analysis-input.ts";
import { buildGraph, graphNeighbors } from "./vault-graph.ts";
import { lintVault } from "./vault-lint.ts";
import { writeAnalysisReports } from "./analysis-reports.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import type { VaultSpec } from "./config.ts";
import { loadRegistry, registryStatus } from "./registry.ts";
import { VaultIndex } from "./vault-index.ts";
import { appendLog, readLog } from "./vault-log.ts";
import { applyWrite } from "./writer.ts";
import { notePath } from "./write-operations.ts";
import type { LogEvent } from "./log-types.ts";
import type { WriteOp, WriteReceipt, WriteRequest } from "./write-types.ts";
import type { McpHandler, McpTool } from "./mcp.ts";

const string = (maxLength: number, minLength = 1) => ({ type: "string", minLength, maxLength });
const integer = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const tool = (name: string, description: string, inputSchema: Record<string, unknown>, kind: "read" | "write" | "confirm" = "read"): McpTool => ({
  name, description, inputSchema, annotations: { readOnlyHint: kind === "read", destructiveHint: kind === "confirm", idempotentHint: kind === "read", openWorldHint: false },
});
const RELATIONS = ["supports", "contradicts", "extends", "applies-to", "context-for"];
const LOG_TYPES = ["INGEST", "ROUTE", "EXTRACT", "CONNECT", "DIGEST", "LEARN", "LINT", "TASK", "GRAPH", "SYNC", "RETHINK", "SOURCE"];
const note = string(1024), sha = { type: "string", minLength: 64, maxLength: 64 };
const logEvent = object({ type: { type: "string", enum: LOG_TYPES }, project: string(64), source: string(512), dest: string(512), note: string(500) }, ["type", "project", "source", "note"]);
const scalar = { type: ["string", "number", "boolean", "null", "array"], maxLength: 4096, maxItems: 64, items: { type: ["string", "number", "boolean"], maxLength: 1024 } };

/** Tool names for implemented read, write, log and analysis providers. Promotion lands separately. */
export const VMEM_TOOL_NAMES = ["vmem_lint", "vmem_graph_build", "vmem_graph_neighbors", "vmem_status", "vmem_search", "vmem_read", "vmem_read_many", "vmem_list", "vmem_links", "vmem_mocs", "vmem_check", "vmem_log_tail",
  "vmem_create", "vmem_patch", "vmem_append", "vmem_set_frontmatter", "vmem_link", "vmem_supersede", "vmem_log_append", "vmem_move", "vmem_delete", "vmem_promote_from_amem"] as const;

/** Tool definitions for a fixed vault set: `vault` is an enum of the registered ids. */
export function vaultTools(ids: readonly string[]): McpTool[] {
  const vault = ids.length ? { type: "string", enum: [...ids] } : string(32);
  const twoStep = { confirm: { type: "boolean" }, fingerprint: sha };
  return [
    tool("vmem_lint", "Lint a private derived snapshot; write=true writes a screened report.", object({ vault, write: { type: "boolean" }, dryRun: { type: "boolean" } }), "write"),
    tool("vmem_graph_build", "Build a deterministic graph and screened reports; dryRun changes nothing.", object({ vault, dryRun: { type: "boolean" } }), "write"),
    tool("vmem_graph_neighbors", "Read a bounded graph neighborhood.", object({ vault, path: note, hops: integer(1,2), limit: integer(1,500) }, ["path"])),
    tool("vmem_status", "Registered vaults with health, write policy and effective pii.", object({})),
    tool("vmem_search", "Full-text (BM25) search over indexed notes. Literal AND terms.", object({ query: string(1000), vault, limit: integer(1, 50), type: string(64), domain: string(64) }, ["query"])),
    tool("vmem_read", "Read one note by stem, alias or notes/ path: frontmatter, body, sha256. Bounded by maxBytes.", object({ path: note, vault, maxBytes: integer(1, 65536) }, ["path"])),
    tool("vmem_read_many", "Read up to 20 notes (8 KiB each).", object({ paths: { type: "array", minItems: 1, maxItems: 20, items: note }, vault }, ["paths"])),
    tool("vmem_list", "List indexed notes under notes/, optionally by stem prefix.", object({ vault, prefix: string(256, 0), limit: integer(1, 500) })),
    tool("vmem_links", "Outgoing links (with resolution) and/or incoming backlinks of a note.", object({ path: note, vault, direction: { type: "string", enum: ["out", "in", "both"] }, limit: integer(1, 200) }, ["path"])),
    tool("vmem_mocs", "MOC notes with incoming link counts.", object({ vault })),
    tool("vmem_check", "Validate a prospective note text without writing.", object({ vault, path: string(200), text: string(262144, 0) }, ["text"])),
    tool("vmem_log_tail", "Read the newest vault log lines, optionally filtered.", object({ vault, n: integer(1, 200), type: { type: "string", enum: LOG_TYPES }, grep: string(256) })),
    tool("vmem_create", "Create a validated note. Requires a vault with write=mcp.", object({ vault, stem: string(200), type: string(64), domain: string(64), topics: { type: "array", maxItems: 32, items: string(200) }, description: string(1000), title: string(300), body: string(65536, 0), source: string(512), confidence: string(32), status: string(32), extra: { type: "object", maxProperties: 32, additionalProperties: scalar }, log: logEvent }, ["stem", "type", "domain", "description"]), "write"),
    tool("vmem_patch", "Replace one exact string in a note.", object({ vault, path: note, oldString: string(8192), newString: string(8192, 0), expectedSha: sha }, ["path", "oldString", "newString"]), "write"),
    tool("vmem_append", "Append markdown to a section of a note.", object({ vault, path: note, section: string(120), markdown: string(16384), expectedSha: sha }, ["path", "section", "markdown"]), "write"),
    tool("vmem_set_frontmatter", "Set or unset frontmatter keys of a note.", object({ vault, path: note, set: { type: "object", maxProperties: 32, additionalProperties: scalar }, unset: { type: "array", maxItems: 32, items: string(64) }, expectedSha: sha }, ["path"]), "write"),
    tool("vmem_link", "Add a typed relation link between two notes (bidirectional by default).", object({ vault, from: note, to: note, relation: { type: "string", enum: RELATIONS }, context: string(500), bidirectional: { type: "boolean" }, log: logEvent }, ["from", "to", "relation"]), "write"),
    tool("vmem_supersede", "Mark a note superseded by another.", object({ vault, old: note, next: note, log: logEvent }, ["old", "next"]), "write"),
    tool("vmem_log_append", "Append one validated event line to the vault log.", object({ vault, type: { type: "string", enum: LOG_TYPES }, project: string(64), source: string(512), dest: string(512), note: string(500) }, ["type", "project", "source", "note"]), "write"),
    tool("vmem_move", "Two-step rename with link rewrites: without confirm returns preview and fingerprint; then confirm=true with that fingerprint.", object({ vault, from: note, to: note, ...twoStep }, ["from", "to"]), "confirm"),
    tool("vmem_delete", "Two-step delete: without confirm returns preview (or refusal), backlinks and fingerprint; then confirm=true with that fingerprint.", object({ vault, path: note, ...twoStep }, ["path"]), "confirm"),
    tool("vmem_promote_from_amem", "Two-step promotion of one durable agent-mem entry (id from amem_vault_candidates) into a vault note: without confirm returns the full note text, possible duplicates and fingerprint; confirm=true with that fingerprint creates the note, logs LEARN and records the agent-mem vault link. linkTo links an existing note instead.",
      object({ vault, id: { type: "string", minLength: 32, maxLength: 36 }, stem: string(120), type: string(64), domain: string(64), topics: { type: "array", maxItems: 32, items: string(200) }, description: string(1000), title: string(300), body: string(65536, 0), linkTo: note, project: string(400), ...twoStep }, ["id"]), "confirm"),
  ];
}
type Issue = { code: string; severity: "error"; message: string };
const refusal = (code: string, message: string) => ({ refused: true as const, issues: [{ code, severity: "error", message } as Issue] });
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

/**
 * Handlers over the shared providers (VaultIndex, applyWrite, appendLog/readLog). The vault set and
 * the default (first personal) are fixed when the server starts; later registry changes need a restart.
 */
export function createVaultMcp(home: string, env: NodeJS.ProcessEnv = process.env): { tools: McpTool[]; handlers: Record<string, McpHandler>; vaults: VaultSpec[]; defaultVault: string | undefined } {
  const vaults = loadRegistry(home).vaults, ids = vaults.map(v => v.id);
  const defaultVault = (vaults.find(v => v.kind === "personal") ?? vaults[0])?.id;
  const pick = (args: Record<string, unknown>): VaultSpec => {
    const id = str(args.vault) ?? defaultVault;
    const spec = vaults.find(v => v.id === id);
    if (!spec) throw Object.assign(new Error(ids.length ? "unknown vault id" : "no vaults registered"), { code: "V04" });
    return spec;
  };
  const read = <T>(args: Record<string, unknown>, body: (index: VaultIndex) => T): T => {
    const spec = pick(args), index = new VaultIndex(home, spec, vaults.map(v => v.path));
    try { index.scan(); return body(index); } finally { index.close(); }
  };
  const write = (args: Record<string, unknown>, operation: WriteOp, extra: Partial<WriteRequest> = {}): WriteReceipt | ReturnType<typeof refusal> & Partial<WriteReceipt> => {
    const request: WriteRequest = { vault: pick(args).id, operation, channel: "mcp", ...extra, ...(args.log ? { log: args.log as LogEvent } : {}) };
    const receipt = applyWrite(home, request, { env });
    return receipt.ok ? receipt : { ...receipt, refused: true };
  };
  const twoStep = (args: Record<string, unknown>) => ({ confirm: args.confirm === true, ...(str(args.fingerprint) ? { fingerprint: str(args.fingerprint) } : {}) });
  const document = (path: string, content: string, hash: string, truncated: boolean) => {
    if (truncated) return { path, sha256: hash, truncated, frontmatter: null, body: content };
    const parsed = parseFrontmatter(content);
    return { path, sha256: hash, truncated, frontmatter: parsed.data, body: parsed.body };
  };
  const handlers: Record<string, McpHandler> = {
    vmem_promote_from_amem: async args => {
      const { promoteFromAmem } = await import("./promote.ts");
      const id = str(args.id)!.replace(/^mem:/, "");
      const result = await promoteFromAmem(home, { vault: pick(args).id, id, channel: "mcp", confirm: args.confirm === true,
        ...Object.fromEntries(["stem", "type", "domain", "description", "title", "body", "linkTo", "fingerprint"].filter(key => str(args[key]) !== undefined).map(key => [key, str(args[key])])),
        ...(Array.isArray(args.topics) ? { topics: args.topics as string[] } : {}) }, { env, ...(str(args.project) ? { project: str(args.project) } : {}) });
      return result.ok ? result : { ...result, refused: true };
    },
    vmem_lint: args => args.write === true ? writeAnalysisReports(home,{vault:pick(args).id,kind:"lint",channel:"mcp",expectedVault:pick(args),dryRun:args.dryRun === true},env) : lintVault(analysisInput(home,pick(args).id,{expectedVault:pick(args)}).snapshot),
    vmem_graph_build: args => writeAnalysisReports(home,{vault:pick(args).id,kind:"graph",channel:"mcp",expectedVault:pick(args),dryRun:args.dryRun === true},env),
    vmem_graph_neighbors: args => graphNeighbors(buildGraph(analysisInput(home,pick(args).id,{expectedVault:pick(args)}).snapshot),str(args.path)!, (args.hops as 1|2|undefined) ?? 1, (args.limit as number|undefined) ?? 50),
    vmem_status: () => ({ defaultVault: defaultVault ?? null, vaults: registryStatus(home).filter(v => ids.includes(v.id)) }),
    vmem_search: args => read(args, index => ({ hits: index.search(str(args.query)!, { limit: (args.limit as number | undefined) ?? 20, type: str(args.type), domain: str(args.domain) }) })),
    vmem_read: args => read(args, index => { const r = index.show(str(args.path)!, (args.maxBytes as number | undefined) ?? 16384); return document(r.path, r.content, r.hash, r.truncated); }),
    vmem_read_many: args => read(args, index => ({ notes: (args.paths as string[]).map(path => {
      try { const r = index.show(path, 8192); return document(r.path, r.content, r.hash, r.truncated); }
      catch (error) { return { path, ...refusal("V04", error instanceof Error ? error.message : "unreadable") }; }
    }) })),
    vmem_list: args => read(args, index => ({ notes: index.list(str(args.prefix) ?? "", (args.limit as number | undefined) ?? 100) })),
    vmem_links: args => read(args, index => {
      const direction = str(args.direction) ?? "both", limit = (args.limit as number | undefined) ?? 50;
      const out = direction === "in" ? [] : index.links(str(args.path)!, limit);
      return { out: out.filter(l => l.resolved), dead: out.filter(l => !l.resolved), in: direction === "out" ? [] : index.backlinks(str(args.path)!, limit) };
    }),
    vmem_mocs: args => read(args, index => ({ mocs: index.mocs() })),
    vmem_check: args => write(args, { op: "check", path: notePath(str(args.path) ?? "checked-note"), text: str(args.text)! }),
    vmem_log_tail: args => readLog(home, { vault: pick(args).id, limit: (args.n as number | undefined) ?? 50, ...(str(args.type) ? { type: str(args.type) } : {}), ...(str(args.grep) ? { grep: str(args.grep) } : {}) }),
    vmem_create: args => {
      const frontmatter: Record<string, unknown> = { ...(args.extra as Record<string, unknown> | undefined ?? {}) };
      for (const key of ["type", "domain", "description", "title", "source", "confidence", "status"]) if (str(args[key]) !== undefined) frontmatter[key] = args[key];
      if (Array.isArray(args.topics)) frontmatter.topics = (args.topics as string[]).map(v => v.startsWith("[[") ? v : `[[${v}]]`);
      return write(args, { op: "create", path: str(args.stem)!, frontmatter, ...(str(args.body) !== undefined ? { body: str(args.body) } : {}) });
    },
    vmem_patch: args => write(args, { op: "patch", path: str(args.path)!, oldString: str(args.oldString)!, newString: str(args.newString)!, expectedSha: str(args.expectedSha) }),
    vmem_append: args => write(args, { op: "append", path: str(args.path)!, section: str(args.section)!, markdown: str(args.markdown)!, expectedSha: str(args.expectedSha) }),
    vmem_set_frontmatter: args => write(args, { op: "frontmatter", path: str(args.path)!, set: (args.set as Record<string, unknown> | undefined) ?? {}, ...(args.unset ? { unset: args.unset as string[] } : {}), expectedSha: str(args.expectedSha) }),
    vmem_link: args => write(args, { op: "link", from: str(args.from)!, to: str(args.to)!, relation: args.relation as Extract<WriteOp, { op: "link" }>["relation"], ...(str(args.context) ? { context: str(args.context) } : {}), bidirectional: args.bidirectional !== false }),
    vmem_supersede: args => write(args, { op: "supersede", old: str(args.old)!, next: str(args.next)! }),
    vmem_log_append: args => {
      const event: LogEvent = { type: str(args.type)!, project: str(args.project)!, source: str(args.source)!, note: str(args.note)!, ...(str(args.dest) ? { dest: str(args.dest) } : {}) };
      const receipt = appendLog(home, { vault: pick(args).id, event, channel: "mcp" }, { env });
      return receipt.ok ? receipt : { ...receipt, refused: true };
    },
    vmem_move: args => write(args, { op: "move", from: str(args.from)!, to: str(args.to)! }, twoStep(args)),
    vmem_delete: args => {
      const receipt = write(args, { op: "delete", path: str(args.path)! }, twoStep(args));
      if (args.confirm === true) return receipt;
      let backlinks: { source: string; line: number }[] = [];
      try { backlinks = read(args, index => index.backlinks(str(args.path)!, 200).map(l => ({ source: l.source, line: l.line }))); } catch { /* preview stays valid without backlinks */ }
      return { ...receipt, backlinks };
    },
  };
  // Every handler returns a structured value; provider errors become refusals, never protocol errors.
  const guarded: Record<string, McpHandler> = {};
  for (const [name, handler] of Object.entries(handlers)) guarded[name] = async args => {
    try { return await handler(args); }
    catch (error) { return refusal((error as { code?: unknown }).code === "V04" ? "V04" : "REFUSED", error instanceof Error ? error.message.slice(0, 500) : "operation refused"); }
  };
  return { tools: vaultTools(ids), handlers: guarded, vaults, defaultVault };
}
