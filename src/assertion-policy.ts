/** Current-policy projection of assertion content. Never cache the projected result across reads. */
import { resolve } from "node:path";
import type { VaultSpec, VmemConfig } from "./config.ts";
import { parseEvidence, verifyEvidenceEntry, type EvidenceReadBudget, type EvidenceReads } from "./evidence.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { sourceReferences, sourceWorkspaceRoot } from "./source.ts";
import { screenContent } from "./write-validation.ts";
import type { AssertionItem } from "./assertions.ts";

export type AssertionValue = string | { withheld: "secret" | "pii_policy" };
export type ScreenedAssertion = Omit<AssertionItem, "value" | "evidence" | "source" | "origin"> & {
  value?: AssertionValue;
  evidence?: Record<string, unknown>[];
  source?: (string | { withheld: true })[];
  origin?: AssertionItem["origin"] | { withheld: true };
  availability?: "unavailable";
};

function withheld(text: string, vault: VaultSpec, config: VmemConfig): "secret" | "pii_policy" | undefined {
  const issues = screenContent(text, vault, config).filter(issue => issue.severity === "error");
  return issues.some(issue => issue.code === "V06") ? "secret" : issues.length ? "pii_policy" : undefined;
}
function deniedSource(source: string, vault: VaultSpec, config: VmemConfig): boolean {
  const deny = config.denyPaths ?? [];
  try {
    const ref = sourceReferences(source)[0]!;
    if (ref.kind !== "path") return false;
    const root = sourceWorkspaceRoot(vault);
    return isDenied(ref.value, deny) || (root !== undefined && isDenied(canonicalPath(resolve(root, ref.value)), deny));
  } catch { return true; }
}

/** Screen every field on every read. A denied evidence entry reveals neither its source, quote nor hashes. */
export function screenAssertion(item: AssertionItem, vault: VaultSpec, config: VmemConfig, reads: EvidenceReads, budget: EvidenceReadBudget): ScreenedAssertion {
  const { value, evidence, source, origin, ...safe } = item;
  const out: ScreenedAssertion = { ...safe };
  if (origin !== undefined) out.origin = !origin || typeof origin !== "object" || typeof origin.path !== "string" || !/^notes\/[^/\\]+\.md$/.test(origin.path) || isDenied(origin.path, config.denyPaths ?? []) || isDenied(canonicalPath(resolve(vault.path, origin.path)), config.denyPaths ?? []) || withheld(JSON.stringify(origin), vault, config) ? { withheld: true } : origin;
  if (item.purged) { out.availability = "unavailable"; out.evidence = [{ status: "unavailable" }]; return out; }
  if (typeof value === "string") {
    const reason = withheld(value, vault, config);
    out.value = reason ? { withheld: reason } : value;
  }
  if (Array.isArray(source)) out.source = source.map(entry => typeof entry === "string" && !deniedSource(entry, vault, config) && !withheld(entry, vault, config) ? entry : { withheld: true as const });
  if (evidence !== undefined) {
    if (!Array.isArray(evidence)) { out.evidence = [{ status: "unsupported", reason: "invalid_metadata" }]; return out; }
    // Journal entries add the write-time status; verify again and never treat that old status as current proof.
    const entries = evidence.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const { status: _status, ...entry } = value as Record<string, unknown>;
      return entry;
    });
    const evidenceSources = entries.flatMap(value => value && typeof value === "object" && "source" in value && typeof value.source === "string" ? [value.source] : []);
    const parsed = entries.length ? parseEvidence(entries, evidenceSources.length ? evidenceSources : undefined) : { entries: [] };
    out.evidence = parsed.problem ? [{ status: "unsupported", reason: "invalid_metadata" }] : parsed.entries.map((entry, index) => {
      if ("problem" in entry) return { status: "unsupported", reason: "invalid_metadata" };
      if (deniedSource(entry.source, vault, config) || withheld(entry.source, vault, config) || withheld(entry.quote, vault, config) || (entry.section && withheld(entry.section, vault, config))) return { status: "withheld", reason: "denied_by_current_policy" };
      const result = verifyEvidenceEntry(vault, entry, index, config.denyPaths ?? [], reads, budget);
      if (result.reason === "denied") return { status: "withheld", reason: "denied_by_current_policy" };
      if (result.reason === "read_budget") throw Object.assign(new Error("assertions: evidence read budget exceeded; narrow the query or lower the page limit"), { code: "V09" });
      if (result.reason === "source_not_found") return { source: entry.source, status: "unavailable" };
      return { ...entry, status: result.status, ...(result.reason ? { reason: result.reason } : {}) };
    });
  }
  return out;
}
