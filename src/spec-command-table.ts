import { SPEC_EDGE_KINDS } from "./spec-graph.ts";
import { SPEC_UPDATE_LIST_FIELDS as listFields, SPEC_UPDATE_OPTIONAL_FIELDS as optionalFields } from "./spec-write.ts";

const string = (maxLength: number, minLength = 1) => ({ type: "string", minLength, maxLength });
const integer = (maximum: number, minimum = 0) => ({ type: "integer", minimum, maximum });
const common = { source: string(64), worktree: string(4096) };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: { ...common, ...properties }, required, additionalProperties: false, maxProperties: 20 });
const listChanges = { type: "object", properties: Object.fromEntries(listFields.map(field => [field, { type: "array", items: string(4096), maxItems: 256 }])), additionalProperties: false, maxProperties: listFields.length };
const scalarChanges = { type: "object", properties: {
  title: string(4096), type: { type: "string", enum: ["goal", "architecture", "module", "submodule"] },
  status: { type: "string", enum: ["draft", "active", "deprecated"] }, parent: string(1024), "superseded-by": string(1024), "verified-against": { ...string(64, 40), pattern: "^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$" },
}, additionalProperties: false, maxProperties: 6 };
/** Implemented commands only; CLI flags and MCP definitions share these schemas. */
export const SPEC_COMMANDS = [
  { command: "get", name: "vmem_spec_get", usage: "spec get <id> [--source ID] [--worktree PATH] [--body] [--section TEXT] [--offset N] [--max-bytes 1..65536] [--json]", description: "Read spec metadata, resolved links, backlinks, children and freshness; body reads are optional and paged.", inputSchema: schema({ id: string(1024), body: { type: "boolean" }, section: string(1024), offset: integer(2097152), maxBytes: integer(65536, 1) }, ["id"]) },
  { command: "graph", name: "vmem_spec_graph", usage: "spec graph <id> [--source ID] [--worktree PATH] [--direction subtree|ancestors|neighbors] [--edge KIND] [--depth 0..3] [--limit 1..500] [--json]", description: "Read a bounded spec graph slice without raw source content.", inputSchema: schema({ id: string(1024), direction: { type: "string", enum: ["subtree", "ancestors", "neighbors"] }, edge: { type: "string", enum: [...SPEC_EDGE_KINDS] }, depth: integer(3), limit: integer(500, 1) }, ["id"]) },
  { command: "grep", name: "vmem_spec_grep", usage: "spec grep [query] [--source ID] [--worktree PATH] [--literal] [--type TYPE] [--status STATUS] [--tag TAG] [--parent ID] [--depends-on ID] [--covers-path FILE] [--offset 0..10000] [--limit 1..500] [--json]", description: "Search specs with FTS terms or literal substring, metadata/path-scope filters and continuation offsets.", inputSchema: schema({ query: string(1024, 0), literal: { type: "boolean" }, type: string(256), status: string(256), tag: string(1024), parent: string(1024), dependsOn: string(1024), coversPath: string(4096), offset: integer(10000), limit: integer(500, 1) }) },
  { command: "validate", name: "vmem_spec_validate", usage: "spec validate [--source ID] [--worktree PATH] [--require-fresh] [--limit 1..500] [--json] | spec validate --repo PATH [--require-fresh] [--limit 1..500] [--json]", description: "Validate spec candidates and report bounded errors, warnings and computed freshness; requireFresh makes stale scopes fatal.", inputSchema: schema({ requireFresh: { type: "boolean" }, limit: integer(500, 1) }) },
  { command: "update", name: "vmem_spec_update", usage: "spec update <id> [--source ID] [--worktree PATH] [--set JSON] [--unset JSON] [--add JSON] [--remove JSON] [--expected-sha SHA] [--json]", description: "Update only spec frontmatter with scalar set/unset and list add/remove, preserving body bytes and refusing new validation errors; expectedSha protects a prior read.", inputSchema: schema({ id: string(1024), set: scalarChanges, unset: { type: "array", items: { type: "string", enum: [...optionalFields] }, maxItems: optionalFields.length }, add: listChanges, remove: listChanges, expectedSha: { ...string(64, 64), pattern: "^[a-f0-9]{64}$" } }, ["id"]) },
] as const;
export type SpecCommand = typeof SPEC_COMMANDS[number]["command"];
export const specCommandSchema = (command: SpecCommand) => SPEC_COMMANDS.find(item => item.command === command)!.inputSchema;
