/** Internal submission entry point. CLI/MCP and decision operations are intentionally not exposed yet. */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { closeSync, constants, fsyncSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { loadRegistry, LOCK_FILE } from "./registry.ts";
import { logBinding, matchesBinding } from "./vault-log.ts";
import { applyProposalWrite, applyWrite, proposalRejectionPlan, proposalTargetDigest, rejectProposalWrite, type ProposalRejectReceipt } from "./writer.ts";
import { screenMetadata } from "./write-validation.ts";
import { checkStoredBinding, createStoredProposal, listStoredProposalIds, readStoredProposal, replaceStoredProposal } from "./proposal-storage.ts";
import { encodeProposalRecord, MAX_PROPOSAL_RECORD_BYTES, parseProposalOperation, proposalDecisionFingerprint, proposalPayloadDigest, proposalRecordDigest, type ProposalRecord } from "./proposals.ts";
import type { ChangeReceipt, WriteIssue, WriteReceipt } from "./write-types.ts";
import type { LogBinding } from "./log-types.ts";
import { unenforceablePii, type VaultSpec } from "./config.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { cleanupOwnedFile } from "./write-files.ts";

export interface ProposalSubmitRequest { vault: string; operation: unknown; agentLabel?: string }
export interface ProposalContext { channel: "cli" | "mcp"; env?: NodeJS.ProcessEnv; now?: Date; expectedVault?: VaultSpec; expectedBinding?: LogBinding | null }
export interface ProposalSubmitted { ok: boolean; stored: true | null; id: string; vault: string; path: string | null; state: "pending" | null; createdAt: string; payloadDigest: string | null; issues: WriteIssue[] }
export interface ProposalSummary { id: string; vault: string; path: string; state: ProposalRecord["state"]; createdAt: string }
export interface ProposalListRequest { vault: string; state?: ProposalRecord["state"]; limit?: number; after?: string }
export interface ProposalPage { items: ProposalSummary[]; nextCursor: string | null }
export interface ProposalShowRequest { vault: string; id: string; offset?: number; maxBytes?: number }
export interface ProposalView { id: string; vault: string; state: ProposalRecord["state"]; path: string; createdAt: string; payloadDigest: string; agentLabelUnverified?: string; decisionReason?: string; content: string; offset: number; nextOffset: number | null; truncated: boolean }
export interface ProposalApplyPreview { id: string; vault: string; state: "pending"; fingerprint: string; changes: ChangeReceipt[]; issues: WriteIssue[] }
export interface ProposalApplyResult { ok: boolean; applied: boolean; state: "pending" | "applied" | "apply_unknown"; logged: boolean | null; issues: WriteIssue[] }
export interface ProposalReconciliation { id: string; vault: string; state: "apply_unknown"; beforeSha: string | null; afterSha: string | null; observedSha: string | null; matchesBefore: boolean; matchesAfter: boolean; receiptEvidence: "unavailable"; explanation: string }
export interface ProposalRejectPreview { id: string; vault: string; state: "pending"; reason: string; fingerprint: string }
const MAX_SHOW_BYTES = 16 * 1024, MAX_RPC_REPLY_BYTES = 48 * 1024;

/** Conservative complete MCP reply size; MCP limits request IDs to 200 UTF-16 units (at most 1200 encoded bytes). */
export function proposalReplyBytes(result: unknown): number {
  const text = JSON.stringify(result);
  return Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: "x".repeat(1200), result: { content: [{ type: "text", text }] } }), "utf8") + 1;
}

function currentBinding(home: string, id: string, options: ProposalContext) {
  const channel = options.channel;
  if (channel !== "cli" && channel !== "mcp") throw new Error("proposal: invalid write channel; use CLI or MCP");
  const config = loadRegistry(home), vault = config.vaults.find(item => item.id === id);
  if (!vault) throw new Error("proposal: unknown vault; choose a registered vault");
  if (options.expectedVault && !isDeepStrictEqual(vault, options.expectedVault)) throw new Error("proposal: vault registration changed since MCP startup; restart the MCP server");
  if (options.expectedBinding === null || (options.expectedBinding && !matchesBinding(config, id, options.expectedBinding))) throw new Error("proposal: vault identity or policy changed since MCP startup; restart the MCP server");
  if (vault.write === "none" || (channel === "mcp" && vault.write !== "mcp")) throw new Error("proposal: vault write policy refuses this channel; choose an authorized vault or channel");
  let root: string;
  try { root = realpathSync(vault.path); } catch { throw new Error("proposal: vault root is unavailable; inspect the registered vault"); }
  if (root !== vault.path || isDenied(vault.path, config.denyPaths ?? [])) throw new Error("proposal: vault root is denied, changed or linked; inspect the registered vault");
  if (unenforceablePii(vault)) throw new Error("proposal: vault PII policy cannot be enforced; inspect the vault policy");
  const homePath = canonicalPath(home);
  if (isDenied(homePath, config.denyPaths ?? []) || isDenied(join(homePath, "proposals"), config.denyPaths ?? [])) throw new Error("proposal: configured proposal storage is denied; inspect the configured deny paths");
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
function bindingStillCurrent(home: string, context: ReturnType<typeof currentBinding>): boolean {
  try { return matchesBinding(loadRegistry(home), context.vault.id, context.binding); } catch { return false; }
}
/** Recheck policy under the registry lock before touching a post-publication proposal record. */
function finishProposalApply(home: string, context: ReturnType<typeof currentBinding>, record: ProposalRecord, fingerprint: string, receipt: WriteReceipt, now?: Date): ProposalApplyResult {
  const logged = receipt.logged === true ? true : receipt.logged === false ? false : null;
  const uncertain = (message: string): ProposalApplyResult => ({ ok: false, applied: receipt.applied, state: "apply_unknown", logged, issues: [{ code: "PROPOSAL_RECEIPT", severity: "error", message }] });
  const lock = join(home, LOCK_FILE);
  if (isDenied(lock, context.config.denyPaths ?? [])) return uncertain("proposal registry lock path is denied; inspect the proposal and current policy before retrying");
  let fd: number;
  try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { return uncertain("proposal registry lock is unavailable after the write; inspect and reconcile the proposal before retrying"); }
  let result = uncertain("proposal finalization failed; inspect and reconcile the proposal before retrying");
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), created: new Date().toISOString() }) + "\n"); fsyncSync(fd);
    if (!bindingStillCurrent(home, context)) result = uncertain("vault binding or policy changed after the write; inspect the proposal before retrying");
    else if (receipt.applied) {
      try {
        const current = readStoredProposal(home, context.bindingDigest, record.id, context.config.denyPaths ?? []), change = receipt.changes.find(item => item.path === record.operation.path);
        if (current.state !== "apply_unknown" || current.intent?.fingerprint !== fingerprint || !change || current.intent.beforeSha !== change.beforeSha || current.intent.afterSha !== change.sha256) throw new Error("intent or receipt does not match");
        replaceStoredProposal(home, context.bindingDigest, record.id, proposalRecordDigest(current), { ...current, state: "applied", updatedAt: (now ?? new Date()).toISOString(), receipt: { applied: true, logged, beforeSha: change.beforeSha, afterSha: change.sha256 } }, context.config.denyPaths ?? []);
        result = { ok: receipt.ok && logged !== false, applied: true, state: "applied", logged, issues: [...receipt.issues, ...(receipt.log?.issues ?? [])] };
      } catch {
        let recorded = false;
        try {
          const current = readStoredProposal(home, context.bindingDigest, record.id, context.config.denyPaths ?? []), change = receipt.changes.find(item => item.path === record.operation.path);
          recorded = current.state === "applied" && current.intent?.fingerprint === fingerprint && current.receipt?.applied === true && !!change && current.receipt.beforeSha === change.beforeSha && current.receipt.afterSha === change.sha256;
        } catch { /* An unreadable record cannot establish that the receipt was saved. */ }
        result = { ...uncertain(recorded ? "note and proposal receipt were recorded but finalization failed; inspect the proposal store before retrying" : "note was applied but proposal receipt could not be recorded; inspect and reconcile the proposal before retrying"), state: recorded ? "applied" : "apply_unknown" };
      }
    } else {
      let state: "pending" | "applied" | "apply_unknown" = "apply_unknown";
      try {
        const current = readStoredProposal(home, context.bindingDigest, record.id, context.config.denyPaths ?? []);
        if (current.state === "pending" || current.state === "applied") state = current.state;
      } catch { /* Failure to read the state cannot prove that publication did not start. */ }
      result = { ok: false, applied: false, state, logged, issues: receipt.issues };
    }
  } catch { /* Keep the conservative unknown receipt. */ }
  finally {
    try { cleanupOwnedFile(lock, fd); } catch { result.ok = false; result.issues.push({ code: "CLEANUP", severity: "error", message: "proposal registry lock cleanup failed after the write; inspect the lock before retrying" }); }
    finally { try { closeSync(fd); } catch { result.ok = false; result.issues.push({ code: "CLEANUP", severity: "error", message: "proposal registry lock descriptor close failed; inspect the lock before retrying" }); } }
  }
  if (!bindingStillCurrent(home, context)) return { ok: false, applied: receipt.applied, state: result.state === "applied" ? "applied" : "apply_unknown", logged, issues: [{ code: "VAULT_DRIFT", severity: "error", message: "vault binding or policy changed after the write; inspect the registered vault and proposal" }] };
  return result;
}

/** Screen and validate a proposal before any persistent record is created. */
export function submitProposal(home: string, request: ProposalSubmitRequest, options: ProposalContext): ProposalSubmitted {
  if (!request || typeof request !== "object" || Object.keys(request).some(key => !["vault", "operation", "agentLabel"].includes(key)) || typeof request.vault !== "string")
    throw new Error("proposal: invalid submit request; provide a vault and one operation");
  if (options.channel !== "cli" && options.channel !== "mcp") throw new Error("proposal: invalid write channel; use CLI or MCP");
  if (request.agentLabel !== undefined && (typeof request.agentLabel !== "string" || !request.agentLabel.trim() || Buffer.byteLength(request.agentLabel) > 256 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(request.agentLabel)))
    throw new Error("proposal: agent label must be nonempty text without controls and at most 256 bytes; correct the label");
  const operation = parseProposalOperation(request.operation), { config, vault, binding, bindingDigest } = currentBinding(home, request.vault, options);
  const screen = screenMetadata({ operation, ...(request.agentLabel !== undefined ? { agentLabel: request.agentLabel } : {}) }, { vault, config }, operation.path);
  if (screen.some(issue => issue.severity === "error")) throw new Error(`proposal: payload screening refused (${[...new Set(screen.filter(issue => issue.severity === "error").map(issue => issue.code))].join(", ")}); remove prohibited content or correct the vault policy`);
  const preview = applyWrite(home, { vault: vault.id, operation, channel: options.channel, dryRun: true }, { env: options.env, binding, now: options.now });
  if (!preview.ok) throw new Error(`proposal: validation refused (${[...new Set(preview.issues.filter(issue => issue.severity === "error").map(issue => issue.code))].join(", ") || "unknown"}); correct the proposal and retry`);
  const createdAt = (options.now ?? new Date()).toISOString();
  const record: ProposalRecord = { schemaVersion: 1, id: randomUUID(), vault: vault.id, bindingDigest, state: "pending", createdAt, updatedAt: createdAt, operation, payloadDigest: proposalPayloadDigest(operation), ...(request.agentLabel !== undefined ? { agentLabel: request.agentLabel } : {}) };
  encodeProposalRecord(record);
  const placeholder = "0".repeat(64);
  encodeProposalRecord({ ...record, state: "applied", intent: { fingerprint: placeholder, beforeSha: placeholder, afterSha: placeholder }, receipt: { applied: true, logged: false, beforeSha: placeholder, afterSha: placeholder } });
  const lock = join(home, LOCK_FILE);
  if (isDenied(lock, config.denyPaths ?? [])) throw new Error("proposal: registry lock path is denied; inspect the configured deny paths");
  let fd: number;
  try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw new Error("proposal: registry lock is unavailable; stop concurrent registry updates and inspect the lock"); }
  let attempted = false, stored = false, primary: unknown;
  const issues: WriteIssue[] = [];
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), created: new Date().toISOString() }) + "\n"); fsyncSync(fd);
    if (!matchesBinding(loadRegistry(home), vault.id, binding)) throw new Error("proposal: vault binding or policy changed during submit; request a new preview");
    checkStoredBinding(home, vault.id, bindingDigest, config.denyPaths ?? []);
    attempted = true;
    try { createStoredProposal(home, record, config.denyPaths ?? []); stored = true; }
    catch (error) {
      try { stored = proposalRecordDigest(readStoredProposal(home, bindingDigest, record.id, config.denyPaths ?? [])) === proposalRecordDigest(record); } catch { /* An unreadable record cannot prove whether publication occurred. */ }
      primary = error;
    }
    if (stored && !matchesBinding(loadRegistry(home), vault.id, binding)) issues.push({ code: "VAULT_DRIFT", severity: "error", message: "proposal was stored but the vault binding or policy changed; inspect the proposal store and current policy" });
  } catch (error) { primary = error; }
  finally {
    try { cleanupOwnedFile(lock, fd); } catch { issues.push({ code: "CLEANUP", severity: "error", message: "proposal registry lock cleanup failed; inspect the lock before retrying" }); }
    finally { try { closeSync(fd); } catch { issues.push({ code: "CLEANUP", severity: "error", message: "proposal registry lock descriptor close failed; inspect the lock before retrying" }); } }
  }
  if (!attempted && primary) throw primary;
  if (primary) issues.push({ code: "PROPOSAL_STORE", severity: "error", message: stored ? "proposal was stored but store finalization failed; inspect it before retrying" : "proposal storage outcome is unknown; inspect the proposal store before retrying" });
  let current = false;
  try { current = matchesBinding(loadRegistry(home), vault.id, binding); } catch { /* Unavailable policy cannot authorize disclosure. */ }
  if (!current) issues.push({ code: "VAULT_DRIFT", severity: "error", message: "vault binding or policy changed during submission; inspect the registered vault and proposal store" });
  return { ok: stored && issues.length === 0, stored: stored ? true : null, id: record.id, vault: record.vault, path: current ? operation.path : null, state: stored ? "pending" : null, createdAt, payloadDigest: current ? record.payloadDigest : null, issues };
}

/** Returns screened summaries, examining at most 512 records per call. The cursor is a record id, never a path. */
export function listProposals(home: string, request: ProposalListRequest, options: ProposalContext): ProposalPage {
  if (!request || typeof request !== "object" || Object.keys(request).some(key => !["vault", "state", "limit", "after"].includes(key)) || typeof request.vault !== "string") throw new Error("proposal: invalid list request; provide a registered vault");
  const limit = request.limit ?? 50, state = request.state ?? "pending";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !["pending", "applied", "rejected", "apply_unknown"].includes(state) || (request.after !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.after)))
    throw new Error("proposal: invalid list state, cursor or limit; use a returned cursor and limit 1..100");
  const context = currentBinding(home, request.vault, options);
  if (!checkStoredBinding(home, context.vault.id, context.bindingDigest, context.config.denyPaths ?? [])) {
    if (!matchesBinding(loadRegistry(home), context.vault.id, context.binding)) throw new Error("proposal: vault binding or policy changed during listing; retry with the current policy");
    return { items: [], nextCursor: null };
  }
  const ids = listStoredProposalIds(home, context.bindingDigest, context.config.denyPaths ?? []).filter(id => request.after === undefined || id > request.after);
  const items: ProposalSummary[] = []; let scanned = 0, cursor: string | null = null;
  for (const id of ids) {
    if (scanned >= 512 || items.length >= limit) break;
    const record = readStoredProposal(home, context.bindingDigest, id, context.config.denyPaths ?? []); scanned++; cursor = id;
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
  const context = currentBinding(home, request.vault, options);
  if (!checkStoredBinding(home, context.vault.id, context.bindingDigest, context.config.denyPaths ?? [])) throw new Error("proposal: no proposal store for this vault; use proposal list to find an id");
  const record = readStoredProposal(home, context.bindingDigest, request.id, context.config.denyPaths ?? []);
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
  const context = currentBinding(home, request.vault, options);
  if (!checkStoredBinding(home, context.vault.id, context.bindingDigest, context.config.denyPaths ?? [])) throw new Error("proposal: no proposal store for this vault; use proposal list to find an id");
  const record = readStoredProposal(home, context.bindingDigest, request.id, context.config.denyPaths ?? []);
  screenForRead(record, context);
  if (record.state !== "pending") throw new Error(`proposal: ${record.state === "apply_unknown" ? "apply outcome is unknown; reconcile before another decision" : "proposal is no longer pending; inspect the proposal"}`);
  const recordDigest = proposalRecordDigest(record);
  const preview = applyWrite(home, { vault: record.vault, operation: record.operation, channel: options.channel, dryRun: true }, { binding: context.binding, env: options.env, now: options.now });
  if (!preview.ok || !preview.fingerprint) throw new Error(`proposal: apply preview refused (${[...new Set(preview.issues.filter(issue => issue.severity === "error").map(issue => issue.code))].join(", ") || "unknown"}); correct the vault or proposal and retry`);
  if (preview.changes.length !== 1) throw new Error("proposal: apply preview is not a single note change; inspect the proposal");
  if (!matchesBinding(loadRegistry(home), context.vault.id, context.binding) || proposalRecordDigest(readStoredProposal(home, context.bindingDigest, record.id, context.config.denyPaths ?? [])) !== recordDigest)
    throw new Error("proposal: record, vault binding or policy changed during preview; request a new preview");
  return { id: record.id, vault: record.vault, state: "pending", fingerprint: proposalDecisionFingerprint(recordDigest, preview.fingerprint, "apply"), changes: preview.changes, issues: preview.issues };
}

/** Preview a rejection without changing the proposal, notes, graph or log. */
export function previewProposalReject(home: string, request: { vault: string; id: string; reason: string }, options: ProposalContext): ProposalRejectPreview {
  if (!request || typeof request !== "object" || Object.keys(request).some(key => !["vault", "id", "reason"].includes(key)) || typeof request.vault !== "string" || typeof request.id !== "string" || typeof request.reason !== "string" || !request.reason.trim() || Buffer.byteLength(request.reason, "utf8") > 4096)
    throw new Error("proposal: rejection requires a nonempty reason of at most 4096 bytes; provide a reason and preview again");
  const context = currentBinding(home, request.vault, options);
  if (!checkStoredBinding(home, context.vault.id, context.bindingDigest, context.config.denyPaths ?? [])) throw new Error("proposal: no proposal store for this vault; use proposal list to find an id");
  const record = readStoredProposal(home, context.bindingDigest, request.id, context.config.denyPaths ?? []);
  screenForRead(record, context);
  if (record.state !== "pending") throw new Error(`proposal: ${record.state === "apply_unknown" ? "apply outcome is unknown; reconcile before another decision" : "proposal is no longer pending; inspect the proposal"}`);
  if (screenMetadata({ reason: request.reason }, { vault: context.vault, config: context.config }, record.operation.path).some(issue => issue.severity === "error"))
    throw new Error("proposal: current policy refuses the rejection reason; remove prohibited content or inspect the vault policy");
  const rejected: ProposalRecord = { ...record, state: "rejected", decisionReason: request.reason, updatedAt: (options.now ?? new Date()).toISOString() };
  if (Buffer.byteLength(JSON.stringify(rejected), "utf8") > MAX_PROPOSAL_RECORD_BYTES) throw new Error("proposal: rejection would exceed the 32 KiB record bound; shorten the reason and preview again");
  encodeProposalRecord(rejected);
  const recordDigest = proposalRecordDigest(record), plan = proposalRejectionPlan(home, record.vault, options.channel, context.binding);
  if (!bindingStillCurrent(home, context) || proposalRecordDigest(readStoredProposal(home, context.bindingDigest, record.id, context.config.denyPaths ?? [])) !== recordDigest)
    throw new Error("proposal: record, vault binding or policy changed during preview; request a new preview");
  return { id: record.id, vault: record.vault, state: "pending", reason: request.reason, fingerprint: proposalDecisionFingerprint(recordDigest, plan, "reject", request.reason) };
}

/** Confirm a rejection using a freshly recomputed plan while holding the vault's mutation lock. */
export function rejectProposal(home: string, request: { vault: string; id: string; reason: string; fingerprint: string }, options: ProposalContext): ProposalRejectReceipt {
  if (!request || typeof request !== "object" || Object.keys(request).some(key => !["vault", "id", "reason", "fingerprint"].includes(key)) || typeof request.vault !== "string" || typeof request.id !== "string" || typeof request.reason !== "string" || !request.reason.trim() || Buffer.byteLength(request.reason, "utf8") > 4096 || typeof request.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(request.fingerprint))
    throw new Error("proposal: invalid rejection confirmation; use the reason and fingerprint from a fresh preview");
  const context = currentBinding(home, request.vault, options);
  if (!checkStoredBinding(home, context.vault.id, context.bindingDigest, context.config.denyPaths ?? [])) throw new Error("proposal: no proposal store for this vault; use proposal list to find an id");
  const record = readStoredProposal(home, context.bindingDigest, request.id, context.config.denyPaths ?? []);
  screenForRead(record, context);
  if (record.state !== "pending") throw new Error(`proposal: ${record.state === "apply_unknown" ? "apply outcome is unknown; reconcile before another decision" : "proposal is no longer pending; inspect the proposal"}`);
  const result = rejectProposalWrite(home, record.vault, options.channel, context.binding, { id: record.id, bindingDigest: context.bindingDigest, recordDigest: proposalRecordDigest(record), fingerprint: request.fingerprint, reason: request.reason }, options.now);
  if (!bindingStillCurrent(home, context)) return { ok: false, rejected: result.rejected, issues: [{ code: "VAULT_DRIFT", severity: "error", message: `vault binding or policy changed${result.rejected ? " after rejection was recorded" : ""}; inspect the registered vault and proposal` }] };
  return result;
}

/** Confirm through the existing writer; an applied note remains applied even if logging or receipt persistence fails. */
export function applyProposal(home: string, request: { vault: string; id: string; fingerprint: string }, options: ProposalContext): ProposalApplyResult {
  if (!request || typeof request !== "object" || Object.keys(request).some(key => !["vault", "id", "fingerprint"].includes(key)) || typeof request.vault !== "string" || typeof request.id !== "string" || typeof request.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(request.fingerprint))
    throw new Error("proposal: invalid apply confirmation; use the fingerprint returned by a fresh preview");
  const context = currentBinding(home, request.vault, options);
  if (!checkStoredBinding(home, context.vault.id, context.bindingDigest, context.config.denyPaths ?? [])) throw new Error("proposal: no proposal store for this vault; use proposal list to find an id");
  const record = readStoredProposal(home, context.bindingDigest, request.id, context.config.denyPaths ?? []);
  screenForRead(record, context);
  if (record.state !== "pending") throw new Error(`proposal: ${record.state === "apply_unknown" ? "apply outcome is unknown; reconcile before another decision" : "proposal is no longer pending; inspect the proposal"}`);
  const receipt = applyProposalWrite(home, { vault: record.vault, operation: record.operation, channel: options.channel }, {
    binding: context.binding, env: options.env, now: options.now,
    proposal: { id: record.id, bindingDigest: context.bindingDigest, recordDigest: proposalRecordDigest(record), fingerprint: request.fingerprint },
  });
  return finishProposalApply(home, context, record, request.fingerprint, receipt, options.now);
}

/** Compare recorded intent to the current target without inferring attribution or changing state. */
export function reconcileProposal(home: string, request: { vault: string; id: string }, options: ProposalContext): ProposalReconciliation {
  if (!request || typeof request !== "object" || Object.keys(request).some(key => !["vault", "id"].includes(key)) || typeof request.vault !== "string" || typeof request.id !== "string")
    throw new Error("proposal: invalid reconciliation request; provide a vault and proposal id");
  const context = currentBinding(home, request.vault, options);
  if (!checkStoredBinding(home, context.vault.id, context.bindingDigest, context.config.denyPaths ?? [])) throw new Error("proposal: no proposal store for this vault; use proposal list to find an id");
  const record = readStoredProposal(home, context.bindingDigest, request.id, context.config.denyPaths ?? []);
  screenForRead(record, context);
  if (record.state !== "apply_unknown" || !record.intent) throw new Error("proposal: reconciliation needs an uncertain apply; inspect the proposal state");
  const recordDigest = proposalRecordDigest(record), observedSha = proposalTargetDigest(home, record.vault, record.operation.path, context.binding);
  if (!bindingStillCurrent(home, context) || proposalRecordDigest(readStoredProposal(home, context.bindingDigest, record.id, context.config.denyPaths ?? [])) !== recordDigest)
    throw new Error("proposal: record, vault binding or policy changed during reconciliation; retry with the current policy");
  return { id: record.id, vault: record.vault, state: "apply_unknown", beforeSha: record.intent.beforeSha, afterSha: record.intent.afterSha, observedSha,
    matchesBefore: observedSha === record.intent.beforeSha, matchesAfter: observedSha === record.intent.afterSha, receiptEvidence: "unavailable",
    explanation: "Matching content does not prove this proposal published it; inspect independent receipt evidence before any manual recovery." };
}
