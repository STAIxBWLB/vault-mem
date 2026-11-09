/**
 * Text renderers for the registry, health, setup and manifest commands (#114). Each is a pure function of the
 * command's JSON result; `--json` never comes through here, and the text shows no more than that JSON carries.
 */
import { effectiveDomains, PII_SURFACES, type SpecSourceSpec, type VaultSpec } from "./config.ts";
import type { ResolvedHome } from "./home.ts";
import type { PiiMatrix, PiiRow } from "./pii.ts";
import { effectivePii, type RecoveryReport } from "./registry.ts";
import type { SetupReport } from "./setup.ts";
import { blocks, clean, fields, heading, issueTable, nextCommand, paint, paragraph, plural, shellWord, table, tone, type CellInput, type TextOptions } from "./text-output.ts";
import { MAX_RATIO_NOTES } from "./vault-index.ts";
import type { VaultStats } from "./vault-stats.ts";

type Check = { ok: boolean; issue?: string };
export type VaultRow = Omit<VaultSpec, "pii"> & { pii: string; healthy?: boolean; issue?: string; checks?: Record<string, Check>;
  tidy?: { pending: Record<string, number>; notes: number; unparsable: string[]; hint: string } };
export type SpecRow = SpecSourceSpec & { healthy?: boolean; issue?: string };
export interface StatusResult extends ResolvedHome { version: string; healthy: boolean; vaults: VaultRow[]; specs?: SpecRow[] }
export interface Manifest { name: string; version: string; configVersion: number; mcp: { server: string; tools: (string | { name: string; readOnly: boolean })[] }; commands: string[] }

const OK = tone("ok", "ok"), WARN = tone("warn", "warn"), FAIL = tone("fail", "fail");
const homeLine = (r: StatusResult, o: TextOptions) => `${heading(`vmem ${r.version}`, o)}  home ${clean(r.home)} (${r.source})`;
const NO_VAULTS = "no vaults registered; add one with vmem vaults add <id> <absolute-path> --kind personal|org --write mcp|cli|none";

export function renderStatus(r: StatusResult, o: TextOptions): string {
  const title = `${homeLine(r, o)}  ${r.healthy ? paint("healthy", "ok", o) : paint("unhealthy", "fail", o)}`;
  const vaults = r.vaults.length ? table(["VAULT", "KIND", "WRITE", "PII", "HEALTH", "PATH"], r.vaults.map(v => [v.id, v.kind, v.write, v.pii, v.healthy ? OK : FAIL, v.path]), o) : paragraph(NO_VAULTS, o);
  const issues = r.vaults.filter(v => v.issue).map(v => paragraph(`${v.id}: ${v.issue}`, o, "fail")).join("\n");
  const specs = r.specs?.length ? table(["SOURCE", "WRITE", "PII", "PATH"], r.specs.map(s => [s.id, s.write, s.pii, s.path]), o) : undefined;
  return blocks(title, issues ? `${vaults}\n${issues}` : vaults, specs);
}

function tidyFinding(t: NonNullable<VaultRow["tidy"]>): string {
  const pending = Object.entries(t.pending).filter(([, n]) => n > 0).map(([rule, n]) => `${rule} ${n}`).join(", ");
  return [`${plural(t.notes, "note")} to migrate${pending ? ` (${pending})` : ""}`, t.unparsable.length ? `${plural(t.unparsable.length, "unparsable note")} skipped` : ""].filter(Boolean).join("; ");
}
export function renderDoctor(r: StatusResult, o: TextOptions): string {
  let failed = 0;
  const vaults = r.vaults.map(v => {
    const rows: CellInput[][] = [[v.healthy ? OK : FAIL, "path", v.healthy ? v.path : `${v.path}: ${v.issue ?? "unavailable"}`]];
    if (!v.healthy) failed++;
    for (const [name, check] of Object.entries(v.checks ?? {})) {
      if (!check.ok) failed++;
      rows.push([check.ok ? OK : FAIL, name, check.ok ? (name === "remote" ? v.remote : name === "registry" ? v.registry : "ok") : check.issue]);
    }
    if (v.tidy) rows.push([WARN, "tidy", tidyFinding(v.tidy)]);
    const next = v.tidy ? `\n${nextCommand("next", `vmem tidy ${shellWord(v.id)} --all`, o)}, then confirm its fingerprint to apply the migration` : "";
    return `${heading(`Vault ${v.id}`, o)}\n${table(["LEVEL", "CHECK", "FINDING"], rows, o)}${next}`;
  });
  const specs = (r.specs ?? []).map(s => {
    if (s.healthy === false) failed++;
    return `${heading(`Spec source ${s.id}`, o)}\n${table(["LEVEL", "CHECK", "FINDING"], [[s.healthy === false ? FAIL : OK, "root", s.healthy === false ? s.issue : s.path]], o)}`;
  });
  const checked = [plural(r.vaults.length, "vault"), ...(r.specs ? [plural(r.specs.length, "spec source")] : [])].join(" and ");
  const verdict = r.healthy ? paragraph(`healthy: ${checked} checked`, o, "ok")
    : paragraph(`unhealthy: ${plural(failed, "failed check")}; fix the findings above, then run vmem doctor again`, o, "fail");
  return blocks(homeLine(r, o), r.vaults.length ? undefined : paragraph(NO_VAULTS, o), ...vaults, ...specs, verdict);
}

export function renderStats(r: VaultStats, o: TextOptions): string {
  const counts = (record: Record<string, number>) => fields(Object.entries(record).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)), o);
  const block = (name: string, body: string | undefined) => body ? `${heading(name, o)}\n${body}` : undefined;
  const size = r.size.total, ratio = r.ratio;
  const notFile = ratio.skippedNonFile ? `, ${ratio.skippedNonFile} not a file` : "";
  // No ratio can be printed either because nothing was readable or because every readable source was empty.
  const noRatio = ratio.sources ? "no cited source had a nonzero size" : "no note cites a readable workspace file";
  const ratioBody = ratio.notes
    ? fields([["notes", plural(ratio.notes, "note")], ["sources", plural(ratio.sources, "file")], ["median", ratio.median ?? ""], ["p90", ratio.p90 ?? ""],
      ["over 1", plural(ratio.overOne, "note")], ["skipped", `${plural(ratio.skipped, "source reference")}${notFile}`],
      ["truncated", ratio.truncatedNotes ? `${plural(ratio.truncatedNotes, "note")} past the ${MAX_RATIO_NOTES}-note cap` : ""],
      ["largest", ratio.largest.map(entry => `${entry.path} ${entry.ratio}`).join("; ")]], o)
    : paragraph(`${noRatio}${ratio.skipped ? `; ${plural(ratio.skipped, "source reference")} skipped` : ""}${ratio.truncatedNotes ? `; ${plural(ratio.truncatedNotes, "note")} past the ${MAX_RATIO_NOTES}-note cap` : ""}`, o);
  const log = r.log.total === null ? paragraph("unreadable; see the issues below", o, "fail", "  ")
    : fields([["total", r.log.total], ...Object.entries(r.log.byType ?? {}).filter(([, n]) => n > 0).sort(([a, x], [b, y]) => y - x || a.localeCompare(b))], o);
  return blocks(`${heading(r.vault, o)}  ${plural(r.notes.total, "note")} as of ${r.asOf}`,
    block("Notes by type", counts(r.notes.byType)), block("Notes by domain", counts(r.notes.byDomain)), block("Notes by status", counts(r.notes.byStatus)),
    block("Note size", size.notes ? fields([["total", `${plural(size.bytes, "byte")}, ${plural(size.words, "word")}`]], o) : undefined),
    block("Note-to-source ratio", ratioBody),
    block("Modified", fields([["last 7 days", r.modified.last7Days], ["last 30 days", r.modified.last30Days]], o)),
    block(`Log since ${r.log.since} (${plural(r.log.days, "day")})`, log),
    r.log.warnings.map(w => paragraph(`warning: ${w}`, o, "warn")).join("\n"), issueTable(r.log.issues, o));
}

export function renderRecover(r: RecoveryReport, o: TextOptions): string {
  const owner = r.lock.owner ? `pid ${r.lock.owner.pid} on ${r.lock.owner.host} since ${r.lock.owner.created}` : undefined;
  const detail = fields([["lock", r.lock.path], ["state", r.lock.state], ["owner", owner], ["temporary files", r.temporaryFiles.join(", ")]], o);
  if (r.blocked) return blocks(paragraph(`recovery blocked: ${r.blocked}`, o, "fail"), detail);
  if (r.applied) {
    const done = [r.lock.removed ? "the stale registry lock" : "", r.removedTemporaryFiles.length ? plural(r.removedTemporaryFiles.length, "temporary config file") : ""].filter(Boolean);
    return paragraph(done.length ? `recovered: removed ${done.join(" and ")}` : "nothing to recover: no stale lock and no temporary config files", o, done.length ? "ok" : undefined);
  }
  const work = [r.lock.state === "stale" ? "the stale registry lock" : "", r.temporaryFiles.length ? plural(r.temporaryFiles.length, "temporary config file") : ""].filter(Boolean);
  if (!work.length) return paragraph("nothing to recover: no stale lock and no temporary config files", o);
  return blocks(paragraph(`dry run: would remove ${work.join(" and ")}`, o), detail, nextCommand("confirm", "vmem recover --confirm", o));
}

export function renderVaultsList(vaults: VaultRow[], o: TextOptions): string {
  return vaults.length ? table(["VAULT", "KIND", "WRITE", "PII", "DOMAINS", "PATH"], vaults.map(v => [v.id, v.kind, v.write, v.pii, effectiveDomains(v).join(", "), v.path]), o) : paragraph(NO_VAULTS, o);
}
export function renderVaultAdd(r: { vault: VaultSpec }, o: TextOptions): string {
  const v = r.vault;
  return paragraph(`registered vault ${v.id}: ${v.kind}, write ${v.write}, PII ${effectivePii(v)}, at ${v.path}`, o, "ok");
}
export function renderSpecsList(specs: SpecSourceSpec[], o: TextOptions): string {
  return specs.length ? table(["SOURCE", "WRITE", "PII", "PATH"], specs.map(s => [s.id, s.write, s.pii, s.path]), o)
    : paragraph("no spec sources registered; add one with vmem specs add <id> <absolute-path>", o);
}
export function renderSpecAdd(r: { spec: SpecSourceSpec }, o: TextOptions): string {
  return paragraph(`registered spec source ${r.spec.id}: write ${r.spec.write}, PII ${r.spec.pii}, at ${r.spec.path}`, o, "ok");
}
/** `vaults remove` and `specs remove`: unregistering only, so the files are always said to stay. */
export function renderRemove(group: "vaults" | "specs", r: { applied: boolean; vault?: { id: string; path: string }; spec?: { id: string; path: string } }, o: TextOptions): string {
  const entry = (r.vault ?? r.spec)!, what = `${group === "vaults" ? "vault" : "spec source"} ${entry.id} at ${entry.path}`;
  const stays = group === "vaults" ? "its files stay on disk" : "the repository stays on disk";
  if (r.applied) return paragraph(`unregistered ${what}; ${stays}`, o, "ok");
  return blocks(paragraph(`dry run: would unregister ${what}; ${stays}`, o), nextCommand("confirm", `vmem ${group} remove ${shellWord(entry.id)} --confirm`, o));
}

export interface PiiResult { vault: string; pii: string; piiPolicy: PiiMatrix; applied?: boolean; changed?: boolean; loosened?: string[]; preview?: true }
/** `confirm` is the exact command that applies a preview; the result itself does not carry the `--set` value. */
export function renderVaultPii(r: PiiResult, o: TextOptions, confirm?: string): string {
  const row = (name: string, cells: PiiRow): CellInput[] => [name, ...PII_SURFACES.map(surface => cells[surface])];
  const matrix = table(["CATEGORY", "NOTES", "LOG", "PROMOTION"], [row("email", r.piiPolicy.email), row("phone", r.piiPolicy.phone), row("custom", r.piiPolicy.custom),
    ...r.piiPolicy.patterns.map(p => row(`pattern ${p.name}`, p.action))], o);
  const allow = r.piiPolicy.allow.length ? paragraph(`allow list: ${plural(r.piiPolicy.allow.length, "entry", "entries")} (shown with --json)`, o) : undefined;
  const title = r.changed === undefined ? `Vault ${r.vault} PII policy: ${r.pii}`
    : !r.changed ? `unchanged: vault ${r.vault} already has this PII policy (${r.pii})`
    : r.applied ? `set the PII policy of vault ${r.vault} to ${r.pii}` : `dry run: would set the PII policy of vault ${r.vault} to ${r.pii}`;
  const loosened = r.loosened?.length ? r.loosened.map(cell => paragraph(`loosens ${cell}`, o, "warn")).join("\n") : undefined;
  const next = r.preview && r.changed && confirm ? nextCommand("confirm", confirm, o) : undefined;
  return blocks(paragraph(title, o, r.applied ? "ok" : undefined), matrix, allow, loosened, next);
}

export function renderManifest(m: Manifest, o: TextOptions): string {
  const tools = m.mcp.tools.map(t => typeof t === "string" ? [t, "may write"] : [t.name, tone("read-only", "muted")]);
  return blocks(`${heading(`${m.name} ${m.version}`, o)}  config format ${m.configVersion}`,
    `${heading(`MCP server ${m.mcp.server}`, o)}: ${plural(tools.length, "tool")}\n${table(["TOOL", "ACCESS"], tools, o)}`,
    `${heading("Commands", o)}: ${m.commands.length}\n${paragraph(m.commands.join(", "), o, undefined, "  ")}`);
}

/** `apply` is the exact command that applies a dry run. */
export function renderSetup(r: SetupReport, o: TextOptions, apply?: string): string {
  const rows = [...r.actions.map(a => ({ host: a.target, ...a })), ...(r.console ? [{ host: "console", ...r.console }] : [])];
  const reasons = rows.some(a => a.reason), refused = rows.filter(a => a.change === "refused").length, pending = rows.some(a => !["none", "unchanged", "refused"].includes(a.change));
  const title = r.mode === "dry-run" ? "dry run: nothing written" : r.applied ? (r.mode === "apply" ? "setup applied" : "setup undone") : "unchanged: nothing to do";
  const changeTone = (change: string) => change === "refused" ? "fail" : ["none", "unchanged"].includes(change) ? "muted" : "info";
  return blocks(paragraph(title, o, r.applied ? "ok" : undefined),
    fields([["server", [r.entry.command, ...r.entry.args].map(shellWord).join(" ")], ["root", r.root ? `${r.root.path} (${r.root.version})` : undefined]], o),
    rows.length ? table(["HOST", "CHANGE", "PATH", ...(reasons ? ["REASON"] : [])], rows.map(a => [a.host, tone(a.change, changeTone(a.change)), a.file, a.reason]), o) : undefined,
    r.notes.map(note => paragraph(note, o)).join("\n"),
    refused ? paragraph(`${plural(refused, "host")} refused; see REASON.`, o, "fail") : undefined,
    r.mode === "dry-run" && pending && apply ? nextCommand("apply", apply, o) : undefined);
}
