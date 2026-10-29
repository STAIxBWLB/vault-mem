import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

/** Newline-delimited JSON-RPC stdio transport (MCP basic + tools). Sequential, bounded, no timers. */
export const FRAME_BYTES = 65_536, RESULT_BYTES = 262_144;
export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, boolean> }
export type McpHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
export interface McpServerOptions { tools: readonly McpTool[]; handlers: Record<string, McpHandler>; input?: Readable; output?: Writable; name?: string; version?: string }
const protocols = ["2025-06-18", "2025-03-26", "2024-11-05"];
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Runtime validation for the small schema vocabulary the tools use. Unknown keywords never widen acceptance. */
export function validArguments(value: unknown, raw: unknown): boolean {
  const s = raw as Record<string, any>, type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types: unknown[] = Array.isArray(s.type) ? s.type : [s.type];
  if (!types.includes(type) && !(type === "number" && Number.isSafeInteger(value) && types.includes("integer"))) return false;
  if (type === "number" && !types.includes("number") && !Number.isSafeInteger(value)) return false;
  if (s.enum && !s.enum.includes(value)) return false;
  if (typeof value === "string" && (value.length < (s.minLength ?? 0) || value.length > (s.maxLength ?? FRAME_BYTES) || value.includes("\0"))) return false;
  if (typeof value === "number" && (!Number.isFinite(value) || value < (s.minimum ?? -Infinity) || value > (s.maximum ?? Infinity))) return false;
  if (Array.isArray(value)) {
    if (value.length < (s.minItems ?? 0) || value.length > (s.maxItems ?? 64) || !plain(s.items)) return false;
    return value.every(item => validArguments(item, s.items));
  }
  if (plain(value)) {
    const keys = Object.keys(value);
    if (keys.length < (s.minProperties ?? 0) || keys.length > (s.maxProperties ?? 64)) return false;
    if ((s.required ?? []).some((key: string) => !Object.hasOwn(value, key))) return false;
    for (const key of keys) {
      if (["__proto__", "prototype", "constructor"].includes(key) || key.length > 200) return false;
      if (Object.hasOwn(s.properties ?? {}, key)) { if (!validArguments(value[key], s.properties[key])) return false; }
      else if (s.additionalProperties === false || !plain(s.additionalProperties) || !validArguments(value[key], s.additionalProperties)) return false;
    }
  } else if (type === "object") return false;
  return true;
}

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
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: options.name ?? "vmem", version: options.version ?? "unreleased" } } });
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
    if (!definition || !handler || !validArguments(args, definition.inputSchema)) { await error(id, -32602, "Invalid tool name or arguments"); return; }
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
