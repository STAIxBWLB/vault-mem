/** Bounded hybrid ranking over current indexed notes and local stored vectors. */
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AnalysisSnapshot } from "./analysis-types.ts";
import { loadRegistry } from "./registry.ts";
import { logBinding, matchesBinding } from "./vault-log.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { readEnrichmentStore } from "./enrichment-store.ts";
import { rankHybridCandidates, vectorSimilarity } from "./enrichment-search.ts";
import { resultLimit, type VaultIndex, type SearchOptions, type SearchResult } from "./vault-index.ts";

export interface QueryVector { model: string; values: number[] }
function queryContext(home: string, vaultId: string) {
  const config = loadRegistry(home), vault = config.vaults.find(v => v.id === vaultId);
  if (!vault) throw new Error("enrichment: vault is not registered; select a registered vault");
  let binding: ReturnType<typeof logBinding>;
  try { binding = logBinding(vault, config); } catch { throw new Error("enrichment: vault root is unavailable; restore the registered vault and retry"); }
  const check = () => {
    let current: ReturnType<typeof loadRegistry>;
    try { current = loadRegistry(home); } catch { throw new Error("enrichment: registry is unavailable after the read; inspect the configuration and retry"); }
    if (!matchesBinding(current, vault.id, binding)) throw new Error("enrichment: vault binding or policy changed during the read; retry with the current registry");
  };
  const store = vault.enrichment?.enabled ? readEnrichmentStore(home, vault, config.vaults, config.denyPaths ?? []) : undefined;
  return { config, vault, store, check };
}
function allowed(ctx: ReturnType<typeof queryContext>, path: string): boolean {
  const file = join(ctx.vault.path, "notes", path);
  return !isDenied(file, ctx.config.denyPaths ?? []) && !isDenied(canonicalPath(file), ctx.config.denyPaths ?? []);
}
function candidates(ctx: ReturnType<typeof queryContext>, index: VaultIndex, query: QueryVector) {
  const { store } = ctx;
  if (!store) return [];
  const vectors = store.records.filter(r => r.kind === "embedding");
  if (!vectors.length) return [];
  if (!query || query.model !== store.model || !Array.isArray(query.values) || query.values.length !== store.dimension) throw new Error("enrichment: query vector model or dimension differs from stored vectors; use the recorded model and dimension");
  try { vectorSimilarity(query.values, query.values); } catch { throw new Error("enrichment: query vector is invalid or zero; provide finite nonzero values"); }
  const metadata = new Map(index.enrichmentPointers().filter(p => allowed(ctx, p.path)).map(p => [p.path, p]));
  return vectors.flatMap(r => {
    const id = r.path.slice(6), note = metadata.get(id);
    if (!note || note.hash !== r.contentHash || !Array.isArray(r.value)) return [];
    return [{ id, score: vectorSimilarity(query.values, r.value as number[]), note }];
  }).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** Internal graph inputs: only current, allowed vectors; callers must never serialize values. */
export function graphEnrichmentInputs(home: string, vault: string, snapshot: AnalysisSnapshot) {
  const ctx = queryContext(home, vault);
  if (!ctx.store) { ctx.check(); return undefined; }
  const metadata = new Map(snapshot.notes.map(note => {
    const path = note.path.replace(/^notes\//, "");
    return [path, createHash("sha256").update(note.source).digest("hex")] as const;
  }));
  const vectors = ctx.store.records.flatMap(record => {
    if (record.kind !== "embedding" || !Array.isArray(record.value)) return [];
    const path = record.path.slice(6);
    if (!allowed(ctx, path) || metadata.get(path) !== record.contentHash) return [];
    return [{ path, values: record.value as number[] }];
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const hash = createHash("sha256").update(JSON.stringify([ctx.store.model ?? null, snapshot.notes.length]));
  for (const item of vectors) hash.update(JSON.stringify([item.path, item.values]));
  ctx.check();
  return { model: ctx.store.model ?? null, embedded: vectors.length, total: snapshot.notes.length, digest: hash.digest("hex"), vectors };
}
export function hybridSearch(home: string, vault: string, index: VaultIndex, query: string, options: SearchOptions, vector: QueryVector): SearchResult[] {
  const limit = resultLimit(options.limit), ctx = queryContext(home, vault);
  if (index.vault.id !== ctx.vault.id || index.vault.path !== ctx.vault.path || !index.sourceIdentityCurrent()) throw new Error("enrichment: index is unscanned or belongs to another vault; reopen and scan the selected vault before retrying");
  const lexical = index.search(query, { ...options, limit: 500 }).filter(note => allowed(ctx, note.path));
  const hits = candidates(ctx, index, vector).filter(h => (!options.type || h.note.type === options.type) && (!options.domain || h.note.domain === options.domain));
  if (!hits.length) { ctx.check(); if (!index.sourceIdentityCurrent()) throw new Error("enrichment: index source changed during the read; reopen the vault and retry"); return lexical.slice(0, limit); }
  const vectorHits = hits.slice(0, 9500), ranked = rankHybridCandidates(lexical.map((v, i) => ({ id: v.path, rank: i + 1 })), vectorHits.map((v, i) => ({ id: v.id, rank: i + 1 })));
  const notes = new Map(vectorHits.map(h => [h.id, h.note]));
  for (const note of lexical) notes.set(note.path, { ...note, hash: "" });
  const result = ranked.slice(0, limit).map(r => { const { hash: _, ...note } = notes.get(r.id)!; return { ...note, score: r.score }; });
  ctx.check(); if (!index.sourceIdentityCurrent()) throw new Error("enrichment: index source changed during the read; reopen the vault and retry"); return result;
}
export function similarNotes(home: string, vault: string, index: VaultIndex, path: string, limit = 20) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("enrichment: similar limit must be 1..100; choose a smaller page");
  const ctx = queryContext(home, vault), { vault: spec, store } = ctx;
  if (index.vault.id !== spec.id || index.vault.path !== spec.path || !index.sourceIdentityCurrent()) throw new Error("enrichment: index is unscanned or belongs to another vault; reopen and scan the selected vault before retrying");
  if (!store) throw new Error("enrichment: enrichment is disabled; enable it in settings");
  const id = index.resolve(path), pointer = index.enrichmentPointers().find(p => p.path === id);
  if (!allowed(ctx, id)) throw new Error("enrichment: source note is denied; select an allowed note");
  const source = store.records.find(r => r.kind === "embedding" && r.path === `notes/${id}` && r.contentHash === pointer?.hash);
  if (!source || !Array.isArray(source.value) || !store.model) throw new Error("enrichment: no current vector exists for this note; run enrichment for the current content");
  const result = candidates(ctx, index, { model: store.model, values: source.value as number[] }).filter(hit => hit.id !== id).slice(0, limit).map(({ note, score }) => ({ path: note.path, title: note.title, score }));
  ctx.check(); if (!index.sourceIdentityCurrent()) throw new Error("enrichment: index source changed during the read; reopen the vault and retry"); return result;
}
