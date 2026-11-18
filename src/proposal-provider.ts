/** Internal submission entry point. CLI/MCP and decision operations are intentionally not exposed yet. */
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry } from "./registry.ts";
import { logBinding, matchesBinding } from "./vault-log.ts";
import { applyWrite } from "./writer.ts";
import { screenMetadata } from "./write-validation.ts";
import { checkStoredBinding, createStoredProposal, listStoredProposalIds, readStoredProposal } from "./proposal-storage.ts";
import { encodeProposalRecord, parseProposalOperation, proposalDecisionFingerprint, proposalPayloadDigest, proposalRecordDigest, type ProposalRecord } from "./proposals.ts";
import type { ChangeReceipt, WriteIssue } from "./write-types.ts";
import { unenforceablePii } from "./config.ts";
import { canonicalPath, isDenied } from "./platform.ts";

export interface ProposalSubmitRequest { vault: string; operation: unknown; agentLabel?: string }
export interface ProposalContext { channel: "cli" | "mcp"; env?: NodeJS.ProcessEnv; now?: Date }
export interface ProposalSubmitted { id: string; vault: string; path: string; state: "pending"; createdAt: string; payloadDigest: string }
export interface ProposalSummary { id: string; vault: string; path: string; state: ProposalRecord["state"]; createdAt: string }
export interface ProposalListRequest { vault: string; state?: ProposalRecord["state"]; limit?: number; after?: string }
export interface ProposalPage { items: ProposalSummary[]; nextCursor: string | null }
export interface ProposalShowRequest { vault: string; id: string; offset?: number; maxBytes?: number }
export interface ProposalView { id: string; vault: string; state: ProposalRecord["state"]; path: string; createdAt: string; payloadDigest: string; agentLabelUnverified?: string; decisionReason?: string; content: string; offset: number; nextOffset: number | null; truncated: boolean }
export interface ProposalApplyPreview { id: string; vault: string; state: "pending"; fingerprint: string; changes: ChangeReceipt[]; issues: WriteIssue[] }
const MAX_SHOW_BYTES = 16 * 1024, MAX_RPC_REPLY_BYTES = 48 * 1024;

/** Conservative complete MCP reply size; MCP limits request IDs to 200 UTF-16 units (at most 1200 encoded bytes). */
export function proposalReplyBytes(result: unknown): number {
  const text = JSON.stringify(result);
  return Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: "x".repeat(1200), result: { content: [{ type: "text", text }] } }), "utf8") + 1;
}

function currentBinding(home: string, id: string, channel: ProposalContext["channel"]) {
  if (channel !== "cli" && channel !== "mcp") throw new Error("proposal: invalid write channel; use CLI or MCP");
  const config = loadRegistry(home), vault = config.vaults.find(item => item.id === id);
  if (!vault) throw new Error("proposal: unknown vault; choose a registered vault");
  if (vault.write === "none" || (channel === "mcp" && vault.write !== "mcp")) throw new Error("proposal: vault write policy refuses this channel; choose an authorized vault or channel");
  if (realpathSync(vault.path) !== vault.path || isDenied(vault.path, config.denyPaths ?? [])) throw new Error("proposal: vault root is denied, changed or linked; inspect the registered vault");
  if (unenforceablePii(vault)) throw new Error("proposal: vault PII policy cannot be enforced; inspect the vault policy");
  const homePath = canonicalPath(home);
  if (config.vaults.some(item => homePath === item.path || homePath.startsWith(`${item.path}/`))) throw new Error("proposal: configured home is inside a registered vault; move the home outside vaults");
  const binding = logBinding(vault, config);
  const bindingDigest = createHash("sha256").update(JSON.stringify([vault.id, vault.path, binding.dev, binding.ino]), "utf8").digest("hex");
  return { config, vault, binding, bindingDigest };
}
function screenForRead(record: ProposalRecord, context: ReturnType<typeof currentBinding>): void {
  if (record.vault !== context.vault.id || record.bindingDigest !== context.bindingDigest || isDenied(join(context.vault.path, record.operation.path), context.config.denyPaths ?? []))
    throw new Error("proposal: stored binding or target is denied or changed; inspect the registered vault and policy");
  const issues = screenMetadata({ operation: record.operation, agentLabel: record.agentLabel, decisionReason: record.decisionReason }, { vault: context.vault, config: context.config }, record.operation.path);
  if (issues.some(issue => issue.severity === "error")) throw new Error("proposal: current disclosure policy refuses stored content; inspect the vault policy");
}

/** Screen and validate a proposal before any persistent record is created. */
export function submitProposal(home: string, request: ProposalSubmitRequest, options: ProposalContext): ProposalSubmitted {
  if (!request || typeof request !== "object" || Object.keys(request).some(key => !["vault", "operation", "agentLabel"].includes(key)) || typeof request.vault !== "string")
    throw new Error("proposal: invalid submit request; provide a vault and one operation");
  if (options.channel !== "cli" && options.channel !== "mcp") throw new Error("proposal: invalid write channel; use CLI or MCP");
  if (request.agentLabel !== undefined && (typeof request.agentLabel !== "string" || !request.agentLabel.trim() || Buffer.byteLength(request.agentLabel) > 256 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(request.agentLabel)))
    throw new Error("proposal: agent label must be nonempty text without controls and at most 256 bytes; correct the label");
  const operation = parseProposalOperation(request.operation), { config, vault, binding, bindingDigest } = currentBinding(home, request.vault, options.channel);
  const screen = screenMetadata({ operation, ...(request.agentLabel !== undefined ? { agentLabel: request.agentLabel } : {}) }, { vault, config }, operation.path);
  if (screen.some(issue => issue.severity === "error")) throw new Error(`proposal: payload screening refused (${[...new Set(screen.filter(issue => issue.severity === "error").map(issue => issue.code))].join(", ")}); remove prohibited content or correct the vault policy`);
  const preview = applyWrite(home, { vault: vault.id, operation, channel: options.channel, dryRun: true }, { env: options.env, binding, now: options.now });
  if (!preview.ok) throw new Error(`proposal: validation refused (${[...new Set(preview.issues.filter(issue => issue.severity === "error").map(issue => issue.code))].join(", ") || "unknown"}); correct the proposal and retry`);
  const createdAt = (options.now ?? new Date()).toISOString();
  const record: ProposalRecord = { schemaVersion: 1, id: randomUUID(), vault: vault.id, bindingDigest, state: "pending", createdAt, updatedAt: createdAt, operation, payloadDigest: proposalPayloadDigest(operation), ...(request.agentLabel !== undefined ? { agentLabel: request.agentLabel } : {}) };
  encodeProposalRecord(record);
  if (!matchesBinding(loadRegistry(home), vault.id, binding)) throw new Error("proposal: vault binding or policy changed during submit; request a new preview");
  createStoredProposal(home, record);
  if (!matchesBinding(loadRegistry(home), vault.id, binding)) throw new Error("proposal: record was stored but the vault binding or policy changed; inspect the proposal store and current vault policy");
  return { id: record.id, vault: record.vault, path: operation.path, state: "pending", createdAt, payloadDigest: record.payloadDigest };
}

/** Returns screened summaries, examining at most 512 records per call. The cursor is a record id, never a path. */
export function listProposals(home: string, request: ProposalListRequest, options: ProposalContext): ProposalPage {
  if (!request || typeof request !== "object" || Object.keys(request).some(key => !["vault", "state", "limit", "after"].includes(key)) || typeof request.vault !== "string") throw new Error("proposal: invalid list request; provide a registered vault");
  const limit = request.limit ?? 50, state = request.state ?? "pending";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !["pending", "applied", "rejected", "apply_unknown"].includes(state) || (request.after !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.after)))
    throw new Error("proposal: invalid list state, cursor or limit; use a returned cursor and limit 1..100");
  const context = currentBinding(home, request.vault, options.channel);
  if (!checkStoredBinding(home, context.vault.id, context.bindingDigest)) {
    if (!matchesBinding(loadRegistry(home), context.vault.id, context.binding)) throw new Error("proposal: vault binding or policy changed during listing; retry with the current policy");
    return { items: [], nextCursor: null };
  }
  const ids = listStoredProposalIds(home, context.bindingDigest).filter(id => request.after === undefined || id > request.after);
  const items: ProposalSummary[] = []; let scanned = 0, cursor: string | null = null;
  for (const id of ids) {
    if (scanned >= 512 || items.length >= limit) break;
    const record = readStoredProposal(home, context.bindingDigest, id); scanned++; cursor = id;
    screenForRead(record, context);
    if (record.state !== state) continue;
    items.push({ id: record.id, vault: record.vault, path: record.operation.path, state: record.state, createdAt: record.createdAt });
  }
  if (!matchesBinding(loadRegistry(home), context.vault.id, context.binding)) throw new Error("proposal: vault binding or policy changed during listing; retry with the current policy");
  return { items, nextCursor: scanned < ids.length ? cursor : null };
}

/** Pages the normalized operation as UTF-8 text without splitting a code point or exceeding the encoded MCP reply cap. */
export function showProposal(home: string, request: ProposalShowRequest, options: ProposalContext): ProposalView {
  if (!request || typeof request !== "object" || Object.keys(request).some(key => !["vault", "id", "offset", "maxBytes"].includes(key)) || typeof request.vault !== "string" || typeof request.id !== "string")
    throw new Error("proposal: invalid show request; provide a vault and proposal id");
  const offset = request.offset ?? 0, maxBytes = request.maxBytes ?? MAX_SHOW_BYTES;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SHOW_BYTES)
    throw new Error("proposal: invalid show offset or page size; use a returned offset and maxBytes 1..16384");
  const context = currentBinding(home, request.vault, options.channel);
  if (!checkStoredBinding(home, context.vault.id, context.bindingDigest)) throw new Error("proposal: no proposal store for this vault; use proposal list to find an id");
  const record = readStoredProposal(home, context.bindingDigest, request.id);
  screenForRead(record, context);
  const serialized = JSON.stringify(record.operation), bytes = Buffer.from(serialized, "utf8");
  if (offset > bytes.length || !Buffer.from(bytes.subarray(0, offset).toString("utf8"), "utf8").equals(bytes.subarray(0, offset)))
    throw new Error("proposal: offset is outside the payload or splits a UTF-8 character; use the returned nextOffset");
  const chars = Array.from(bytes.subarray(offset).toString("utf8"));
  const view = (count: number): ProposalView => {
    const content = chars.slice(0, count).join(""), end = offset + Buffer.byteLength(content, "utf8"), more = end < bytes.length;
    return { id: record.id, vault: record.vault, state: record.state, path: record.operation.path, createdAt: record.createdAt, payloadDigest: record.payloadDigest,
      ...(record.agentLabel !== undefined ? { agentLabelUnverified: record.agentLabel } : {}), ...(record.decisionReason !== undefined ? { decisionReason: record.decisionReason } : {}),
      content, offset, nextOffset: more ? end : null, truncated: more };
  };
  let low = 0, high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2), candidate = view(middle);
    if (Buffer.byteLength(candidate.content, "utf8") <= maxBytes && proposalReplyBytes(candidate) <= MAX_RPC_REPLY_BYTES) low = middle;
    else high = middle - 1;
  }
  const result = view(low);
  if (proposalReplyBytes(result) > MAX_RPC_REPLY_BYTES || (low === 0 && chars.length > 0)) throw new Error("proposal: page cannot fit the requested bounds; increase maxBytes or inspect the record");
  if (!matchesBinding(loadRegistry(home), context.vault.id, context.binding)) throw new Error("proposal: vault binding or policy changed during read; retry with the current policy");
  return result;
}

/** Produce a read-only preview whose fingerprint binds the current writer plan and exact record. */
export function previewProposalApply(home: string, request: { vault: string; id: string }, options: ProposalContext): ProposalApplyPreview {
  if (!request || typeof request !== "object" || Object.keys(request).some(key => !["vault", "id"].includes(key)) || typeof request.vault !== "string" || typeof request.id !== "string")
    throw new Error("proposal: invalid apply preview request; provide a vault and proposal id");
  const context = currentBinding(home, request.vault, options.channel);
  if (!checkStoredBinding(home, context.vault.id, context.bindingDigest)) throw new Error("proposal: no proposal store for this vault; use proposal list to find an id");
  const record = readStoredProposal(home, context.bindingDigest, request.id);
  screenForRead(record, context);
  if (record.state !== "pending") throw new Error(`proposal: ${record.state === "apply_unknown" ? "apply outcome is unknown; reconcile before another decision" : "proposal is no longer pending; inspect the proposal"}`);
  const recordDigest = proposalRecordDigest(record);
  const preview = applyWrite(home, { vault: record.vault, operation: record.operation, channel: options.channel, dryRun: true }, { binding: context.binding, env: options.env, now: options.now });
  if (!preview.ok || !preview.fingerprint) throw new Error(`proposal: apply preview refused (${[...new Set(preview.issues.filter(issue => issue.severity === "error").map(issue => issue.code))].join(", ") || "unknown"}); correct the vault or proposal and retry`);
  if (preview.changes.length !== 1) throw new Error("proposal: apply preview is not a single note change; inspect the proposal");
  if (!matchesBinding(loadRegistry(home), context.vault.id, context.binding) || proposalRecordDigest(readStoredProposal(home, context.bindingDigest, record.id)) !== recordDigest)
    throw new Error("proposal: record, vault binding or policy changed during preview; request a new preview");
  return { id: record.id, vault: record.vault, state: "pending", fingerprint: proposalDecisionFingerprint(recordDigest, preview.fingerprint, "apply"), changes: preview.changes, issues: preview.issues };
}
