---
name: vault_adapter
description: Vault access rules for public vault-facing skills. Shared runtime, vault access, logging and schema guidance for vmem skills.
type: spec
---

# Vault Adapter Rules

## Purpose

This spec is the shared access contract for vault-facing skills. It is a policy document, not a Python module.

## Runtime Discovery

At the start of a vault-facing workflow:

1. Prefer connected vmem MCP tools. If they are unavailable but the CLI is installed, use documented CLI equivalents where available; for MCP tools without a CLI equivalent start `vmem mcp` as a stdio subprocess. Use newline-delimited JSON-RPC: send `initialize` with `protocolVersion: "2025-06-18"`, `capabilities: {}` and `clientInfo: {name: "skill-client", version: "1"}`; read its response, send `notifications/initialized`, then use `tools/list` and `tools/call` with `params: {name, arguments}`. Read each response and its full tool receipt before continuing; close the subprocess when done. Stdout is protocol only, stderr is diagnostic. Respect the registered vault's write policy; a refusal is not permission to bypass it.
2. Discover registered vaults using `vmem_status` when MCP is available, or `vmem vaults list --json` using the CLI. If a workspace config is present, discover it by walking up from the current directory and match its `vault.path` to the canonical registered path. Otherwise use the user's explicitly selected vault, or the sole registered vault. If selection is ambiguous or no vault matches, ask the user; never rely on an implicit first-vault fallback.
3. Pass the selected id as `vault` on every vmem tool call and as `<vault>` on CLI calls. When workspace configuration exists, read the relevant `vault.log_file` and `ssot.*` keys only for workspace-dependent steps. If a required workspace or key is absent, skip that step and report it; do not invent a path.
4. When a skill states a minimum version, check `vmem --version` if the CLI is available, or the MCP initialize response's `serverInfo.version` if exposed by the host. If an available version is below the minimum, stop and report the required upgrade. If the MCP host does not expose the version, report it as unknown and use the tool availability and receipts; do not require a CLI solely for the version check.

## Access Rules

### Vault Markdown

All vault writes go through vmem, which validates before it saves (schema, enums, MOC topics, links, secrets, PII):

- `notes/*.md`: the vmem write tools below, using the selected transport.
- `ops/` and `reports/` files: `vmem_report(path, body)`, the MCP form of the CLI `vmem report <vault> <ops/...|reports/...> --body -` (same path rules, screening, receipt and default `EXTRACT` line).
- Root docs (`AGENTS.md` and similar) are not agent-writable; change them only on the user's explicit maintenance instruction.

Reads: `notes/` through `vmem_read` / `vmem_read_many` / `vmem_search` / `vmem_list`. `ops/`, `reports/`, `self/`, `templates/` and root docs through `vmem_read_file` / `vmem_list_files` (bounded, paged like `vmem_read`); read-only filesystem access also works. Do not use filesystem write/edit, shell redirection or another MCP server for any vault file.

### Write results

Read the whole receipt, never one field. `ok: true` with `applied: true` saved its changes. A write that persisted changes and then failed returns `ok: false` with `applied: true` — that is the one partial-write signal, for direct note writes since vmem 0.6.0 and for `vmem_promote` / `vmem_promote_from_amem` since 0.7.0. In that case stop, report the receipt, reconcile the note and log, and never retry blindly. `ok: false` with `applied: false` wrote nothing, so its issues are the whole result. Always check `changes` and `logged` too: a saved note whose log line failed is `applied: true, logged: false`, which is a warning, not a rollback.

Skills link to this section (§Write results) instead of restating the rule.

Declared exceptions (machine I/O, not agent writes):

| Path | Writer / reader | Why |
|---|---|---|
| `ops/sessions/last-sync-timestamp` | fs read/write by vault-sync | plain file, not a note |

Typical mappings:

| Operation | vmem tool |
|---|---|
| Read note / several notes | `vmem_read` (frontmatter, body, sha256), `vmem_read_many` (<=20) |
| Search / list | `vmem_search`, `vmem_list` (page with the returned `nextCursor` as `cursor`) |
| Read / list non-note files | `vmem_read_file`, `vmem_list_files` |
| Links / neighbourhood | `vmem_links` (out, in or both, each dead link with at most one `suggested` target), `vmem_graph_neighbors` (`hops` 1–2, `limit` 1–500, `relation`; each node carries `community` and `degree`), `vmem_graph_path` (`from`/`to` stems, `maxHops` 1–6 default 6, `relation`, `viaHubs`; `found: false` when no route within `maxHops`). Neighbour, path or community questions never read `reports/vault-graph.json` or the graph report |
| Create note | `vmem_create` |
| Edit body | `vmem_patch` (exact old/new text, or `edits` for up to 32 at once), `vmem_append` (into an H2 section) |
| Edit frontmatter or tags | `vmem_set_frontmatter` |
| Typed relation link | `vmem_link` |
| Supersede | `vmem_supersede` |
| Merge two notes | `vmem_merge`: call once for the merged body, source/topic unions, inbound rewrites and `fingerprint`, then again with `confirm: true`, that fingerprint and `log` |
| Intent-scoped pointers | `vmem_brief` (`intent` <=1024 bytes, optional `paths` as extra basename word hints — not a citation filter — and `bytes` 256–4096; screened pointer lines without bodies, one-hop rows marked `[neighbor]`) |
| Promote an agent-mem entry | `vmem_promote_from_amem`: two-step like `vmem_move`; its confirm logs `LEARN` itself and takes no `log` |
| Recent log events | `vmem_log_tail` (read-only) |
| Move / delete | `vmem_move`, `vmem_delete`: call once for `{preview, fingerprint}`, then again with `confirm: true` and that fingerprint |
| MOCs / stats | `vmem_mocs`, `vmem_stats` (counts by type, domain and status, `size` bytes and words by type and domain, note-to-source `ratio`, recent edits, log events), `vmem_status` |
| `ops/` / `reports/` file | `vmem_report` |
| Lint / graph reports | `vmem_lint` (`write: true` saves `reports/lint-report-YYMMDD.md`; it takes no note argument), `vmem_graph_build` |
| Dry validation | `vmem_check` (prospective note text, no write; run it before `vmem_create` so a refusal costs no write) |

Pass `expectedSha` (from `vmem_read`) on edits that must not race another writer. Every successful write changes the note's sha256, so re-read before the next `expectedSha` edit of the same note.

### Workspace SSOT

Workspace-local operational files are not vault markdown. They may be read or edited through normal filesystem tools:

- `workspace.config.yaml`
- `project-registry.yaml`
- files under the workspace rules directory
- skill source files in this repo

## Log Append

vmem owns the vault log (`vault.log_file`). Every vmem write appends one attributed line itself:

- Every write tool (`vmem_create`, `vmem_patch`, `vmem_append`, `vmem_set_frontmatter`, `vmem_link`, `vmem_supersede`, `vmem_merge`, `vmem_report`, and `vmem_move` / `vmem_delete` on the confirm call) accepts an optional `log` argument (`{type, project, source, dest?, note}`) that sets that line's TYPE, project and note. vmem refuses the whole write when the event is invalid. `vmem_promote_from_amem` is the exception: its confirm logs `LEARN` itself and takes no `log`.
- Without `log`, a write records vmem's default for that operation: `vmem_link` records `CONNECT`, `vmem_move` records `ROUTE`, `vmem_merge` / `vmem_supersede` record `RETHINK`, every other write records `EXTRACT` (`…  -  vmem:<op> → path`); `vmem_lint(write: true)` and `vmem_graph_build` record `LINT` / `GRAPH`.
- When a workflow's contract needs a TYPE (for example a LEARN line for an update), pass it as `log` on that write. Use `vmem_log_append` only for an event with no write (a failure, a batch summary, a promoted TASK).

Do not append to the log with `>>` or any other filesystem write.

### Log failure handling

Read the whole receipt per §Write results. The one rule this section adds: on `ok: false, applied: false`, record a `failed: <reason or issue codes>` line with `vmem_log_append` under the workflow's TYPE and report the issues.

```text
YYYY-MM-DD HH:MM  TYPE  project  source → dest  — note
```

Each field is two spaces apart; `project` is a registry id or `-` when unclassified, and `dest` uses `notes/<x>.md`. For `source`, use the real workspace-relative source path when available, otherwise a valid source URL or `mem:` id; if none is available use `-` and report missing provenance. Do not invent a workspace path. The log field must be nonempty, at most 512 characters, without control characters, `|`, double spaces, ` → ` or ` — `; vmem also screens it and limits the whole line to 1000 UTF-8 bytes. If the real reference cannot satisfy those rules, report the refusal and ask for a valid reference rather than silently changing it.

When available, consult the workspace `ssot.ingest_chain` normalization table. `TYPE` is validated by vmem: the canonical set is `INGEST ROUTE EXTRACT CONNECT DIGEST LEARN LINT TASK GRAPH SYNC RETHINK SOURCE`; historical non-standard TYPEs are interpreted via that rule's normalization table and must not be written anew (a split or MOC refactor logs as `EXTRACT`, while vmem records a rename as `ROUTE` and a merge as `RETHINK` on its own). vmem refuses a TYPE outside the set.

## Summary To Vault Fields

When promoting a source summary into a vault note, copy source-derived fields instead of regenerating them:

| Vault note field | Source summary field | Rule |
|---|---|---|
| `description` | `description` | Required, non-empty, concise |
| `domain` | `domain` | Required, workspace-defined domain enum |
| `topics` | `topics` | Required, at least one wiki link, **and every `[[target]]` must already exist as a MOC note in vault** (MOC = note where `type: moc` or a domain hub like `projects.md`, `research.md`, `operations.md`, `teaching.md`, `people.md`, `ai-practice.md`). |
| `source` | `source` | Preserve source identity |
| `project` | `project` | Map via project registry when available |

If required fields are missing, fail before writing. Do not synthesize blank or guessed values. expect: vmem refuses a missing `description`, `type` or `domain`, an enum value outside the vocabulary, and a `topics` entry that is not an existing MOC.

**MOC enforcement on `topics`**: `topics` carries hub navigation only. Concept/keyword tags (e.g., `credit-recognition`, `partnership-mapping`, `duty-model`) belong in body text, not in `topics`. vmem refuses a `topics` entry that does not resolve to an existing MOC. If a needed MOC does not exist, ABORT: a MOC is created separately with a `vmem_create type: moc` call on the user's instruction, never implicitly by an extract. Never silently copy unknown wiki-links from summary.md into vault notes.

## Project Registry Pattern

1. When a workspace and its registry are available, load `ssot.project_registry` from `workspace.config.yaml`. Otherwise skip registry classification, report the skipped step, and use content-based domain analysis or an unclassified project (`-`); ask if the result remains ambiguous.
2. Consider `status: active` entries only. Extract signals from the source (people, acronyms, keywords, orgs, tags).
3. Score with the workspace weights; the default is people +3, acronyms +2, keywords +2, orgs +1, tags +1, with a match threshold of 3. A workspace scoring rule under `ssot.registry_scoring` overrides these defaults.
4. A single top score at or above the threshold is the match: use its `path` to validate the source. Resolve its `vault_note` in the bound vault. Add it to `topics` only if `vmem_mocs` confirms it is a MOC; for an ordinary note, keep it as a project/body link and use its validated MOC topics or a relevant existing domain MOC. Apply §Summary To Vault Fields before writing; a missing MOC is unresolved, never auto-created.
5. Tie or ambiguity: use the registry disambiguation fields, then ask the user.
6. Below the threshold (registry fallback): fall back to content-based domain analysis; if still ambiguous, ask the user, or record the source as unclassified (`project: -`) when the calling workflow allows it.

## Boundary

- Work files: filesystem tools.
- Vault markdown: vmem tools or documented CLI equivalents only; never write directly to the filesystem.
- Cloud mirrors or synced copies: do not edit directly from vault skills.
