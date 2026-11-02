import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { realPath } from "./platform.ts";
import { extractLinks } from "./links.ts";
import { specReference, MAX_SPEC_INPUTS } from "./spec-graph.ts";
import { discoverSpecs, type SpecCandidate, type SpecDiagnostic, type SpecSnapshot } from "./spec-source.ts";
import { specFreshness, specMetadataIssues, type SpecFreshnessEntry } from "./spec-freshness.ts";

export interface SpecValidationIssue {
  code: string;
  severity: "error" | "warning";
  path: string;
  id?: string;
  field?: string;
  target?: string;
  message: string;
}
export interface SpecValidationOptions { env?: NodeJS.ProcessEnv; requireFresh?: boolean; limit?: number; git?: boolean }
export interface SpecValidationReport {
  ok: boolean;
  errors: number;
  warnings: number;
  items: SpecValidationIssue[];
  diagnostics: SpecDiagnostic[];
  freshness: SpecFreshnessEntry[];
  truncated: boolean;
}
export interface SpecRepoValidationOptions { env?: NodeJS.ProcessEnv; requireFresh?: boolean; limit?: number }
export interface SpecRepoValidation { code: 0 | 1; report: SpecValidationReport }
const RANK: Readonly<Record<string, number>> = { goal: 0, architecture: 1, module: 2, submodule: 3 };
const STATUSES = new Set(["draft", "active", "deprecated"]);
const MAX_OPERATIONS = 200000, MAX_ITEMS = 500, MAX_REPORT_BYTES = 128 * 1024;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const candidateId = (candidate: SpecCandidate) => nonempty(candidate.frontmatter.id) ? candidate.frontmatter.id : undefined;
interface ErrorOwner { kind: "old" | "new"; path: string }
interface Collected { records: { issue: SpecValidationIssue; key: string }[]; freshness: SpecFreshnessEntry[] }

/** Complete collection is separate from display limits, so the introduced-error gate never compares samples. */
function collect(snapshot: SpecSnapshot, options: SpecValidationOptions, owners?: ReadonlyMap<string, ErrorOwner>): Collected {
  const candidates = [...(snapshot.candidates ?? snapshot.specs)].sort((a, b) => compare(a.path.normalize("NFC"), b.path.normalize("NFC")) || compare(a.path, b.path));
  if (new Set(candidates.map(candidate => candidate.path)).size !== candidates.length) throw new Error("spec validation: duplicate candidate paths; provide one candidate record per file");
  if (candidates.length > MAX_SPEC_INPUTS) throw new Error("spec validation: more than 10000 candidates; reduce the candidate tree before validating");
  let operations = 0;
  const tick = () => { if (++operations > MAX_OPERATIONS) throw new Error("spec validation: more than 200000 checks; reduce repeated links or metadata lists before validating"); };
  const hashes = new Map<string, string>();
  const digest = (value: string): string => {
    let hash = hashes.get(value);
    if (hash === undefined) { hash = createHash("sha256").update(value).digest("hex"); hashes.set(value, hash); }
    return hash;
  };
  const records: Collected["records"] = [], keys = new Set<string>();
  const addIssue = (issue: SpecValidationIssue) => {
    tick();
    const correspondence = owners?.get(issue.path) ?? { kind: owners === undefined ? "old" : "new", path: issue.path };
    const owner = `${correspondence.kind}:${digest(correspondence.path)}`;
    // Hash values independently: a long owner id is never copied once per relation/error key.
    const key = JSON.stringify([digest(snapshot.commonDir), issue.severity, issue.code, owner, issue.field ?? "", issue.target === undefined ? "" : digest(issue.target)]);
    if (!keys.has(key)) { keys.add(key); records.push({ issue, key }); }
  };
  const add = (candidate: SpecCandidate, code: string, severity: SpecValidationIssue["severity"], field: string, message: string, target?: string) => {
    const id = candidateId(candidate);
    addIssue({ code, severity, path: candidate.path, ...(id === undefined ? {} : { id }), field, message, ...(target === undefined ? {} : { target }) });
  };
  const nodes = new Map<string, SpecCandidate>(), first = new Map<string, string>();
  for (const candidate of candidates) {
    const id = candidateId(candidate);
    if (id !== undefined) {
      const previous = first.get(id);
      if (previous !== undefined) add(candidate, "duplicate_id", "error", "id", "duplicate id; give each candidate a unique id", previous);
      else first.set(id, candidate.path);
      if (nonempty(candidate.frontmatter.type) && !nodes.has(id)) nodes.set(id, candidate);
    }
  }
  const covers = new Map<string, Map<string, SpecCandidate>>();
  for (const candidate of candidates) {
    tick();
    const data = candidate.frontmatter, id = candidateId(candidate);
    if (options.git === false) for (const issue of specMetadataIssues(candidate)) addIssue(issue);
    for (const field of ["id", "type", "title"] as const) {
      if (data[field] === undefined) add(candidate, `missing_${field}`, "error", field, `required ${field} is missing; add a nonempty string field`);
      else if (!nonempty(data[field])) add(candidate, "wrong_shape", "error", field, `${field} must be a nonempty string; correct the frontmatter field`);
    }
    if (nonempty(data.type) && !Object.hasOwn(RANK, data.type)) add(candidate, "unknown_type", "error", "type", "unknown type; use goal, architecture, module or submodule");
    if (data.status !== undefined && (typeof data.status !== "string" || !STATUSES.has(data.status))) add(candidate, "unknown_status", "error", "status", "unknown status; use draft, active or deprecated");
    if (data.parent === undefined && data.type !== "goal") add(candidate, "orphan", "warning", "parent", "non-goal spec has no parent; link it to its owning higher-level spec");
    if (data.status === "active" && data.paths === undefined) add(candidate, "active_without_paths", "warning", "paths", "active spec has no paths; add relative Git pathspecs for its source scope");
    const checkLink = (field: string, value: unknown, shapeField = field): string | undefined => {
      tick();
      const target = specReference(value);
      if (target === undefined) { add(candidate, "wrong_shape", "error", shapeField, "link must be one id or wiki link; correct the frontmatter value"); return undefined; }
      if (!nodes.has(target)) add(candidate, "dangling_link", "error", field, "frontmatter link names no graph node; link to an existing spec id or remove it", target);
      return target;
    };
    let parent: string | undefined, replacement: string | undefined;
    if (data.parent !== undefined) parent = checkLink("parent", data.parent);
    if (data["superseded-by"] !== undefined) {
      replacement = checkLink("superseded-by", data["superseded-by"]);
      if (data.status !== "deprecated") add(candidate, "superseded_status", "error", "superseded-by", "replacement link requires deprecated status; deprecate the spec or remove the link");
      if (replacement !== undefined && replacement === id) add(candidate, "superseded_self", "error", "superseded-by", "replacement points to this spec; link to a different replacement", replacement);
    } else if (data.status === "deprecated") add(candidate, "deprecated_without_replacement", "warning", "superseded-by", "deprecated spec has no replacement; add a superseded-by id when one exists");
    if (data.status === "deprecated" && replacement !== undefined && replacement !== id && nodes.get(replacement)?.frontmatter.status === "deprecated") add(candidate, "deprecated_replacement", "warning", "superseded-by", "replacement is also deprecated; link to an active replacement", replacement);
    for (const field of ["depends-on", "references", "implements"] as const) {
      if (data[field] === undefined) continue;
      const values = data[field];
      if (!Array.isArray(values)) { add(candidate, "wrong_shape", "error", field, `${field} must be a list of links; wrap the value in a list`); continue; }
      for (let i = 0; i < values.length; i++) checkLink(field, values[i], `${field}[${i}]`);
    }
    if (parent !== undefined) {
      const parentType = nodes.get(parent)?.frontmatter.type;
      if (typeof data.type === "string" && typeof parentType === "string" && Object.hasOwn(RANK, data.type) && Object.hasOwn(RANK, parentType) && RANK[data.type]! <= RANK[parentType]!) add(candidate, "type_rank", "error", "parent", "child rank must exceed parent rank; choose a higher-level parent (levels may be skipped)", parent);
    }
    for (const field of ["covers", "tags"] as const) {
      const values = data[field];
      if (values === undefined) continue;
      let valid = Array.isArray(values);
      if (Array.isArray(values)) for (const value of values) { tick(); if (!nonempty(value)) valid = false; }
      if (!valid) {
        add(candidate, "wrong_shape", "error", field, `${field} must be a list of nonempty strings; correct the frontmatter field`);
        continue;
      }
      if (field === "covers") for (const value of values as string[]) {
        const token = value.trim();
        let owners = covers.get(token); if (!owners) covers.set(token, owners = new Map());
        owners.set(candidate.path, candidate);
      }
    }
    for (const link of extractLinks(candidate.body)) {
      tick();
      if (link.target && !nodes.has(link.target)) add(candidate, "unknown_body_link", "warning", "body", "body wiki link names no graph node; correct the target id or remove the link", link.target);
    }
  }
  for (const [token, owners] of covers) if (owners.size > 1) for (const candidate of owners.values()) add(candidate, "duplicate_covers", "warning", "covers", "covers token is claimed by multiple specs; choose a single owning spec", token);
  const goals = [...nodes.values()].filter(candidate => candidate.frontmatter.type === "goal");
  if (goals.length > 1) for (const candidate of goals) add(candidate, "multiple_goals", "warning", "type", "multiple goal roots exist; consolidate or document separate goal trees");
  // Iterative traversal handles a 10000-node chain without overflowing the JS stack.
  const finished = new Set<string>();
  for (const id of nodes.keys()) {
    if (finished.has(id)) continue;
    const chain: string[] = [], positions = new Map<string, number>();
    let next: string | undefined = id;
    while (next !== undefined && nodes.has(next) && !finished.has(next) && !positions.has(next)) {
      tick(); positions.set(next, chain.length); chain.push(next);
      next = specReference(nodes.get(next)!.frontmatter.parent);
    }
    if (next !== undefined && positions.has(next)) for (const member of chain.slice(positions.get(next)!)) add(nodes.get(member)!, "parent_cycle", "error", "parent", "parent cycle detected; remove a cycle link and point to a higher-level parent", specReference(nodes.get(member)!.frontmatter.parent));
    for (const member of chain) finished.add(member);
  }
  for (const diagnostic of snapshot.diagnostics) {
    if (diagnostic.code === "invalid_frontmatter") addIssue({ code: "invalid_frontmatter", severity: "error", path: diagnostic.path, field: "frontmatter", message: diagnostic.message });
    else if (snapshot.candidates === undefined && diagnostic.code === "duplicate_id") addIssue({ code: "duplicate_id", severity: "error", path: diagnostic.path, id: diagnostic.id, field: "id", target: diagnostic.firstPath, message: diagnostic.message });
    else if (snapshot.candidates === undefined && diagnostic.code === "invalid_identity") addIssue({ code: "wrong_shape", severity: "error", path: diagnostic.path, field: "id/type", message: diagnostic.message });
  }
  if (options.requireFresh && options.git === false) throw new Error("spec validation: requireFresh needs Git inspection; enable Git checks before requiring freshness");
  const freshness = options.git === false ? { items: [], issues: [] } : specFreshness(snapshot, { env: options.env });
  for (const issue of freshness.issues) addIssue(issue);
  if (options.requireFresh) for (const item of freshness.items) if (item.state === "stale") addIssue({ code: "stale", severity: "error", path: item.path, id: item.id, field: "verified-against", message: "spec source scope is stale; review its paths and refresh verified-against after verification" });
  records.sort((a, b) => (a.issue.severity === b.issue.severity ? 0 : a.issue.severity === "error" ? -1 : 1) || compare(a.issue.path.normalize("NFC"), b.issue.path.normalize("NFC")) || compare(a.issue.path, b.issue.path) || compare(a.issue.code, b.issue.code) || compare(a.issue.field ?? "", b.issue.field ?? "") || compare(a.key, b.key));
  return { records, freshness: freshness.items };
}

/** Display is count/byte bounded; oversized optional identifiers are omitted, never silently renamed. */
function display<T extends object>(values: readonly T[], limit: number, budget: { bytes: number; truncated: boolean }): T[] {
  const out: T[] = [];
  for (const original of values) {
    if (out.length >= limit) { budget.truncated = true; break; }
    const value = { ...original } as T & { id?: string; target?: string };
    for (const field of ["id", "target"] as const) if (typeof value[field] === "string" && Buffer.byteLength(value[field]!) > 1024) { delete value[field]; budget.truncated = true; }
    const bytes = Buffer.byteLength(JSON.stringify(value)) + 1;
    if (budget.bytes + bytes > MAX_REPORT_BYTES) { budget.truncated = true; break; }
    budget.bytes += bytes; out.push(value);
  }
  return out;
}
function reportLimit(value = MAX_ITEMS): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ITEMS) throw new Error("spec validation: report limit must be 1..500; pass a smaller positive item limit");
  return value;
}
export function validateSpecs(snapshot: SpecSnapshot, options: SpecValidationOptions = {}): SpecValidationReport {
  const limit = reportLimit(options.limit), result = collect(snapshot, options), budget = { bytes: 1024, truncated: false };
  const errors = result.records.filter(record => record.issue.severity === "error").length;
  return { ok: errors === 0, errors, warnings: result.records.length - errors,
    items: display(result.records.map(record => record.issue), limit, budget),
    diagnostics: display(snapshot.diagnostics, limit, budget), freshness: display(result.freshness, limit, budget),
    get truncated() { return budget.truncated; } };
}
/** Existing error identities are retained even when their display sample was truncated. */
export function introducedSpecErrors(current: SpecSnapshot, prospective: SpecSnapshot, options: SpecValidationOptions = {}): SpecValidationIssue[] {
  const limit = reportLimit(options.limit);
  const pathsById = (input: SpecSnapshot) => {
    const paths = new Map<string, Set<string>>();
    const add = (id: string, path: string) => { let found = paths.get(id); if (!found) paths.set(id, found = new Set()); found.add(path); };
    for (const candidate of input.candidates ?? input.specs) { const id = candidateId(candidate); if (id !== undefined) add(id, candidate.path); }
    if (input.candidates === undefined) for (const diagnostic of input.diagnostics) if (diagnostic.code === "duplicate_id" && diagnostic.id !== undefined) add(diagnostic.id, diagnostic.path);
    return paths;
  };
  const oldIds = pathsById(current), nextIds = pathsById(prospective), owners = new Map<string, ErrorOwner>(), reserved = new Set<string>();
  for (const candidate of prospective.candidates ?? prospective.specs) {
    const id = candidateId(candidate), previous = id === undefined ? undefined : oldIds.get(id);
    if (previous?.size === 1 && nextIds.get(id!)?.size === 1) {
      const path = previous.values().next().value!;
      owners.set(candidate.path, { kind: "old", path }); reserved.add(path);
    }
  }
  const previousPaths = new Set([...(current.candidates ?? current.specs).map(candidate => candidate.path), ...current.diagnostics.map(diagnostic => diagnostic.path)]);
  const prospectivePaths = new Set([...(prospective.candidates ?? prospective.specs).map(candidate => candidate.path), ...prospective.diagnostics.map(diagnostic => diagnostic.path)]);
  for (const path of prospectivePaths) if (!owners.has(path)) {
    const retained = previousPaths.has(path) && !reserved.has(path);
    owners.set(path, { kind: retained ? "old" : "new", path });
    if (retained) reserved.add(path);
  }
  // Duplicate identity belongs to the id, even when a move changes the first file in path order.
  // Keep collection keys unchanged so validation still reports each duplicate file.
  const comparisonKey = (input: SpecSnapshot, record: Collected["records"][number]): string =>
    record.issue.code === "duplicate_id" && record.issue.id !== undefined
      ? JSON.stringify([createHash("sha256").update(input.commonDir).digest("hex"), "duplicate_id", createHash("sha256").update(record.issue.id).digest("hex")])
      : record.key;
  const old = new Map<string, number>();
  for (const record of collect(current, options).records) if (record.issue.severity === "error") {
    const key = comparisonKey(current, record); old.set(key, (old.get(key) ?? 0) + 1);
  }
  const prospectiveErrors = collect(prospective, options, owners).records.filter(record => record.issue.severity === "error");
  // Retained owners consume existing debt before new or moved files do.
  prospectiveErrors.sort((a, b) => Number(owners.get(b.issue.path)?.kind === "old") - Number(owners.get(a.issue.path)?.kind === "old"));
  const next = prospectiveErrors.filter(record => {
    const key = comparisonKey(prospective, record), count = old.get(key) ?? 0;
    if (count === 0) return true;
    old.set(key, count - 1); return false;
  });
  const result = display(next.map(record => record.issue), limit, { bytes: 1024, truncated: false });
  if (next.length && !result.length) throw new Error("spec validation: introduced error metadata exceeds the report budget; reduce metadata before writing");
  return result;
}
/** Registry-free CI logic; no home/config/cache creation and no authored freshness fields. */
export function validateSpecRepo(repo: string, options: SpecRepoValidationOptions = {}): SpecRepoValidation {
  let root: string;
  try { root = realPath(resolve(repo)); } catch (error) { throw new Error("spec validation: repository root is unavailable; pass an existing checkout root", { cause: error }); }
  const snapshot = discoverSpecs({ id: "repo", path: root, write: "none", pii: "deny" }, { env: options.env });
  const report = validateSpecs(snapshot, options);
  return { code: report.ok ? 0 : 1, report };
}
