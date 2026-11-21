/** Proposal payload and durable record contracts. */
import { createHash } from "node:crypto";
import { notePath } from "./write-operations.ts";
import type { PatchEdit, WriteOp } from "./write-types.ts";

export const MAX_PROPOSAL_RECORD_BYTES = 32 * 1024;
export const MAX_PROPOSAL_RPC_BYTES = 48 * 1024;
export const MAX_PROPOSAL_EDITS = 32;
export type ProposalOperation = Extract<WriteOp, { op: "create" | "patch" | "infer-link" }>;

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
/** Create, exact-replacement patch and inferred-link proposals have one canonical flat note target. */
export function parseProposalOperation(value: unknown): ProposalOperation {
  if (!object(value) || typeof value.path !== "string") throw new Error("proposal: operation or note target is missing; supply a create, patch or infer-link operation with a path");
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
  if (value.op === "infer-link") {
    if (!exactKeys(value, ["op", "path", "target", "expectedSha"]) || typeof value.target !== "string" || typeof value.expectedSha !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedSha)) throw new Error("proposal: infer-link requires a target and base SHA; select a target and reread the source for its current SHA-256");
    const target = notePath(value.target).slice(6, -3);
    if (path === `notes/${target}.md`) throw new Error("proposal: infer-link endpoints must differ; select another target note");
    return { op: "infer-link", path, target, expectedSha: value.expectedSha };
  }
  throw new Error("proposal: unsupported operation; choose create, patch or infer-link");
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
  decisionReasonRef?: string;
  intent?: { fingerprint: string; beforeSha: string | null; afterSha: string | null };
  receipt?: { applied: true; logged: boolean | null; beforeSha: string | null; afterSha: string | null };
}
/** Written by the locked writer after an apply attempt; it is never accepted from a caller. */
export interface ProposalExecutionEvidence {
  schemaVersion: 1; id: string; bindingDigest: string; fingerprint: string;
  beforeSha: string | null; afterSha: string | null; applied: boolean; publicationStarted: boolean; logged: boolean | null;
}
export interface ProposalReason { schemaVersion: 1; id: string; bindingDigest: string; digest: string; reason: string }

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
  if (!object(parsed) || !exactKeys(parsed, ["schemaVersion", "id", "vault", "bindingDigest", "state", "createdAt", "updatedAt", "operation", "payloadDigest", "agentLabel", "decisionReason", "decisionReasonRef", "intent", "receipt"]) || parsed.schemaVersion !== 1 || typeof parsed.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed.id) || typeof parsed.vault !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(parsed.vault) || !digest(parsed.bindingDigest) || !["pending", "applied", "rejected", "apply_unknown"].includes(String(parsed.state)) || !date(parsed.createdAt) || !date(parsed.updatedAt) || !digest(parsed.payloadDigest))
    throw new Error("proposal: stored record has invalid metadata; inspect the proposal store");
  if ((parsed.agentLabel !== undefined && (typeof parsed.agentLabel !== "string" || Buffer.byteLength(parsed.agentLabel) > 256)) || (parsed.decisionReason !== undefined && (typeof parsed.decisionReason !== "string" || !parsed.decisionReason.isWellFormed() || Buffer.byteLength(parsed.decisionReason) > 4096)))
    throw new Error("proposal: stored record has invalid optional fields; inspect the proposal store");
  if (parsed.decisionReasonRef !== undefined && !digest(parsed.decisionReasonRef)) throw new Error("proposal: stored reason reference is invalid; inspect the proposal store");
  if (parsed.intent !== undefined && (!object(parsed.intent) || !exactKeys(parsed.intent, ["fingerprint", "beforeSha", "afterSha"]) || !digest(parsed.intent.fingerprint) || (parsed.intent.beforeSha !== null && !digest(parsed.intent.beforeSha)) || (parsed.intent.afterSha !== null && !digest(parsed.intent.afterSha))))
    throw new Error("proposal: stored record has invalid apply intent; inspect the proposal store");
  if (parsed.state === "apply_unknown" && parsed.intent === undefined) throw new Error("proposal: uncertain apply has no recorded intent; inspect the proposal store");
  if (parsed.state === "applied" && parsed.intent === undefined) throw new Error("proposal: applied record has no recorded intent; inspect the proposal store");
  if (parsed.receipt !== undefined && (!object(parsed.receipt) || !exactKeys(parsed.receipt, ["applied", "logged", "beforeSha", "afterSha"]) || parsed.receipt.applied !== true || (typeof parsed.receipt.logged !== "boolean" && parsed.receipt.logged !== null) || (parsed.receipt.beforeSha !== null && !digest(parsed.receipt.beforeSha)) || (parsed.receipt.afterSha !== null && !digest(parsed.receipt.afterSha))))
    throw new Error("proposal: stored receipt is invalid; inspect the proposal store");
  if (parsed.state === "applied" && parsed.receipt === undefined) throw new Error("proposal: applied record has no durable receipt; inspect the proposal store");
  if (parsed.receipt !== undefined && (!object(parsed.receipt) || parsed.state !== "applied" || !object(parsed.intent) || parsed.receipt.beforeSha !== parsed.intent.beforeSha || parsed.receipt.afterSha !== parsed.intent.afterSha))
    throw new Error("proposal: stored receipt does not match its apply intent; inspect the proposal store");
  if (parsed.state === "pending" && parsed.intent !== undefined) throw new Error("proposal: pending record has an apply intent; inspect the proposal store");
  if (parsed.state === "rejected" && ((typeof parsed.decisionReason !== "string" || !parsed.decisionReason.trim()) === (parsed.decisionReasonRef === undefined))) throw new Error("proposal: rejected record must have exactly one reason or reason reference; inspect the proposal store");
  if (parsed.state !== "rejected" && (parsed.decisionReason !== undefined || parsed.decisionReasonRef !== undefined)) throw new Error("proposal: non-rejected record has a rejection reason; inspect the proposal store");
  const operation = parseProposalOperation(parsed.operation);
  if (proposalPayloadDigest(operation) !== parsed.payloadDigest) throw new Error("proposal: stored payload digest differs; inspect the proposal store");
  return { ...parsed, operation } as unknown as ProposalRecord;
}
export function encodeProposalRecord(record: ProposalRecord): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  decodeProposalRecord(bytes);
  return bytes;
}
/** Digest the complete canonical record so decisions can bind both payload and state. */
export function proposalRecordDigest(record: ProposalRecord): string {
  return createHash("sha256").update(encodeProposalRecord(record)).digest("hex");
}
export function encodeProposalEvidence(value: ProposalExecutionEvidence): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  decodeProposalEvidence(bytes);
  return bytes;
}
export function decodeProposalEvidence(bytes: Uint8Array): ProposalExecutionEvidence {
  if (bytes.byteLength > 4096) throw new Error("proposal: execution evidence exceeds its bound; inspect the proposal store");
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) throw new Error("proposal: execution evidence is not UTF-8; inspect the proposal store");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("proposal: execution evidence is not JSON; inspect the proposal store"); }
  if (!object(value) || JSON.stringify(value) !== text || !exactKeys(value, ["schemaVersion", "id", "bindingDigest", "fingerprint", "beforeSha", "afterSha", "applied", "publicationStarted", "logged"]) || value.schemaVersion !== 1 || typeof value.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id) || !digest(value.bindingDigest) || !digest(value.fingerprint) || (value.beforeSha !== null && !digest(value.beforeSha)) || (value.afterSha !== null && !digest(value.afterSha)) || typeof value.applied !== "boolean" || typeof value.publicationStarted !== "boolean" || (value.logged !== null && typeof value.logged !== "boolean") || (value.applied && !value.publicationStarted))
    throw new Error("proposal: execution evidence has invalid fields; inspect the proposal store");
  return value as unknown as ProposalExecutionEvidence;
}
export function proposalEvidenceDigest(value: ProposalExecutionEvidence): string { return createHash("sha256").update(encodeProposalEvidence(value)).digest("hex"); }
export function proposalReasonDigest(reason: string): string { return createHash("sha256").update(reason, "utf8").digest("hex"); }
export function encodeProposalReason(value: ProposalReason): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(value), "utf8"); decodeProposalReason(bytes); return bytes;
}
export function decodeProposalReason(bytes: Uint8Array): ProposalReason {
  if (bytes.byteLength > MAX_PROPOSAL_RECORD_BYTES) throw new Error("proposal: rejection reason record exceeds its bound; inspect the proposal store");
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) throw new Error("proposal: rejection reason record is not UTF-8; inspect the proposal store");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("proposal: rejection reason record is not JSON; inspect the proposal store"); }
  if (!object(value) || JSON.stringify(value) !== text || !exactKeys(value, ["schemaVersion", "id", "bindingDigest", "digest", "reason"]) || value.schemaVersion !== 1 || typeof value.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id) || !digest(value.bindingDigest) || !digest(value.digest) || typeof value.reason !== "string" || !value.reason.trim() || !value.reason.isWellFormed() || Buffer.byteLength(value.reason, "utf8") > 4096 || proposalReasonDigest(value.reason) !== value.digest)
    throw new Error("proposal: rejection reason record is invalid; inspect the proposal store");
  return value as unknown as ProposalReason;
}
/** Keep a near-limit proposal rejectable without making its primary record exceed 32 KiB. */
export function prepareRejectedProposal(record: ProposalRecord, reason: string, updatedAt: string): { record: ProposalRecord; reasonRecord?: ProposalReason } {
  if (!reason.trim() || !reason.isWellFormed() || Buffer.byteLength(reason, "utf8") > 4096) throw new Error("proposal: rejection requires a well-formed nonempty reason of at most 4096 bytes; provide a reason and preview again");
  const inline: ProposalRecord = { ...record, state: "rejected", updatedAt, decisionReason: reason };
  if (Buffer.byteLength(JSON.stringify(inline), "utf8") <= MAX_PROPOSAL_RECORD_BYTES) { encodeProposalRecord(inline); return { record: inline }; }
  const ref = proposalReasonDigest(reason), compact: ProposalRecord = { ...record, state: "rejected", updatedAt, decisionReasonRef: ref };
  const reasonRecord: ProposalReason = { schemaVersion: 1, id: record.id, bindingDigest: record.bindingDigest, digest: ref, reason };
  encodeProposalRecord(compact); encodeProposalReason(reasonRecord);
  return { record: compact, reasonRecord };
}
export function proposalReconcileFingerprint(recordDigest: string, evidenceDigest: string, plan: string, state: "pending" | "applied"): string {
  if (!digest(recordDigest) || !digest(evidenceDigest) || !digest(plan) || (state !== "pending" && state !== "applied")) throw new Error("proposal: invalid reconciliation inputs; request a new preview");
  return createHash("sha256").update(JSON.stringify(["vmem-proposal-reconcile", 1, recordDigest, evidenceDigest, plan, state]), "utf8").digest("hex");
}
/** Bind the exact prior record and writer plan, including the rejection reason when present. */
export function proposalDecisionFingerprint(recordDigest: string, writerFingerprint: string, decision: "apply" | "reject", reason?: string): string {
  if (!digest(recordDigest) || !digest(writerFingerprint) || (decision !== "apply" && decision !== "reject")) throw new Error("proposal: invalid decision inputs; request a new preview");
  if (decision === "reject" && (typeof reason !== "string" || !reason.trim() || Buffer.byteLength(reason, "utf8") > 4096))
    throw new Error("proposal: rejection needs a nonempty reason of at most 4096 bytes; provide a reason and preview again");
  if (decision === "apply" && reason !== undefined) throw new Error("proposal: an apply decision cannot carry a rejection reason; request a new preview");
  return createHash("sha256").update(JSON.stringify(["vmem-proposal-decision", 1, decision, recordDigest, writerFingerprint, reason ?? null]), "utf8").digest("hex");
}
