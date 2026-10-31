import { localDate } from "./local-date.ts";
import { createHash } from "node:crypto";
import type { VaultSpec } from "./config.ts";
import { emitFrontmatter, parseFrontmatter } from "./frontmatter.ts";
import { loadRegistry } from "./registry.ts";
import { VaultIndex } from "./vault-index.ts";
import { applyWrite } from "./writer.ts";
import { notePath } from "./write-operations.ts";
import type { WriteIssue, WriteReceipt } from "./write-types.ts";
import type { AmemCandidate, AmemSeam, AmemOptions } from "./amem/seam.ts";

/** Explicit metadata that overrides the prefill from the agent-mem entry. */
export interface PromoteMetadata { stem?: string; type?: string; domain?: string; topics?: string[]; description?: string; title?: string; body?: string; logProject?: string }
export interface PromoteRequest extends PromoteMetadata {
  vault: string;
  id: string;
  /** Link the candidate to an existing note instead of creating one. */
  linkTo?: string;
  confirm?: boolean;
  fingerprint?: string;
  channel?: "cli" | "mcp";
}
export interface PromoteResult {
  ok: boolean;
  action: "create" | "link";
  applied: boolean;
  preview?: boolean;
  id: string;
  path: string | null;
  text?: string;
  fingerprint?: string;
  issues: WriteIssue[];
  possibleDuplicates?: string[];
  /** Choices offered when the note may already exist in the vault. */
  choices?: string[];
  note?: WriteReceipt;
  linked?: string | null;
  alreadyLinked?: boolean;
}
export interface SeamFactory { (options: AmemOptions): Promise<AmemSeam> }
const defaultSeam: SeamFactory = async options => (await import("./amem/seam.ts")).openAmem(options);
const ID = /^[a-f0-9]{32}$/;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const issue = (code: string, message: string, path?: string): WriteIssue => ({ code, severity: "error", message, ...(path ? { path } : {}) });

export function stemFor(title: string): string {
  const stem = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
  return /^[a-z0-9]/.test(stem) ? stem : "";
}
/** The vault log's project field: an explicit value, else the last segment of the agent-mem project key. */
export function logProjectFor(project: string, explicit?: string): string {
  if (explicit !== undefined) return explicit;
  const slug = (project.split(/[/:]/).filter(Boolean).at(-1) ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : "-";
}
function firstSentence(text: string): string {
  const line = text.replace(/\s+/g, " ").trim(), cut = /^(.{20,200}?[.!?])(?:\s|$)/.exec(line)?.[1] ?? line.slice(0, 200);
  return cut.trim();
}
/** Prefilled note text: H1 from the title, body from the entry text, about[] as hints, provenance in frontmatter. */
export function draftNote(entry: AmemCandidate, meta: PromoteMetadata, now = new Date()): { stem: string; frontmatter: Record<string, unknown>; text: string } {
  const title = meta.title ?? entry.title ?? firstSentence(entry.text);
  const stem = meta.stem ?? stemFor(title);
  const topics = (meta.topics ?? []).map(value => value.startsWith("[[") ? value : `[[${value}]]`);
  const frontmatter: Record<string, unknown> = {
    title, description: meta.description ?? firstSentence(entry.text), type: meta.type ?? (entry.kind === "decision" ? "decision" : entry.kind === "fail" ? "method" : "insight"),
    ...(meta.domain ? { domain: meta.domain } : {}), topics, promoted_from: `mem:${entry.id}`, promoted_at: localDate(now),
  };
  const hints = entry.about.length ? `${entry.about.slice(0, 20).map(node => `- ${node.replace(/[\r\n[\]]/g, " ")}`).join("\n")}\n` : "";
  const body = meta.body ?? `# ${title}\n\n${entry.text.trim()}\n\n## Relevant Notes\n\n${hints}\n## Topics\n\n${topics.map(topic => `- ${topic}`).join("\n")}\n`;
  return { stem, frontmatter, text: emitFrontmatter(parseFrontmatter(body), frontmatter) };
}
function vaultSpec(home: string, id: string): { spec: VaultSpec; all: VaultSpec[] } {
  const all = loadRegistry(home).vaults, spec = all.find(v => v.id === id);
  if (!spec) throw new Error("promote: unknown vault id");
  return { spec, all };
}
const fold = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[-_\s]+/g, " ").trim();
/** Existing notes with the same stem or title, plus close FTS title matches: the link-existing choices. */
function similar(home: string, spec: VaultSpec, all: VaultSpec[], title: string, stem: string): string[] {
  const index = new VaultIndex(home, spec, all.map(v => v.path));
  try {
    index.scan();
    const words = title.normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 2).slice(0, 8);
    const hits = words.length ? index.search(words.join(" "), { limit: 5 }) : [];
    const exact = hits.filter(hit => fold(hit.title) === fold(title) || hit.path === `${stem}.md`);
    return [...exact, ...hits].map(hit => `notes/${hit.path}`).filter((path, i, list) => list.indexOf(path) === i).slice(0, 5);
  } catch { return []; } finally { index.close(); }
}
function lookup(home: string, spec: VaultSpec, all: VaultSpec[], id: string, linkTo?: string): { promoted: string[]; target?: string } {
  const index = new VaultIndex(home, spec, all.map(v => v.path));
  try {
    index.scan();
    const promoted = index.promotedFrom(`mem:${id}`).map(path => `notes/${path}`);
    let target: string | undefined;
    if (linkTo !== undefined) target = `notes/${index.show(linkTo, 1).path}`;
    return { promoted, ...(target ? { target } : {}) };
  } finally { index.close(); }
}

/**
 * Two-step promotion of one agent-mem entry. Without `confirm` nothing is written and the result carries
 * the full note text (or the link to record) and a fingerprint. With `confirm` the fingerprint must match
 * the recomputed preview; then the note is created through applyWrite, one LEARN event is appended, and
 * the vault link is recorded last. If that last step fails the candidate stays listed, and a rerun finds
 * the note through `promoted_from` and offers link-only instead of a second note.
 */
export async function promoteFromAmem(home: string, request: PromoteRequest, options: { env?: NodeJS.ProcessEnv; project?: string; cwd?: string; seam?: SeamFactory; now?: Date } = {}): Promise<PromoteResult> {
  const base: PromoteResult = { ok: false, action: "create", applied: false, id: request.id, path: null, issues: [] };
  if (!ID.test(request.id)) return { ...base, issues: [issue("AMEM", "expected a 32-hex agent-mem entry id")] };
  const { spec, all } = vaultSpec(home, request.vault);
  if (spec.write === "none" || (request.channel === "mcp" && spec.write !== "mcp")) return { ...base, issues: [issue("POLICY", "vault write policy refuses this channel")] };
  const seam = await (options.seam ?? defaultSeam)({ env: options.env, ...(options.project ? { project: options.project } : {}), ...(options.cwd ? { cwd: options.cwd } : {}), piiPatterns: loadRegistry(home).piiPatterns });
  try {
    const entry = await seam.entry(request.id);
    if (!entry) return { ...base, issues: [issue("AMEM", "entry is not an available curated entry of this project")] };
    const linked = seam.linkedPath(request.id) ?? null;
    const { promoted, target } = lookup(home, spec, all, request.id, request.linkTo);
    // Link-only: an earlier promotion already created the note, or the caller chose an existing note.
    const existing = target ?? promoted[0];
    if (existing) {
      const fingerprint = sha({ action: "link", id: request.id, path: existing, linked, vault: spec.id });
      const result: PromoteResult = { ...base, action: "link", path: existing, fingerprint, linked, alreadyLinked: linked === existing, ok: true,
        ...(promoted.length && !target ? { choices: [`link-only ${existing}`] } : {}) };
      if (request.confirm !== true) return { ...result, preview: true };
      if (request.fingerprint !== fingerprint) return { ...result, ok: false, issues: [issue("V09", "stale or missing preview fingerprint")] };
      if (linked === existing) return { ...result, applied: false };
      await seam.recordLink(request.id, existing);
      return { ...result, applied: true, linked: existing };
    }
    const draft = draftNote(entry, request, options.now);
    if (!draft.stem) return { ...base, issues: [issue("V04", "cannot derive an ASCII stem from the title; pass --stem")] };
    let path: string;
    try { path = notePath(draft.stem); } catch { return { ...base, issues: [issue("V04", "expected a flat lowercase ASCII stem")] }; }
    const operation = { op: "create" as const, path: draft.stem, frontmatter: {}, body: draft.text };
    const planned = applyWrite(home, { vault: spec.id, operation, channel: request.channel ?? "cli", dryRun: true }, { env: options.env });
    const v08 = planned.issues.some(i => i.code === "V08") || (planned.possibleDuplicates?.length ?? 0) > 0;
    const possibleDuplicates = v08 ? [...new Set([...(planned.possibleDuplicates ?? []), ...similar(home, spec, all, String(draft.frontmatter.title), draft.stem)])].filter(p => p !== path) : [];
    const fingerprint = sha({ action: "create", id: request.id, write: planned.fingerprint, text: draft.text, linked, vault: spec.id });
    const result: PromoteResult = { ...base, ok: planned.ok, path, text: draft.text, fingerprint, issues: planned.issues, linked,
      ...(possibleDuplicates.length ? { possibleDuplicates, choices: ["create", ...possibleDuplicates.map(p => `link-existing ${p}`)] } : {}) };
    if (request.confirm !== true || !planned.ok) return { ...result, preview: request.confirm !== true };
    if (request.fingerprint !== fingerprint) return { ...result, ok: false, issues: [issue("V09", "stale or missing preview fingerprint")] };
    const note = applyWrite(home, { vault: spec.id, operation, channel: request.channel ?? "cli",
      log: { type: "LEARN", project: logProjectFor(seam.project, request.logProject), source: `mem:${request.id}`, dest: path, note: `promoted: ${entry.kind}` } }, { env: options.env });
    if (!note.ok || !note.applied) return { ...result, ok: false, note, issues: note.issues };
    try {
      await seam.recordLink(request.id, path);
      return { ...result, ok: note.log?.ok !== false, applied: true, note, linked: path, issues: note.log?.ok === false ? note.log.issues : [] };
    } catch (error) {
      return { ...result, ok: false, applied: true, note, linked: null, choices: [`link-only ${path}`],
        issues: [issue("LINK", `note created but the agent-mem link failed (${error instanceof Error ? error.message.slice(0, 200) : "error"}); rerun to record the link only`)] };
    }
  } finally { seam.close(); }
}
/** Candidate table: one project (default: the current one) or every readable project. */
export async function listPromotionCandidates(options: { env?: NodeJS.ProcessEnv; project?: string; cwd?: string; allProjects?: boolean; limit?: number; piiPatterns?: string[]; seam?: SeamFactory }): Promise<{ projects: { project: string; candidates: { id: string; project: string; kind: string; title: string | null; at: string }[] }[] }> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit: expected integer 1..200");
  const brief = (c: AmemCandidate) => ({ id: c.id, project: c.project, kind: c.kind, title: c.title ?? firstSentence(c.text), at: c.at });
  if (options.allProjects) {
    const { allProjectCandidates } = await import("./amem/seam.ts");
    return { projects: (await allProjectCandidates({ env: options.env, limit, piiPatterns: options.piiPatterns })).map(p => ({ project: p.project, candidates: p.candidates.map(brief) })) };
  }
  const seam = await (options.seam ?? defaultSeam)({ env: options.env, ...(options.project ? { project: options.project } : {}), ...(options.cwd ? { cwd: options.cwd } : {}), piiPatterns: options.piiPatterns });
  try { return { projects: [{ project: seam.project, candidates: (await seam.candidates(limit)).map(brief) }] }; }
  finally { seam.close(); }
}
