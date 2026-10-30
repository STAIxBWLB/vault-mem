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
type PhonePart = { start: number; end: number; digits: string };
/**
 * Phone candidates: each exact source run, the phone numbers (as digits) inside it and their raw positions.
 * In an oversized run (several numbers separated by spaces) every contiguous run of digit-bearing groups with
 * 9-15 digits is a candidate (fails closed), except that groups forming an allow-listed number are protected:
 * no candidate crosses them. Each group carries at least one digit, so the work per run is linear.
 */
export function phoneMatches(text: string, allow: string[] = []): { text: string; index: number; phones: string[]; parts: PhonePart[] }[] {
  // A complete ISO calendar timestamp is metadata, not a phone-number candidate; the newline keeps neighbours apart.
  const cleaned = text.replace(TIMESTAMP, match => "\n".repeat(match.length)), out: { text: string; index: number; phones: string[]; parts: PhonePart[] }[] = [];
  for (const match of cleaned.matchAll(/(?<![\p{L}\p{N}])\+?\d(?:[\d ().-]{6,}\d)(?![\p{L}\p{N}])/gu)) {
    const count = digitsOf(match[0]).length, base = match.index!, parts: PhonePart[] = [];
    if (count >= 9 && count <= 15) parts.push({ start: base, end: base + match[0].length, digits: digitsOf(match[0]) });
    else if (count > 15) {
      const groups = [...match[0].matchAll(/\S+/g)].map(g => ({ start: base + g.index!, end: base + g.index! + g[0].length, digits: digitsOf(g[0]) })).filter(g => g.digits);
      const spans = (visit: (from: number, to: number, digits: string) => void) => {
        for (let from = 0; from < groups.length; from++) {
          let total = "";
          for (let to = from; to < groups.length && total.length <= 15; to++) { total += groups[to]!.digits; if (total.length >= 9 && total.length <= 15) visit(from, to, total); }
        }
      };
      const protectedGroup = new Array<boolean>(groups.length).fill(false);
      spans((from, to, digits) => { if (allowedPhone(digits, allow)) for (let k = from; k <= to; k++) protectedGroup[k] = true; });
      spans((from, to, digits) => {
        if (allowedPhone(digits, allow)) { parts.push({ start: groups[from]!.start, end: groups[to]!.end, digits }); return; }
        for (let k = from; k <= to; k++) if (protectedGroup[k]) return;
        parts.push({ start: groups[from]!.start, end: groups[to]!.end, digits });
      });
    }
    const phones = parts.map(part => part.digits);
    if (phones.length) out.push({ text: text.slice(match.index!, match.index! + match[0].length), index: match.index!, phones, parts });
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
interface Finding { label: string; action: PiiAction; spans: [number, number][]; unlocated: boolean; invalid?: boolean }
/** Per-code-point NFKC view of `text`: each view index maps to the raw code point it came from. */
function normalizedView(text: string): { view: string; start: number[]; end: number[] } {
  let view = ""; const start: number[] = [], end: number[] = [];
  for (let i = 0; i < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(i)!), n = ch.normalize("NFKC");
    for (let k = 0; k < n.length; k++) { start.push(i); end.push(i + ch.length); }
    view += n; i += ch.length;
  }
  return { view, start, end };
}
/**
 * Non-exempt matches per category. Detection looks at the raw text, its full NFKC form and a per-code-point NFKC view.
 * Spans are view matches mapped to every raw code point they overlap. `unlocated` is set when some detected match
 * has no span: a zero-length match, or more matches in the raw or full NFKC text than were located.
 */
function findings(text: string, vault: VaultSpec, config: VmemConfig, surface: PiiSurface): Finding[] {
  const m = piiPolicy(vault), out: Finding[] = [], full = text.normalize("NFKC"), { view, start, end } = normalizedView(text);
  const toRaw = (from: number, to: number): [number, number] => [start[from]!, end[to - 1]!];
  const scan = (label: string, action: PiiAction, make: () => RegExp, exempt: (value: string) => boolean) => {
    const hits = (source: string) => [...source.matchAll(make())].filter(x => !x[0] || !exempt(x[0]));
    const raw = hits(text), normal = hits(full), viewed = hits(view), located = viewed.filter(x => x[0]);
    if (!raw.length && !normal.length && !viewed.length) return;
    const unlocated = [raw, normal, viewed].some(list => list.some(x => !x[0])) || raw.length > located.length || normal.length > located.length;
    out.push({ label, action, spans: located.map(x => toRaw(x.index!, x.index! + x[0].length)), unlocated });
  };
  if (m.email[surface] !== "allow") scan("email", m.email[surface], () => new RegExp(EMAIL_PATTERN.source, "gi"), v => allowedEmail(v, m.allow));
  if (m.phone[surface] !== "allow") {
    const flagged = (source: string) => phoneMatches(source, m.allow).flatMap(r => r.parts).filter(part => !allowedPhone(part.digits, m.allow));
    const raw = flagged(text), normal = flagged(full), viewed = flagged(view);
    if (raw.length || normal.length || viewed.length) out.push({ label: "phone", action: m.phone[surface], spans: viewed.map(part => toRaw(part.start, part.end)), unlocated: raw.length > viewed.length || normal.length > viewed.length });
  }
  const custom = (config.piiPatterns ?? []).map((regex, i) => ({ name: `custom-${i + 1}`, regex, action: m.custom[surface], flags: "" }));
  for (const p of [...custom, ...m.patterns.map(p => ({ name: p.name, regex: p.regex, action: p.action[surface], flags: "u" }))]) {
    if (p.action === "allow") continue;
    try { new RegExp(p.regex, p.flags); } catch { out.push({ label: p.name, action: "deny", spans: [], unlocated: true, invalid: true }); continue; }
    scan(p.name, p.action, () => new RegExp(p.regex, `${p.flags}g`), v => m.allow.some(a => a.toLowerCase() === v.toLowerCase()));
  }
  return out;
}
/** V07 issues for one surface: deny cells are errors, warn cells warnings. Matched values are never returned. */
export function screenPii(text: string, vault: VaultSpec, config: VmemConfig, surface: PiiSurface): WriteIssue[] {
  const issues: WriteIssue[] = [];
  for (const f of findings(text, vault, config, surface)) {
    if (f.invalid) { issues.push({ code: "V07", severity: "error", message: "invalid PII screening configuration" }); continue; }
    const builtin = f.label === "email" || f.label === "phone", custom = f.label.startsWith("custom-");
    const message = f.action === "deny"
      ? builtin ? "PII is refused by the vault policy" : custom ? "configured PII pattern matched" : `PII pattern ${f.label} matched`
      : `PII flagged by the vault policy (${builtin || custom ? f.label.replace(/-\d+$/, "") : `pattern ${f.label}`}, warn)`;
    if (!issues.some(i => i.message === message)) issues.push({ code: "V07", severity: f.action === "deny" ? "error" : "warning", message });
  }
  return issues;
}
/**
 * Replace the spans a deny cell refuses on this surface with `[redacted]` (tidy --log), leaving allow-listed text untouched.
 * If any denied match cannot be located in the raw text, the whole text is redacted before any replacement (fail closed).
 */
export function redactPii(text: string, vault: VaultSpec, config: VmemConfig, surface: PiiSurface): { text: string; hits: number } {
  const denied = findings(text, vault, config, surface).filter(f => f.action === "deny" && !f.invalid);
  if (!denied.length) return { text, hits: 0 };
  if (denied.some(f => f.unlocated)) return { text: "[redacted]", hits: 1 };
  const spans = denied.flatMap(f => f.spans).sort((a, b) => a[0] - b[0] || b[1] - a[1]), merged: [number, number][] = [];
  for (const span of spans) { const last = merged.at(-1); if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]); else merged.push([...span]); }
  let out = "", at = 0;
  for (const [from, to] of merged) { out += text.slice(at, from) + "[redacted]"; at = to; }
  return { text: out + text.slice(at), hits: merged.length };
}
