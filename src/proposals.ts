/** Internal proposal payload contracts. Durable storage and public commands are not available yet. */
import { createHash } from "node:crypto";
import { notePath } from "./write-operations.ts";
import type { PatchEdit, WriteOp } from "./write-types.ts";

export const MAX_PROPOSAL_RECORD_BYTES = 32 * 1024;
export const MAX_PROPOSAL_RPC_BYTES = 48 * 1024;
export const MAX_PROPOSAL_EDITS = 32;
export type ProposalOperation = Extract<WriteOp, { op: "create" | "patch" }>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function jsonBytes(value: unknown): number {
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { throw new Error("proposal: input is not JSON serializable"); }
  if (text === undefined) throw new Error("proposal: input is not JSON serializable");
  return Buffer.byteLength(text, "utf8");
}
/** Measures the complete JSON-RPC frame, including escaping, envelope, and its terminating newline. */
export function proposalRpcBytes(request: unknown): number { return jsonBytes(request) + 1; }
export function checkProposalRpcSize(request: unknown): void {
  if (proposalRpcBytes(request) > MAX_PROPOSAL_RPC_BYTES) throw new Error("proposal: encoded JSON-RPC request exceeds 48 KiB; shorten the proposal");
}
/** Only create and exact-replacement patch operations are admissible, with one canonical flat note target. */
export function parseProposalOperation(value: unknown): ProposalOperation {
  if (!object(value) || typeof value.path !== "string") throw new Error("proposal: expected one create or patch operation and note target");
  if (jsonBytes(value) > MAX_PROPOSAL_RECORD_BYTES) throw new Error("proposal: operation exceeds the 32 KiB record limit; shorten the payload");
  const path = notePath(value.path);
  if (value.op === "create") {
    if (!exactKeys(value, ["op", "path", "frontmatter", "body"]) || !object(value.frontmatter) || (value.body !== undefined && typeof value.body !== "string"))
      throw new Error("proposal: create requires frontmatter and an optional text body; remove unsupported fields");
    return { op: "create", path, frontmatter: value.frontmatter, ...(typeof value.body === "string" ? { body: value.body } : {}) };
  }
  if (value.op === "patch") {
    if (!exactKeys(value, ["op", "path", "edits", "expectedSha"]) || typeof value.expectedSha !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedSha) || !Array.isArray(value.edits) || value.edits.length < 1 || value.edits.length > MAX_PROPOSAL_EDITS)
      throw new Error("proposal: patch requires a base SHA and 1..32 exact edits; correct the patch");
    const edits: PatchEdit[] = value.edits.map(edit => {
      if (!object(edit) || !exactKeys(edit, ["oldString", "newString"]) || typeof edit.oldString !== "string" || !edit.oldString || typeof edit.newString !== "string")
        throw new Error("proposal: each edit needs nonempty oldString and a text newString; correct the patch");
      return { oldString: edit.oldString, newString: edit.newString };
    });
    return { op: "patch", path, edits, expectedSha: value.expectedSha };
  }
  throw new Error("proposal: unsupported operation; choose create or patch");
}

/** Durable record schema: version 1 is local state, not an index or a note. */
export interface ProposalRecord {
  schemaVersion: 1;
  id: string;
  vault: string;
  bindingDigest: string;
  state: "pending" | "applied" | "rejected" | "apply_unknown";
  createdAt: string;
  updatedAt: string;
  operation: ProposalOperation;
  payloadDigest: string;
  agentLabel?: string;
  decisionReason?: string;
  intent?: { fingerprint: string; beforeSha: string | null; afterSha: string | null };
}

/** A digest of the exact normalized operation, never a claim about who authored it. */
export function proposalPayloadDigest(operation: ProposalOperation): string {
  return createHash("sha256").update(JSON.stringify(operation), "utf8").digest("hex");
}
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
/** Parse bounded bytes and reject unknown fields, malformed states and payload drift. */
export function decodeProposalRecord(bytes: Uint8Array): ProposalRecord {
  if (bytes.byteLength > MAX_PROPOSAL_RECORD_BYTES) throw new Error("proposal: stored record exceeds 32 KiB; inspect the proposal store");
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) throw new Error("proposal: stored record is not UTF-8; inspect the proposal store");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("proposal: stored record is not JSON; inspect the proposal store"); }
  if (JSON.stringify(parsed) !== text) throw new Error("proposal: stored record is not in canonical JSON form; inspect the proposal store");
  if (!object(parsed) || !exactKeys(parsed, ["schemaVersion", "id", "vault", "bindingDigest", "state", "createdAt", "updatedAt", "operation", "payloadDigest", "agentLabel", "decisionReason", "intent"]) || parsed.schemaVersion !== 1 || typeof parsed.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed.id) || typeof parsed.vault !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(parsed.vault) || !digest(parsed.bindingDigest) || !["pending", "applied", "rejected", "apply_unknown"].includes(String(parsed.state)) || !date(parsed.createdAt) || !date(parsed.updatedAt) || !digest(parsed.payloadDigest))
    throw new Error("proposal: stored record has invalid metadata; inspect the proposal store");
  if ((parsed.agentLabel !== undefined && (typeof parsed.agentLabel !== "string" || Buffer.byteLength(parsed.agentLabel) > 256)) || (parsed.decisionReason !== undefined && (typeof parsed.decisionReason !== "string" || Buffer.byteLength(parsed.decisionReason) > 4096)))
    throw new Error("proposal: stored record has invalid optional fields; inspect the proposal store");
  if (parsed.intent !== undefined && (!object(parsed.intent) || !exactKeys(parsed.intent, ["fingerprint", "beforeSha", "afterSha"]) || !digest(parsed.intent.fingerprint) || (parsed.intent.beforeSha !== null && !digest(parsed.intent.beforeSha)) || (parsed.intent.afterSha !== null && !digest(parsed.intent.afterSha))))
    throw new Error("proposal: stored record has invalid apply intent; inspect the proposal store");
  if (parsed.state === "apply_unknown" && parsed.intent === undefined) throw new Error("proposal: uncertain apply has no recorded intent; inspect the proposal store");
  if (parsed.state === "applied" && parsed.intent === undefined) throw new Error("proposal: applied record has no recorded intent; inspect the proposal store");
  if (parsed.state === "pending" && parsed.intent !== undefined) throw new Error("proposal: pending record has an apply intent; inspect the proposal store");
  if (parsed.state === "rejected" && (typeof parsed.decisionReason !== "string" || !parsed.decisionReason.trim())) throw new Error("proposal: rejected record has no decision reason; inspect the proposal store");
  const operation = parseProposalOperation(parsed.operation);
  if (proposalPayloadDigest(operation) !== parsed.payloadDigest) throw new Error("proposal: stored payload digest differs; inspect the proposal store");
  return { ...parsed, operation } as unknown as ProposalRecord;
}
export function encodeProposalRecord(record: ProposalRecord): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  decodeProposalRecord(bytes);
  return bytes;
}
