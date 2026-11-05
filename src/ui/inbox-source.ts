/** One read-only inbox source. Runs off the request thread, with a parent-enforced deadline. */
import type { InboxItem } from "@staix/agent-console/contract";
import { analysisInput } from "../analysis-input.ts";
import { listPromotionCandidates } from "../promote.ts";
import { loadRegistry } from "../registry.ts";
import type { VaultSpec } from "../config.ts";
import { isDenied } from "../platform.ts";
import { localSyncPending, STAGED_DESCRIPTION } from "../sync.ts";
import { lintVault } from "../vault-lint.ts";

export type InboxSource = { kind: "candidates" } | { kind: "lint" | "sync"; vault: VaultSpec };
export async function collectInboxSource(home: string, source: InboxSource): Promise<InboxItem[]> {
  const at = new Date().toISOString();
  if (source.kind === "candidates") {
    const { projects } = await listPromotionCandidates({ allProjects: true, limit: 50, piiPatterns: loadRegistry(home).piiPatterns });
    return projects.flatMap(p => p.candidates.map(c => ({
      id: `mem:${c.id}`, group: "candidate" as const, kind: "promotion", title: c.title ?? c.kind,
      project: c.project, at: new Date(c.at).toISOString(), verbs: [],
      link: { panel: "promote", params: { id: c.id, project: c.project } },
    })));
  }
  const v = source.vault;
  if (source.kind === "lint") {
    const report = lintVault(analysisInput(home, v.id, { expectedVault: v }).snapshot);
    const items: InboxItem[] = [];
    if (report.errors > 0) items.push({ id: `lint:${v.id}`, group: "alert", kind: "lint", title: `${report.errors} lint errors in ${v.id}`,
      at, chip: { text: `${report.errors} errors`, tone: "err" }, verbs: [], link: { panel: "lint", params: { vault: v.id } } });
    if (report.findings.L11?.length) items.push({ id: `stale:${v.id}`, group: "alert", kind: "lint", title: `Graph report is stale in ${v.id}`,
      at, chip: { text: "stale", tone: "warn" }, verbs: [], link: { panel: "lint", params: { vault: v.id } } });
    return items;
  }
  const config = loadRegistry(home), spec = config.vaults.find(x => x.id === v.id);
  if (!spec || JSON.stringify(spec) !== JSON.stringify(v)) throw new Error("vault binding changed; restart the console provider");
  if (isDenied(spec.path, config.denyPaths)) throw new Error("vault path is denied; check its path policy in System");
  const pending = localSyncPending(spec.path), count = pending.changed + pending.ahead;
  return count > 0 ? [{ id: `sync:${v.id}`, group: "alert", kind: "sync", title: `${count} unsynced change${count === 1 ? "" : "s"} in ${v.id}`,
    detail: [`${pending.changed} uncommitted path${pending.changed === 1 ? "" : "s"} to sync`,
      ...(pending.ignored ? [`${pending.ignored} other path${pending.ignored === 1 ? "" : "s"} outside ${STAGED_DESCRIPTION} not counted`] : []),
      ...(pending.upstream ? [`${pending.ahead} local commit${pending.ahead === 1 ? "" : "s"} ahead of upstream`] : [])].join("; "),
    at, chip: { text: "sync pending", tone: "warn" }, verbs: [], link: { panel: "overview", params: { vault: v.id } } }] : [];
}
