import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { VaultSpec, VmemConfig } from "./config.ts";
import { emitFrontmatter, parseFrontmatter } from "./frontmatter.ts";
import { normalizeTarget, proseLines } from "./links.ts";
import { loadRegistry } from "./registry.ts";
import { VaultIndex } from "./vault-index.ts";
import { applyWrite } from "./writer.ts";
import { notePath } from "./write-operations.ts";
import { screenContent } from "./write-validation.ts";
import { appendLog } from "./vault-log.ts";
import type { WriteIssue, WriteReceipt } from "./write-types.ts";
import type { LogReceipt } from "./log-types.ts";

export interface OrgPromoteRequest {
  /** Personal vault id and note (stem, alias or notes/ path). */
  from: string;
  note: string;
  /** Target org vault id. */
  to: string;
  /** Override target topics; each must be an existing MOC in the target. */
  topics?: string[];
  again?: boolean;
  confirm?: boolean;
  fingerprint?: string;
  channel?: "cli" | "mcp";
  logProject?: string;
}
export interface OrgPromoteResult {
  ok: boolean;
  applied: boolean;
  preview?: boolean;
  source: string | null;
  target: string | null;
  text?: string;
  droppedLinks?: string[];
  screen: { passed: boolean; issues: WriteIssue[] };
  fingerprint?: string;
  issues: WriteIssue[];
  note?: WriteReceipt;
  provenance?: WriteReceipt;
  logs?: { source: LogReceipt | null; target: LogReceipt | null };
  lint?: { passed: boolean; issues: WriteIssue[] };
}
const issue = (code: string, message: string, path?: string): WriteIssue => ({ code, severity: "error", message, ...(path ? { path } : {}) });
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const strings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

// ponytail: keyword heuristics from hub-contract §2 never_upload; the org clone's git diff before `vmem sync` is the review surface.
const CORRESPONDENCE = [/^inbox\//i, /(^|[\s/])inbox\//i, /^outlook:/i, /telegram\(/i, /kakao/i];
const MEETING = [/(^|\/)meetings\//i];
/**
 * Fail-closed org screen over the transformed text and source frontmatter: secrets, PII under the
 * target's policy (org default deny), person/people records, private correspondence and internal
 * meeting sources. Returns error issues only; any issue refuses promotion.
 */
export function screenForOrg(text: string, data: Record<string, unknown>, target: VaultSpec, config: VmemConfig): WriteIssue[] {
  const issues: WriteIssue[] = screenContent(text, target, config).map(found => ({ ...found, severity: "error" as const }));
  if (data.type === "person" || data.domain === "people") issues.push(issue("SCREEN", "personal_data: person or people records are never promoted"));
  const sources = [...strings(data.source), ...strings(data.source_ref)];
  if (sources.some(value => MEETING.some(pattern => pattern.test(value)))) issues.push(issue("SCREEN", "internal_meeting_notes: source under meetings/"));
  if (sources.some(value => CORRESPONDENCE.some(pattern => pattern.test(value)))) issues.push(issue("SCREEN", "private_correspondence: inbox, mail or chat source"));
  return issues;
}

/** Replace visible wiki links whose target does not resolve in the target vault with their plain text. */
export function dropUnresolvedLinks(body: string, resolves: (target: string) => boolean): { body: string; dropped: string[] } {
  const prose = proseLines(body), raw = body.split("\n"), dropped: string[] = [];
  const out = raw.map((line, index) => {
    const visible = (prose[index] ?? "").replace(/(`+)[^`]*?\1/g, match => " ".repeat(match.length));
    let result = line;
    for (const match of [...visible.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)].reverse()) {
      if (match.index! > 0 && visible[match.index! - 1] === "\\") continue;
      const [address, ...labels] = match[2]!.split("|");
      const hash = address!.indexOf("#"), target = (hash < 0 ? address! : address!.slice(0, hash)).trim();
      if (!target || resolves(target)) continue;
      dropped.push(target);
      const plain = labels.length ? labels.join("|") : address!.replace("#", " ").trim();
      result = result.slice(0, match.index!) + plain + result.slice(match.index! + match[0].length);
    }
    return result;
  });
  return { body: out.join("\n"), dropped: [...new Set(dropped)].sort() };
}

/** Target-vault facts read once from its index: link resolution (stems and aliases), MOCs and existing paths. */
function targetFacts(home: string, spec: VaultSpec, all: VaultSpec[], links: string[], targetPath: string): { resolved: Set<string>; mocs: Set<string>; exists: boolean } {
  const index = new VaultIndex(home, spec, all.map(v => v.path));
  try {
    index.scan();
    const resolved = new Set<string>();
    for (const link of new Set(links)) { try { index.show(link, 1); resolved.add(linkKey(link)); } catch { /* unresolved or ambiguous */ } }
    let exists = false;
    try { exists = `notes/${index.show(targetPath, 1).path}` === targetPath; } catch { /* absent */ }
    return { resolved, mocs: new Set(index.mocs(500).map(moc => linkKey(moc.path))), exists };
  } finally { index.close(); }
}
function readSource(spec: VaultSpec, path: string): string {
  const file = join(realpathSync(spec.path), path);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const size = fstatSync(fd).size;
    if (!fstatSync(fd).isFile() || size > 256 * 1024) throw new Error("source note: expected plain file <=256 KiB");
    const buffer = Buffer.alloc(size); let read = 0;
    while (read < size) { const n = readSync(fd, buffer, read, size - read, null); if (!n) break; read += n; }
    return buffer.subarray(0, read).toString("utf8");
  } finally { closeSync(fd); }
}
const linkKey = (value: string) => normalizeTarget(value.replace(/^\[\[|\]\]$/g, "").split(/[|#]/)[0]!.trim().replace(/^notes\//i, "").replace(/\.md$/i, ""));

/** The single org-lint call site. Until analysis lint lands this runs the writer's read-only check on the written note. */
export function lintPromoted(home: string, target: VaultSpec, path: string, text: string): { passed: boolean; issues: WriteIssue[] } {
  const checked = applyWrite(home, { vault: target.id, operation: { op: "check", path, text } });
  const issues = checked.issues.filter(found => found.severity === "error" && found.code !== "V08");
  return { passed: issues.length === 0, issues };
}

/**
 * Two-step personal-to-org promotion. Writes only local clones: never commits or pushes; publishing is `syncVault`.
 * Preview and refusal write nothing; confirm needs the fingerprint of the current preview.
 */
export function promoteToOrg(home: string, request: OrgPromoteRequest, options: { env?: NodeJS.ProcessEnv; now?: Date } = {}): OrgPromoteResult {
  const result: OrgPromoteResult = { ok: false, applied: false, source: null, target: null, screen: { passed: false, issues: [] }, issues: [] };
  const fail = (found: WriteIssue) => ({ ...result, issues: [found] });
  const config = loadRegistry(home), all = config.vaults;
  const source = all.find(v => v.id === request.from), target = all.find(v => v.id === request.to);
  if (!source || !target) return fail(issue("V04", "unknown source or target vault id"));
  if (source.kind !== "personal") return fail(issue("POLICY", "promotion source must be a personal vault"));
  if (target.kind !== "org" || target.write === "none") return fail(issue("POLICY", "promotion target must be a writable org vault"));
  if (request.channel === "mcp" && target.write !== "mcp") return fail(issue("POLICY", "target vault write policy refuses MCP"));
  if (request.channel === "mcp" && source.write !== "mcp") return fail(issue("POLICY", "source provenance write needs write=mcp on the personal vault"));
  let path: string;
  const index = new VaultIndex(home, source, all.map(v => v.path));
  try { index.scan(); path = `notes/${index.show(request.note, 1).path}`; }
  catch (error) { return fail(issue("V04", error instanceof Error ? error.message : "unknown source note")); }
  finally { index.close(); }
  result.source = `${source.id}:${path}`;
  const original = readSource(source, path);
  let parsed;
  try { parsed = parseFrontmatter(original); } catch { return fail(issue("V01", "source frontmatter is not parseable", path)); }
  const promotedTo = `${target.id}:${path}`;
  const prior = strings(parsed.data.promoted_to);
  if (prior.length && !request.again) return fail(issue("AGAIN", `already promoted to ${prior.join(", ")}; pass --again to promote again`, path));
  const targetPath = notePath(path);
  // Topics: explicit override, else the source topics; each must be an existing MOC in the target.
  const topics = (request.topics ?? strings(parsed.data.topics)).map(value => value.startsWith("[[") ? value : `[[${value}]]`);
  const bodyLinks = [...parsed.body.matchAll(/\[\[([^\]\n|#]+)/g)].map(match => match[1]!.trim());
  const fieldLinks = ["project", "superseded_by", "supersedes", "source_ref"].flatMap(key => strings(parsed.data[key]).filter(value => value.includes("[[")).map(linkKey));
  const targetNotes = targetFacts(home, target, all, [...bodyLinks, ...fieldLinks], targetPath);
  // The org note is never overwritten; a repeat promotion (--again) needs the earlier org copy moved or deleted first.
  if (targetNotes.exists) return fail(issue("V08", `${target.id} already has ${targetPath}; move or delete it in the org vault first`, targetPath));
  const missingTopics = topics.filter(topic => !targetNotes.mocs.has(linkKey(topic)));
  if (!topics.length || missingTopics.length) return fail(issue("V02", `target topics must name existing MOCs in ${target.id}${missingTopics.length ? `: missing ${missingTopics.join(", ")}` : ""}; use --topics`));
  const transformed = dropUnresolvedLinks(parsed.body, value => targetNotes.resolved.has(linkKey(value)));
  // Body Topics section follows the target topics.
  const body = transformed.body.replace(/\n## Topics\n[\s\S]*$/, `\n## Topics\n\n${topics.map(topic => `- ${topic}`).join("\n")}\n`);
  const day = (options.now ?? new Date()).toISOString().slice(0, 10);
  const frontmatter: Record<string, unknown> = { topics, promoted_from: result.source, promoted_at: day, promoted_to: undefined };
  // Wiki-valued fields that point outside the target vault are dropped as well.
  for (const key of ["project", "superseded_by", "supersedes", "source_ref"]) {
    const values = strings(parsed.data[key]);
    if (values.some(value => value.includes("[[") && !targetNotes.resolved.has(linkKey(value)))) { frontmatter[key] = undefined; transformed.dropped.push(`${key}:${values.join(",")}`); }
  }
  const text = emitFrontmatter(parseFrontmatter(parsed.source.slice(0, parsed.source.length - parsed.body.length) + body), frontmatter);
  result.target = `${target.id}:${targetPath}`; result.text = text; result.droppedLinks = transformed.dropped;
  const screen = screenForOrg(text, parsed.data, target, config);
  result.screen = { passed: screen.length === 0, issues: screen };
  if (screen.length) return { ...result, issues: screen };
  const planned = applyWrite(home, { vault: target.id, operation: { op: "create", path: targetPath, frontmatter: {}, body: text }, channel: request.channel ?? "cli", dryRun: true }, { env: options.env });
  const provenanceSet = { promoted_to: prior.length ? [...prior.filter(p => p !== promotedTo), promotedTo] : promotedTo };
  const provenanceText = emitFrontmatter(parsed, provenanceSet);
  const provenancePlan = applyWrite(home, { vault: source.id, operation: { op: "frontmatter", path, set: provenanceSet }, channel: request.channel ?? "cli", dryRun: true }, { env: options.env });
  result.fingerprint = sha({ target: planned.fingerprint, source: provenancePlan.fingerprint, text, provenanceText });
  const blocking = [...planned.issues, ...provenancePlan.issues].filter(found => found.severity === "error");
  if (blocking.length) return { ...result, issues: blocking };
  if (request.confirm !== true) return { ...result, ok: true, preview: true, issues: [...planned.issues, ...provenancePlan.issues] };
  if (request.fingerprint !== result.fingerprint) return { ...result, issues: [issue("V09", "stale or missing preview fingerprint")] };
  const event = { type: "SYNC", project: request.logProject ?? "-", source: `${source.id}:${path}`, dest: `${target.id}:${targetPath}`, note: `promoted: ${typeof parsed.data.type === "string" ? parsed.data.type : "note"}` };
  const note = applyWrite(home, { vault: target.id, operation: { op: "create", path: targetPath, frontmatter: {}, body: text }, channel: request.channel ?? "cli", log: false }, { env: options.env });
  if (!note.ok || !note.applied) return { ...result, note, issues: note.issues };
  const provenance = applyWrite(home, { vault: source.id, operation: { op: "frontmatter", path, set: provenanceSet }, channel: request.channel ?? "cli", log: false }, { env: options.env });
  const logs = { source: null as LogReceipt | null, target: null as LogReceipt | null };
  for (const [key, vault] of [["target", target], ["source", source]] as const) {
    try { logs[key] = appendLog(home, { vault: vault.id, event, channel: request.channel ?? "cli" }, { env: options.env }); }
    catch { logs[key] = { ok: false, appended: null, synced: false, bytesWritten: null, issues: [issue("LOG_IO", "log append failed")] }; }
  }
  const lint = lintPromoted(home, target, targetPath, text);
  const issues = [...(provenance.ok ? [] : provenance.issues), ...(logs.source?.ok ? [] : logs.source?.issues ?? []), ...(logs.target?.ok ? [] : logs.target?.issues ?? []), ...lint.issues];
  return { ...result, ok: issues.length === 0, applied: true, note, provenance, logs, lint, issues };
}
