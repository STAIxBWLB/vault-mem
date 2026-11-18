# vault-mem

`vmem` keeps Obsidian-compatible knowledge vaults that agents and people both write safely. Every note write is validated (schema, links, secrets, PII), staged atomically, returned as a receipt and recorded in the vault log; reads go through a derived SQLite FTS5 index. It ships a CLI and an MCP stdio server. Requires <!-- facts:bun-floor -->Bun >=1.4.2<!-- /facts:bun-floor -->.

Status: released versions are published to npm ([CHANGELOG](CHANGELOG.md), [release readiness](docs/release-readiness.md)). Replacing an existing vault writer is a live cutover: it is the parent plan's operation, outside this repository, and follows the [cutover checklist](docs/cutover-checklist.md). This repository does not record its result, and a release does not authorize it.

## Install

```sh
npm i -g @staix/vault-mem      # the vmem bin runs under Bun
vmem --version
```

## Quickstart

```sh
vmem vaults add personal /absolute/vault --kind personal --write mcp   # the directory must contain notes/
vmem status                     # home, registered vaults and health
vmem doctor                     # path, remote, registry, pending-tidy and spec-source checks; exits 1 when unhealthy
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
- **Two-step changes**: move, delete, merge, tidy, promotion, sync and proposal decisions first return a preview with a fingerprint and change nothing; `--confirm --fingerprint <sha>` (MCP `confirm`, `fingerprint`) applies exactly that preview.
- **Proposals**: opt-in create or exact-patch requests remain outside the vault and index until confirmed. Review and rejection do not authenticate a human; existing direct writes retain their policy. An interrupted apply remains `apply_unknown` until inspected, and is never replayed automatically.
- **Receipts**: an applied write can still report a later failure (log append, cleanup, sync). Read `applied`, `logged` and `issues` before retrying, and never repeat an applied write blindly.
- **Git**: each vault is its own repository. Only `vmem sync` commits or pushes, and nothing runs on a schedule.

## Output

Output: every command prints text for people by default, following agent-hub's CLI style. Lists are tables with uppercase headers, single objects are a title line and aligned fields, checks (`doctor`, `check`, `lint`, `spec validate`) print LEVEL/CHECK/FINDING rows and a verdict, and writes print what changed or would change. A preview prints the exact confirm command with its fingerprint; a truncated read or full page prints the command for the next one. `--json` prints compact JSON objects for scripts and agents; existing fields keep their shape; status and vaults list additionally report effective `domains`. `--color=auto|always|never` is accepted by every command: auto colors only a terminal, and `NO_COLOR` or `TERM=dumb` turn it off. Text wraps to the terminal width, or to `COLUMNS` when output is not a terminal. Errors stay `vmem: <message>` on stderr, and exit codes are unchanged. `vmem help <command>` or `<command> --help` prints one command's entries.

## Commands

| area | commands | reference |
|---|---|---|
| Registry and policy | `status`, `doctor`, `recover`, `vaults add\|list\|remove\|pii`, `specs add\|list\|remove` | [configuration](docs/reference/configuration.md) |
| Reads | `rebuild`, `search`, `show`, `links`, `brief`, `stats`, `evidence` | [reads](docs/reference/reads.md) |
| Writes and log | `new`, `patch`, `append`, `frontmatter`, `link`, `supersede`, `merge`, `move`, `delete`, `check`, `report`, `tidy`, `log append\|tail\|grep` | [writes](docs/reference/writes.md) |
| Proposals | `proposal submit\|list\|show\|apply\|reject\|reconcile` | [writes](docs/reference/writes.md#proposals) |
| MCP and hosts | `mcp`, `setup`, `completion`, `manifest` | [mcp-and-setup](docs/reference/mcp-and-setup.md) |
| Promotion and sync | `promote-from-amem`, `promote`, `sync` | [promotion-and-sync](docs/reference/promotion-and-sync.md) |
| Analysis | `lint`, `graph build\|neighbors\|path\|explain`, `skills mine` | [analysis](docs/reference/analysis.md) |
| Specs | `spec get\|graph\|grep\|validate\|create\|update\|delete` | [specs](docs/reference/specs.md) |

`vmem help <command>` prints one command's syntax; `vmem manifest --json` lists the commands and MCP tools for scripts. [docs/README.md](docs/README.md) says which document to open for which task.

## Not implemented

- Live cutover of an existing vault writer: outside this repository (see Status).
- File watching, model calls and embeddings: reads and writes are deterministic and offline.
- Cross-vault links: `[[x]]` always resolves inside its own vault.
- Evidence verification of sources outside the same vault's `notes/` (other files, other vaults, URLs, memory ids): those entries are stored and reported `unverified_external` or `unsupported`, never fetched.
- Scheduled or automatic sync and push.
- A resolution setting for graph communities.
- An event-filtered capture read for skill mining.
- A console bin: vault-mem ships only the plugin module for the `acon` console of [agent-console](https://github.com/STAIxBWLB/agent-console).

## Library

The only runtime dependency is the exact first-party pin <!-- facts:amem-pin -->`@staix/agent-mem@0.28.0`<!-- /facts:amem-pin -->; it is not loaded by registry commands. Public library exports (`@staix/vault-mem`, from `src/index.ts`) cover configuration and home resolution, registry operations, frontmatter, link resolution and the derived index, validated writes, the append-only log, the MCP server and its vault tools, host setup, the CLI command table and completion, promotion from agent-mem and to org vaults, lint and graph analysis, sync, source references, migration tidy, and the spec source registry, graph, validation and freshness. `@staix/vault-mem/ui-plugin` is the console plugin entry (see [Console plugin](docs/reference/mcp-and-setup.md#console-plugin)). No console bin is shipped. Exported functions and constants by module:
<!-- facts:exports -->

- `src/home.ts`: `resolveHome`
- `src/config.ts`: `parseConfig`, `parseVault`, `parseSpec`, `readConfig`, `CONFIG_FILE`, `MAX_CONFIG_BYTES`
- `src/registry.ts`: `addVault`, `removeVault`, `addSpec`, `removeSpec`, `specStatus`, `loadRegistry`, `registryStatus`, `recoverRegistry`, `effectivePii`, `syncDirectory`, `LOCK_FILE`
- `src/frontmatter.ts`: `parseFrontmatter`, `emitFrontmatter`
- `src/links.ts`: `extractLinks`, `resolveLinks`, `normalizeTarget`
- `src/vault-index.ts`: `VaultIndex`, `MAX_NOTE_BYTES`, `MAX_RESULTS`, `MAX_READ_BYTES`
- `src/vault-history.ts`: `readHistory`, `readRevision`, `readChanges`, `historyText`, `revisionText`, `changesText`, `HISTORY_PAGE_LIMIT`, `HISTORY_SCAN_LIMIT`, `CHANGES_PAGE_LIMIT`, `SNAPSHOT_TRANSPORT_BYTES`
- `src/writer.ts`: `applyWrite`, `sha256`, `MUTATION_LOCK`, `MAX_WRITE_BYTES`
- `src/proposal-provider.ts`: `submitProposal`, `listProposals`, `showProposal`, `previewProposalApply`, `applyProposal`, `previewProposalReject`, `rejectProposal`, `reconcileProposal`
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

<!-- /facts:exports -->

## Development

```sh
bun install --frozen-lockfile
bun bin/vmem.js --help          # run from a checkout
bun run check
```

`bun run check` needs Bun, git and tar: strict types, import boundaries, README facts, documentation freshness, tests, a package dry-run and a clean installed CLI/MCP smoke (the tarball install needs network access to resolve the pinned dependency). Node/npm are used only by the release workflow. CI runs on Ubuntu for pull requests (macOS too when the `ci:macos` label is added), and on Ubuntu and macOS for pushes to `main` and releases. Generated facts blocks in README.md and docs/reference change only through `bun scripts/readme-facts.ts --write`. Contributor rules are in [AGENTS.md](AGENTS.md) and [REVIEW.md](REVIEW.md); release gates in [docs/release-readiness.md](docs/release-readiness.md).
