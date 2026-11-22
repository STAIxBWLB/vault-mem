# vault-mem

`vmem` keeps Obsidian-compatible knowledge vaults that agents and people both write safely. Every note write is validated (schema, links, secrets, PII), staged atomically, returned as a receipt and recorded in the vault log; reads go through a derived SQLite FTS5 index. It ships a CLI and an MCP stdio server. Requires <!-- facts:bun-floor -->Bun >=1.4.4<!-- /facts:bun-floor -->.

Status: released versions are published to npm ([CHANGELOG](CHANGELOG.md), [release readiness](docs/release-readiness.md)). Replacing an existing vault writer is a live cutover: it is the parent plan's operation, outside this repository, and follows the [cutover checklist](docs/cutover-checklist.md). This repository does not record its result, and a release does not authorize it.

## Install

```sh
npm i -g @staix/vault-mem      # the vmem bin runs under Bun
vmem --version
```

## Quickstart

```sh
vmem vaults add personal /absolute/vault --kind personal --write mcp   # the directory must contain notes/
vmem status                     # home, agent-mem version, registered vaults and health
vmem doctor                     # agent-mem version, path, remote, registry, pending-tidy and spec-source checks; exits 1 when unhealthy
vmem setup claude               # dry run: the MCP entry it would add
vmem setup claude --apply       # register `vmem mcp` in the host, then restart the host session
vmem search personal "project discovery"
vmem show personal "Note or alias" --section "Evidence"
vmem new personal example-finding --type insight --domain research --topics research --description "A distinct supporting observation."
vmem tidy personal --all        # once after upgrading an existing vault: preview, then --confirm --fingerprint
```

## Concepts

- **Home**: the registry and policies live in `vmem.config.json` under the vmem home: `VMEM_HOME`, else the `home` pointer in the default home's config, else the default home (`$AGENTHUB_HOME/vmem`, or `~/.agenthub/vmem`). Derived index caches live under the home, never inside a vault. Proposal records are durable home data, not a rebuildable cache: include the configured home in backups.
- **Vault**: a directory with a flat `notes/` folder, an append-only `log` and optional `reports/` and `ops/`. Each vault has a `kind` (`personal` or `org`), a `write` policy (`mcp` allows CLI and MCP writes, `cli` CLI only, `none` no writes) and a PII policy (default `allow` for personal, `deny` for org).
- **Notes**: frontmatter `type` is one of <!-- facts:note-types -->`insight`, `decision`, `observation`, `person`, `project`, `method`, `moc`, `reference`<!-- /facts:note-types -->; links are `[[wiki links]]` resolved by filename stem inside the same vault.
- **Two-step changes**: move, delete, merge, tidy, promotion, sync, proposal decisions and assertion purges first return a preview with a fingerprint and change nothing; `--confirm --fingerprint <sha>` (MCP `confirm`, `fingerprint`) applies exactly that preview.
- **Proposals**: opt-in create or exact-patch requests remain outside the vault and index until confirmed. Review and rejection do not authenticate a human; existing direct writes retain their policy. An interrupted apply remains `apply_unknown` until inspected, and is never replayed automatically.
- **Assertions**: an optional `assertions/` directory holds an append-only, hash-chained journal of manually authored subject/relation/value assertions, each with its evidence and its record time. `vmem assert` appends a validated batch there and writes no note, so a note edit never rewrites history; `vmem assertions` and `vmem_assertions` read it with current policy, and `vmem sync` commits the segments like the log. `vmem assertions purge` removes one assertion's payloads: `payload` goes, `payload_sha256` and every hashed field stay, `purged: {at, reason}` is added, the chain still verifies, and reads then leave the assertion out of answers, show it `unavailable` in history and count it in `coverage.purged`.
- **Receipts**: an applied write can still report a later failure (log append, cleanup, sync). Read `applied`, `logged` and `issues` before retrying, and never repeat an applied write blindly.
- **Git**: each vault is its own repository. Only `vmem sync` commits or pushes, and nothing runs on a schedule.

## Output

Output: every command prints text for people by default, following agent-hub's CLI style. Lists are tables with plain column headers, single objects are a header line and aligned fields under `> Section` titles, checks (`doctor`, `check`, `lint`, `spec validate`, `assertions exposure`) print one marker line per finding and end with exactly one summary line such as `! 2 warnings`, and writes print what changed or would change. A preview prints the exact confirm command with its fingerprint; a truncated read or full page prints the command for the next one. `--json` prints compact JSON objects for scripts and agents; existing fields keep their shape; status and vaults list additionally report effective `domains`. `--color=auto|always|never` is accepted by every command. With `auto` (the default) `NO_COLOR` turns color off, then `FORCE_COLOR` or `CLICOLOR_FORCE` (not `0`) turns it on, then `FORCE_COLOR=0` or `CLICOLOR=0` turns it off; otherwise only a terminal is colored, unless `TERM=dumb`. `--ascii`, also accepted by every command, prints ASCII markers, as does a locale that is not UTF-8. Text wraps to the terminal width, or to `COLUMNS` when output is not a terminal. Errors stay `vmem: <message>` on stderr, and exit codes are unchanged; a usage error adds the command's usage, wrapped within 80 columns or shortened. `vmem help` lists each command with a one-line summary within 80 columns; `vmem help <command>` or `<command> --help` prints its Usage, Description, Flags, Examples and Details.

## Commands

| area | commands | reference |
|---|---|---|
| Registry and policy | `status`, `doctor`, `recover`, `vaults add\|list\|remove\|pii`, `specs add\|list\|remove` | [configuration](docs/reference/configuration.md) |
| Reads | `rebuild`, `search`, `show`, `links`, `brief`, `stats`, `evidence` | [reads](docs/reference/reads.md) |
| Writes and log | `new`, `patch`, `append`, `frontmatter`, `link`, `supersede`, `merge`, `move`, `delete`, `check`, `report`, `tidy`, `log append\|tail\|grep` | [writes](docs/reference/writes.md) |
| Assertions | `assert` (append a validated batch of temporal assertions), `assertions purge` (preview, then confirm removal of one assertion's payloads) | [writes](docs/reference/writes.md#assertions) |
| Proposals | `proposal submit\|list\|show\|apply\|reject\|reconcile` | [writes](docs/reference/writes.md#proposals) |
| MCP and hosts | `mcp`, `setup`, `completion`, `manifest` | [mcp-and-setup](docs/reference/mcp-and-setup.md) |
| Promotion and sync | `promote-from-amem`, `promote`, `sync` | [promotion-and-sync](docs/reference/promotion-and-sync.md) |
| Analysis | `lint`, `graph build\|neighbors\|path\|explain`, `skills mine` | [analysis](docs/reference/analysis.md) |
| Specs | `spec get\|graph\|grep\|validate\|create\|update\|delete` | [specs](docs/reference/specs.md) |

`vmem help <command>` prints one command's usage, flags and examples; `vmem manifest --json` lists the commands and MCP tools for scripts. [docs/README.md](docs/README.md) says which document to open for which task.

`vmem settings <vault>` displays effective settings as a human-readable report (`--json` retains structured output); `--set JSON` previews changes and `--confirm --fingerprint SHA` applies them. The console Settings panel uses the same preview and confirmation. Graph community resolution defaults to 1.

Enrichment is opt-in per vault through `vmem settings` or the Settings panel. A skill computes results outside vmem and uses `vmem_enrichment_work`, `vmem_enrichment_intake` and `vmem_enrichment_get` over MCP. An uncertain fact or link intake blocks replay until the journal or proposal is inspected and `vmem_enrichment_reconcile` confirms whether it was published. Results bind a source path and content hash to unverified producer metadata. Embeddings, summaries and community labels stay in a local sidecar under the vmem home; they are not synced. Embeddings are rounded to little-endian Float32. The sidecar is capped at 128 MiB and 50,000 records; 10,000 vectors of 1,536 dimensions fit with bounded metadata when the remaining capacity is not occupied by other records. Updating a record rewrites the sidecar, so large bulk intakes can be slow. Inferred links enter the existing proposal flow and the `inferred_links` frontmatter list is an unverified declaration. L19 warns when a listed target has no visible body link. Facts enter the assertion journal. `vmem_similar` uses stored vectors, and `vmem_search` accepts an optional model and vector for hybrid ranking; without stored vectors it keeps lexical ordering and scores while excluding currently denied paths. Only enabled vaults report missing or stale embeddings in lint.

## Skills

The package includes `vault-connect`, `vault-enrich`, `vault-extract`, `vault-graph`, `vault-learn`, `vault-lint`, `vault-refactor`, `vault-remember`, `vault-rethink`, `vault-stats`, `vault-sync`, `vault-update`, `vmem-status` and `skill-mine`. They run with vmem alone; workspace-specific steps are optional.

`vmem setup claude|codex|kimi|qwen --apply` installs the skills alongside the MCP entry. `--undo` removes only unmodified vmem-owned skills. Pi, jcode and agy do not have an automatic skill root; use `vmem skills export <dir>` to prepare self-contained directories for another host.

Each installed directory has a `.vmem-skill.json` ownership marker with its package version and SHA-256 over its files, excluding the marker. Unexpected empty directories are treated as modifications. An absent skill is installed; an owned, unchanged skill can be replaced. Locally modified skills and foreign directories or symlinks are reported and left untouched. An existing export directory with unrelated entries is refused. Setup reports each result; a conflict does not prevent other requested changes.

## Not implemented

- Live cutover of an existing vault writer: outside this repository (see Status).
- File watching, model calls and embeddings: reads and writes are deterministic and offline.
- Cross-vault links: `[[x]]` always resolves inside its own vault.
- Evidence verification of sources outside the same vault's `notes/` (other files, other vaults, URLs, memory ids): those entries are stored and reported `unverified_external` or `unsupported`, never fetched.
- Scheduled or automatic sync and push.
- Rewriting assertion bytes out of Git history, other clones or remotes: `vmem assertions purge` removes a payload from the journal in the working tree, and complete erasure needs a history rewrite outside vmem.
- An event-filtered capture read for skill mining.
- A console bin: vault-mem ships only the plugin module for the `acon` console of [agent-console](https://github.com/STAIxBWLB/agent-console).

## Library

Runtime dependencies are the first-party range <!-- facts:amem-pin -->`@staix/agent-mem@>=0.33.0 <1.0.0`<!-- /facts:amem-pin --> and exact pin `@staix/cli-output@0.1.0`; host API 1 is checked at load before any agent-mem store opens. Registry commands do not load the agent-mem root. New compatible minors are resolved on installation or update; an existing installation keeps its resolved version. Public library exports (`@staix/vault-mem`, from `src/index.ts`) cover configuration and home resolution, registry operations, frontmatter, link resolution and the derived index, validated writes, the append-only log, the MCP server and its vault tools, host setup, the CLI command table and completion, promotion from agent-mem and to org vaults, lint and graph analysis, sync, source references, migration tidy, the temporal assertion journal and its evaluation, and the spec source registry, graph, validation and freshness. `@staix/vault-mem/ui-plugin` is the console plugin entry, with panels for graph snapshots with optional enrichment and semantic edges, proposals (list, show, apply, reject), assertions and note history and changes, and their snapshot types (see [Console plugin](docs/reference/mcp-and-setup.md#console-plugin)). No console bin is shipped. Exported functions and constants by module:
<!-- facts:exports -->

- `src/assertion-read.ts`: `readAssertions`, `ASSERTIONS_PAGE_LIMIT`
- `src/home.ts`: `resolveHome`
- `src/config.ts`: `parseConfig`, `parseVault`, `parseSpec`, `readConfig`, `CONFIG_FILE`, `MAX_CONFIG_BYTES`
- `src/registry.ts`: `addVault`, `removeVault`, `addSpec`, `removeSpec`, `specStatus`, `loadRegistry`, `registryStatus`, `recoverRegistry`, `effectivePii`, `syncDirectory`, `LOCK_FILE`
- `src/frontmatter.ts`: `parseFrontmatter`, `emitFrontmatter`
- `src/links.ts`: `extractLinks`, `resolveLinks`, `normalizeTarget`
- `src/vault-index.ts`: `VaultIndex`, `MAX_NOTE_BYTES`, `MAX_RESULTS`, `MAX_READ_BYTES`
- `src/vault-history.ts`: `readHistory`, `readRevision`, `readChanges`, `historyText`, `revisionText`, `changesText`, `HISTORY_PAGE_LIMIT`, `HISTORY_SCAN_LIMIT`, `CHANGES_PAGE_LIMIT`, `SNAPSHOT_TRANSPORT_BYTES`
- `src/assertions.ts`: `readJournal`, `verifySegment`, `evaluateAssertions`, `asOfCutoff`, `appendAssertions`, `purgeAssertions`, `assertFrameBytes`, `ASSERTIONS_DIR`, `ASSERTIONS_LOCK`, `ASSERTION_SCHEMA_VERSION`, `ASSERT_FRAME_BYTES`, `MAX_BATCH_OPS`, `PURGE_LIST_LIMIT`
- `src/assertion-exposure.ts`: `scanAssertionExposure`, `writeReplaceFile`, `EXPOSURE_COMMIT_BUDGET`, `EXPOSURE_BLOB_BYTES`, `EXPOSURE_COMMIT_BYTES`, `EXPOSURE_FRAME_BYTES`
- `src/writer.ts`: `applyWrite`, `sha256`, `MUTATION_LOCK`, `MAX_WRITE_BYTES`
- `src/proposal-provider.ts`: `submitProposal`, `listProposals`, `showProposal`, `previewProposalApply`, `applyProposal`, `previewProposalReject`, `rejectProposal`, `reconcileProposal`, `confirmProposalReconciliation`
- `src/write-validation.ts`: `validateWrite`, `screenContent`
- `src/vault-log.ts`: `appendLog`, `readLog`, `LOG_LOCK`, `MAX_LOG_READ_BYTES`, `MAX_LOG_RESULT_BYTES`, `LARGE_LOG_LINES`
- `src/log-format.ts`: `formatLogEvent`, `LOG_TYPES`, `AGENT_MARKERS`
- `src/mcp.ts`: `serveMcp`, `validArguments`, `FRAME_BYTES`, `RESULT_BYTES`
- `src/mcp-vault.ts`: `createVaultMcp`, `vaultTools`, `VMEM_TOOL_NAMES`
- `src/setup.ts`: `runSetup`, `defaultEntry`, `SETUP_TARGETS`, `SERVER_NAME`
- `src/commands-table.ts`: `COMMANDS`, `completionDefinitions`, `completionScript`
- `src/promote.ts`: `promoteFromAmem`, `listPromotionCandidates`, `draftNote`, `stemFor`, `logProjectFor`
- `src/vault-lint.ts`: `lintVault`
- `src/vault-graph.ts`: `buildGraph`, `graphNeighbors`, `graphPath`, `graphReport`
- `src/graph-evidence.ts`: `explainGraphPath`, `EXPLAIN_OCCURRENCES_PER_HOP`, `EXPLAIN_MAX_BYTES`
- `src/analysis-reports.ts`: `writeAnalysisReports`
- `src/org-promote.ts`: `promoteToOrg`, `screenForOrg`, `dropUnresolvedLinks`, `lintPromoted`
- `src/sync.ts`: `syncVault`, `sameRemote`
- `src/source.ts`: `normalizeSource`, `sourceReferences`
- `src/evidence.ts`: `evidenceReport`, `verifyNoteEvidence`, `verifyEvidenceEntry`, `parseEvidence`, `evidenceProblem`, `screenEvidenceForTarget`, `EVIDENCE_SCHEMA_VERSION`
- `src/tidy.ts`: `tidyVault`, `parseTidyMap`, `TIDY_RULES`
- `src/spec-source.ts`: `resolveSpecWorktree`, `discoverSpecs`, `SpecIndex`
- `src/spec-graph.ts`: `buildSpecGraph`, `specSlice`, `SPEC_EDGE_KINDS`, `MAX_SPEC_INPUTS`, `MAX_SPEC_EDGES`
- `src/spec-validate.ts`: `validateSpecs`, `introducedSpecErrors`, `validateSpecRepo`
- `src/spec-freshness.ts`: `specFreshness`, `specsCoveringPath`
- `src/registry.ts`: `settingsSnapshot`, `changeSettings`
- `src/ui/plugin.ts`: `plugin as consolePlugin`
- `src/enrichment.ts`: `listEnrichmentWork`, `intakeEnrichment`, `readEnrichment`, `reconcileEnrichment`
- `src/enrichment-query.ts`: `hybridSearch`, `similarNotes`

<!-- /facts:exports -->

The `./ui-plugin` entry also exports `GraphSnapshotPage`, `GraphPanelPage`, `GraphNodeColumns` and `GraphEdgeColumns`.

## Development

```sh
bun install --frozen-lockfile
bun bin/vmem.js --help          # run from a checkout
bun run check
```

`bun run check` needs Bun, git and tar: strict types, import boundaries, README facts, documentation freshness, tests, a package dry-run and a clean installed CLI/MCP smoke (the tarball install needs network access to resolve the dependency range). Node/npm are used only by the release workflow. CI runs on Ubuntu for pull requests (macOS too when the `ci:macos` label is added), and on Ubuntu and macOS for pushes to `main` and releases. Generated facts blocks in README.md and docs/reference change only through `bun scripts/readme-facts.ts --write`. Contributor rules are in [AGENTS.md](AGENTS.md) and [REVIEW.md](REVIEW.md); release gates in [docs/release-readiness.md](docs/release-readiness.md).
