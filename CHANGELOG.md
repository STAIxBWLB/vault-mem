# Changelog

## [Unreleased]

## [0.2.4] - 2026-11-01

- Report names (`graph-report-YYMMDD.md`, `lint-report-YYMMDD.md`), graph trend rows, L11 staleness, `promoted_at` (agent-mem and org promotion) and the skill-candidate report date now use the local calendar date, the same clock as the log lines, instead of UTC. A run early in the morning in a timezone ahead of UTC is no longer dated the previous day. `options.today` and `now` overrides still apply. Skill mining's `unique_days` keeps the UTC day of each record's `...Z` timestamp, as Python's `.date()` does.
- Console plugin for `acon` (agent-console api 1), exported as `@staix/vault-mem/ui-plugin`: Overview, Search, Note, Promote, Lint and Log panels, inbox items for promotion candidates and lint alerts, palette search, and two-step `delete`, `move`, `promote` and `promote-from-amem` behind the console's confirm dialog.
- `vmem setup` writes, reports and undoes the console plugin manifest `$AGENTHUB_HOME/console/plugins/vmem.json`.

## [0.2.3] - 2026-10-31

- Graph communities use a deterministic, dependency-free Leiden (modularity, resolution 1.0) instead of label propagation, which collapsed most of a real vault into one community. Every community is connected, ids are numbered by size then smallest member, and `vault-graph.json` and the report Overview record the partitioner, resolution and modularity. The vault graph, the workspace graph and skill mining share it.
- `vmem graph build <vault> --workspace` and `vmem_graph_build` with `workspace: true` build `reports/workspace-graph.json`: the vault graph plus the work layer (work docs, business-unit hubs, `source:` stubs and `related`, `fm_ref`, `wiki_link`, `bu_member`, `source_ref` and `supersedes` edges), a rule-for-rule port of `build-graph.py --work-root`. It writes only that file and one GRAPH event and returns the work counters and per-relation edge counts. `bun scripts/workspace-parity.ts <vault>` compares it against the Python reference, counts only.
- `vmem skills mine <vault>` and the MCP tool `vmem_skills_mine` rank new-skill candidates from agent-mem curated entries, agent-mem capture prompts, observations and summaries, and vault notes. They port the skill-mine dictionary matching, masking and scoring, cluster with vmem's deterministic graph communities, report counts by source and write nothing.

## [0.2.2] - 2026-10-31

- Report operations under `reports/` and `ops/` accept and reread files up to 16 MiB, so graph artifacts above 2 MiB can be rebuilt. Notes keep their 256 KiB write / 2 MiB read limits; CLI body input limits are unchanged.
- `vmem doctor` checks configured remotes and project registries locally, without network access. Remote validation shares sync's origin URL rules, registry validation uses the log-write parser, and failed checks exit 1.
- A registry update whose directory flush fails after the config was replaced now reports `registry updated but directory fsync failed`, so the caller knows the update committed and need not retry. The lock is still released; a retried `vaults add` remains refused as already registered.
- `vmem recover` reads at most 4 KiB of the lock owner record; a larger lock file is treated as unreadable (state `unknown`) and is never removed.

## [0.2.1] - 2026-10-30

- The `tidy` LINT event and the org-promotion SYNC events are bound to the vaults resolved at the start of the run; if a vault id is re-registered before the append, the event is refused with LOG_DRIFT instead of landing in the other vault. The committed notes are not rolled back.
- Tidy and org promotion bind every note write to the same vaults: a re-registration before a write is refused with VAULT_DRIFT and nothing is written. A bound log append reports any re-registration as LOG_DRIFT, before policy or path checks.
- Org promotion and `tidy --log` report `applied: true` when a write committed and a later step (lock removal, directory flush) failed; tidy then lists the log in `written`.

## [0.2.0] - 2026-10-30

- Fine-grained PII policy: `vault.pii` can set `allow`, `warn` or `deny` per category (email, phone, the global `piiPatterns`, named per-vault patterns) and per surface (notes, log, promotion), with an allow list of exact addresses, domains and phone numbers. The `allow`/`deny` shorthand keeps its previous meaning.
- `vmem vaults pii <id>` shows the effective policy; `--set` previews a change and lists every loosened cell, and `--confirm` applies it. `vaults list` and `vmem_status` report the matrix as `piiPolicy`.
- `vmem tidy --log` redacts only PII that the policy denies on the log surface, so personal vaults keep historical email addresses; secrets are still redacted everywhere.
- Org promotion reports a `warn` cell in the target policy as a warning instead of refusing.

## [0.1.3] - 2026-10-30

- `vmem tidy --log` fixes legacy log lines that fail lint L09: a trailing seconds field is dropped, and any other malformed line is kept verbatim behind `# legacy: `.

## [0.1.2] - 2026-10-30

- `vmem move` accepts an existing legacy-named note (lint L13) as its source and may rewrite inbound links in other legacy-named notes, so the finding can be fixed with a normal rename. Destinations still need a valid stem.

## [0.1.1] - 2026-10-30

- `vmem setup` registers the PATH `bun` launcher when it runs the same binary, so host MCP entries survive a runtime upgrade that removes the versioned real path.

## [0.1.0] - 2026-10-30

- Add vault registration, bounded configuration, home resolution, diagnostics and explicit unregister confirmation.
- Add lossless frontmatter, local wiki-link resolution and incremental SQLite FTS indexing.
- Add validated atomic note mutations, preview fingerprints and append-only attributed vault events.
- Add bounded CLI/MCP providers, reversible host setup and agent-mem promotion with provenance.
- Add indexed lint, deterministic graph reports, bounded neighborhoods and synthetic reference-parity checks.
- Reuse unchanged parsed notes and link analysis during write validation, refresh derived links only for affected sources, and recheck the staging snapshot by direct content comparison instead of rehashing.
- Resolve wiki links by note path only, matching Obsidian and lint L01; aliases remain lookup metadata for read commands, and new alias-only links are refused.
- Prepare release validation, clean-install package smoke and an opt-in npm OIDC workflow. Publication, private evidence and live cutover remain separate gates.
