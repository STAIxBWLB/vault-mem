/** Pure, bounded helpers for combining lexical and vector search results. */

export const MAX_VECTOR_DIMENSIONS = 4096;
export const MAX_RANK_CANDIDATES = 10_000;
const RRF_K = 60;

/** Cosine similarity for two finite, non-zero vectors of equal bounded size. */
export function vectorSimilarity(left: readonly number[], right: readonly number[]): number {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) {
    throw new TypeError("vectors must be nonempty arrays");
  }
  if (left.length > MAX_VECTOR_DIMENSIONS || right.length > MAX_VECTOR_DIMENSIONS) {
    throw new RangeError(`vector dimensions must not exceed ${MAX_VECTOR_DIMENSIONS}`);
  }
  if (left.length !== right.length) throw new RangeError("vector dimensions do not match");
  let leftScale = 0, rightScale = 0;
  for (let i = 0; i < left.length; i++) {
    const a = left[i], b = right[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new TypeError("vector values must be finite numbers");
    leftScale = Math.max(leftScale, Math.abs(a));
    rightScale = Math.max(rightScale, Math.abs(b));
  }
  if (leftScale === 0 || rightScale === 0) throw new RangeError("zero vectors are not supported");
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    const a = left[i] / leftScale, b = right[i] / rightScale;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export interface RankedCandidate { id: string; rank: number }
export interface HybridRankedCandidate { id: string; score: number; lexicalRank?: number; vectorRank?: number }

/** Reciprocal-rank fusion with lexical then id tie-breaking for stable output. */
export function rankHybridCandidates(
  lexical: readonly RankedCandidate[],
  vector: readonly RankedCandidate[],
): HybridRankedCandidate[] {
  if (!Array.isArray(lexical) || !Array.isArray(vector)) throw new TypeError("candidate lists must be arrays");
  if (lexical.length > MAX_RANK_CANDIDATES || vector.length > MAX_RANK_CANDIDATES || lexical.length + vector.length > MAX_RANK_CANDIDATES) {
    throw new RangeError(`candidate count must not exceed ${MAX_RANK_CANDIDATES}`);
  }
  const merged = new Map<string, { lexicalRank?: number; vectorRank?: number }>();
  const add = (items: readonly RankedCandidate[], field: "lexicalRank" | "vectorRank") => {
    for (const item of items) {
      if (!item || typeof item.id !== "string" || item.id.length === 0 || !Number.isSafeInteger(item.rank) || item.rank < 1 || item.rank > MAX_RANK_CANDIDATES) {
        throw new TypeError(`each candidate needs a nonempty id and rank in 1..${MAX_RANK_CANDIDATES}`);
      }
      let entry = merged.get(item.id);
      if (!entry) {
        entry = {};
        merged.set(item.id, entry);
      }
      if (entry[field] !== undefined) throw new TypeError(`duplicate candidate id in ${field === "lexicalRank" ? "lexical" : "vector"} results`);
      entry[field] = item.rank;
    }
  };
  add(lexical, "lexicalRank");
  add(vector, "vectorRank");
  return Array.from(merged, ([id, ranks]) => ({
    id,
    score: (ranks.lexicalRank === undefined ? 0 : 1 / (RRF_K + ranks.lexicalRank)) +
      (ranks.vectorRank === undefined ? 0 : 1 / (RRF_K + ranks.vectorRank)),
    ...ranks,
  })).sort((a, b) => b.score - a.score || (a.lexicalRank ?? Infinity) - (b.lexicalRank ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
