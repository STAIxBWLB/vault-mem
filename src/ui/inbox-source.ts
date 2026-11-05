/** One read-only inbox source. Runs off the request thread, with a parent-enforced deadline. */
import type { InboxItem } from "@staix/agent-console/contract";
import { analysisInput } from "../analysis-input.ts";
import { listPromotionCandidates } from "../promote.ts";
import { loadRegistry } from "../registry.ts";
import type { VaultSpec } from "../config.ts";
import { isDenied } from "../platform.ts";
import { localSyncPending, STAGED_DESCRIPTION } from "../sync.ts";
import { boundInbox, type InboxRows } from "./inbox.ts";
import { lintVault } from "../vault-lint.ts";

export type InboxSource = { kind: "candidates" } | { kind: "lint" | "sync"; vault: VaultSpec };
export async function collectInboxSource(home: string, source: InboxSource): Promise<InboxRows> {
  const at = new Date().toISOString();
  if (source.kind === "candidates") {
    // Fetch one beyond the payload cap. The API limits per project and has no cheap total.
    // `more` is "at least N more" when any project saturates: it cannot fall as candidates
    // are added to the same population, and a single overflowing project never reports zero.
    const { projects } = await listPromotionCandidates({ allProjects: true, limit: 51, piiPatterns: loadRegistry(home).piiPatterns });
    const items: InboxItem[] = projects.flatMap(p => p.candidates.map(c => ({
      id: `mem:${c.id}`, group: "candidate" as const, kind: "promotion", title: c.title ?? c.kind, detail: `${c.kind} memory to promote into a vault note`,
      project: c.project, at: new Date(c.at).toISOString(), verbs: [],
      link: { panel: "promote", params: { id: c.id, project: c.project } },
    })));
    return boundInbox(items, 0, projects.some(p => p.candidates.length === 51));
  }
  const v = source.vault;
  if (source.kind === "lint") {
    const report = lintVault(analysisInput(home, v.id, { expectedVault: v }).snapshot);
    const items: InboxItem[] = [];
    if (report.errors > 0) items.push({ id: `lint:${v.id}`, group: "alert", kind: "lint", title: `${report.errors} lint errors in ${v.id}`,
      detail: report.summary, at, chip: { text: `${report.errors} errors`, tone: "err" }, verbs: [], link: { panel: "lint", params: { vault: v.id } } });
    if (report.findings.L11?.length) items.push({ id: `stale:${v.id}`, group: "alert", kind: "lint", title: `Graph report is stale in ${v.id}`,
      detail: report.findings.L11[0]!, at, chip: { text: "stale", tone: "warn" }, verbs: [], link: { panel: "lint", params: { vault: v.id } } });
    return boundInbox(items);
  }
  const config = loadRegistry(home), spec = config.vaults.find(x => x.id === v.id);
  if (!spec || JSON.stringify(spec) !== JSON.stringify(v)) throw new Error("vault binding changed; restart the console provider");
  if (isDenied(spec.path, config.denyPaths)) throw new Error("vault path is denied; check its path policy in System");
  const pending = localSyncPending(spec.path), count = pending.changed + pending.ahead;
  return boundInbox(count > 0 ? [{ id: `sync:${v.id}`, group: "alert", kind: "sync", title: `${count} unsynced change${count === 1 ? "" : "s"} in ${v.id}`,
    detail: [`${pending.changed} uncommitted path${pending.changed === 1 ? "" : "s"} to sync`,
      ...(pending.ignored ? [`${pending.ignored} other path${pending.ignored === 1 ? "" : "s"} outside ${STAGED_DESCRIPTION} not counted`] : []),
      ...(pending.upstream ? [`${pending.ahead} local commit${pending.ahead === 1 ? "" : "s"} ahead of upstream`] : [])].join("; "),
    at, chip: { text: "sync pending", tone: "warn" }, verbs: [], link: { panel: "overview", params: { vault: v.id } } }] : []);
}
