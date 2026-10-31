/**
 * Console plugin (api 1) for acon: STAIxBWLB/agent-console contract, UX per vault-mem#48.
 * The provider reuses the `vmem mcp` handlers in process, so the console acts with exactly the MCP rights and checks.
 */
import { readFileSync } from "node:fs";
import type { ActionResult, Change, ConsolePlugin, ConsoleProvider, InboxItem } from "@staix/agent-console/contract";
import { analysisInput } from "../analysis-input.ts";
import { resolveHome } from "../home.ts";
import { createVaultMcp } from "../mcp-vault.ts";
import { listPromotionCandidates } from "../promote.ts";
import { loadRegistry } from "../registry.ts";
import { lintVault } from "../vault-lint.ts";
import type { LintCode } from "../analysis-types.ts";

const asset = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const VERSION = (JSON.parse(asset("../../package.json")) as { version: string }).version;
const LINT_ERRORS: LintCode[] = ["L01", "L02", "L13"];
const CACHE_MS = 60_000;

type Args = Record<string, unknown>;
const str = (v: unknown): string | undefined => typeof v === "string" && v.length > 0 ? v : undefined;
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});
const firstIssue = (r: Args): string => {
  const issues = Array.isArray(r.issues) ? r.issues as { message?: string; severity?: string }[] : [];
  return (issues.find(i => i.severity !== "warning") ?? issues[0])?.message ?? "refused";
};

/** `- 2026-10-31 09:12  LEARN  proj  src → dest  — note (vmem:agent)` as a row; unparsable lines keep their text. */
export function parseLogLine(line: string): { at: string; type: string; project: string; source: string; dest?: string; note: string; agent: boolean } | { raw: string } {
  const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})  (\S+)  (\S+)  (.+?)(?: → (.+?))?  — (.*?)( \(vmem:agent\))?$/.exec(line.replace(/\n$/, ""));
  if (!m) return { raw: line };
  return { at: m[1]!, type: m[2]!, project: m[3]!, source: m[4]!, ...(m[5] ? { dest: m[5] } : {}), note: m[6]!, agent: m[7] !== undefined };
}

/** Lint strings carry the note path in the first backtick span; this turns them into typed findings. */
export function typedFindings(findings: Record<string, string[]>): { code: string; severity: "error" | "warning"; path?: string; message: string }[] {
  return Object.entries(findings).flatMap(([code, list]) => list.map(message => {
    const path = /`(notes\/[^`]+\.md)`/.exec(message)?.[1];
    return { code, severity: LINT_ERRORS.includes(code as LintCode) ? "error" as const : "warning" as const, ...(path ? { path } : {}), message };
  }));
}

/** Planned file changes of a vmem preview, as the shell's "What will change" list. */
function changesOf(receipt: Args): Change[] {
  const list = Array.isArray(receipt.changes) ? receipt.changes as { path: string; beforeSha: string | null; sha256: string | null }[] : [];
  return list.map(c => ({ op: c.beforeSha === null ? "create" : c.sha256 === null ? "delete" : "modify", target: c.path }));
}

export const plugin: ConsolePlugin = {
  manifest: {
    api: 1, tool: "vmem", version: VERSION, title: "Vault", icon: "vault", pollMs: 15_000,
    panels: [
      { id: "overview", title: "Overview", order: 1 },
      { id: "notes", title: "Search", order: 2 },
      { id: "note", title: "Note", order: 3 },
      { id: "promote", title: "Promote", order: 4 },
      { id: "lint", title: "Lint", order: 5 },
      { id: "log", title: "Log", order: 6 },
    ],
    capabilities: { actions: ["delete", "move", "promote", "promote-from-amem"], confirm: true, inbox: true, search: true },
  },
  async open(ctx): Promise<ConsoleProvider> {
    const home = resolveHome().home;
    const mcp = createVaultMcp(home);
    const call = async (name: string, args: Args): Promise<Args> => rec(await mcp.handlers[name]!(args));
    const vaultOf = (args: Args) => mcp.vaults.find(v => v.id === (str(args.vault) ?? mcp.defaultVault));
    const pass = (args: Args) => (str(args.vault) ? { vault: args.vault } : {});

    // ponytail: lint reads every note, so inbox polls reuse one result per vault for 60 s; invalidate on writes if it lags.
    const lintCache = new Map<string, { at: number; report: ReturnType<typeof lintVault> }>();
    const lint = (id: string) => {
      const hit = lintCache.get(id);
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.report;
      const spec = mcp.vaults.find(v => v.id === id)!;
      const report = lintVault(analysisInput(home, id, { expectedVault: spec }).snapshot);
      lintCache.set(id, { at: Date.now(), report });
      return report;
    };
    const projectOf = new Map<string, string>();
    const candidates = async () => {
      try {
        const { projects } = await listPromotionCandidates({ allProjects: true, limit: 50, piiPatterns: loadRegistry(home).piiPatterns });
        for (const p of projects) for (const c of p.candidates) projectOf.set(c.id, c.project);
        return { projects };
      }
      catch (error) { ctx.log(`vmem: promotion candidates unavailable: ${error instanceof Error ? error.message : String(error)}`); return { projects: [], unavailable: "agent-mem candidates are unavailable; see System" }; }
    };

    async function inbox(): Promise<InboxItem[]> {
      const items: InboxItem[] = [];
      for (const p of (await candidates()).projects) for (const c of p.candidates) items.push({
        id: `mem:${c.id}`, group: "candidate", kind: "promotion", title: c.title ?? c.kind, detail: `${c.kind} memory to promote into a vault note`,
        project: c.project, at: new Date(c.at).toISOString(),
        // Promotion needs a domain and topics, so the item opens the Promote panel instead of offering a one-key verb.
        verbs: [],
        link: { panel: "promote", params: { id: c.id, project: c.project } },
      });
      for (const v of mcp.vaults.filter(x => x.kind === "personal")) {
        let report;
        try { report = lint(v.id); } catch (error) { ctx.log(`vmem: lint ${v.id} failed: ${error instanceof Error ? error.message : String(error)}`); continue; }
        if (report.errors > 0) items.push({ id: `lint:${v.id}`, group: "alert", kind: "lint", title: `${report.errors} lint errors in ${v.id}`, detail: report.summary, at: new Date().toISOString(),
          chip: { text: `${report.errors} errors`, tone: "err" }, verbs: [], link: { panel: "lint", params: { vault: v.id } } });
        const stale = report.findings.L11 ?? [];
        if (stale.length) items.push({ id: `stale:${v.id}`, group: "alert", kind: "lint", title: `Graph report is stale in ${v.id}`, detail: stale[0]!, at: new Date().toISOString(),
          chip: { text: "stale", tone: "warn" }, verbs: [], link: { panel: "lint", params: { vault: v.id } } });
      }
      return items;
    }

    /** One two-step operation: preview, and with the console's confirmation recompute and write only on the same fingerprint. */
    async function twoStep(tool: string, args: Args, confirmed: boolean, fingerprint: string | undefined, describe: (preview: Args) => { verb: string; preview: string[]; changes: Change[]; warnings: string[] }): Promise<ActionResult> {
      const preview = await call(tool, args);
      if (preview.refused || preview.ok === false || typeof preview.fingerprint !== "string") return { ok: false, error: firstIssue(preview) };
      if (!confirmed || fingerprint !== preview.fingerprint) {
        const d = describe(preview);
        return { ok: false, needsConfirm: true, fingerprint: preview.fingerprint, verb: d.verb, preview: d.preview, changes: d.changes, ...(d.warnings.length ? { warnings: d.warnings } : {}) };
      }
      const done = await call(tool, { ...args, confirm: true, fingerprint });
      if (done.refused || done.ok === false) return { ok: false, error: firstIssue(done) };
      lintCache.clear();
      return { ok: true, message: `${describe(preview).verb}: done` };
    }

    return {
      assets: { js: asset("./panel.js"), css: asset("./panel.css") },
      async snapshot(input) {
        const args = input as Args;
        switch (input.panel) {
          case "inbox": return { items: await inbox() };
          case "search": {
            const q = str(args.q);
            if (!q) return { hits: [], total: 0 };
            const limit = Math.min(10, Math.max(1, Number(args.limit) || 10));
            const r = await call("vmem_search", { query: q, limit, ...pass(args) });
            const hits = (Array.isArray(r.hits) ? r.hits as { path: string; title: string; description: string }[] : []).map(h => ({
              id: h.path, kind: "note", title: h.title, detail: h.description, link: { panel: "note", params: { path: h.path } } }));
            return { hits, total: hits.length };
          }
          case "overview": {
            const status = await call("vmem_status", {});
            const vault = vaultOf(args);
            if (!vault) return { status, vault: null };
            const [notes, mocs, log] = await Promise.all([call("vmem_list", { vault: vault.id, limit: 500 }), call("vmem_mocs", { vault: vault.id }), call("vmem_log_tail", { vault: vault.id, n: 8 })]);
            return { status, vault: vault.id, noteCount: Array.isArray(notes.notes) ? notes.notes.length : 0, mocs: mocs.mocs ?? [], log: (Array.isArray(log.lines) ? log.lines as string[] : []).map(parseLogLine) };
          }
          case "notes": {
            const q = str(args.q);
            const r = q ? await call("vmem_search", { query: q, limit: 50, ...pass(args) }) : await call("vmem_list", { limit: 100, ...pass(args) });
            return { q: q ?? "", notes: r.hits ?? r.notes ?? [], ...(r.refused ? { error: firstIssue(r) } : {}) };
          }
          case "note": {
            const path = str(args.path);
            if (!path) return { note: null };
            const note = await call("vmem_read", { path, ...pass(args) });
            if (note.refused) return { note: null, error: firstIssue(note) };
            const links = await call("vmem_links", { path, ...pass(args) });
            // vmem_promote always reads from the default personal vault, so offer it only there.
            const promotable = vaultOf(args)?.id === mcp.defaultVault && vaultOf(args)?.kind === "personal";
            return { note, links, orgVaults: promotable ? mcp.vaults.filter(v => v.kind === "org").map(v => v.id) : [] };
          }
          case "promote": return { ...(await candidates()), selected: str(args.id) ?? null };
          case "lint": {
            const vault = vaultOf(args);
            if (!vault) return { findings: [] };
            const report = lint(vault.id);
            return { vault: vault.id, errors: report.errors, warnings: report.warnings, summary: report.summary, findings: typedFindings(report.findings) };
          }
          case "log": {
            const vault = vaultOf(args);
            if (!vault) return { rows: [] };
            const r = await call("vmem_log_tail", { vault: vault.id, n: 100, ...(str(args.type) ? { type: args.type } : {}) });
            return { vault: vault.id, rows: (Array.isArray(r.lines) ? r.lines as string[] : []).map(parseLogLine).reverse(), ...(r.ok === false ? { error: firstIssue(r) } : {}) };
          }
          default: return { error: `unknown panel ${input.panel}` };
        }
      },
      async action(input) {
        const args = input as Args, confirmed = input.confirmed === true, fingerprint = str(input.fingerprint);
        switch (input.action) {
          case "delete": {
            const path = str(args.path) ?? str(args.id);
            if (!path) return { ok: false, error: "path is required" };
            return twoStep("vmem_delete", { path, ...pass(args) }, confirmed, fingerprint, p => {
              const backlinks = Array.isArray(p.backlinks) ? p.backlinks as { source: string }[] : [];
              return { verb: "Delete note", preview: [`delete ${path}`], changes: changesOf(p),
                warnings: backlinks.length ? [`${backlinks.length} links point here: ${[...new Set(backlinks.map(b => b.source))].slice(0, 5).join(", ")}`] : [] };
            });
          }
          case "move": {
            const from = str(args.from), to = str(args.to);
            if (!from || !to) return { ok: false, error: "from and to are required" };
            return twoStep("vmem_move", { from, to, ...pass(args) }, confirmed, fingerprint, p => ({ verb: "Move note", preview: [`move ${from} → ${to}`], changes: changesOf(p), warnings: [] }));
          }
          case "promote": {
            const path = str(args.path), to = str(args.to);
            if (!path || !to) return { ok: false, error: "path and to are required" };
            if (str(args.vault) && args.vault !== mcp.defaultVault) return { ok: false, error: `promotion to an org vault reads from ${mcp.defaultVault}; open the note there` };
            return twoStep("vmem_promote", { path, to }, confirmed, fingerprint, p => {
              const screen = rec(p.screen), dropped = Array.isArray(p.droppedLinks) ? p.droppedLinks as string[] : [];
              return { verb: "Promote note", preview: String(p.text ?? "").split("\n"),
                changes: [{ op: "create", target: `${to}:${String(p.target ?? path)}` }, { op: "modify", target: path, note: "provenance" }, { op: "log", target: "log", note: "SYNC lines in both vaults" }],
                warnings: [...(dropped.length ? [`${dropped.length} links become plain text: ${dropped.slice(0, 5).join(", ")}`] : []), ...(screen.passed === false ? ["screen reported issues"] : [])] };
            });
          }
          case "promote-from-amem": {
            const id = (str(args.id) ?? "").replace(/^mem:/, "");
            if (!/^[0-9a-f-]{32,36}$/i.test(id)) return { ok: false, error: "a memory id is required" };
            if (!projectOf.has(id)) await candidates();
            const project = str(args.project) ?? projectOf.get(id);
            const topics = Array.isArray(args.topics) ? args.topics.filter((t): t is string => typeof t === "string")
              : str(args.topics)?.split(",").map(t => t.trim()).filter(Boolean);
            const meta = Object.fromEntries(["stem", "type", "domain", "description", "title", "linkTo"].filter(k => str(args[k])).map(k => [k, str(args[k])]));
            return twoStep("vmem_promote_from_amem", { id, ...pass(args), ...(project ? { project } : {}), ...meta, ...(topics?.length ? { topics } : {}) }, confirmed, fingerprint, p => {
              const dupes = Array.isArray(p.possibleDuplicates) ? p.possibleDuplicates as string[] : [];
              return { verb: p.action === "link" ? "Link memory" : "Promote memory", preview: String(p.text ?? `link mem:${id} → ${String(p.path)}`).split("\n"),
                changes: [{ op: p.action === "link" ? "modify" : "create", target: String(p.path ?? "note") }, { op: "log", target: "log", note: "LEARN line" }],
                warnings: dupes.length ? [`possible duplicates: ${dupes.slice(0, 5).join(", ")}`] : [] };
            });
          }
          default: return { ok: false, error: `unknown action ${input.action}` };
        }
      },
    };
  },
};

export default plugin;
