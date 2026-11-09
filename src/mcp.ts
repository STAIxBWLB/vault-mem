import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

/** Newline-delimited JSON-RPC stdio transport (MCP basic + tools). Sequential, bounded, no timers. */
export const FRAME_BYTES = 65_536, RESULT_BYTES = 262_144;
export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, boolean> }
export type McpHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
export interface McpServerOptions { tools: readonly McpTool[]; handlers: Record<string, McpHandler>; input?: Readable; output?: Writable; name?: string; version?: string; instructions?: string }
const protocols = ["2025-06-18", "2025-03-26", "2024-11-05"];
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** First schema failure only; paths and schema limits are reported, never argument values. */
export function argumentError(value: unknown, raw: unknown, path = ""): string | undefined {
  const at = path || "arguments", fail = (reason: string) => `${at}: ${reason}`;
  if (!plain(raw)) return fail("invalid schema");
  const s = raw as Record<string, any>, type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types: unknown[] = Array.isArray(s.type) ? s.type : [s.type];
  if (!types.includes(type) && !(type === "number" && Number.isSafeInteger(value) && types.includes("integer"))) return fail(`expected ${types.join(" or ")}`);
  if (type === "number" && !types.includes("number") && !Number.isSafeInteger(value)) return fail("expected safe integer");
  if (s.enum && !s.enum.includes(value)) return fail("not an allowed value");
  if (typeof value === "string") {
    if (value.length < (s.minLength ?? 0)) return fail(`shorter than ${s.minLength}`);
    if (value.length > (s.maxLength ?? FRAME_BYTES)) return fail(`longer than ${s.maxLength ?? FRAME_BYTES}`);
    if (value.includes("\0")) return fail("NUL is not allowed");
    if (s.pattern && !new RegExp(s.pattern).test(value)) return fail("does not match the required pattern");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail("expected finite number");
    if (value < (s.minimum ?? -Infinity)) return fail(`less than ${s.minimum}`);
    if (value > (s.maximum ?? Infinity)) return fail(`greater than ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (value.length < (s.minItems ?? 0)) return fail(`fewer than ${s.minItems} items`);
    if (value.length > (s.maxItems ?? 64)) return fail(`more than ${s.maxItems ?? 64} items`);
    if (!plain(s.items)) return fail("invalid item schema");
    for (let i = 0; i < value.length; i++) {
      const error = argumentError(value[i], s.items, `${path}[${i}]`);
      if (error) return error;
    }
  } else if (plain(value)) {
    const keys = Object.keys(value);
    if (keys.length < (s.minProperties ?? 0)) return fail(`fewer than ${s.minProperties} properties`);
    if (keys.length > (s.maxProperties ?? 64)) return fail(`more than ${s.maxProperties ?? 64} properties`);
    for (const key of s.required ?? []) if (!Object.hasOwn(value, key)) return `${path ? path + "." : ""}${key}: required`;
    for (const key of keys) {
      if (key.length > 200) return fail("property name longer than 200");
      const child = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path || "$"}[${JSON.stringify(key)}]`;
      if (["__proto__", "prototype", "constructor"].includes(key)) return `${child}: forbidden property name`;
      let schema;
      if (Object.hasOwn(s.properties ?? {}, key)) schema = s.properties[key];
      else if (s.additionalProperties === false || !plain(s.additionalProperties)) return `${path ? path + ": " : ""}unknown argument: ${key}`;
      else schema = s.additionalProperties;
      const error = argumentError(value[key], schema, child);
      if (error) return error;
    }
  } else if (type === "object") return fail("expected plain object");
  return undefined;
}
/** Boolean compatibility API for the same closed, bounded schema vocabulary. */
export function validArguments(value: unknown, raw: unknown): boolean { return argumentError(value, raw) === undefined; }

/** Serve until input ends. stdout carries protocol messages only; nothing else is written to `output`. */
export async function serveMcp(options: McpServerOptions): Promise<void> {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  let phase: "new" | "initializing" | "ready" = "new";
  const send = async (response: unknown) => { if (!output.write(JSON.stringify(response) + "\n")) await once(output, "drain"); };
  const error = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const handle = async (line: string) => {
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { await error(null, -32700, "Parse error"); return; }
    if (!plain(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") { await error(null, -32600, "Invalid request"); return; }
    if (!Object.hasOwn(msg, "id")) {
      if (msg.method === "notifications/initialized" && phase === "initializing") phase = "ready";
      return; // Notifications never invoke a handler.
    }
    const id = msg.id;
    if (!(typeof id === "string" && id.length <= 200 || typeof id === "number" && Number.isSafeInteger(id))) { await error(null, -32600, "Invalid request id"); return; }
    if (msg.method === "ping") { await send({ jsonrpc: "2.0", id, result: {} }); return; }
    if (msg.method === "initialize") {
      if (phase !== "new" || !plain(msg.params) || typeof msg.params.protocolVersion !== "string" || !plain(msg.params.capabilities) || !plain(msg.params.clientInfo)) { await error(id, -32602, "Invalid initialization"); return; }
      phase = "initializing";
      await send({ jsonrpc: "2.0", id, result: { protocolVersion: protocols.includes(msg.params.protocolVersion) ? msg.params.protocolVersion : protocols[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: options.name ?? "vmem", version: options.version ?? "unreleased" },
        ...(options.instructions !== undefined ? { instructions: options.instructions } : {}) } });
      return;
    }
    if (phase !== "ready") { await error(id, -32002, "Initialize the session first"); return; }
    if (msg.method === "tools/list") {
      const params = msg.params;
      if (params !== undefined && params !== null && (!plain(params) || Object.keys(params).some(key => key !== "cursor" && key !== "_meta") || params.cursor !== undefined && params.cursor !== null)) { await error(id, -32602, "Invalid tool listing arguments"); return; }
      await send({ jsonrpc: "2.0", id, result: { tools: options.tools } }); return;
    }
    if (msg.method !== "tools/call") { await error(id, -32601, "Method not found"); return; }
    const params = msg.params;
    if (!plain(params) || Object.keys(params).some(k => !["name", "arguments", "_meta"].includes(k)) || typeof params.name !== "string") { await error(id, -32602, "Invalid tool call"); return; }
    const definition = options.tools.find(t => t.name === params.name), args = params.arguments ?? {};
    const handler = definition && options.handlers[definition.name];
    if (!definition || !handler) { await error(id, -32602, `unknown tool: ${params.name.slice(0, 200)}`); return; }
    const invalid = argumentError(args, definition.inputSchema);
    if (invalid) { await error(id, -32602, invalid); return; }
    let result: unknown;
    try {
      const text = JSON.stringify(await handler(args as Record<string, unknown>));
      if (text === undefined) throw new Error("tool returned no result");
      result = Buffer.byteLength(text) > RESULT_BYTES
        ? { isError: true, content: [{ type: "text", text: JSON.stringify({ refused: true, issues: [{ code: "LIMIT", severity: "error", message: "result exceeds 256 KiB; narrow the request" }] }) }] }
        : { content: [{ type: "text", text }] };
    } catch (failure) {
      // Handlers return structured refusals; anything thrown is reported without stack or content.
      const message = failure instanceof Error ? failure.message.slice(0, 500) : "operation failed";
      result = { isError: true, content: [{ type: "text", text: JSON.stringify({ refused: true, issues: [{ code: "ERROR", severity: "error", message }] }) }] };
    }
    await send({ jsonrpc: "2.0", id, result });
  };
  let pending = "", overflow = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const consume = async (chunk: string) => {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start), part = chunk.slice(start, newline < 0 ? undefined : newline);
      if (!overflow) {
        if (Buffer.byteLength(pending) + Buffer.byteLength(part) > FRAME_BYTES) { overflow = true; pending = ""; }
        else pending += part;
      }
      if (newline < 0) return;
      if (overflow) await error(null, -32600, "Request exceeds the 64 KiB frame bound");
      else if (pending.trim()) await handle(pending);
      pending = ""; overflow = false; start = newline + 1;
    }
  };
  try {
    for await (const chunk of input) await consume(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
  } catch { await error(null, -32700, "Invalid UTF-8 input"); return; }
  await consume(decoder.decode());
  // A truncated frame at EOF is never executed.
  if (pending.trim() || overflow) await error(null, -32700, "Incomplete request at EOF");
}
