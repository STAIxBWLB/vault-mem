import { Report } from "@staix/cli-output";
/**
 * Text renderers for the registry, health, setup and manifest commands (#114). Each is a pure function of the
 * command's JSON result; `--json` never comes through here, and the text shows no more than that JSON carries.
 */
import { effectiveDomains, PII_SURFACES, type SpecSourceSpec, type VaultSpec } from "./config.ts";
import type { ResolvedHome } from "./home.ts";
import type { PiiMatrix, PiiRow } from "./pii.ts";
import { effectivePii, type RecoveryReport, type SettingsResult, type SettingsSnapshot } from "./registry.ts";
import type { SetupReport } from "./setup.ts";
import type { SkillInstallReport } from "./skills-install.ts";
import { plural, shellWord, type TextOptions } from "./text-output.ts";
import { MAX_RATIO_NOTES } from "./vault-index.ts";
import type { VaultStats } from "./vault-stats.ts";

type Check = { ok: boolean; issue?: string };
export type VaultRow = Omit<VaultSpec, "pii"> & { pii: string; healthy?: boolean; issue?: string; checks?: Record<string, Check>;
  tidy?: { pending: Record<string, number>; notes: number; unparsable: string[]; hint: string } };
export type SpecRow = SpecSourceSpec & { healthy?: boolean; issue?: string };
export interface StatusResult extends ResolvedHome { version: string; agentMem?: { version: string; hostApi: number; hostApiMin: number }; healthy: boolean; vaults: VaultRow[]; specs?: SpecRow[] }
export interface Manifest { name: string; version: string; configVersion: number; mcp: { server: string; tools: (string | { name: string; readOnly: boolean })[] }; commands: string[] }

const report = (name: string, o: TextOptions) => new Report(o.columns, o.ascii).header("vmem", name);
const render = (r: Report, o: TextOptions) => r.render(o.color).join("\n");
const NO_VAULTS = "no vaults registered";
const plainReason = (reason: string) => reason.replace(/`(vmem [^`]+)`/g, "$1");

export function renderStatus(r: StatusResult, o: TextOptions): string {
  const out = report("status", o);
  const issues = r.vaults.filter(v => v.issue);
  if (issues.length) { out.section("Problems"); for (const v of issues) out.bullet("fail", `${v.id}: ${v.issue}`); }
  out.section("Home").kv([["Version", r.version], ["Home", r.home], ["Source", r.source], ["Health", r.healthy ? "healthy" : "unhealthy"], ["agent-mem", r.agentMem?.version], ["Host API", r.agentMem?.hostApi]]);
  out.section("Vaults");
  if (r.vaults.length) out.table(["Vault", "Kind", "Write", "PII", "Health", "Path"], r.vaults.map(v => [v.id, v.kind, v.write, v.pii, v.healthy ? "ok" : "failed", v.path]));
  else out.note(NO_VAULTS).next("vmem help vaults add");
  out.section("Spec sources");
  if (r.specs?.length) out.table(["Source", "Write", "PII", "Path"], r.specs.map(s => [s.id, s.write, s.pii, s.path]));
  else out.note("no spec sources registered").next("vmem help specs add");
  return render(out, o);
}

function tidyFinding(t: NonNullable<VaultRow["tidy"]>): string {
  const pending = Object.entries(t.pending).filter(([, n]) => n > 0).map(([rule, n]) => `${rule} ${n}`).join(", ");
  return [`${plural(t.notes, "note")} to migrate${pending ? ` (${pending})` : ""}`, t.unparsable.length ? `${plural(t.unparsable.length, "unparsable note")} skipped` : ""].filter(Boolean).join("; ");
}
export function renderDoctor(r: StatusResult, o: TextOptions): string {
  const out = report("doctor", o);
  const findings: { marker: "ok" | "fail" | "warn"; text: string; next?: string }[] = [];
  for (const v of r.vaults) {
    findings.push({ marker: v.healthy ? "ok" : "fail", text: `${v.id} path: ${v.healthy ? v.path : `${v.path}: ${v.issue ?? "unavailable"}`}` });
    for (const [name, check] of Object.entries(v.checks ?? {})) findings.push({ marker: check.ok ? "ok" : "fail", text: `${v.id} ${name}: ${check.ok ? (name === "remote" ? v.remote : name === "registry" ? v.registry : "ok") : (name === "remote" ? (check.issue ?? "unavailable").replace("; nothing was fetched or pushed", "") : check.issue ?? "unavailable")}`,
      ...(!check.ok && name === "remote" ? { next: `git -C ${shellWord(v.path)} remote -v` } : {}) });
    if (v.tidy) findings.push({ marker: "warn", text: `${v.id} tidy: ${tidyFinding(v.tidy)}`, next: `vmem tidy ${shellWord(v.id)} --all` });
  }
  for (const s of r.specs ?? []) findings.push({ marker: s.healthy === false ? "fail" : "ok", text: `${s.id} root: ${s.healthy === false ? s.issue : s.path}` });
  out.section("Findings");
  if (!findings.length) out.note(NO_VAULTS);
  for (const finding of findings.sort((a, b) => ({ fail: 0, warn: 1, ok: 2 }[a.marker] - { fail: 0, warn: 1, ok: 2 }[b.marker]))) {
    out.bullet(finding.marker, finding.text); if (finding.next) out.next(finding.next);
  }
  out.section("Home").kv([["Version", r.version], ["Home", r.home], ["Source", r.source], ["agent-mem", r.agentMem?.version], ["Host API", r.agentMem?.hostApi]]);
  out.summary({ failed: findings.filter(f => f.marker === "fail").length, warnings: findings.filter(f => f.marker === "warn").length, ok: findings.filter(f => f.marker === "ok").length, unknown: findings.length ? 0 : 1 });
  return render(out, o);
}

export function renderStats(r: VaultStats, o: TextOptions): string {
  const out = report("stats", o);
  if (r.log.issues.length || r.log.warnings.length) {
    out.section("Log problems");
    for (const issue of r.log.issues) out.bullet("fail", `${issue.code}: ${issue.message}`);
    for (const warning of r.log.warnings) out.bullet("warn", warning);
  }
  out.section("Vault").kv([["Vault", r.vault], ["As of", r.asOf], ["Notes", r.notes.total]]);
  for (const [name, record] of [["Notes by type", r.notes.byType], ["Notes by domain", r.notes.byDomain], ["Notes by status", r.notes.byStatus]] as const) {
    if (Object.keys(record).length) out.section(name).kv(Object.entries(record).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)));
  }
  if (r.size.total.notes) out.section("Note size").kv([["Bytes", r.size.total.bytes], ["Words", r.size.total.words]]);
  const ratio = r.ratio;
  out.section("Note-to-source ratio").kv([["Notes", ratio.notes], ["Sources", ratio.sources], ["Median", ratio.median], ["P90", ratio.p90], ["Over 1", ratio.overOne], ["Skipped references", ratio.skipped], ["Not a file", ratio.skippedNonFile], ["Empty source notes", ratio.emptySourceNotes], ["Notes past cap", ratio.truncatedNotes]]);
  if (!ratio.notes) out.note(ratio.sources ? "no cited source had a nonzero size" : "no note cites a readable workspace file");
  if (ratio.truncatedNotes) out.note(`${plural(ratio.truncatedNotes, "note")} past the ${MAX_RATIO_NOTES}-note cap`);
  for (const entry of ratio.largest) out.bullet("absent", `${entry.path}: ${entry.ratio}`);
  out.section("Modified").kv([["Last 7 days", r.modified.last7Days], ["Last 30 days", r.modified.last30Days]]);
  out.section("Log").kv([["Since", r.log.since], ["Days", r.log.days], ["Total", r.log.total], ...Object.entries(r.log.byType ?? {}).filter(([, n]) => n > 0).sort(([a, x], [b, y]) => y - x || a.localeCompare(b))]);
  return render(out, o);
}

export function renderRecover(r: RecoveryReport, o: TextOptions): string {
  const out = report("recover", o).section("Registry");
  if (r.blocked) out.bullet("fail", `recovery blocked: ${r.blocked}`);
  else if (r.applied) out.bullet("ok", r.lock.removed || r.removedTemporaryFiles.length ? "recovery applied" : "nothing to recover");
  else if (r.lock.state === "stale" || r.temporaryFiles.length) { out.bullet("pending", "dry run: recovery is available"); out.next("vmem recover --confirm"); }
  else out.note("nothing to recover");
  out.kv([["Lock", r.lock.path], ["State", r.lock.state], ["Owner", r.lock.owner ? `pid ${r.lock.owner.pid} on ${r.lock.owner.host} since ${r.lock.owner.created}` : null], ["Temporary files", r.temporaryFiles.join(", ")], ["Removed temporary files", r.removedTemporaryFiles.join(", ")]]);
  return render(out, o);
}

export function renderVaultsList(vaults: VaultRow[], o: TextOptions): string {
  const out = report("vaults", o).section("Vaults");
  if (vaults.length) out.table(["Vault", "Kind", "Write", "PII", "Domains", "Path"], vaults.map(v => [v.id, v.kind, v.write, v.pii, effectiveDomains(v).join(", "), v.path]), 4);
  else out.note(NO_VAULTS).next("vmem help vaults add");
  return render(out, o);
}
export function renderVaultAdd(r: { vault: VaultSpec }, o: TextOptions): string {
  const v = r.vault, out = report("vaults add", o).section("Vault").bullet("ok", `registered ${v.id}`).kv([["Kind", v.kind], ["Write", v.write], ["PII", effectivePii(v)], ["Path", v.path]]);
  return render(out, o);
}
export function renderSpecsList(specs: SpecSourceSpec[], o: TextOptions): string {
  const out = report("specs", o).section("Spec sources");
  if (specs.length) out.table(["Source", "Write", "PII", "Path"], specs.map(s => [s.id, s.write, s.pii, s.path])); else out.note("no spec sources registered").next("vmem help specs add");
  return render(out, o);
}
export function renderSpecAdd(r: { spec: SpecSourceSpec }, o: TextOptions): string {
  return render(report("specs add", o).section("Spec source").bullet("ok", `registered ${r.spec.id}`).kv([["Write", r.spec.write], ["PII", r.spec.pii], ["Path", r.spec.path]]), o);
}
export function renderRemove(group: "vaults" | "specs", r: { applied: boolean; vault?: { id: string; path: string }; spec?: { id: string; path: string } }, o: TextOptions): string {
  const entry = (r.vault ?? r.spec)!, out = report(`${group} remove`, o).section("Registration");
  out.bullet(r.applied ? "ok" : "pending", `${r.applied ? "unregistered" : "dry run: would unregister"} ${entry.id}; ${group === "vaults" ? "its files stay on disk" : "the repository stays on disk"}`).kv([["Path", entry.path]]);
  if (!r.applied) out.next(`vmem ${group} remove ${shellWord(entry.id)} --confirm`);
  return render(out, o);
}

export interface PiiResult { vault: string; pii: string; piiPolicy: PiiMatrix; applied?: boolean; changed?: boolean; loosened?: string[]; preview?: true }
export function renderVaultPii(r: PiiResult, o: TextOptions, confirm?: string): string {
  const out = report("vaults pii", o).section("Policy");
  for (const cell of r.loosened ?? []) out.bullet("warn", `loosens ${cell}`);
  out.kv([["Vault", r.vault], ["Policy", r.pii], ["State", r.changed === undefined ? "current" : !r.changed ? "unchanged" : r.applied ? "applied" : "preview"], ["Allow list", r.piiPolicy.allow.length]]);
  const row = (name: string, cells: PiiRow): string[] => [name, ...PII_SURFACES.map(surface => cells[surface])];
  out.section("Categories").table(["Category", "Notes", "Log", "Promotion"], [row("email", r.piiPolicy.email), row("phone", r.piiPolicy.phone), row("custom", r.piiPolicy.custom), ...r.piiPolicy.patterns.map(p => row(`pattern ${p.name}`, p.action))]);
  if (r.preview && r.changed && confirm) out.next(confirm);
  return render(out, o);
}

export function renderManifest(m: Manifest, o: TextOptions): string {
  const out = report("manifest", o).section("Package").kv([["Name", m.name], ["Version", m.version], ["Config format", m.configVersion]]);
  out.section("MCP").kv([["Server", m.mcp.server]]).table(["Tool", "Access"], m.mcp.tools.map(t => typeof t === "string" ? [t, "may write"] : [t.name, "read-only"]));
  out.section("Commands"); for (const command of m.commands) out.bullet("absent", command);
  return render(out, o);
}

export function renderSettings(result: SettingsSnapshot | SettingsResult, o: TextOptions, next?: string): string {
  const out = report("settings", o).section("Settings");
  if ("changes" in result) {
    out.bullet(result.applied ? "ok" : "pending", result.applied ? "settings applied" : "settings preview");
    out.kv(Object.entries(result.changes).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value]));
    out.kv([["Fingerprint", result.fingerprint]]); if (next) out.next(next);
  } else out.kv([["Vault", result.vault], ["Home", result.home], ["Default vault", result.defaultVault], ["Default explicit", result.defaultVaultExplicit], ["Write", result.write], ["PII patterns", result.piiPatterns.join(", ")], ["Graph resolution", result.graphResolution], ["Enrichment enabled", result.enrichmentEnabled]]);
  return render(out, o);
}

export function renderSetup(r: SetupReport, o: TextOptions, apply?: string): string {
  const out = report("setup", o);
  const rows = [...r.actions.map(a => ({ host: a.target, file: a.file, change: a.change, reason: a.reason })), ...(r.console ? [{ host: "console", file: r.console.file, change: r.console.change, reason: r.console.reason }] : [])];
  const problems = [...rows.filter(a => a.change === "refused").map(a => `${a.host}: ${plainReason(a.reason ?? "refused")}`), ...(r.skills ?? []).flatMap(s => s.refused ? [`${s.target} skills: ${plainReason(s.reason ?? "refused")}`] : (s.report?.actions ?? []).filter(a => ["refused", "foreign", "modified"].includes(a.change)).map(a => `${s.target} ${a.name}: ${plainReason(a.reason ?? a.change)}`))];
  if (problems.length) { out.section("Problems"); for (const problem of problems) out.bullet("fail", problem); }
  out.section("Server").kv([["Command", [r.entry.command, ...r.entry.args].map(shellWord).join(" ")], ["Root", r.root ? `${r.root.path} (${r.root.version})` : null], ["Mode", r.mode]]);
  out.section("Hosts");
  for (const a of [...rows].sort((a,b) => Number(b.change === "refused") - Number(a.change === "refused"))) out.bullet(a.change === "refused" ? "fail" : a.change === "none" || a.change === "unchanged" ? "absent" : "ok", `${a.host}: ${a.change} ${a.file}${a.reason ? `; ${plainReason(a.reason)}` : ""}`);
  for (const skill of r.skills ?? []) {
    out.section(`${skill.target} skills`);
    if (!skill.report) out.bullet(skill.refused ? "fail" : "absent", `${skill.refused ? "refused" : "none"}${skill.reason ? `: ${plainReason(skill.reason)}` : ""}`);
    else for (const a of [...skill.report.actions].sort((a, b) => Number(["refused", "foreign", "modified"].includes(b.change)) - Number(["refused", "foreign", "modified"].includes(a.change)))) {
      out.bullet(["refused", "foreign", "modified"].includes(a.change) ? "fail" : ["none", "unchanged", "absent"].includes(a.change) ? "absent" : "ok", `${a.name}: ${a.change} ${a.path}${a.reason ? `; ${a.reason.replace(/`(vmem [^`]+)`/g, "$1")}` : ""}`);
    }
  }
  const allChanges = [...rows.map(a => a.change), ...(r.skills ?? []).flatMap(s => s.report ? s.report.actions.map(a => a.change) : [s.refused ? "refused" : "none"])];
  const failed = allChanges.filter(c => ["refused", "foreign", "modified"].includes(c)).length;
  const changed = allChanges.filter(c => !["none", "unchanged", "absent", "refused", "foreign", "modified"].includes(c)).length;
  if (changed && r.mode !== "undo") {
    out.section("Notes");
    if (rows.some(a => a.host !== "console" && ["add", "replace"].includes(a.change))) out.note("Restart the host session to load the vmem MCP server.");
    if (rows.some(a => a.host === "console" && ["add", "replace"].includes(a.change))) out.note("Run setup again after upgrading vmem to refresh the console plugin.");
    if (r.notes.some(note => note.includes("user-level hosts"))) out.note("The all target covers user-level hosts; run vmem setup agy inside a workspace for Antigravity.");
  }
  if (r.mode === "dry-run" && changed && apply) out.next(apply);
  out.summary({ failed, ok: allChanges.length - failed, unknown: allChanges.length ? 0 : 1 });
  return render(out, o);
}

export function renderSkillsExport(r: SkillInstallReport, o: TextOptions): string {
  const out = report("skills export", o).section("Skills").kv([["Root", r.root]]);
  for (const a of [...r.actions].sort((a, b) => Number(["refused", "foreign", "modified"].includes(b.change)) - Number(["refused", "foreign", "modified"].includes(a.change)))) {
    out.bullet(["refused", "foreign", "modified"].includes(a.change) ? "fail" : ["unchanged", "absent"].includes(a.change) ? "absent" : "ok", `${a.name}: ${a.change} ${a.path}${a.reason ? `; ${a.reason.replace(/`(vmem [^`]+)`/g, "$1")}` : ""}`);
  }
  return render(out, o);
}
