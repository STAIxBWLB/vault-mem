/** Bounded hybrid ranking over current indexed notes and local stored vectors. */
import { join } from "node:path";
import { loadRegistry } from "./registry.ts";
import { isDenied } from "./platform.ts";
import { readEnrichmentStore } from "./enrichment-store.ts";
import { rankHybridCandidates, vectorSimilarity } from "./enrichment-search.ts";
import type { VaultIndex, SearchOptions, SearchResult } from "./vault-index.ts";

export interface QueryVector { model: string; values: number[] }
function candidates(home: string, vaultId: string, index: VaultIndex, query: QueryVector) {
  const config = loadRegistry(home), vault = config.vaults.find(v => v.id === vaultId);
  if (!vault) throw new Error("enrichment: vault is not registered; select a registered vault");
  if (!vault.enrichment?.enabled) return [];
  const store = readEnrichmentStore(home, vault, config.vaults, config.denyPaths ?? []);
  const vectors = store.records.filter(r => r.kind === "embedding");
  if (!vectors.length) return [];
  if (!query || query.model !== store.model || !Array.isArray(query.values) || query.values.length !== store.dimension) throw new Error("enrichment: query vector model or dimension differs from stored vectors; use the recorded model and dimension");
  try { vectorSimilarity(query.values, query.values); } catch { throw new Error("enrichment: query vector is invalid or zero; provide finite nonzero values"); }
  const metadata = new Map(index.enrichmentPointers().filter(p => !isDenied(join(vault.path, "notes", p.path), config.denyPaths ?? [])).map(p => [p.path, p]));
  const hits = vectors.flatMap(r => {
    const id = r.path.slice(6), note = metadata.get(id);
    if (!note || note.hash !== r.contentHash || !Array.isArray(r.value)) return [];
    return [{ id, score: vectorSimilarity(query.values, r.value as number[]), note }];
  }).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits;
}
export function hybridSearch(home: string, vault: string, index: VaultIndex, query: string, options: SearchOptions, vector: QueryVector): SearchResult[] {
  const lexical = index.search(query, { ...options, limit: 500 });
  const hits = candidates(home, vault, index, vector).filter(h => (!options.type || h.note.type === options.type) && (!options.domain || h.note.domain === options.domain));
  if (!hits.length) return lexical.slice(0, options.limit ?? 50);
  // Combined input is capped before fusion; the store itself is read under a single aggregate byte bound.
  const vectorHits = hits.slice(0, 9500), ranked = rankHybridCandidates(lexical.map((v, i) => ({ id: v.path, rank: i + 1 })), vectorHits.map((v, i) => ({ id: v.id, rank: i + 1 })));
  const notes = new Map(vectorHits.map(h => [h.id, h.note]));
  for (const note of lexical) notes.set(note.path, { ...note, hash: "" });
  return ranked.slice(0, options.limit ?? 50).map(r => { const { hash: _, ...note } = notes.get(r.id)!; return { ...note, score: r.score }; });
}
export function similarNotes(home: string, vault: string, index: VaultIndex, path: string, limit = 20) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("enrichment: similar limit must be 1..100; choose a smaller page");
  const config = loadRegistry(home), spec = config.vaults.find(v => v.id === vault);
  if (!spec?.enrichment?.enabled) throw new Error("enrichment: vault is missing or enrichment is disabled; select a vault and enable enrichment in settings");
  const store = readEnrichmentStore(home, spec, config.vaults, config.denyPaths ?? []), id = index.resolve(path), pointer = index.enrichmentPointers().find(p => p.path === id);
  if (isDenied(join(spec.path, "notes", id), config.denyPaths ?? [])) throw new Error("enrichment: source note is denied; select an allowed note");
  const source = store.records.find(r => r.kind === "embedding" && r.path === `notes/${id}` && r.contentHash === pointer?.hash);
  if (!source || !Array.isArray(source.value) || !store.model) throw new Error("enrichment: no current vector exists for this note; run enrichment for the current content");
  return candidates(home, vault, index, { model: store.model, values: source.value as number[] }).filter(hit => hit.id !== id).slice(0, limit).map(({ note, score }) => ({ path: note.path, title: note.title, score }));
}
