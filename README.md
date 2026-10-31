# vault-mem

An Obsidian-compatible knowledge vault tool for agents and people. Requires Bun >=1.4.2. The full check (`bun run check`) needs Bun, git and tar; it includes a package dry-run and clean installed CLI/MCP smoke. Node/npm are used by the separate release workflow, not required for the ordinary Bun gate. CI runs on Ubuntu and macOS for pull requests and for pushes to `main`.

Implemented: configuration, vault registration, lossless frontmatter parsing/emission, wiki-link resolution and derived SQLite FTS5 indexing with bounded read commands. Validated note writes, the append-only log, the `vmem mcp` stdio server, reversible `vmem setup` host registration and promotion from agent-mem (`promote-from-amem`) are also implemented below. Lint/graph analysis, promotion to org vaults (`vmem promote`) and explicit `vmem sync` are implemented below. The vmem plugin for the `acon` console ([agent-console](https://github.com/STAIxBWLB/agent-console)) is described under "Console plugin"; vault-mem ships no console bin. Do not use this increment to replace an existing vault writer.

```sh
bun install
bun bin/vmem.js --help
bun bin/vmem.js vaults add personal /absolute/vault --kind personal --write mcp
bun bin/vmem.js status --json
bun bin/vmem.js doctor
bun bin/vmem.js vaults remove personal
bun bin/vmem.js vaults remove personal --confirm
bun bin/vmem.js recover            # preview crash leftovers
bun bin/vmem.js recover --confirm
bun run check
```

The first remove prints a preview; `--confirm` unregisters the vault. It never deletes vault files. Commands work without a TTY and in agent environments. Add requires an existing `notes/` directory, stores the canonical vault path, and rejects duplicate ids and paths. Doctor returns a nonzero status when a registered vault becomes unavailable or its notes directory is replaced by a symlink.

Home precedence: `VMEM_HOME` (the pointer is not consulted), else a `home` pointer in the default home's `vmem.config.json`, else the default home itself. The default home is `$AGENTHUB_HOME/vmem` when `AGENTHUB_HOME` is set, otherwise `~/.agenthub/vmem`. Home paths are reported absolute and lexically normalized (`.`, `..` and trailing slashes removed, symlinks not resolved); registered vault paths are stored and reported canonical (symlinks resolved). Environment paths and configured paths must be absolute. A redirect file contains only `home`; the target contains the registry and policy, and cannot redirect again. Missing config means an empty registry. Malformed, oversized, linked or nonregular config files fail closed.

```json
{"vaults":[{"id":"personal","path":"/absolute/vault","kind":"personal","write":"mcp"}],"denyPaths":[],"piiPatterns":[]}
```

Configuration is limited to 64 KiB both on read and after serialization (a change whose pretty-printed result exceeds the limit is refused and the file is unchanged), rejects unknown keys, and is updated under an exclusive lock using a flushed temporary file and atomic rename. Errors name the config file or vault id and path but never echo config or note contents.

Durability: the temporary file is fsynced before the rename and the home directory is fsynced after it. On Linux this makes the new config durable once the command returns. On macOS directory fsync succeeds but does not flush the drive cache (no `F_FULLFSYNC`), so a power loss right after a change can revert to the previous complete config, never to a partial one. Windows is not a supported platform for durability claims; the rename stays atomic.

Crash recovery: the lock file records the writer's pid, host and start time. Nothing is cleaned up automatically. `vmem recover` previews the state; `vmem recover --confirm` removes the lock only when it names this host and a pid that no longer runs, and then removes leftover `.config-<uuid>.tmp` files. A live lock, a lock from another host, or an unreadable (older-format) lock is never removed and the command exits 1; confirm no writer runs, then delete `config.lock` by hand. No other file in the home or any vault is touched. If cleanup fails after an operation (for example the lock cannot be removed), the original error is kept and the cleanup failure, including a retained lock, is appended to it.

Vault fields: `id`, absolute `path` (must contain a real `notes/` directory), `kind` (`personal|org`), `write` (`mcp|cli|none`), optional `pii` (the `allow|deny` shorthand or a policy object, see PII policy below; default `allow` for personal and `deny` for org, and `status`/`vaults list` always report the effective shorthand and `piiPolicy` matrix, including for unhealthy entries), optional `remote` (any nonempty string such as an `https://` or `git@host:path` URL) and optional `registry` (absolute path). For healthy vaults, `doctor` checks locally that the vault is a git repository root with an origin whose fetch and push URLs all match `remote` (URL rewrites are refused), and that `registry` passes the same deny-path, size and project-id validation as log appends. Results appear under each vault's `checks.remote` and `checks.registry`; a failed check exits 1. These checks use no network and do not test reachability. `status` is unchanged. Policy fields are stored for later note-writing stages, not enforced by the read commands. Writer commands enforce write/channel policy and configured deny/PII screening.

The only runtime dependency is the exact first-party pin `@staix/agent-mem@0.11.0`; it is not loaded by registry commands. Public library exports cover configuration, home resolution, registry operations, frontmatter, link resolution and the derived index. No console bin or UI contract is advertised before its implementation.

# PII policy

`pii` is either the shorthand `allow`/`deny` (every category on every surface) or an object that sets an action per category and, optionally, per surface:

```json
{"email": {"notes": "allow", "log": "deny"}, "phone": "warn", "custom": "deny",
 "patterns": [{"name": "student-id", "regex": "S\\d{6}", "action": {"notes": "deny", "log": "allow"}}],
 "allow": ["owner@example.org", "@example.org", "+82 10 0000 0000"]}
```

- Categories:
  - `email`;
  - `phone`;
  - `custom`, the global `piiPatterns`;
  - named per-vault `patterns` (at most 32; names `[a-z][a-z0-9-]{0,31}`, regexes compiled with the `u` flag).
- Surfaces:
  - `notes`: note and report writes, frontmatter screening, tidy value echo;
  - `log`: log appends and `tidy --log` on existing lines;
  - `promotion`: the screen `vmem promote` applies when this vault is the target.
- Actions:
  - `allow`: not screened.
  - `warn`: the write proceeds with a V07 warning, and tidy echo prints the value as `[redacted]`.
  - `deny`: V07 error, and `tidy --log` replaces matches in existing lines.
  - Org promotion refuses only `deny` cells and secrets. The promoted note's write into the target vault is screened with the target's `promotion` cells, not its `notes` cells.
  - `tidy --log` replaces the raw denied matches and leaves allow-listed values intact. Screening also checks the NFKC form. If a denied match is zero-length, or the replaced line still contains a denied match (for example a form only NFKC normalization reveals, or a pattern that matches the `[redacted]` marker), the whole line is redacted (fail closed).
- An omitted category or surface takes the vault default: `allow` for personal vaults, `deny` for org vaults.
- `allow` entries (at most 64) are exempt everywhere:
  - an exact address, compared case-insensitively;
  - an `@domain` suffix;
  - a phone number standing alone, compared by its digits. Several numbers run together with spaces are never exempt (fail closed);
  - an exact match of a pattern.
- Secret detection is separate from this policy and always applies.

```sh
vmem vaults pii personal                                   # effective matrix and allow list
vmem vaults pii personal --set '{"email":{"log":"deny"}}'  # preview: changed cells and every loosened cell
vmem vaults pii personal --set '{"email":{"log":"deny"}}' --confirm
```

The policy is changed only through the CLI, under the config lock. MCP clients can read it in `vmem_status` but cannot set it.

# Indexed reads

```sh
bun bin/vmem.js rebuild personal
bun bin/vmem.js search personal "project discovery" --type concept --domain research --limit 20
bun bin/vmem.js show personal "Note or alias" --max-bytes 16384
bun bin/vmem.js links personal "Note or alias" --limit 50 --json
```

All four commands require a registered vault id. They read only flat, regular `notes/*.md` files (case-sensitive `.md` extension), skip subdirectories and symlink files, and refuse a replaced vault/notes directory. Notes are limited to 2 MiB each. They never write note content, registry configuration or `.obsidian/`. `rebuild` rebuilds the derived cache; other commands scan metadata on every invocation and rehash new or metadata-changed files. Content-identical changes only update metadata; deleted/renamed paths leave the index. SQLite transactions make each scan atomic. A concurrently changing note aborts that scan, so retry after its writer finishes. No watcher, model calls or embeddings run.

The cache is `$VMEM_HOME/indexes/<canonical-vault-path-sha256>.sqlite` using the resolved home, not necessarily the environment variable. Cache files use mode 0600 on creation. The location must be outside every registered vault, including through symlinks; linked cache directories/files are refused. It contains note text and is disposable private derived state. Removing it while commands are stopped allows the next read to build it again. SQLite uses its own transaction lock and a five-second busy timeout. There is no automatic migration or live vault cutover.

Search uses FTS5 `unicode61` over title, description and body with BM25 weights 5:2:1, ascending score and path tie-breaking. Whitespace-separated query terms are literal AND terms, not a raw FTS expression; quote the query as one shell argument. `--type` and `--domain` are exact scalar frontmatter filters. Results include a bounded snippet and metadata, not the full body. Search queries and note targets accept at most 1024 UTF-8 bytes. Search/links default to 50 results, with an enforced 1..500 range. Show defaults to 16384 UTF-8 bytes and permits 1..65536, returning `truncated` and the full note SHA-256. `--section "Exact H2"` selects one real H2 through the next H1/H2, including its H3 children; code-fenced headings are ignored and duplicate/missing names refuse. Truncated reads include bounded `headings` (at most 64 names/8KiB metadata; `headingsTruncated` when omitted) and `nextOffset`. `--offset N` is a UTF-8 byte offset within the selected section or whole note; use the returned `nextOffset` to page even a single section larger than 64 KiB, and compare note hashes across pages. Invalid UTF-8 boundaries and zero-progress byte budgets refuse. Link string fields are capped at 1024 bytes in command results. Oversized arguments fail instead of silently raising a bound.

Link resolution uses NFC and case-insensitive filename stems only, as Obsidian and `vmem lint` L01 do. Frontmatter `aliases` (string or string array; legacy `alias` accepted) are not link targets; `show`, `links <target>` and `vmem_read` still find a note by alias. A link that only an alias matches is a missing-note link, so the writer refuses a new one and org promotion drops it to text. An optional `notes/` prefix and `.md` suffix are accepted. `[[target|label]]`, `[[target#heading]]`, `[[target#^block]]`, `![[target]]` and same-note anchors work. ATX/Setext headings and end-of-line block ids are checked; fenced code is skipped. Missing/ambiguous targets and missing anchors remain explicit with a reason. Stems that differ only by case or Unicode normalization are ambiguous. Links returns outgoing links in source order, with one-based body-relative `line` values (frontmatter excluded); it does not write backlinks or repair dead links.

`parseFrontmatter` retains source bytes alongside semantic YAML data using Bun's built-in YAML parser. `emitFrontmatter(document, changes)` returns the entire note, preserving omitted and semantically unchanged keys byte-identically (comments, quoting, sequences, one-level mappings, folded/literal/chomped scalars, BOM and line endings). Changed keys use canonical JSON-compatible YAML; `undefined` removes a key. Editing requires a block mapping, while an unchanged flow mapping round-trips. This is a library transformation only, not a note-write command. Synthetic fixtures and create/edit/delete/rename parity tests cover this increment; Linux/macOS CI remains the platform verification gate.


# Validated writes

All mutations use `applyWrite(home, request)`: per-vault `mutation.lock`, current-SHA checks, in-memory planning, final-snapshot validation/screening, same-directory flushed temporary files and atomic renames, directory flushes, derived-index refresh and a structured receipt. `write: mcp` allows CLI and MCP writes; `cli` allows CLI only; `none` refuses mutations. `check` is read-only and works with `none`. No command requires a TTY or rejects agent environments. This increment runs on fixtures; it does not authorize a live vault cutover.

```sh
vmem new personal example-finding --type insight --domain research --topics research --description "A distinct supporting observation."
vmem new personal another-finding --type insight --domain research --topics research --description "An independently sourced result." --body body.md
vmem patch personal example-finding --old "This note argues that" --new "This finding states that" --expected-sha <sha256>
vmem append personal example-finding --section Evidence --markdown "Additional evidence."
vmem frontmatter personal example-finding --set '{"confidence":"likely"}'
vmem link personal example-finding another-finding --relation supports
vmem supersede personal example-finding another-finding
vmem check personal candidate.md --path candidate
vmem report personal reports/result.md --body report.md
vmem move personal example-finding renamed-finding
vmem move personal example-finding renamed-finding --confirm --fingerprint <preview-fingerprint>
vmem delete personal renamed-finding
vmem tidy personal --connections
vmem tidy personal --all --json                 # migration sanitize preview (see Migration tidy)
```

Syntax follows indexed reads: the vault id comes first. `new` supports `--title`, `--source`, `--confidence`, `--status`, `--extra JSON` and `--body file|-`; omitted body gets an H1/Relevant Notes/Topics skeleton. Patch accepts nonempty old/new strings up to 8192 bytes and requires exactly one occurrence (including overlapping occurrences). Append uses an existing section or inserts it before Topics; it refuses targeting or introducing a Topics H2. `frontmatter` supports `--set JSON`, `--unset key,key` and `--expected-sha`; append also supports `--expected-sha`. Link relations are `supports`, `contradicts`, `extends`, `applies-to`, `context-for`; links are bidirectional unless `--one-way`. Supersede sets `status`/`superseded_by` on the old note and adds a reverse link in the next note. Report permits plain paths below `reports/` or `ops/`, is schema-exempt and still screened. Inputs are bounded to 256 KiB, follow no file symlinks and accept stdin with `-`.

`--dry-run` plans and validates any writer without creating locks, temporary files, directories or caches. `check` always takes this path, even without `--dry-run`. Move, delete and tidy first return a preview with planned path/hash changes and a fingerprint; confirmation requires that fingerprint. It covers canonical operation input, the canonical vault path/identity and policy, expected SHAs, every scanned note and all touched files, so even a new inbound reference after preview forces another preview. Move rewrites visible wiki/heading/block/embed targets and wiki references in frontmatter across the vault, preserving explicit `|label` text, anchors and code. Alias-only links resolve to no note and are left as written. The move source may be an existing note with a legacy file name (lint L13, for example a dot in the stem); the destination must be a valid stem. Tidy folds Connections sections into Relevant Notes. Delete refuses when it would newly break inbound links or MOC topics; fix those references first.

Validation returns named issues with severity and no matched secret text: V01 schema/enums/description; V02 existing MOC topics; V03 newly unresolved links; V04 flat ASCII note paths (maximum 200 bytes) and safe report paths; V05 final Topics placement/content (warning), with explicit append-to-Topics refusal; V06 pinned agent-mem secret regex parity and denied sources/input/snapshot paths; V07 email/phone/configured PII patterns when denied; V08 create duplicates (stem/NFKC H1); V09 256 KiB prospective note size / 16 MiB report size, exact patch and expected-SHA/drift; V10 supersession target integrity. Unchanged pre-existing broken links warn, including after a move. `possibleDuplicates` lists candidate paths for warnings from a disposable in-memory FTS5 query of title terms, with BM25 <= -0.000001, up to three paths; no disk cache is written for that check. `LOCKED`, `IO`, `ROLLBACK`, `INDEX` and `CLEANUP` identify operational failures. CLI returns exit 1 when `ok` is false.

A successful receipt reports `applied`, planned path/hash/byte changes, issues and `indexUpdated`. Unrelated malformed legacy YAML is skipped by duplicate hints and by writer index refresh, with a V01 warning naming the unchanged note; normal read/rebuild commands retain strict parsing. Move/tidy still require parseable inputs and name the offending path on refusal. Reads allocate each note's stat size plus one growth-probe byte, capped at the 2 MiB read limit plus one. A failed index refresh rolls back the file changes. Rollback first verifies each file still equals this operation's committed result; external edits are preserved. Failed/refused rollback retains the original backup and reports its relative recovery path. All files are staged before replacement and backups permit rollback of caught multi-file failures. Each individual rename is atomic; a machine/process crash between multiple renames can leave a partially completed batch. The retained lock and `.vmem-<uuid>.tmp` files require inspection and manual recovery after confirming the writer stopped. They are never automatically removed by registry recovery. Uncoordinated editors do not honor the lock; the pipeline rechecks SHAs before replacement, but this does not provide a filesystem transaction against concurrent external edits. Existing notes may be read up to the index's 2 MiB limit; prospective notes are limited to 256 KiB; report operations under `reports/` and `ops/` allow up to 16 MiB for both prospective content and existing-file reads (including staging and rollback rechecks), with at most 10000 flat notes per mutation snapshot. File/directory fsync has the platform guarantees described above. Successful changed mutations now append an event as described below; log failure is reported separately from note success.


# Append-only events

```sh
vmem log append personal EXTRACT - synthetic:source "A synthetic event" --dest notes/example.md
vmem log tail personal --limit 50 --json
vmem log grep personal "EXTRACT|CONNECT" --type EXTRACT --limit 20
```

Events keep the canonical local-time format `YYYY-MM-DD HH:MM  TYPE  project  source → dest  — note` (two spaces between fields, one LF at the end). Destination is optional. Allowed new types: `INGEST ROUTE EXTRACT CONNECT DIGEST LEARN LINT TASK GRAPH SYNC RETHINK SOURCE`. Project must be `-` or a lowercase alphanumeric/hyphen id; when `registry` is configured, ids must exist in its bounded YAML `projects`/nested `sub_projects` arrays. Registry files are limited to 1 MiB, eight nesting levels and 10000 unique ids; invalid or unavailable configuration fails closed. Invalid types/fields/projects use L09 issues, the 1000-byte line bound uses V09, and secret/PII refusals use V06/V07. Fields cannot inject pipes, control characters or two-space/column separators. Validation and screening run before a file or lock is created. The 1000 UTF-8-byte bound includes the LF and attribution.

Every MCP log append and CLI call with a nonempty `AGENTHUB_PEER_ID`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID` or `PI_SESSION_ID` adds ` (vmem:agent)` to the note. Ordinary CLI events have no automatic suffix. Being an agent never causes refusal. Complete ISO timestamps are excluded from phone-number candidates, while real email/phone/configured PII matches remain refused when the vault denies PII.

`appendLog` validates the registered canonical vault and write/channel policy, acquires a separate `log.lock` (bounded two-second contention wait), then makes one O_APPEND write and fsyncs the log. New log files are mode 0600 and their parent directory is flushed. Linked/nonregular files and an incomplete existing final line are refused. Cooperating appenders share the lock; a short write is truncated back only when the same file still has the expected size, and its tail still equals our exact prefix, then flushed. Error-after-write cases inspect at most one event's bytes. Failed/ambiguous writes or cleanup are explicit; the receipt reports `appended` (possibly null when unknown), `synced`, `bytesWritten` (possibly null) and `rolledBack` when a partial append was removed. Before reporting sync, the current log and vault identities are rechecked; rotation produces LOG_DRIFT and an unknown current-path append state. A synced event can coexist with a cleanup error. No existing event is rewritten. A crash can retain `log.lock`, and failed short-write recovery can retain an incomplete line; inspect the file and stopped writer before manual recovery. There is no automatic cleanup or new TTY requirement.

Successful changed mutations default to EXTRACT, link to CONNECT, move to ROUTE, and supersede/tidy to RETHINK. Default events use project `-`, affected paths and the operation name rather than note text. Library callers can supply `WriteRequest.log` to override the event or `false` to disable it; CLI writers accept `--log JSON` for overrides. Preview/check/no-op/refused mutations never append. The append is bound to the mutation's resolved vault identity/policy, so re-registration cannot route its event to another vault; the same binding covers the tidy LINT event and both SYNC events of org promotion, which are refused with LOG_DRIFT instead. A bound append compares the registry before any policy or path check, so a re-registration always reads as LOG_DRIFT. Tidy and org promotion also bind every note write to the vaults resolved at the start of the run: if a vault id is re-registered before a write, that write is refused with VAULT_DRIFT and nothing is written to either vault. After a committed mutation, log append is independent: `ok`/`applied` describe the note operation, `log` holds its append receipt, and `logged` is true only when the event was appended and synced. A log error does not roll back a successfully saved note. CLI exits 1 for a log failure even when the note receipt says `ok: true`; inspect the receipt before retrying to avoid duplicate mutations/events. An override is validated at append time, not during a note-only dry run.

Readers never create a home, log or lock, and work with `write: none`. They skip blank/comment lines, return the last matching 1..200 records (default 50), accept an optional canonical TYPE and non-backtracking regex subset up to 256 characters (`|`, `^`, `$`, `.`, character classes, `\d`/`\s`/`\w` and their inverses, escaped literals, and atom `*`/`+`/`?`; groups, backreferences and brace quantifiers are refused), and scan a fixed descriptor-size snapshot. Streaming is capped at 32 MiB; individual historical lines over 4096 bytes and incomplete final lines are omitted with warnings, and the serialized line array stays within 128 KiB. Above 20000 data lines, the manual-archival warning is preserved. Read failure returns `dataLines: null` rather than claiming a count. Golden synthetic fixtures and concurrent/fault persistence tests cover the format and actual append state; no live vault log was read or modified for this increment.

# MCP server

`vmem mcp` serves newline-delimited JSON-RPC 2.0 (MCP tools, protocol 2025-06-18 and earlier) on stdio. stdout carries protocol messages only; it needs no TTY and runs in agent sessions. Requests are limited to 64 KiB per frame and results to 256 KiB (a larger result becomes a structured `LIMIT` refusal). Arguments are validated against each tool's bounded schema (`additionalProperties: false`, string/array/integer caps); invalid arguments or unknown tools return JSON-RPC `-32602`, unknown methods `-32601`, malformed frames `-32700`/`-32600`. The `@staix/agent-mem` root is never loaded at startup.

The vault set is read once at startup: every tool's `vault` property is an enum of the registered ids and defaults to the first `personal` vault. Restart the host session after `vaults add/remove`. Reads go through the same index as the CLI; writes go through `applyWrite`/`appendLog` with channel `mcp`, so they require `write: mcp` and pass the same V01-V10 gates. Every tool returns a JSON result: a receipt, or `{refused: true, issues}` for policy, validation or lookup failures.

| tool | arguments (caps) |
|---|---|
| `vmem_status` | none; vaults with health, write policy, effective pii and `piiPolicy` (read-only) |
| `vmem_search` | `query`<=1000, `vault`, `limit`<=50, `type`, `domain` |
| `vmem_read` | `path` (stem, alias or `notes/` path), `vault`, `maxBytes`<=65536; returns `{path, frontmatter, body, sha256, truncated}` |
| `vmem_read_many` | `paths`<=20 (8 KiB each), `vault` |
| `vmem_list` | `vault`, `prefix`, `limit`<=500 |
| `vmem_links` | `path`, `vault`, `direction` out/in/both, `limit`<=200; returns `{out, dead, in}` |
| `vmem_mocs` | `vault`; MOC notes with incoming link counts |
| `vmem_check` | `vault`, `path`, `text`<=256 KiB; validation only |
| `vmem_log_tail` | `vault`, `n`<=200, `type`, `grep`<=256 |
| `vmem_create` | `stem`, `type`, `domain`, `description`, `topics[]`<=32, `title`, `body`<=65536, `source`, `confidence`, `status`, `extra`, `log` |
| `vmem_patch` | `path`, `oldString`<=8192, `newString`<=8192, `expectedSha` |
| `vmem_append` | `path`, `section`<=120, `markdown`<=16384, `expectedSha` |
| `vmem_set_frontmatter` | `path`, `set`, `unset[]`, `expectedSha` |
| `vmem_link` | `from`, `to`, `relation`, `context`, `bidirectional` (default true), `log` |
| `vmem_supersede` | `old`, `next`, `log` |
| `vmem_log_append` | `type`, `project`, `source`, `dest`, `note`<=500 |
| `vmem_move` | `from`, `to`, `confirm`, `fingerprint` (two-step) |
| `vmem_delete` | `path`, `confirm`, `fingerprint` (two-step; the preview lists backlinks) |
| `vmem_promote` | `path` (in the personal vault), `to` (enum of org vaults), `topics[]`, `again`, `confirm`, `fingerprint` (two-step; never pushes) |
| `vmem_skills_mine` | `vault`, `days`, `project`, `allProjects`, `vocab`, `skills[]`, `minSize`, `minNovelty` (read-only; see Skill mining) |
| `vmem_promote_from_amem` | `id`, `project`, `stem`, `type`, `domain`, `topics[]`, `description`, `title`, `body`<=65536, `linkTo`, `confirm`, `fingerprint` (two-step) |

Move and delete without `confirm` write nothing and return the preview and `fingerprint`; `confirm: true` requires the fingerprint recomputed on the current state, otherwise the call is refused with `V09`. `vmem_promote_from_amem` is described under Promotion from agent-mem. `vmem_promote` is described under Org promotion and sync. Graph/lint tools are listed below. Note paths in read results are relative to `notes/`.

# Host setup

```sh
vmem setup claude            # dry-run: lists the file and change per host, writes nothing
vmem setup all --apply       # claude codex kimi pi qwen jcode
vmem setup agy --apply       # run inside the workspace; writes ./.agents/mcp_config.json
vmem setup all --undo
```

Setup registers one server entry named `vmem` (`<bun> --smol <package>/bin/vmem.js mcp`) by editing the host's own MCP configuration: `~/.claude.json` (`mcpServers`; `$CLAUDE_CONFIG_DIR/.claude.json` when set), `$CODEX_HOME/config.toml` (`[mcp_servers.vmem]`), `$KIMI_CODE_HOME/mcp.json`, `$PI_CODING_AGENT_DIR/mcp.json`, `$QWEN_HOME/settings.json` (all `mcpServers`), `$JCODE_HOME/mcp.json` (`servers`) and the workspace's `.agents/mcp_config.json` for Antigravity. Defaults are `~/.codex`, `~/.kimi-code`, `~/.pi/agent`, `~/.qwen` and `~/.jcode`; overrides must be absolute. It does not call host CLIs and does not need a TTY. Run it while the host is closed: Claude Code in particular rewrites `.claude.json` while it runs and can overwrite a concurrent change.

Apply is idempotent and touches only the `vmem` entry: other servers and settings are preserved (TOML is edited textually, so comments and other tables stay byte-identical; JSON is re-serialized with its indentation). Configuration files must be plain strict JSON or TOML; links, JSONC and unparsable files are refused per host without writing, and the command exits 1. Apply records the prior `vmem` value in a receipt, `$VMEM_HOME/setup/<host>-<hash of the config path>.json`, so separate host profiles (for example two `CODEX_HOME`s) sharing one `VMEM_HOME` keep separate receipts. The receipt is written before the host file; if the host write fails, the receipt is rolled back. In TOML, every `[mcp_servers.vmem]` and `[mcp_servers.vmem.*]` table belongs to the entry, even when other tables sit between them. Undo restores that prior value (or removes the entry, and the file if setup created it and nothing else was added) only while the entry is still the one setup installed; an entry edited later is left alone and reported as `refused`. Every mode also handles the console plugin manifest (see "Console plugin"): apply writes it, undo removes it while it still points at this install.

`vmem completion bash|zsh|fish` prints a completion script generated from the same command table as `--help`.

# Promotion from agent-mem

`vmem promote-from-amem` turns one durable agent-mem entry into a vault note and records agent-mem's own vault link back to it. Agent memory is never indexed or copied into a second store, and no agent-mem tool is added: candidates come from agent-mem's `vaultCandidates` selection and the link from its `recordVaultLink`.

```sh
vmem promote-from-amem personal                                  # candidates of the current project (--project KEY | --all-projects, --limit 1..200)
vmem promote-from-amem personal mem:<id> --type decision --domain research --topics storage   # preview: full note text + fingerprint
vmem promote-from-amem personal mem:<id> ... --confirm --fingerprint <sha>
vmem promote-from-amem personal mem:<id> --link-to existing-note  # link an existing note instead of creating one
```

- `src/amem/seam.ts` is the only module that imports the `@staix/agent-mem` root (exact pin 0.11.0), and it is loaded lazily: `vmem mcp`, reads, writes and every other command never load it. The project defaults to agent-mem's key for the current directory (`--project` overrides); `AMEM_HOME` selects the memory home as in agent-mem.
- Listing and linking require agent-mem's generation profile; a shared-v1 memory home is refused. Candidate listing applies agent-mem's durable selection and policy (secrets, default PII and the vault config's `piiPatterns`) before ordering and `--limit`; previews screen the requested entry with the same policy.
- The preview prefills the H1 and stem from the entry title, the body from its text, `about[]` as Relevant Notes hints, and provenance `promoted_from: mem:<id>` plus `promoted_at`. `--stem --type --domain --topics --description --title` and `--body file|-` override it; none of this needs a TTY. When a note with the same stem or title exists, the preview is refused with V08 and lists `link-existing <path>` choices; `--link-to` takes one. `--edit` opens `$VISUAL`/`$EDITOR` on the draft only when stdin is a terminal (the only TTY check); the edited text is previewed and confirmed with `--body`.
- Confirm requires the preview fingerprint, then creates the note through `applyWrite` (V01-V10), appends one `LEARN  <project>  mem:<id> → notes/<stem>.md  <em-dash> promoted: <kind>` event (`--log-project` sets the project field; it defaults to the last segment of the agent-mem project key) and records the vault link last.
- If the final link fails, the note stays, the result reports `LINK` and `link-only notes/<stem>.md`, and the entry stays a candidate. A rerun finds the note through `promoted_from` and offers link-only, never a second note or a second LEARN event.
- `vmem_promote_from_amem` is the same two steps over MCP and needs a vault with `write: mcp`.

## Console plugin

`vmem setup <target> --apply` also writes `$AGENTHUB_HOME/console/plugins/vmem.json` (default `~/.agenthub`; directory 0700, file 0600) with the absolute path and sha256 of `src/ui/plugin.ts`. `acon ui` then shows a Vault area. Re-run setup after upgrading vmem: acon refuses a module whose hash changed.

- Panels: Overview (vaults, maps, recent log), Search, Note (body, links, actions), Promote (agent-mem candidates), Lint (typed findings linked to notes) and Log (parsed rows).
- Inbox: promotion candidates (group `candidate`), lint errors and a stale graph report (group `alert`). The palette searches notes.
- Actions: `delete`, `move`, `promote` (to an org vault) and `promote-from-amem` reuse the two-step MCP tools. Each first answers a preview with the planned changes; the write happens only after the console's confirm dialog, and only while the fingerprint still matches.
- The provider calls the `vmem mcp` handlers in process, so the console has exactly the MCP rights: writes need a vault with `write: mcp`, and log lines carry the agent attribution.
- The module is exported as `@staix/vault-mem/ui-plugin`. Lint results are cached for 60 seconds per vault.

## Lint and graph analysis

`vmem lint <vault>` checks L01/L02/L03/L09/L10/L11/L12 and L13 (lowercase ASCII kebab-case filenames). `--note notes/example.md` limits note findings. Section names and `SUMMARY errors=N warnings=N` follow the Python reference. `--write` writes a screened lint report and LINT event; `--dry-run` previews without persistence. Findings may identify paths, link targets and malformed log prefixes. Note bodies are never included in analysis results.

`vmem graph build <vault> [--dry-run]` writes `reports/vault-graph.json`, a dated graph report, graph trend history and GRAPH events through `applyWrite`. Old dated reports are preserved. Trend history appends one row per build, including repeated builds on the same date. Output receipts expose partial report/log failure; these separate writes are not a single transaction. `vmem graph neighbors <vault> <stem> [--hops 1..2] [--limit 1..500]` reads a bounded neighborhood. Matching MCP tools are `vmem_lint`, `vmem_graph_build`, and `vmem_graph_neighbors`; MCP report writes require `write=mcp`.

**Communities** come from a deterministic, dependency-free Leiden (Traag, Waltman and van Eck 2019) optimizing modularity with resolution γ = 1.0: fast local moving with a node queue, refinement that merges only well-connected nodes inside each community (the greedy variant, so no random step), and aggregation on the refined partition initialized from the unrefined one, repeated while modularity improves. Nodes are processed in code-point id order and gain ties go to the lowest community id, so the same graph gives byte-identical output whatever the input order. Every community induces a connected subgraph. MOC (and, in the workspace graph, `bu`) nodes are excluded and get `community: null`; an isolated note is its own community. Community ids are numbered by size (descending), then by smallest member id; they are build-local, so cite a member, not the id. `vault-graph.json` records `graph.partitioner: "leiden"`, `resolution`, the achieved `modularity` and the number of levels, and the report Overview prints the partitioner, resolution and modularity. Modularity has a resolution limit: communities smaller than a size that grows with the whole graph cannot be separated, so a very small cluster may merge into a neighbor. There is no resolution setting yet. Skill mining (`vmem skills mine`) and the workspace graph use the same function. `bun scripts/leiden-live.ts <vault-id>` prints counts only: modularity, community count, largest share, connectivity, clustering time and NMI against the Python reference's Leiden partition.

`vmem graph build <vault> --workspace [--dry-run]` (MCP: `vmem_graph_build` with `workspace: true`) builds the workspace graph: the vault graph exactly as above plus the work layer under the vault's work root (the parent of its `registry`; a vault without `registry` is refused). It writes only `reports/workspace-graph.json` through `applyWrite` (no dated report, no trend row) and one GRAPH event, and returns the work counters (`work_docs`, `yaml_fail`, `template_skip`, `related_*`, `source_*`, `collisions`, `dup_edges`) and edge counts per relation. It ports `extract_work` from `build-graph.py --work-root` rule for rule:

- **Walk.** `.md` files under the work root, never following symlinks, pruning `.git node_modules .venv .sync-conflicts temp .maru .pnpm-store .conductor .dotfiles .omx .omc .gstack .frontend-slides .claude .archive archive vault inbox sites dev shared _templates templates` and the scratchpad memos/temp roots (`workspace.config.yaml` `paths.scratchpad`, `scratchpad.memos_subdir`, `scratchpad.temp_subdir`; default `scratchpad/memos`, `scratchpad/temp`). `denyPaths` are honored. Only a file whose first bytes open frontmatter (`---` and whitespace) is read; the rest are probed and skipped.
- **Nodes.** A work doc qualifies with `document_type`, a non-empty `projects project vault_note topics attendees relatedMeetings relatedTasks`, or `related`; frontmatter containing `{{` is a template (`template_skip`) and unparseable frontmatter is `yaml_fail`. Ids are `work:<relpath>`; business-unit hubs `bu:<slug>` come from `bu_id` in `bu-config.yaml` files named by a doc's `business_unit`; a vault `source:` that names an existing work file outside the qualifying set becomes a `type: file` stub.
- **Edges.** `related` (work to work, by unique stem or relative `.md` path, `rel` kept), `fm_ref` (work field wiki-link to a vault stem, `field` kept), `wiki_link` (work body to a vault stem), `bu_member`, `source_ref` (vault `source:` to a work node) and `supersedes` (`supersedes`/`superseded_by`, `field` kept). Edges to unknown nodes and self-loops are dropped; one edge per pair survives by priority `wiki_link < fm_ref < bu_member < source_ref < related < supersedes`, and a work-layer edge replaces a vault-layer edge on the same pair. Communities exclude `moc` and `bu` nodes.
- **Bounds.** 50,000 probed files (each counted once, whether or not it is then read), 2 MiB per read work doc, 128 MiB read in total and 2,000,000 directory entries per walk; exceeding one fails explicitly. Every probed file is stamped, so a file that changes during the build (including a plain file that gains frontmatter) refuses the write. The output is within the 16 MiB report bound.

`bun scripts/workspace-parity.ts <vault-id>` runs the unchanged Python `build-graph.py --work-root` into a private temp directory and the in-memory vmem build on the same tree, and prints only counts: node-id, edge-pair, relation, attribute and counter differences (`--python`, `--reference` select the interpreter and script). Communities are not compared.

Analysis consumes note sources from the derived SQLite index, including invalid-frontmatter rows retained separately from searchable notes. Normal scans also retain note sources in `analysis_notes`, roughly doubling cached source storage outside the vault; the cache remains derived and can be rebuilt. Read-only analysis and dry runs clone any existing derived cache through a readonly connection, then refresh changed notes in memory. A missing cache is built in memory. They create no cache, locks, reports or events. Auxiliary log, registry and report inputs use bounded plain-file reads. Snapshot limits are 10,000 notes / 64 MiB source, 1,000 reports / 16 MiB per file and combined, and 32 MiB log; oversized inputs fail explicitly. Graph limits are 100,000 edges. MOCs are excluded from clustering; ties sort by node id. Graph extraction intentionally retains the reference's body-only legacy wiki-link semantics, distinct from the richer navigation resolver.

`bun scripts/lint-parity.ts` and `bun scripts/graph-parity.ts` compare the synthetic corpus against frozen Python reference oracles. Use `--reference /absolute/path/to/lint.py` or `--reference /absolute/path/to/build-graph.py` to run the unchanged Python tools directly (`PYTHON` selects an interpreter with PyYAML/networkx). Keep those references until a separate retirement decision after two consecutive zero-diff runs. Fixture parity does not establish private-corpus parity or authorize a live vault cutover. Private corpus evidence stays private; no note bodies belong in public fixtures.

Analysis uses YAML 1.1 scalar compatibility for Python parity, including implicit booleans, octal/sexagesimal numbers, floats and timestamps, while preserving quoted/block strings and merge keys. Explicit tags, complex/non-string mapping keys, recursive aliases and nesting beyond 64 levels are refused explicitly instead of reporting misleading findings. These bounded-parser refusals require manual resolution before parity can be established for an affected corpus.
# Org promotion and sync

Each vault is its own git repository. There is no cross-vault link syntax: `[[x]]` always resolves inside its own vault, so an org note cannot link back into a personal vault. Nothing is scheduled and nothing pushes on its own.

```sh
vmem promote personal shared-method --to team                     # preview: full org text, dropped links, screen result, fingerprint
vmem promote personal shared-method --to team --confirm --fingerprint <sha>
vmem sync team                                                    # preview: remote check, branch, ahead/behind, paths to stage
vmem sync team --confirm --fingerprint <sha>
```

`vmem promote` copies one note from a personal vault into the local clone of a writable org vault (`kind: org`, `write` not `none`):

- **Transform.** The last prose `## Topics` section (never one inside a code fence) is replaced with the target topics, which must name MOCs that already exist in the org vault (source topics by default, `--topics` to override); a missing section is appended. Body wiki links that do not resolve in the org vault become plain text (their label, if any); wiki-valued frontmatter (`project`, `supersedes`, `superseded_by`, `source_ref`) pointing outside it is dropped. All of this is listed in `droppedLinks`. The org note gets `promoted_from: "<personal>:notes/x.md"` and `promoted_at`.
- **Screen (fail closed).** It refuses: secrets; PII denied by the org vault's `promotion` cells (org defaults to `deny`, plus configured `piiPatterns`; a `warn` cell is reported, not refused); `type: person` or `domain: people` records; private correspondence (`source`/`source_ref` from `inbox/`, `outlook:`, `telegram(`, `kakao`); and internal meeting notes (`source` under `meetings/`). These are keyword heuristics; the org clone's `git diff` before `vmem sync` is the review surface. Body links that are dropped are also resolved in the personal vault: a link to a person/people, meeting or correspondence note refuses the promotion (reporting only the category and count), so their names never reach the org vault. A refusal or a preview writes nothing in either vault.
- **Confirm.** It requires the current fingerprint. Then it creates the org note through `applyWrite`, records `promoted_to: "<org>:notes/x.md"` on the source, and appends `SYNC  <project>  personal:notes/x.md → <org>:notes/x.md  <em-dash> promoted: <type>` to both vault logs (`--log-project` sets the project, default `-`). The note is also linted against the org vault (`lintVault` over the org snapshot with the note overlaid, scoped to that note): any L01/L02/L13 error refuses the preview, and the lint result is returned again after the write. Vault-wide warnings do not block. A second promotion of the same note needs `--again`, and an existing org note is never overwritten. If the source provenance write failed after the org note was created, a rerun detects the org note's matching `promoted_from` and offers a provenance-only preview and confirm.
- **MCP.** `vmem_promote` does the same over MCP and needs `write: mcp` on both vaults.

`vmem sync <vault>` is the only command that commits or pushes:

- **Preview.** It requires a configured `remote` that every effective `origin` fetch and push URL matches (`remote.origin.pushurl` included), after normalising scheme, credentials, host case and, for host remotes only, a trailing `.git` (local and `file:` paths keep their case and their `.git` suffix, because `x` and `x.git` are different repositories). Any `url.*.insteadOf` or `pushInsteadOf` rewrite is refused, because the real push destination cannot be verified. A mismatch fetches and pushes nothing; the push URLs are part of the preview fingerprint and are checked again just before pushing. It refuses a detached HEAD or an in-progress rebase or merge, then fetches and previews the branch, ahead/behind counts, and the changed paths it will stage: only `notes/`, `reports/` and `log`. Anything else is listed under `ignored` and never staged. A changed file that matches the configured `denyPaths` or the default deny names refuses the whole sync (before hashing, staging, committing or pushing) and is reported only as a count; a denied vault root is never synced.
- **Confirm.** With the current fingerprint it commits those paths, rebases onto `origin/<branch>` when behind, pushes, then re-fetches and reports success only when the remote head equals the local head. Conflicting history aborts the rebase and keeps the local commit (`DIVERGED`). A refused push (`PUSH`) or a failed fetch (`FETCH`, for example missing credentials) reports `ok: false`.
- **Git hardening.** Git runs through agent-mem's hardened argv: hooks, fsmonitor, external diff, pager, credential helper and askpass are disabled, `GIT_TERMINAL_PROMPT=0` is set, and repository-redirecting `GIT_*` variables are removed. So sync uses ssh keys or a deploy key and never prompts.
- **Not decided by the tool.** Which org, visibility, remote and deploy key a vault uses are deployment decisions, and whether an agent may push a given org vault is the workspace's external-sending rule.

## Skill mining

`vmem skills mine <vault> [--days N] [--project KEY|--all-projects] [--vocab DIR] [--skills DIR ...] [--min-size N] [--min-novelty X] [--json]` ranks repeated work patterns as new-skill candidates. It replaces the Python `skill-mine` pipeline and reads memory instead of raw session logs. `vmem_skills_mine` takes the same inputs over MCP.

- **Records** (within `--days`, default 30; exact duplicate texts kept once). agent-mem curated entries of kind `decision`, `finding`, `contract` or `fail` (title and text), screened by agent-mem's standalone policy plus the vault config's `piiPatterns`. agent-mem capture rows with event `UserPromptSubmit`, `observation` or `summary` (the excerpt), opened read-only; tool events are skipped. Vault notes of every type except `person`, `moc` and `reference` (title, description and body), dated by frontmatter `created`/`date`, else the file mtime. All active agent-mem projects are read by default; `--project` narrows to one.
- **Matching and graph.** The `materialize.py` rules: action and object vocabularies from `--vocab DIR` (`actions.yaml`, `objects.yaml`; the skill ships them), plus project keywords, acronyms, people and orgs from the vault's `registry`; every contained surface matches (ASCII case-insensitively, Hangul exactly), giving nodes `action--<canon>`, `object--<canon>` and `entity--<kind>--<slug>`. A person node id is a digest, never the name. Records and vocabulary nodes form one graph clustered by the same deterministic Leiden as `vmem graph build`.
- **Scoring.** The `analyze.py` rules: a community with at least `--min-size` records (default 3) and novelty at least `--min-novelty` (default 0.3) is a candidate, labelled `{top action}-{top object}`, with up to 8 triggers. Cohesion is the community's edge density; novelty is 1 minus the highest Jaccard similarity against the `SKILL.md` name and description tokens under each `--skills` directory; rank is `log2(size) × (unique days / day span) × max(0.1, cohesion) × max(0.1, novelty)`. The report keeps the god nodes, candidates, surprising connections and rejected sections and adds per-candidate counts by source (curated, capture, vault).
- **Privacy boundary.** The command writes nothing: no vault file, lock, cache, report or log event, nothing under the vmem home and no content under the agent-mem home (it opens no store that does not exist). Reading a SQLite database may create an empty `-wal` file and a `-shm` WAL index (no row content) next to it in the agent-mem home, and nothing else. A record matching vmem's secret screen is dropped and counted. Returned samples from all three sources are masked the same way: registry people become `[PERSON]` (ASCII names case-insensitively, as matching does), emails `[EMAIL]`, absolute paths `[PATH]` and matches of the vault config's `piiPatterns` `[PII]`. Over MCP a vault re-registered after server startup is refused. The JSON result and the markdown report are the only output, and the calling skill decides where to save it.
- **Bounds.** At most 20,000 records, 64 KiB per record (larger records are dropped and counted) and 64 MiB in total; exceeding the record or total bound fails with an explicit error. Capture reads keep the newest 20,000 rows per machine and count a truncated shard.



## Release readiness

`bun run check` includes strict types, import boundaries, tests, package dry-run and a clean tarball installation with CLI/MCP reads, non-TTY mutation and stale-preview refusal. Package files are limited to runtime source/bootstrap, manifest, license, README and changelog. Tag validation additionally runs npm package dry-run and tests the exact npm tarball later used by the gated OIDC job. No release tag or publication is created by this readiness change. The tarball install resolves the pinned first-party dependency from the configured registry, so the full check requires network access.

- `bun run parity:release` checks same-snapshot frontmatter bytes, incremental notes/FTS/links against clean rebuild, and two consecutive synthetic Python-oracle lint/graph comparisons. External Python reference paths can be supplied with `--lint-reference` and `--graph-reference`; `--output` records aggregate evidence.
- `bun run release:verify` enforces committed runtime/method/external-parity evidence freshness and the declared synthetic thresholds at the explicit release gate. Ordinary tests validate evidence shape and internal sample consistency; routine source edits and version bumps do not require fresh benchmark evidence until release validation.
- `bun run bench:release --output <file.json>` measures a generated 5000-note corpus in the authorized Linux dgx02 container. It records actual MCP search round-trip timings (including metadata refresh), kernel RSS high-water, raw samples and environment; it exits nonzero when a synthetic threshold fails. Synthetic write timings are diagnostic and do not establish representative private-vault acceptance.
- [Readiness evidence](docs/release-readiness.md), [release workflow](docs/release-workflow.md) and [cutover checklist](docs/cutover-checklist.md) distinguish verified results from outstanding private/native/integration/deployment gates. Live cutover remains blocked.


## Core operating compatibility

- Frontmatter accepts YAML double-quoted Unicode/control escapes, quoted keys and escaped line continuations while preserving unchanged source bytes. New non-ASCII values are emitted as literal characters. A count-only local private snapshot probe verified 717/717 parses and 0 round-trip differences; the private result contains no note names or bodies and is not included here.
- Existing unchanged V01 schema debt (unknown keys, off-enum values and other retained field violations) warns on unrelated edits and moves. Added/changed violations and explicitly assigned invalid fields error; create remains strict. Secret/PII/path safety checks stay enforced, including bounded screening of decoded metadata scalars and key/value context, so quoted escapes cannot hide prohibited values. No extra metadata keys are adopted or automatically migrated.
- `link` skips any requested side already linking the target in visible body content, including embeds and dated Connections sections. Topics and code references do not count. A missing reverse side is still added. A repeated request returns `unchanged: true`, no file changes and no event.
- `patch` refuses any match beginning inside frontmatter with a hint to use `vmem_set_frontmatter` or `frontmatter`; patching body text retains exact-one-match and SHA checks.
- `source` accepts one string or a nonempty list of up to 32 strings (512 UTF-8 bytes each). Each reference is a workspace-relative path, `mem:<id>` or an absolute URL. Explicit source assignments strip a leading `work/`; ordinary edits do not rewrite legacy values. CLI `new --source` accepts either a string or a JSON string array; MCP create and frontmatter updates accept arrays directly.
- With `registry` configured, source existence uses the nearest ancestor containing `workspace.config.yaml`, falling back to the registry directory for standalone fixtures. Missing relative paths warn as V11 on writes and L14 in lint; no referenced file content is read. Denied source references are refused/reported generically before existence warnings. URLs and memory ids are not fetched.
- MCP `vmem_read` supports `section`, `offset`, and `maxBytes`; section/page responses return raw `body` with `frontmatter: null`. CLI `show` uses `--section`, `--offset`, and `--max-bytes`. Responses retain the whole-note SHA; each payload stays bounded while sections beyond the first 64 KiB remain accessible from the derived index.
- `bun scripts/frontmatter-probe.ts --vault <vault> --output <private-counts.json>` is a read-only bounded local diagnostic. It stores aggregate counters/hash only, rejects unstable reads, and writes its private result outside note directories. Real note bodies must never be copied into fixtures or public evidence.

Runtime changes intentionally make `release:verify` report stale historical release evidence until the separately authorized release-time refresh. This core fix does not rerun a benchmark or authorize live cutover.

# Migration tidy

`vmem tidy <vault> [--connections --escapes --enums --keys --sources --topics --secrets --log | --all] [--map <file>] [--json] [--confirm --fingerprint SHA]` sanitizes debt from older, unvalidated writers. It is meant for the one-time V2 cutover and later imports.

- **Two steps.** Without `--confirm` it prints per-rule `counts`, a per-note change list (`key: old -> new`, dropped keys with their values, sections added) and `reported` items that were left unchanged; nothing is written. With `--confirm` the fingerprint must match: it covers the rules, the map file, and the before/after sha of every touched file (and of the log). Each note is then written through `applyWrite` (atomic per note, under the vault lock) and one `LINT` event is appended, for example `tidy: escapes 1, enums 13, keys 78, ...`.
- **Never blocked by one note.** A sanitized note that the writer would still refuse (for example an unknown key) is left unchanged, listed under `skipped` and `reported`, and the rest of the run proceeds. Counts and the `LINT` event cover only notes that are written.
- **No value leaks.** Every value echoed into a change line or report is screened: secret-looking values, and PII values that the `notes` surface warns on or denies, print as `[redacted]`.
- **Restart-safe.** If a run is interrupted, every note is either fully old or fully new; a rerun previews only the rest. A second `--all` run previews zero changes.
- **Scope.** Only flat `notes/*.md` and, for `--log`, the vault `log` are touched; `.obsidian/`, `templates/` and `self/` never are. Nothing is committed; commit the receipt paths yourself.

| rule | default disposition |
|---|---|
| `--escapes` | values written with YAML escapes (`\uXXXX`, ...) or the old writer's trailing-backslash wraps are re-emitted as canonical single-line scalars with literal characters |
| `--enums` | `confidence`: `confirmed`/`verified` -> `proven`, `observed` -> `likely`, `possible`/`speculative`/`web_unverified` -> `experimental`, `a \| b` -> the lower one. Other `confidence`, `status` and `type` values are reported, not guessed |
| `--keys` | `date`/`record_date` -> `created` (dropped when equal, reported when different). `decided_date`/`decision_date`/`decided` -> `decided_at` on `type: decision`. `decided_at`/`decided_by` are schema keys for decisions, and `email`/`phone` for `type: person` in personal vaults (org promotion still refuses them). `related`/`relatedMeetings`/`github`: resolvable wiki targets become `## Relevant Notes` links (deduplicated), paths and URLs join `source`. `origin`, `ideation_stage`, `keywords`, `priority`, `deadline`, `completedDate`, `taskSourceType`, `submission_status` are dropped (values listed in the preview). Any other key is reported and kept |
| `--sources` | strip `work/`, split joined paths into a list (only when every part is a workspace path; URLs and `mem:` ids are never split), report paths that do not resolve |
| `--topics` | append `## Topics` listing the frontmatter topics where no such heading exists; mismatched sections are reported |
| `--connections` | fold `## Connections (...)` headings into `## Relevant Notes` |
| `--secrets` | replace V06 secret matches with `[redacted]`: in the body the match itself, in frontmatter the whole field value (the key stays, so the YAML stays valid). A match outside a field value, such as a YAML comment, is reported for manual repair. The preview names note and line, never the value. PII in personal vaults is left alone |
| `--log` | replace secret-looking substrings in existing log lines with `[redacted]`, and PII values that the vault policy denies on the `log` surface (allow-list entries excepted), under the log lock (refused with V06 when `denyPaths` covers the log). A line that fails the lint L09 structure check loses a trailing seconds field when that makes it valid, and is otherwise kept verbatim behind `# legacy: ` (readers skip `#` lines); no time, zone or TYPE is guessed. Other lines are kept byte for byte. Git history is not rewritten: rotate exposed credentials |

`--map <file>` overrides defaults with strict JSON `{"enums": {"confidence|status|type": {"from": "to"}}, "keys": {"key": "drop" | "keep" | {"rename": "key"}}}` (at most 64 KiB and 1000 entries). For `tidy`, `--log` selects the log rule; tidy always writes its own `LINT` event.
