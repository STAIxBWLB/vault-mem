/** Internal submission entry point. CLI/MCP and decision operations are intentionally not exposed yet. */
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { loadRegistry } from "./registry.ts";
import { logBinding, matchesBinding } from "./vault-log.ts";
import { applyWrite } from "./writer.ts";
import { screenMetadata } from "./write-validation.ts";
import { createStoredProposal } from "./proposal-storage.ts";
import { encodeProposalRecord, parseProposalOperation, proposalPayloadDigest, type ProposalRecord } from "./proposals.ts";

export interface ProposalSubmitRequest { vault: string; operation: unknown; agentLabel?: string }
export interface ProposalContext { channel: "cli" | "mcp"; env?: NodeJS.ProcessEnv; now?: Date }
export interface ProposalSubmitted { id: string; vault: string; path: string; state: "pending"; createdAt: string; payloadDigest: string }

/** Screen and validate a proposal before any persistent record is created. */
export function submitProposal(home: string, request: ProposalSubmitRequest, options: ProposalContext): ProposalSubmitted {
  if (!request || typeof request !== "object" || Object.keys(request).some(key => !["vault", "operation", "agentLabel"].includes(key)) || typeof request.vault !== "string")
    throw new Error("proposal: invalid submit request; provide a vault and one operation");
  if (options.channel !== "cli" && options.channel !== "mcp") throw new Error("proposal: invalid write channel; use CLI or MCP");
  if (request.agentLabel !== undefined && (typeof request.agentLabel !== "string" || !request.agentLabel.trim() || Buffer.byteLength(request.agentLabel) > 256 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(request.agentLabel)))
    throw new Error("proposal: agent label must be nonempty text without controls and at most 256 bytes; correct the label");
  const operation = parseProposalOperation(request.operation), config = loadRegistry(home), vault = config.vaults.find(item => item.id === request.vault);
  if (!vault) throw new Error("proposal: unknown vault; choose a registered vault");
  if (vault.write === "none" || (options.channel === "mcp" && vault.write !== "mcp")) throw new Error("proposal: vault write policy refuses this channel; choose an authorized vault or channel");
  if (realpathSync(vault.path) !== vault.path) throw new Error("proposal: vault root changed or is linked; inspect the registered vault");
  const binding = logBinding(vault, config);
  const screen = screenMetadata({ operation, ...(request.agentLabel !== undefined ? { agentLabel: request.agentLabel } : {}) }, { vault, config }, operation.path);
  if (screen.some(issue => issue.severity === "error")) throw new Error(`proposal: payload screening refused (${[...new Set(screen.filter(issue => issue.severity === "error").map(issue => issue.code))].join(", ")}); remove prohibited content or correct the vault policy`);
  const preview = applyWrite(home, { vault: vault.id, operation, channel: options.channel, dryRun: true }, { env: options.env, binding, now: options.now });
  if (!preview.ok) throw new Error(`proposal: validation refused (${[...new Set(preview.issues.filter(issue => issue.severity === "error").map(issue => issue.code))].join(", ") || "unknown"}); correct the proposal and retry`);
  const bindingDigest = createHash("sha256").update(JSON.stringify([vault.id, vault.path, binding.dev, binding.ino]), "utf8").digest("hex");
  const createdAt = (options.now ?? new Date()).toISOString();
  const record: ProposalRecord = { schemaVersion: 1, id: randomUUID(), vault: vault.id, bindingDigest, state: "pending", createdAt, updatedAt: createdAt, operation, payloadDigest: proposalPayloadDigest(operation), ...(request.agentLabel !== undefined ? { agentLabel: request.agentLabel } : {}) };
  encodeProposalRecord(record);
  if (!matchesBinding(loadRegistry(home), vault.id, binding)) throw new Error("proposal: vault binding or policy changed during submit; request a new preview");
  createStoredProposal(home, record);
  return { id: record.id, vault: record.vault, path: operation.path, state: "pending", createdAt, payloadDigest: record.payloadDigest };
}
