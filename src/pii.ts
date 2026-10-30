import { PII_SURFACES, type PiiAction, type PiiCell, type PiiSurface, type VaultSpec, type VmemConfig } from "./config.ts";
import type { WriteIssue } from "./write-types.ts";

export const PII_CATEGORIES = ["email", "phone", "custom"] as const;
export type PiiCategory = typeof PII_CATEGORIES[number];
export type PiiRow = Record<PiiSurface, PiiAction>;
/** Effective policy: every category and surface resolved, plus named patterns and the allow list. */
export interface PiiMatrix { email: PiiRow; phone: PiiRow; custom: PiiRow; patterns: { name: string; regex: string; action: PiiRow }[]; allow: string[] }

export const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/i;
const RANK: Record<PiiAction, number> = { allow: 0, warn: 1, deny: 2 };

function row(value: PiiCell | undefined, fallback: PiiAction): PiiRow {
  const out = {} as PiiRow;
  for (const surface of PII_SURFACES) out[surface] = typeof value === "string" ? value : value?.[surface] ?? fallback;
  return out;
}
/** Resolve a vault's policy. Omitted cells default to allow for personal and deny for org vaults. */
export function piiPolicy(vault: VaultSpec): PiiMatrix {
  const fallback: PiiAction = vault.kind === "org" ? "deny" : "allow";
  const pii = vault.pii;
  if (pii === undefined || typeof pii === "string") {
    const action = pii ?? fallback;
    return { email: row(action, action), phone: row(action, action), custom: row(action, action), patterns: [], allow: [] };
  }
  return {
    email: row(pii.email, fallback), phone: row(pii.phone, fallback), custom: row(pii.custom, fallback),
    patterns: (pii.patterns ?? []).map(p => ({ name: p.name, regex: p.regex, action: row(p.action, fallback) })),
    allow: [...(pii.allow ?? [])],
  };
}
/** `allow`/`warn`/`deny` when every cell agrees and nothing else is set, else `custom`. */
export function piiShorthand(vault: VaultSpec): PiiAction | "custom" {
  const m = piiPolicy(vault), cells = PII_CATEGORIES.flatMap(c => PII_SURFACES.map(s => m[c][s]));
  return m.patterns.length || m.allow.length || cells.some(a => a !== cells[0]) ? "custom" : cells[0]!;
}
/** Cells (and allow-list or pattern changes) where `next` is more permissive than `prev`. */
export function loosenedCells(prev: PiiMatrix, next: PiiMatrix): string[] {
  const out: string[] = [];
  for (const c of PII_CATEGORIES) for (const s of PII_SURFACES) if (RANK[next[c][s]] < RANK[prev[c][s]]) out.push(`${c}.${s}: ${prev[c][s]} -> ${next[c][s]}`);
  for (const p of prev.patterns) {
    const n = next.patterns.find(q => q.name === p.name);
    if (!n) { out.push(`patterns.${p.name}: removed`); continue; }
    if (n.regex !== p.regex) out.push(`patterns.${p.name}: regex changed`);
    for (const s of PII_SURFACES) if (RANK[n.action[s]] < RANK[p.action[s]]) out.push(`patterns.${p.name}.${s}: ${p.action[s]} -> ${n.action[s]}`);
  }
  for (const value of next.allow) if (!prev.allow.includes(value)) out.push(`allow: + ${value}`);
  return out;
}

const digitsOf = (value: string) => value.replace(/\D/g, "");
const TIMESTAMP = /\b[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])[ T](?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\.[0-9]{1,3})?)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])?\b/g;
/**
 * Phone runs: exact source ranges that hold a 9-15 digit number. `single` is set when the run is exactly one number
 * (the only form the allow list can exempt). An oversized run (numbers separated by spaces) is screened by each
 * contiguous run of digit-bearing groups and stops at the first valid one; it is never exempt (fails closed).
 */
export function phoneRuns(text: string): { start: number; end: number; single?: string }[] {
  // A complete ISO calendar timestamp is metadata, not a phone-number candidate; the newline keeps neighbours apart.
  const cleaned = text.replace(TIMESTAMP, match => "\n".repeat(match.length)), out: { start: number; end: number; single?: string }[] = [];
  for (const match of cleaned.matchAll(/(?<![\p{L}\p{N}])\+?\d(?:[\d ().-]{6,}\d)(?![\p{L}\p{N}])/gu)) {
    const digits = digitsOf(match[0]), range = { start: match.index!, end: match.index! + match[0].length };
    if (digits.length >= 9 && digits.length <= 15) { out.push({ ...range, single: digits }); continue; }
    if (digits.length <= 15) continue;
    const groups = match[0].split(/\s+/).map(digitsOf).filter(Boolean);
    search: for (let from = 0; from < groups.length; from++) {
      let total = 0;
      for (let to = from; to < groups.length && total <= 15; to++) { total += groups[to]!.length; if (total >= 9 && total <= 15) { out.push(range); break search; } }
    }
  }
  return out;
}
function allowedEmail(value: string, allow: string[]): boolean {
  const lower = value.toLowerCase();
  return allow.some(entry => entry.includes("@") && (entry.startsWith("@") ? lower.endsWith(entry.toLowerCase()) : lower === entry.toLowerCase()));
}
function allowedPhone(digits: string, allow: string[]): boolean {
  return allow.some(entry => !entry.includes("@") && digitsOf(entry).length >= 9 && digitsOf(entry) === digits);
}
interface Rule { label: string; action: PiiAction; invalid?: boolean; matches: (text: string) => { start: number; end: number }[]; detect: (text: string) => boolean }
/** The non-allow rules for one surface. `detect` short-circuits; `matches` lists raw non-exempt ranges (zero-length included). */
function rules(vault: VaultSpec, config: VmemConfig, surface: PiiSurface): Rule[] {
  const m = piiPolicy(vault), out: Rule[] = [];
  const regexRule = (label: string, action: PiiAction, make: () => RegExp, exempt: (value: string) => boolean): Rule => ({
    label, action,
    matches: text => [...text.matchAll(make())].filter(x => !x[0] || !exempt(x[0])).map(x => ({ start: x.index!, end: x.index! + x[0].length })),
    detect: text => { for (const source of [text, text.normalize("NFKC")]) for (const x of source.matchAll(make())) if (!x[0] || !exempt(x[0])) return true; return false; },
  });
  if (m.email[surface] !== "allow") out.push(regexRule("email", m.email[surface], () => new RegExp(EMAIL_PATTERN.source, "gi"), v => allowedEmail(v, m.allow)));
  if (m.phone[surface] !== "allow") {
    const flagged = (text: string) => phoneRuns(text).filter(r => !(r.single && allowedPhone(r.single, m.allow)));
    out.push({ label: "phone", action: m.phone[surface], matches: flagged, detect: text => flagged(text).length > 0 || flagged(text.normalize("NFKC")).length > 0 });
  }
  const custom = (config.piiPatterns ?? []).map((regex, i) => ({ name: `custom-${i + 1}`, regex, action: m.custom[surface], flags: "" }));
  for (const p of [...custom, ...m.patterns.map(p => ({ name: p.name, regex: p.regex, action: p.action[surface], flags: "u" }))]) {
    if (p.action === "allow") continue;
    try { new RegExp(p.regex, p.flags); } catch { out.push({ label: p.name, action: "deny", invalid: true, matches: () => [], detect: () => true }); continue; }
    out.push(regexRule(p.name, p.action, () => new RegExp(p.regex, `${p.flags}g`), v => m.allow.some(a => a.toLowerCase() === v.toLowerCase())));
  }
  return out;
}
/** V07 issues for one surface: deny cells are errors, warn cells warnings. Matched values are never returned. */
export function screenPii(text: string, vault: VaultSpec, config: VmemConfig, surface: PiiSurface): WriteIssue[] {
  const issues: WriteIssue[] = [];
  for (const rule of rules(vault, config, surface)) {
    if (rule.invalid) { if (!issues.some(i => i.message === "invalid PII screening configuration")) issues.push({ code: "V07", severity: "error", message: "invalid PII screening configuration" }); continue; }
    if (!rule.detect(text)) continue;
    const builtin = rule.label === "email" || rule.label === "phone", custom = rule.label.startsWith("custom-");
    const message = rule.action === "deny"
      ? builtin ? "PII is refused by the vault policy" : custom ? "configured PII pattern matched" : `PII pattern ${rule.label} matched`
      : `PII flagged by the vault policy (${builtin || custom ? rule.label.replace(/-\d+$/, "") : `pattern ${rule.label}`}, warn)`;
    if (!issues.some(i => i.message === message)) issues.push({ code: "V07", severity: rule.action === "deny" ? "error" : "warning", message });
  }
  return issues;
}
/**
 * Replace raw ranges that a deny cell refuses on this surface with `[redacted]` (tidy --log), leaving allow-listed
 * values intact. Fails closed to a fully redacted text when a denied match is zero-length, or when the returned text
 * itself still contains a denied match (for example a form only NFKC normalization reveals, or a pattern that matches
 * the marker).
 */
export function redactPii(text: string, vault: VaultSpec, config: VmemConfig, surface: PiiSurface): { text: string; hits: number } {
  const denied = rules(vault, config, surface).filter(rule => rule.action === "deny" && !rule.invalid);
  if (!denied.some(rule => rule.detect(text))) return { text, hits: 0 };
  const ranges = denied.flatMap(rule => rule.matches(text));
  if (ranges.some(r => r.end === r.start)) return { text: "[redacted]", hits: 1 };
  const merged: { start: number; end: number }[] = [];
  for (const r of ranges.sort((a, b) => a.start - b.start || b.end - a.end)) { const last = merged.at(-1); if (last && r.start < last.end) last.end = Math.max(last.end, r.end); else merged.push({ ...r }); }
  let out = "", at = 0;
  for (const r of merged) { out += text.slice(at, r.start) + "[redacted]"; at = r.end; }
  out += text.slice(at);
  return denied.some(rule => rule.detect(out)) ? { text: "[redacted]", hits: 1 } : { text: out, hits: merged.length };
}
