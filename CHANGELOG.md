# Changelog

## [Unreleased]

## [0.5.1] - 2026-11-05

- Console inbox snapshots share a background refresh, keep prior rows through refreshes and source failures, and wait at most 700 ms cold before showing a refreshing row. Payloads are capped at 50 prioritized rows with bounded Unicode-safe title and detail. `moreIsLowerBound` identifies "at least N more" when agent-mem's per-project candidate limit prevents an exact total. Applied writes invalidate freshness without clearing triage; source workers refresh on a 60-second cache and have a 30-second termination budget (#149).

- Tests: the core fixture copies use NFC names, so a macOS working copy that holds `café.md` under an NFD name no longer fails `bun run check`. A new test pins the path contract: an NFD-named note keeps its on-disk name in `search`, `show` and `links` and resolves from NFC targets, as the README now states (#147).

## [0.5.0] - 2026-11-04

- Git timeouts and signals are named accurately: `timed out after 60 s` for `vmem sync` and `1 s` for the console check (from Bun's `exitedDueToTimeout`), else `killed by <signal>`, each with its own next step (`check git -C <vault> status, then rerun vmem sync`, the same for `vmem doctor`, or `inspect the vault Git state in System`). `vmem sync` FETCH and PUSH issues with an empty stderr now say why and name a next step. The console sync alert names the staged paths from the same list sync stages (#143).

- Docs: the README says an older agent-console loads the plugin but the panel fails with a TypeError on `host.ui`, fixed by upgrading agent-console, and the spec fixture README says the files need only be tracked, with a commit required only for verification-stamp cases (#142).

- The org sync inbox alert counts only paths `vmem sync` would stage (notes/, reports/, log), with a rename counted once. Other dirty paths are named in the detail but not counted, and a vault with no usable upstream drops the "ahead of upstream" clause. A git call that times out or is killed now logs the signal (`git status failed: timed out (SIGTERM) under the 1 s budget`) and the next step, instead of an empty cause (#138).

- Spec schema fixtures validate every error/warning class in separate default-budget tests and skip unused commit/HEAD setup, avoiding the aggregate macOS timeout. Git inspection failures now name the termination signal and 10-second inspection budget, including shorter parent/test timeouts (#137).

- The console panel's "shown" and "selected" chips use the neutral tone, because they mark a selection and not a state. Two unused panel CSS rules are removed, and the README states that the panel needs agent-console 0.1.0 or later (#129).

- The console `log` snapshot returns an opaque string `cursor`; passing it back as `since` returns only the rows appended since, oldest first up to 100 per poll with `more: true` when rows remain, identical lines included. A rewritten, truncated or far-behind log answers with the latest rows and `reset: true`. The cursor travels as `since` because the console reserves the numeric `after`. Each poll reads a 256 KiB tail or at most 1 MiB forward, plus a back-scan of at most 1 MiB when the tail sits inside one long line. The Log panel keeps re-reading the latest rows, because the shell's poll already refreshes it and skips unchanged data (#48).

- **Behaviour change:** citekey uniqueness now ignores ASCII case while preserving the stored case; retained legacy duplicates warn only on unrelated edits. Reference metadata enforces year-specific arXiv widths, names how to fix reference-only keys, and skips redundant DOI-normalization parsing without changing output (#134).

- Inbox alerts show each org vault's uncommitted paths plus local commits ahead of its tracking ref, with a stable first-seen time and an Overview link. Checks stay local, bounded and cached for 60 seconds; one vault's Git failure is logged and skipped (#48).

- `vmem setup codex` reads TOML table headers quote-aware, so a table such as `[mcp_servers."x]y"]` after the vmem table is no longer swallowed by apply. When the planned file would not parse, the refusal names the right fix: convert a root inline `mcp_servers = { ... }` to `[mcp_servers.<name>]` tables, and on undo rerun `vmem setup codex --undo` (#133).

- Missing or invalid domain ids get a direct set-domain hint without echoing the value; undeclared ids keep their named refusal. L02 domain findings use the neighbouring Korean form, list the selected vault's allowed ids and point to its domains config (#128).

- The console panel uses the kit's `ui.button` and `ui.notice(text, "err")`, which screen readers announce assertively, instead of its own button and error helpers; the truncated-body note is a polite warning. `@staix/agent-console` moves to 4c4c1e0 (#122).

- The console panel builds every view from the agent-console panel kit (`host.ui`): lists use `ui.rows`/`ui.row`, so `j`/`k`/`Enter` work on them, and a note opens in `ui.detail`. The panel CSS uses only the kit's public classes and `--acon-*` tokens, and the `@staix/agent-console` devDependency moves to 5af4dcc, which has `ConsoleUi` (#57).

- `vmem lint` and `vmem graph build` / `graph neighbors` name an option they do not take and where it applies (`graph build: --relation applies only to graph neighbors`) instead of `requires one vault id`. `graph neighbors` now refuses `--dry-run`, which it used to accept and ignore. A wrong positional count keeps its message (#121, #127).

- `vmem graph build` keeps the relation of `- [[x]] (relation)` lines from `vmem link --relation` as `rel` on the `wiki_link` edge, and `vmem graph neighbors --relation` / `vmem_graph_neighbors` `relation` follow only edges of one relation (`wiki_link` for untyped links); an unknown relation is refused. Node and edge sets are unchanged (#74).

- Vault entries accept up to 16 extra domain ids; writers, lint and promotion use the selected target set alongside the six built-ins, and status/list report the effective domains. Malformed declarations fail closed; registry writes with domains use config format 3 (#72).

- Reference notes accept typed citekey, DOI, arXiv id, authors, year and venue metadata with offline syntax checks, lowercase DOI assignments and vault-wide citekey uniqueness. Search includes reference DOI/citekey text; the first run rebuilds the index once in a separate schema3 derived cache without modifying existing notes (#73).

- `vmem setup codex` replaces a vmem entry whose table header uses quoted or spaced keys (`["mcp_servers".vmem]`, `[mcp_servers."vmem"]`, `[ mcp_servers . vmem ]`) and its subtables in place instead of adding a second table and refusing. The dry run now renders and parses the planned file, so a refusal shows in the preview as it does on apply (#116).

- Every CLI command prints text for people by default, following agent-hub's conventions: tables, field blocks, LEVEL/CHECK/FINDING checks with a verdict, one result line per write, and the exact confirm or next-page command after a preview or a cut-off read. Help is grouped into sections with a description per command, and `vmem help <command>` prints one command. `--color=auto|always|never` works everywhere and honors `NO_COLOR` and `TERM=dumb`. **Breaking for scripts:** the default output was pretty JSON and is now text, so pass `--json`, which prints the same compact JSON as before (#114).

- N-1: Against 0.4.0, the derived index moves to `<sha>-links2-schema3.sqlite` (spec caches likewise), so each version keeps its own cache and the first 0.5.0 run builds it once. Configs with vault `domains` use format 3; 0.4.0 reads and preserves those newer-format fields but refuses to create or explicitly set an extra domain id, warning only when an existing value is retained on an unrelated edit. In 0.5.0, `vmem lint`/`vmem_lint` reports an L02 error for a `domain` outside the vault's effective set; 0.4.0 lint had no domain check, so a hand-edited note can pass lint there and fail in 0.5.0. CLI status and `vmem_status` add the effective `domains` field per vault. Note files remain Markdown/YAML, with new reference-only citekey/DOI/arXiv/authors/year/venue fields that 0.4.0 does not validate or author; use 0.5.0 for this metadata and extra-domain writes. Citekey uniqueness is ASCII case-insensitive in 0.5.0; retained legacy duplicates warn only on unrelated edits. Log line format is unchanged. CLI output now defaults to text: scripts must pass `--json` for structured output. Existing MCP tools remain available; reference metadata and the optional `vmem_graph_neighbors` `relation` parameter are additive, and graph wiki-link edges may add `rel`. The console `log` snapshot adds `cursor` and accepts `since`; older callers can omit `since` for the latest rows. These CLI and validation behavior changes require a minor release.

## [0.4.0] - 2026-11-04

- Search, `vmem_search`, spec grep and writer duplicate hints match a Hangul or other CJK term of 2+ characters inside particle and compound forms (`사업단` finds `사업단은`, `사업단장`, `해외사업단`) through a side FTS5 bigram table. Latin terms keep token matching and their ranking; standalone-word and title/description hits rank before substring-only body hits. The index file name gains a schema version (`-links2-schema2.sqlite`), so the first run builds a new index once and older vmem versions keep their own file (#59).

- `vmem_patch` takes `edits` (1 to 32 `{oldString, newString}` pairs) as an alternative to the single pair, and `vmem patch --edits file|-` takes the same JSON array. Each `oldString` must match exactly once in the original note, edits must not overlap or start in frontmatter, and all apply or none do, with one receipt, one log event and the 256 KiB bound checked on the combined result. Several rows of one note no longer need one SHA round trip per edit (#63).

- Every MCP write tool takes the optional `log` event: `vmem_patch`, `vmem_append`, `vmem_set_frontmatter`, `vmem_move` and `vmem_delete` join `vmem_create`, `vmem_link` and `vmem_supersede` (move and delete use it on the confirm call). CLI writers keep `--log JSON` as the one form, now shown in each command's usage and checked against the same closed schema as the MCP field. A given event is validated and screened like `log append` before any note changes, so an invalid event (bad JSON, unknown key, bad type, unknown project, screened secret) refuses the whole write instead of saving the note and logging nothing; the event is no longer part of the move/delete fingerprint (#60).

- `vmem_list` takes a `cursor` and returns the filtered `total`, a per-row `mtime` from the index and `nextCursor`, so a full vault can be paged in stable path order. New read-only `vmem stats <vault>` and `vmem_stats` count notes by type, domain and status, notes modified in the last 7 and 30 days, and log events by type over a bounded window (default 30 days), without writing or locking the vault or its log. `vmem status` and `vmem doctor` no longer print the obsolete `stage: "foundation"` field; scripts that read it should drop that check (#62).

- `vmem manifest --json` lists read-only MCP tools as `{name, readOnly: true}` (taken from each tool's `readOnlyHint`), so installers can approve new read tools without a hard-coded list; other tools stay plain names. The release workflow states N-1 per minor line; patch releases carry no N-1 line (#106).

- Add MCP `vmem_read_file` and `vmem_list_files`, bounded read-only access to `ops/`, `reports/`, `self/`, `templates/`, `AGENTS.md` and `README.md` with `vmem_read` paging and limits; `notes/`, `log`, dot paths, symlinked components, non-UTF-8 and over-limit files are refused with the tool to use instead. Add `vmem_report`, the MCP form of `vmem report` with the same receipt and log event (#61).

- N-1: 0.3.3 runs beside this release. The derived index moves to `<sha>-links2-schema2.sqlite` (spec caches likewise), so 0.3.3 keeps its own `-links2.sqlite` and the first 0.4.0 run builds its index once. The config format, note format and log line format are unchanged, so each version reads what the other writes. MCP and CLI changes are additive for 0.3.3 clients: new tools (`vmem_read_file`, `vmem_list_files`, `vmem_report`, `vmem_stats`), optional `log` and `edits` arguments, and `vmem_list` adds `total`, `nextCursor` and per-row `mtime` beside `notes`. Two behaviors differ: `vmem status` no longer prints `stage`, and a write with an invalid log event is refused instead of saved without its event.

## [0.3.3] - 2026-11-02

- Polish the spec read surface: scope fish parent completions to the first subcommand, preserve positional help tokens after `--`, document spec MCP tools and startup source registration, clarify shared field/error guidance, reuse body section helpers, and keep literal snippets on code-point boundaries (#103).

- Add read-only spec MCP tools and CLI get/graph/grep/validate commands from a shared bounded schema table, registry-free `spec validate --repo` CI mode, worktree-aware source selection, body/search pagination and metadata/path-scope filters. Spec snapshot filtering precedes FTS pagination; new read tools appear in the manifest. Spec content write tools remain deferred (#91 T5).

- Add spec validation reports, complete-tree introduced-error comparison, computed path-scoped freshness, tracked-file coversPath matching and registry-free validation library (#91 T3/T6), with a portable synthetic schema fixture. Candidate, link-list/path-list and supersession rules follow the confirmed schema. Discovery ignores inherited Git pathspec modes, skips oversized/non-UTF8 non-candidates with diagnostics, and performs Git inspection outside cache writer transactions. CLI/MCP wiring remains T5 and spec content writes remain deferred.

## [0.3.2] - 2026-11-02

- Add library-only spec discovery, repository/worktree identity checks, typed id-based graphs and bounded directional slices (#91 T2). `SpecIndex` reuses the vault scan/metadata/hash/BM25 engine with a separate `spec-` cache per canonical worktree; vault cache names remain unchanged. Spec searches exclude shared-cache rows absent from the instance snapshot or replaced since its scan, and discovery errors name the relative file. Filesystem normalization/case aliases are accepted with root-identity and physical-containment checks, skipped listed paths have diagnostics, and error advice preserves the original cause and names `.gitignore` for discovery bounds. No CLI/MCP read surface or spec content write tools are added.

- Register local git roots separately with `specs add|list|remove`; removal previews and unregisters only. Spec root diagnostics distinguish a missing git executable, timeout, git refusal and non-root path, and support repository names containing backslashes. Spec sources default to `write: none` and `pii: deny`, share IDs and the atomic registry lock with vaults, and get root diagnostics in `doctor`. Config writes use format 2 only when `specs` is present; vault-only settings and output stay compatible. Spec graph/read/validation tools and spec content writes are not part of this increment (#91 T1).

- MCP argument errors name the first failing path and reason without echoing values; unknown tools have a separate diagnostic. `vmem_create` accepts top-level `created` and checks a real YYYY-MM-DD calendar date. Writer/log CLI errors name rejected options, writer arity errors show the expected form, and per-command `--help`/`-h` prints usage (#94).

- V05 refuses newly introduced Topics placement or content problems while retaining existing problems as warnings. `frontmatter --set topics` updates only the body Topics wiki-list items in the same atomic write, preserving fenced blocks, H3/prose and line endings; an unchanged topics value leaves the body unchanged. All create paths, including org `promote` and `vmem_create` with a custom body, now refuse a note whose Topics is not the final H2 or does not match its frontmatter topics. Existing vaults must run `vmem tidy <vault> --all` once after upgrading to the validating writer, previewing and then confirming its fingerprint; `doctor` reports pending migration counts and unparsable paths without writing, using only the planning pass, and reports thrown or returned planning failures as per-vault diagnostics (#92).

- Releases publish a GitHub release next to the npm package, with the validated tarball and manifest attached and the CHANGELOG section as notes (#89).

## [0.3.1] - 2026-11-01

- `sync` and `doctor` refuse a git URL rewrite (`insteadOf`/`pushInsteadOf`) only when its prefix matches the configured remote or one of origin's configured or effective URLs, explicit `pushurl` included, and name that rule (#86). An unrelated rule, such as a global `https://github.com/` to SSH rewrite with an SSH vault remote, no longer blocks sync.

## [0.3.0] - 2026-11-01

- A vault whose PII policy has members this build does not know (from a newer-format config) fails closed: note writes, `check`, tidy, `promote-from-amem`, `promote`, move and delete and log appends on it are refused with `PII_POLICY` instead of screening with an incomplete policy. Reads and `vaults pii` show still work.
- Versions coexist on one machine (#82). `vmem mcp` loads every module a tool can run at startup, the agent-mem root included, so a running server keeps its own code and tool list when its install is replaced or a newer release is installed beside it.
- `vmem setup <target> --root <path>` registers another install root, such as `<install>/releases/<version>/`, resolved to its real path. Without `--root` setup registers the running install as before.
- `vmem.config.json` accepts an optional `version` (format 1). A config from a newer format is read tolerantly and its unknown keys survive registry writes; at or below format 1 unknown keys stay errors. Log screening accepts the same extended PII policy, and `vaults pii --set` refuses to replace a policy whose unknown members it would drop.
- The derived index is `indexes/<sha256>-links<N>.sqlite`, named per link-resolution version, so two versions alternating on one vault no longer rebuild each other's links. The first run after upgrading builds it once.
- `vmem manifest --json` lists the version, the config format, the MCP tool names and the CLI commands.
- The embedded `@staix/agent-mem` pin moves from 0.11.0 to 0.17.0, at or above agent-mem's 0.13 floor for agent workflows.
- N-1: 0.2.4 runs beside this release. It keeps its own unversioned index file and reads the config this release writes, since this release never adds `version`; 0.2.4 refuses a config that carries `version` or any other key it does not know.

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
- Add validated atomic note mutations, preview fingerprints and append-only attributed vault events. Existing vaults must run `vmem tidy <vault> --all` once after upgrading, previewing first and then confirming its fingerprint.
- Add bounded CLI/MCP providers, reversible host setup and agent-mem promotion with provenance.
- Add indexed lint, deterministic graph reports, bounded neighborhoods and synthetic reference-parity checks.
- Reuse unchanged parsed notes and link analysis during write validation, refresh derived links only for affected sources, and recheck the staging snapshot by direct content comparison instead of rehashing.
- Resolve wiki links by note path only, matching Obsidian and lint L01; aliases remain lookup metadata for read commands, and new alias-only links are refused.
- Prepare release validation, clean-install package smoke and an opt-in npm OIDC workflow. Publication, private evidence and live cutover remain separate gates.
