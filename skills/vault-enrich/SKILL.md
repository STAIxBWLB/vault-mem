---
name: vault-enrich
description: Enrich opted-in vault notes with externally produced embeddings, summaries, community labels, inferred links or assertion facts through vmem's hash-bound intake.
---

# Vault enrichment

Before the first vmem call, read `references/vault-adapter.md` for runtime discovery and bind a vault id. Pass that `vault` to each tool. Workspace-specific steps in the adapter are optional.

Enrichment requires the selected vault's explicit opt-in and an allowed write channel. Inspect effective settings with `vmem settings <vault>`; if enrichment is disabled, stop and let the person decide whether to enable it using the settings preview and confirmation. Respect current secret, PII and path policies when reading, producing and submitting results. Do not send protected content to an external service without authorization. A host agent may perform the model or embedding work; vmem does not call models.

## Work and intake

1. Call `vmem_enrichment_work` with `vault`, `kind` (one of `embedding`, `summary`, `community-label`, `inferred-link`, `fact`) and optional `limit` (1..100). Each item supplies `path` and `contentHash`; use `next` as `after` for another page. An item with `status: needs-reconciliation` must be resolved before retrying that path and kind.
2. Read the selected note with `vmem_read`, including continuation pages as needed, and generate a result for that exact content. Do not infer missing note text. If the content has changed since the work item was listed, obtain fresh work and recompute.
3. Call `vmem_enrichment_intake` with `vault`, `path`, `contentHash`, `kind`, `producer: {skill, version, model}`, `createdAt` (canonical UTC ISO timestamp with milliseconds, such as `2026-11-22T00:00:00.000Z`) and `value`. The producer is caller-supplied and unverified. Values depend on kind:
   - `embedding`: a finite, nonzero numeric vector, 1..4096 dimensions. Each vault sidecar accepts one model and dimension; reuse them. Stored values are rounded to Float32.
   - `summary` or `community-label`: nonempty text up to 8192 UTF-8 bytes.
   - `inferred-link`: `{target: "note-stem"}` for a different flat lowercase note stem. Intake submits an `infer-link` proposal, not a direct note edit. Review the proposal and use the existing preview, fingerprint and confirmation flow to apply it; applying adds a plain body link and the target to `inferred_links` together.
   - `fact`: an array of assertion operations including `assert` or `revise`, with the existing assertion journal's evidence or source requirements. Resolve subjects and heads from the journal; do not fabricate evidence or treat producer metadata as verification.
4. Inspect the complete receipt, including `ok`, `applied`, nested `receipt`, `issues` and `issue` when present. A stale-hash refusal requires rereading the note, requesting fresh work and recomputing. Do not retry a partial or uncertain fact/link intake until its publication state is resolved.

Use `vmem_enrichment_get` with `vault`, `path` and `kind` to inspect status (`current`, `stale`, `missing` or `needs-reconciliation`). Sidecar data is local to the vmem home and is not synced across machines.

## Uncertain fact or link intake

If the outcome is uncertain or the work/get status is `needs-reconciliation`, do not replay it. Preview `vmem_enrichment_reconcile` with `vault`, `path`, `kind` and a candidate `resolution` (`published` or `not_published`), without `confirm`; its `intakeId` identifies the reservation. Inspect assertion journal entries via `vmem_assertions` for the matching origin intake id, or inspect proposals with `vmem_proposal_list` and `vmem_proposal_show` (the proposal id is the intake id and its agent label is `enrichment:<intakeId>`). Check the available journal/proposal coverage and any nested receipt before deciding. If evidence is incomplete or ambiguous, stop and report it rather than guessing. After inspection, request a fresh preview for the verified resolution, then confirm with its returned `fingerprint`. A `not_published` resolution allows new work; a `published` resolution prevents replay. Respect any refusal and inspect or repair its stated cause first.

## Vector reads

Use `vmem_similar` with `vault` and `path` for neighbors of a note with a current stored embedding. For `vmem_search`, provide both `model` and `vector` for hybrid ranking, using the sidecar's model and dimension. Without matching stored vectors, search retains lexical ranking. Both results are suggestions, not evidence of a factual claim or permission to write links.
