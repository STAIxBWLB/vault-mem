import { expect, test } from "bun:test";
import { MAX_RANK_CANDIDATES, MAX_VECTOR_DIMENSIONS, rankHybridCandidates, vectorSimilarity } from "../src/enrichment-search.ts";

test("vector similarity computes cosine similarity with stable scaling", () => {
  expect(vectorSimilarity([1, 0], [0, 1])).toBe(0);
  expect(vectorSimilarity([1, 2], [2, 4])).toBeCloseTo(1);
  expect(vectorSimilarity([1e308, 0], [1e308, 1])).toBeCloseTo(1);
});

test("vector similarity rejects invalid vector inputs", () => {
  expect(() => vectorSimilarity([], [])).toThrow();
  expect(() => vectorSimilarity([1], [1, 2])).toThrow(/dimensions/);
  expect(() => vectorSimilarity([0, 0], [1, 0])).toThrow(/zero vectors/);
  expect(() => vectorSimilarity([Number.NaN], [1])).toThrow(/finite/);
  expect(() => vectorSimilarity(Array(MAX_VECTOR_DIMENSIONS + 1).fill(1), Array(MAX_VECTOR_DIMENSIONS + 1).fill(1))).toThrow(/dimensions/);
});

test("hybrid ranking uses reciprocal rank fusion and deterministic ties", () => {
  const ranked = rankHybridCandidates(
    [{ id: "alpha", rank: 1 }, { id: "shared", rank: 2 }, { id: "beta", rank: 3 }],
    [{ id: "beta", rank: 1 }, { id: "shared", rank: 2 }, { id: "alpha", rank: 3 }],
  );
  expect(ranked.map(({ id }) => id)).toEqual(["alpha", "beta", "shared"]);
  expect(ranked[0]).toMatchObject({ id: "alpha", lexicalRank: 1, vectorRank: 3 });
  expect(ranked[0]?.score).toBeCloseTo(1 / 61 + 1 / 63);
  expect(rankHybridCandidates([{ id: "b", rank: 1 }, { id: "a", rank: 1 }], []).map(({ id }) => id)).toEqual(["a", "b"]);
});

test("hybrid ranking validates ranks, duplicates and bounded candidate count", () => {
  expect(() => rankHybridCandidates([{ id: "x", rank: 0 }], [])).toThrow();
  expect(() => rankHybridCandidates([{ id: "x", rank: MAX_RANK_CANDIDATES + 1 }], [])).toThrow(/rank/);
  expect(() => rankHybridCandidates([{ id: "x", rank: 1 }, { id: "x", rank: 2 }], [])).toThrow(/duplicate/);
  expect(() => rankHybridCandidates(Array.from({ length: MAX_RANK_CANDIDATES + 1 }, (_, i) => ({ id: String(i), rank: i + 1 })), [])).toThrow(/candidate count/);
});
