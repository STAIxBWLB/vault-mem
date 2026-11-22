/**
 * Console plugin (api 1) for acon: STAIxBWLB/agent-console contract, UX per vault-mem#48.
 * The provider reuses the `vmem mcp` handlers in process, so the console acts with exactly the MCP rights and checks.
 */
import { readFileSync } from "node:fs";
import type { ActionResult, Change, ConsolePlugin, ConsoleProvider } from "@staix/agent-console/contract";
import { analysisInput } from "../analysis-input.ts";
import { resolveHome } from "../home.ts";
import { createVaultMcp } from "../mcp-vault.ts";
import { validArguments } from "../mcp.ts";
import { listPromotionCandidates } from "../promote.ts";
import { changeSettings, settingsSnapshot, loadRegistry } from "../registry.ts";
import { createSnapshotRevision, createPromoteSnapshot, nextSnapshotCursor } from "./snapshot-cache.ts";
import { assembleGraphSnapshot, resolveGraphPage, assembleSemanticPages, resolveSemanticPage } from "./graph-snapshot.ts";
import type { GraphSnapshotAssembly } from "./graph-snapshot.ts";
import type { SemanticGraphPage } from "./panel-types.ts";
import { graphEnrichmentInputs } from "../enrichment-query.ts";
import { enrichmentStoreStamp } from "../enrichment-store.ts";
import { assertionCoverageWarnings } from "./panel-types.ts";
import type { AssertionsReadResult } from "../assertion-read.ts";
import { createInboxSnapshot } from "./inbox.ts";
import { LINK_RELATIONS } from "../links.ts";
import { lintVault } from "../vault-lint.ts";
import { readLogSince } from "../vault-log.ts";
import type { LintCode } from "../analysis-types.ts";

const asset = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const VERSION = (JSON.parse(asset("../../package.json")) as { version: string }).version;
const LINT_ERRORS: LintCode[] = ["L01", "L02", "L13"];
const CACHE_MS = 60_000;
/** Revision-bound assemblies, shared between concurrent requests and bounded to two vaults. */
export function createGraphSnapshotCache(revision: (vault: string) => number | string, load: (vault: string) => Promise<GraphSnapshotAssembly>, now: () => number = Date.now) {
  type Entry = { stamp: number | string; at: number; assembly: GraphSnapshotAssembly; cursors: Map<string, number>; semantic: Map<string, SemanticGraphPage[]> };
  const cache = new Map<string, Entry>(), flights = new Map<string, Promise<Entry>>();
  return {
    async snapshot(vault: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      let entry: Entry | undefined;
      for (let attempts = 0; attempts < 3; attempts++) {
        const stamp = revision(vault), hit = cache.get(vault);
        if (hit && hit.stamp === stamp && now() - hit.at < CACHE_MS) { entry = hit; break; }
        let flight = flights.get(vault);
        if (!flight) {
          flight = load(vault).then(assembly => ({ stamp, at: now(), assembly, cursors: new Map<string, number>(), semantic: new Map<string, SemanticGraphPage[]>() }));
          flights.set(vault, flight);
        }
        try { entry = await flight; } finally { if (flights.get(vault) === flight) flights.delete(vault); }
        if (entry.stamp === revision(vault)) { cache.delete(vault); cache.set(vault, entry); while (cache.size > 2) cache.delete(cache.keys().next().value!); break; }
        entry = undefined;
      }
      if (!entry) throw new Error("graph changed while assembling; restart from the first page");
      cache.delete(vault); cache.set(vault, entry);
      while (cache.size > 2) cache.delete(cache.keys().next().value!);
      if (args.page !== undefined && typeof args.page !== "string") throw new Error("graph page is invalid; restart from the first page");
      let page: ReturnType<typeof resolveGraphPage> | SemanticGraphPage;
      let query = "";
      if (args.semantic !== undefined) {
        const options = args.semantic;
        if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => key !== "k" && key !== "minScore")) throw new Error("graph semantic: supply k and minScore; correct the parameters and restart");
        const { k, minScore } = options as Record<string, unknown>;
        if (typeof k !== "number" || !Number.isInteger(k) || k < 1 || k > 20 || typeof minScore !== "number" || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) throw new Error("graph semantic: k must be 1..20 and minScore must be 0..1; correct the parameters and restart");
        query = JSON.stringify([k, minScore]);
        let pages = entry.semantic.get(query);
        if (!pages) {
          pages = assembleSemanticPages(entry.assembly, k, minScore);
          if (entry.stamp !== revision(vault)) throw new Error("graph changed while assembling semantic edges; restart from the first page");
          if (entry.semantic.size >= 4) entry.semantic.delete(entry.semantic.keys().next().value!);
          entry.semantic.set(query, pages);
        }
        page = resolveSemanticPage(entry.assembly, pages, k, minScore, args.page as string | undefined);
      } else page = resolveGraphPage(entry.assembly, args.page as string | undefined);
      const key = `${page.kind}:${query}:${page.offset}`;
      let cursor = entry.cursors.get(key);
      if (cursor === undefined) { if (entry.cursors.size >= 256) entry.cursors.delete(entry.cursors.keys().next().value!); cursor = nextSnapshotCursor(); entry.cursors.set(key, cursor); }
      if (args.after === cursor) return { changed: false, cursor };
      return { ...page, cursor };
    },
  };
}
const POLL_MS = 15_000;
// The shell reuses a snapshot for maxAgeMs, then serves it stale once more while it refreshes, and drops it on every
// console action. Half the poll keeps both windows inside one poll, so the shell cache never delays a refresh past the
// next poll; the provider's own caches (lint, inbox and promote revisions, 60 s safety refresh) still bound what a
// change made outside the console shows. Note and Search answer the person's own input and keep the shell's 2 s default.
const REUSE_MS = POLL_MS / 2;

type Args = Record<string, unknown>;
const str = (v: unknown): string | undefined => typeof v === "string" && v.length > 0 ? v : undefined;
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});
/**
 * The console's answer to a confirmed write. An applied write is done, together with any later step that failed
 * (a log line, the agent-mem link, SYNC lines). A successful no-op (already linked, nothing to change, a retried
 * confirmation) is success too, never a refusal. Anything else is refused with its first issue.
 */
export function confirmedOutcome(done: Args, verb: string): ActionResult {
  if (done.applied === true) {
    const missing = followUpProblems(done);
    return { ok: true, message: missing.length ? `${verb}: applied, but ${missing.join("; ")}` : `${verb}: done` };
  }
  const issues = Array.isArray(done.issues) ? done.issues as { severity?: string }[] : [];
  if (done.ok === true && !issues.some(i => i.severity !== "warning")) return { ok: true, message: `${verb}: already done, nothing changed` };
  return { ok: false, error: firstIssue(done) };
}
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

/** Failed steps after an applied write: the log receipt(s) of a write, a promotion or an org promotion, and the result's own issues. */
export function followUpProblems(r: Args): string[] {
  const out: string[] = [];
  const failed = (x: unknown) => { const l = rec(x); if (l.ok === false) out.push(firstIssue(l)); };
  const logs = rec(r.logs);
  for (const receipt of [r.log, rec(r.note).log, logs.source, logs.target, r.provenance]) failed(receipt);
  if (r.ok === false) out.push(firstIssue(r));
  return [...new Set(out)];
}

/** Planned file changes of a vmem preview, as the shell's "What will change" list. */
function changesOf(receipt: Args): Change[] {
  const list = Array.isArray(receipt.changes) ? receipt.changes as { path: string; beforeSha: string | null; sha256: string | null }[] : [];
  return list.map(c => ({ op: c.beforeSha === null ? "create" : c.sha256 === null ? "delete" : "modify", target: c.path }));
}

export const plugin: ConsolePlugin = {
  manifest: {
    api: 1, tool: "vmem", version: VERSION, title: "Vault", icon: "vault", pollMs: POLL_MS,
    panels: [
      { id: "overview", title: "Overview", order: 1, maxAgeMs: REUSE_MS },
      { id: "notes", title: "Search", order: 2 },
      { id: "note", title: "Note", order: 3 },
      { id: "promote", title: "Promote", order: 4, maxAgeMs: REUSE_MS },
      { id: "lint", title: "Lint", order: 5, maxAgeMs: REUSE_MS },
      { id: "log", title: "Log", order: 6, maxAgeMs: REUSE_MS },
      { id: "settings", title: "Settings", order: 7 },
      { id: "proposals", title: "Proposals", order: 8, maxAgeMs: REUSE_MS },
      { id: "assertions", title: "Assertions", order: 9 },
      { id: "history", title: "History", order: 10 },
      { id: "graph", title: "Graph", order: 11, maxAgeMs: REUSE_MS },
    ],
    capabilities: { actions: ["delete", "move", "promote", "promote-from-amem", "settings", "proposal-apply", "proposal-reject", "link"], confirm: true, inbox: true, inboxMaxAgeMs: REUSE_MS, search: true },
  },
  async open(ctx): Promise<ConsoleProvider> {
    const home = resolveHome().home;
    const mcp = createVaultMcp(home);
    const call = async (name: string, args: Args): Promise<Args> => rec(await mcp.handlers[name]!(args));
    // The shell's tabs navigate without params, so the vault chosen on one panel is kept for the others.
    // ponytail: one choice per provider; fine for H0's single person, per session once H1 serves several.
    let chosen: string | undefined;
    const promotionSource = mcp.vaults.find(v => v.id === mcp.defaultVault && v.kind === "personal") ?? mcp.vaults.find(v => v.kind === "personal");
    // An explicit vault must exist (undefined otherwise, like MCP's own check); only an omitted one falls back.
    const vaultOf = (args: Args) => {
      const asked = str(args.vault);
      if (asked) { const spec = mcp.vaults.find(v => v.id === asked); if (spec) chosen = spec.id; return spec; }
      return mcp.vaults.find(v => v.id === (chosen ?? mcp.defaultVault));
    };
    // The vault argument for an MCP call: an explicit id goes through unchanged so the handler refuses an unknown one.
    const vaultArg = (args: Args) => str(args.vault) ?? vaultOf(args)?.id;
    const pass = (args: Args) => { vaultOf(args); const v = vaultArg(args); return v ? { vault: v } : {}; };
    /**
     * Every option the MCP tool declares reaches it: the console never hand-picks arguments, so a supported
     * operation cannot be lost on the way. Form text for array options is split on commas; the result is checked
     * against the tool's own schema before anything runs.
     */
    const forward = (tool: string, args: Args, fixed: Args = {}): Args | string => {
      const schema = mcp.tools.find(t => t.name === tool)?.inputSchema as { properties?: Record<string, { type?: unknown }> } | undefined;
      const out: Args = {};
      for (const [key, spec] of Object.entries(schema?.properties ?? {})) {
        if (key === "confirm" || key === "fingerprint") continue;
        let value = key in fixed ? fixed[key] : key === "vault" ? vaultArg(args) : args[key];
        if (value === undefined || value === "") continue;
        const types = Array.isArray(spec.type) ? spec.type : [spec.type];
        if (typeof value === "string" && types.includes("array") && !types.includes("string")) value = value.split(",").map(v => v.trim()).filter(Boolean);
        if (value === "true" && types.includes("boolean")) value = true;
        out[key] = value;
      }
      return validArguments(out, schema ?? { type: "object" }) ? out : `invalid input for ${tool}`;
    };

    // The Lint panel reuses its report for 60 s; inbox collection has its own off-thread cache.
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
    const revision = createSnapshotRevision(home, mcp.vaults);
    const candidates = async () => {
      const { projects } = await listPromotionCandidates({ allProjects: true, limit: 50, piiPatterns: loadRegistry(home).piiPatterns });
      projectOf.clear();
      for (const p of projects) for (const c of p.candidates) projectOf.set(c.id, c.project);
      return { projects };
    };

    const promote = createPromoteSnapshot(revision.current, candidates);
    const graphStamp = (id: string) => {
      const config = loadRegistry(home), vault = config.vaults.find(v => v.id === id);
      if (!vault) throw new Error("graph: vault is no longer registered; select a registered vault");
      return `${revision.current()}:${vault.enrichment?.enabled ? enrichmentStoreStamp(home, vault, config.vaults, config.denyPaths ?? []) : "disabled"}`;
    };
    const graph = createGraphSnapshotCache(graphStamp, async id => {
      const spec = mcp.vaults.find(v => v.id === id)!;
      const snapshot = analysisInput(home, id, { expectedVault: spec }).snapshot;
      return assembleGraphSnapshot(snapshot, id, graphEnrichmentInputs(home, id, snapshot));
    });
    const inbox = createInboxSnapshot(home, mcp.vaults, ctx.log, undefined, revision.current);
    // One cursor for the whole Promote failure: a fresh one per failed scan would rebuild the panel every poll.
    let promoteErrorCursor: number | undefined;

    /** One two-step operation: preview, and with the console's confirmation recompute and write only on the same fingerprint. */
    async function twoStep(tool: string, args: Args | string, confirmed: boolean, fingerprint: string | undefined, describe: (preview: Args) => { verb: string; preview: string[]; changes: Change[]; warnings: string[] }): Promise<ActionResult> {
      if (typeof args === "string") return { ok: false, error: args };
      const preview = await call(tool, args);
      if (preview.refused || preview.ok === false || typeof preview.fingerprint !== "string") return { ok: false, error: firstIssue(preview) };
      if (preview.unchanged === true) return { ok: true, message: `${describe(preview).verb}: already done, nothing changed` };
      if (!confirmed || fingerprint !== preview.fingerprint) {
        const d = describe(preview);
        return { ok: false, needsConfirm: true, fingerprint: preview.fingerprint, verb: d.verb, preview: d.preview, changes: d.changes, ...(d.warnings.length ? { warnings: d.warnings } : {}) };
      }
      const done = await call(tool, { ...args, confirm: true, fingerprint });
      // A tool that answers a stale fingerprint with a fresh preview (vmem_link) gets a new confirmation, never a write.
      if (done.stale === true && typeof done.fingerprint === "string") {
        const d = describe(done);
        return { ok: false, needsConfirm: true, fingerprint: done.fingerprint, verb: d.verb, preview: d.preview, changes: d.changes, warnings: ["the notes changed since the preview; review the fresh preview", ...d.warnings] };
      }
      if (done.applied === true) { lintCache.clear(); revision.invalidate(); inbox.invalidate(); }
      return confirmedOutcome(done, describe(preview).verb);
    }

    /**
     * A read panel through the MCP handler: arguments are checked against the tool schema, and a thrown refusal
     * (unknown vault, invalid cursor, missing proposal) becomes the snapshot's `error` text, which names cause and next step.
     */
    async function readTool(tool: string, args: Args, fixed: Args = {}): Promise<{ result: Args } | { error: string }> {
      const checked = forward(tool, args, fixed);
      if (typeof checked === "string") return { error: `${checked}; correct the panel parameters and reload` };
      try {
        const result = await call(tool, checked);
        return result.refused ? { error: firstIssue(result) } : { result };
      } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
    }
    const PROPOSAL_STATES = ["pending", "applied", "rejected", "apply_unknown"];

    return {
      async close() { await inbox.close(); },
      assets: { js: asset("./panel.js"), css: asset("./panel.css") },
      async snapshot(input) {
        const args = input as Args;
        switch (input.panel) {
          case "graph": {
            const vault = vaultOf(args);
            if (!vault) return { vault: null, error: str(args.vault) ? `unknown vault ${str(args.vault)}; pick a registered vault from Overview` : "graph: no selected vault; select a registered vault" };
            if (args.similar !== undefined) {
              const result = await readTool("vmem_similar", args, { vault: vault.id, path: args.similar });
              return "error" in result ? result : { similar: result.result.hits };
            }
            const stem = (value: unknown) => typeof value === "string" && value.startsWith("notes/") && value.endsWith(".md") ? value.slice(6, -3) : value;
            if (args.neighbors !== undefined) {
              const r = await readTool("vmem_graph_neighbors", args, { vault: vault.id, path: stem(args.neighbors) });
              return "error" in r ? r : { neighborhood: r.result };
            }
            if (args.from !== undefined || args.to !== undefined) {
              const r = await readTool("vmem_graph_path", args, { vault: vault.id, from: stem(args.from), to: stem(args.to) });
              return "error" in r ? r : { path: r.result };
            }
            try { return await graph.snapshot(vault.id, args); }
            catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
          }
          case "settings": {
            const vault = vaultOf(args);
            if (!vault) return { error: "settings: no selected vault; select a registered vault" };
            return settingsSnapshot(home, vault.id);
          }
          case "inbox": {
            const result = await inbox.snapshot();
            return args.after === result.cursor ? { changed: false, cursor: result.cursor } : result;
          }
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
            const count = Array.isArray(notes.notes) ? notes.notes.length : 0;
            return { status, vault: vault.id, noteCount: count, noteCountCapped: count >= 500, mocs: mocs.mocs ?? [], log: (Array.isArray(log.lines) ? log.lines as string[] : []).map(parseLogLine) };
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
            // vmem_promote reads from the preferred personal vault, so offer it only there.
            const promotable = vaultOf(args)?.id === promotionSource?.id && promotionSource !== undefined;
            return { note, links, orgVaults: promotable ? mcp.vaults.filter(v => v.kind === "org").map(v => v.id) : [] };
          }
          case "promote": {
            try {
              const result = await promote.snapshot(args);
              promoteErrorCursor = undefined;
              return result;
            } catch (error) {
              ctx.log(`vmem: promotion snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`);
              promoteErrorCursor ??= nextSnapshotCursor();
              // The shell keeps that one cursor: a matching `after` suppresses the unchanged error view.
              return args.after === promoteErrorCursor
                ? { changed: false, cursor: promoteErrorCursor }
                : { projects: [], unavailable: "Promotion candidates are unavailable; see System", cursor: promoteErrorCursor };
            }
          }
          case "lint": {
            const vault = vaultOf(args);
            if (!vault) return { findings: [] };
            const report = lint(vault.id);
            return { vault: vault.id, errors: report.errors, warnings: report.warnings, summary: report.summary, findings: typedFindings(report.findings) };
          }
          case "log": {
            const vault = vaultOf(args);
            if (!vault) return { rows: [] };
            // `since` is the `cursor` of the previous answer: only newer rows come back, or the latest with `reset: true`.
            // The console owns the numeric `after` (its server refuses any other type), so the log cursor travels as `since`.
            const r = readLogSince(home, { vault: vault.id, limit: 100, ...(str(args.type) ? { type: str(args.type) } : {}), ...(str(args.since) ? { after: str(args.since) } : {}) });
            return { vault: vault.id, rows: r.lines.map(parseLogLine).reverse(), cursor: r.cursor, ...(r.reset ? { reset: true } : {}), ...(r.more ? { more: true } : {}), ...(r.ok ? {} : { error: firstIssue(r as unknown as Args) }) };
          }
          case "proposals": {
            const vault = vaultOf(args);
            const state = PROPOSAL_STATES.includes(String(args.state)) ? String(args.state) : "pending";
            if (!vault) return { vault: null, state, page: null, selected: null, ...(str(args.vault) ? { error: `unknown vault ${str(args.vault)}; pick a registered vault from Overview` } : {}) };
            // The console owns the numeric `after`, so the proposal page cursor travels as `page`.
            const list = await readTool("vmem_proposal_list", args, { vault: vault.id, state, after: str(args.page) });
            const id = str(args.id);
            const shown = id ? await readTool("vmem_proposal_show", args, { vault: vault.id, id }) : undefined;
            const error = "error" in list ? list.error : shown && "error" in shown ? shown.error : undefined;
            return { vault: vault.id, state, page: "result" in list ? list.result : null, selected: shown && "result" in shown ? shown.result : null, ...(error ? { error } : {}) };
          }
          case "assertions": {
            const vault = vaultOf(args);
            if (!vault) return { vault: null, result: null, warnings: [], ...(str(args.vault) ? { error: `unknown vault ${str(args.vault)}; pick a registered vault from Overview` } : {}) };
            const r = await readTool("vmem_assertions", args, { vault: vault.id });
            const result = "result" in r ? r.result : null;
            return { vault: vault.id, result, warnings: assertionCoverageWarnings(result?.coverage as AssertionsReadResult["coverage"] | undefined), ...("error" in r ? { error: r.error } : {}) };
          }
          case "history": {
            const vault = vaultOf(args), path = str(args.path), from = str(args.from), to = str(args.to);
            if (!vault) return { vault: null, path: path ?? null, history: null, changes: null, ...(str(args.vault) ? { error: `unknown vault ${str(args.vault)}; pick a registered vault from Overview` } : {}) };
            if ((from === undefined) !== (to === undefined)) return { vault: vault.id, path: path ?? null, history: null, changes: null, error: "changes need both from and to commit ids; pick two revisions from the history list" };
            const history = path ? await readTool("vmem_history", args, { vault: vault.id, path }) : undefined;
            const changes = from && to ? await readTool("vmem_changes", args, { vault: vault.id, from, to, cursor: str(args.changesCursor) }) : undefined;
            const error = history && "error" in history ? history.error : changes && "error" in changes ? changes.error : undefined;
            return { vault: vault.id, path: path ?? null, history: history && "result" in history ? history.result : null, changes: changes && "result" in changes ? changes.result : null, ...(error ? { error } : {}) };
          }
          default: return { error: `unknown panel ${input.panel}` };
        }
      },
      async action(input) {
        const args = input as Args, confirmed = input.confirmed === true, fingerprint = str(input.fingerprint);
        switch (input.action) {
          case "settings": {
            const vault = vaultOf(args);
            if (!vault) return { ok: false, error: "settings: no selected vault; select a registered vault" };
            try {
              const changes = args.changes as import("../registry.ts").SettingsChanges;
              const preview = changeSettings(home, { vault: vault.id, changes });
              if (!confirmed || fingerprint !== preview.fingerprint) return { ok: false, needsConfirm: true, fingerprint: preview.fingerprint, verb: "Change settings", preview: Object.entries(preview.changes).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), changes: [{ op: "modify", target: "vmem.config.json" }] };
              changeSettings(home, { vault: vault.id, changes, confirm: true, fingerprint });
              return { ok: true, message: "Settings updated; restart the console and MCP server to apply the default vault and permission changes" };
            } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "settings: change failed; inspect the configuration and retry" }; }
          }
          case "delete": {
            const path = str(args.path) ?? str(args.id);
            if (!path) return { ok: false, error: "path is required" };
            return twoStep("vmem_delete", forward("vmem_delete", args, { path }), confirmed, fingerprint, p => {
              const backlinks = Array.isArray(p.backlinks) ? p.backlinks as { source: string }[] : [];
              return { verb: "Delete note", preview: [`delete ${path}`], changes: changesOf(p),
                warnings: backlinks.length ? [`${backlinks.length} links point here: ${[...new Set(backlinks.map(b => b.source))].slice(0, 5).join(", ")}`] : [] };
            });
          }
          case "link": {
            const from = str(args.from), to = str(args.to), relation = str(args.relation);
            if (!from || !to || !relation) return { ok: false, error: "link: from, to and relation are required; pick both notes and a relation" };
            if (!(LINK_RELATIONS as readonly string[]).includes(relation)) return { ok: false, error: `link: invalid relation ${relation}; use one of ${LINK_RELATIONS.join(", ")}` };
            const both = args.bidirectional !== false && args.bidirectional !== "false";
            return twoStep("vmem_link", forward("vmem_link", args, { preview: true, bidirectional: both }), confirmed, fingerprint, p => ({ verb: "Link notes",
              preview: [`link ${from} → ${to} (${relation})${both ? ", both directions" : ", one way"}`, ...(p.logEvent ? [`log: ${JSON.stringify(p.logEvent)}`] : [])], changes: changesOf(p), warnings: [] }));
          }
          case "move": {
            const from = str(args.from), to = str(args.to);
            if (!from || !to) return { ok: false, error: "from and to are required" };
            return twoStep("vmem_move", forward("vmem_move", args), confirmed, fingerprint, p => ({ verb: "Move note", preview: [`move ${from} → ${to}`], changes: changesOf(p), warnings: [] }));
          }
          case "promote": {
            const path = str(args.path), to = str(args.to);
            if (!path || !to) return { ok: false, error: "path and to are required" };
            if (vaultOf(args)?.id !== promotionSource?.id || !promotionSource) return { ok: false, error: promotionSource ? `promotion to an org vault reads from ${promotionSource.id}; open the note there` : "promotion needs a personal vault; register one with vmem vaults add" };
            return twoStep("vmem_promote", forward("vmem_promote", args), confirmed, fingerprint, p => {
              const screen = rec(p.screen), dropped = Array.isArray(p.droppedLinks) ? p.droppedLinks as string[] : [];
              const target = String(p.target ?? `${to}:${path}`);
              // A rerun after an interrupted promotion only restores the source provenance.
              const changes: Change[] = p.recovery === "provenance-only"
                ? [{ op: "modify", target: path, note: `provenance → ${target}` }]
                : [{ op: "create", target }, { op: "modify", target: path, note: "provenance" }, { op: "log", target: "log", note: "SYNC lines in both vaults" }];
              return { verb: p.recovery === "provenance-only" ? "Restore provenance" : "Promote note", preview: String(p.text ?? "").split("\n"),
                changes,
                warnings: [...(dropped.length ? [`${dropped.length} links become plain text: ${dropped.slice(0, 5).join(", ")}`] : []), ...(screen.passed === false ? ["screen reported issues"] : [])] };
            });
          }
          case "promote-from-amem": {
            const id = (str(args.id) ?? "").replace(/^mem:/, "");
            if (!/^[0-9a-f-]{32,36}$/i.test(id)) return { ok: false, error: "a memory id is required" };
            let project = str(args.project) ?? projectOf.get(id);
            if (!project) {
              try { await candidates(); }
              catch (error) {
                ctx.log(`vmem: promotion candidates unavailable: ${error instanceof Error ? error.message : String(error)}`);
                return { ok: false, error: "Promotion candidates are unavailable; see System" };
              }
              project = projectOf.get(id);
            }
            return twoStep("vmem_promote_from_amem", forward("vmem_promote_from_amem", args, { id, ...(project ? { project } : {}) }), confirmed, fingerprint, p => {
              const dupes = Array.isArray(p.possibleDuplicates) ? p.possibleDuplicates as string[] : [];
              // Linking an existing note writes no vault file; it records the link in agent-mem only.
              const changes: Change[] = p.action === "link"
                ? [{ op: "modify", target: `agent-mem mem:${id}`, note: `vault link → ${String(p.path)}` }]
                : [{ op: "create", target: String(p.path ?? "note") }, { op: "log", target: "log", note: "LEARN line" }, { op: "modify", target: `agent-mem mem:${id}`, note: "vault link" }];
              return { verb: p.action === "link" ? "Link memory" : "Promote memory", preview: String(p.text ?? `link mem:${id} → ${String(p.path)}`).split("\n"),
                changes,
                warnings: dupes.length ? [`possible duplicates: ${dupes.slice(0, 5).join(", ")}`] : [] };
            });
          }
          case "proposal-apply":
          case "proposal-reject": {
            const id = str(args.id), reason = str(args.reason), apply = input.action === "proposal-apply";
            if (!id) return { ok: false, error: "a proposal id is required; select a proposal in the Proposals panel" };
            if (!apply && !reason?.trim()) return { ok: false, error: "rejection needs a reason; enter one and reject again" };
            const tool = apply ? "vmem_proposal_apply" : "vmem_proposal_reject";
            const checked = forward(tool, args, { id, ...(apply ? {} : { reason }) });
            if (typeof checked === "string") return { ok: false, error: `${checked}; ${apply ? "select the proposal again from the Proposals panel" : "shorten the reason to at most 4096 bytes and reject again"}` };
            try {
              if (apply) return await twoStep(tool, checked, confirmed, fingerprint, p => ({ verb: "Apply proposal", preview: [`apply proposal ${id}`], changes: changesOf(p), warnings: (Array.isArray(p.issues) ? p.issues as { message?: string }[] : []).map(i => String(i.message ?? "")).filter(Boolean) }));
              // Rejection answers `rejected`, not `applied`, so its confirm step reads that receipt field itself.
              if (typeof checked === "string") return { ok: false, error: checked };
              const preview = await call(tool, checked);
              if (typeof preview.fingerprint !== "string") return { ok: false, error: firstIssue(preview) };
              if (!confirmed || fingerprint !== preview.fingerprint)
                return { ok: false, needsConfirm: true, fingerprint: preview.fingerprint, verb: "Reject proposal", preview: [`reject proposal ${id}`, `reason: ${String(preview.reason ?? reason)}`], changes: [{ op: "modify", target: `proposal ${id}`, note: "state → rejected; no note or log changes" }] };
              const done = await call(tool, { ...checked, confirm: true, fingerprint });
              if (done.rejected === true) { revision.invalidate(); inbox.invalidate(); return done.ok === true ? { ok: true, message: "Reject proposal: done" } : { ok: true, message: `Reject proposal: recorded, but ${firstIssue(done)}` }; }
              return { ok: false, error: firstIssue(done) };
            } catch (error) {
              // The provider refuses by throwing (no longer pending, apply_unknown, binding drift); its message names the next step.
              return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
          }
          default: return { ok: false, error: `unknown action ${input.action}` };
        }
      },
    };
  },
};

export default plugin;
export type { ProposalState, ProposalsSnapshot, AssertionsSnapshot, HistorySnapshot, CoverageWarning, GraphSnapshotPage, GraphPanelPage, GraphNodeColumns, GraphEdgeColumns, SemanticGraphPage } from "./panel-types.ts";
export { assertionCoverageWarnings } from "./panel-types.ts";
