# vault-mem

An Obsidian-compatible knowledge vault tool for agents and people. Requires Bun >=1.4.2. The full check (`bun run check`) needs only Bun: package validation uses `bun pm pack --dry-run`, so Node and npm are not required. CI runs on Ubuntu and macOS for pull requests and for pushes to `main`.

Implemented: configuration, vault registration, lossless frontmatter parsing/emission, wiki-link resolution and derived SQLite FTS5 indexing with bounded read commands. Validated note writes are also implemented below. MCP, lint/graph, promotion, sync, setup and the `acon` console remain planned under issues [#1](https://github.com/STAIxBWLB/vault-mem/issues/1) and [#2](https://github.com/STAIxBWLB/vault-mem/issues/2). Do not use this increment to replace an existing vault writer.

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

Vault fields: `id`, absolute `path` (must contain a real `notes/` directory), `kind` (`personal|org`), `write` (`mcp|cli|none`), optional `pii` (`allow|deny`; default `allow` for personal and `deny` for org, and `status`/`vaults list` always report the effective value, including for unhealthy entries), optional `remote` (any nonempty string such as an `https://` or `git@host:path` URL; stored only) and optional `registry` (absolute path; stored only). No sync exists yet, so `remote` and `registry` are not validated against a server and doctor does not check them; reachability checks apply once sync is implemented. Policy fields are stored for later note-writing stages, not enforced by the read commands. Writer commands enforce write/channel policy and configured deny/PII screening.

The only runtime dependency is the exact first-party pin `@staix/agent-mem@0.11.0`; it is not loaded by registry commands. Public library exports cover configuration, home resolution, registry operations, frontmatter, link resolution and the derived index. No console bin or UI contract is advertised before its implementation.

# Indexed reads

```sh
bun bin/vmem.js rebuild personal
bun bin/vmem.js search personal "project discovery" --type concept --domain research --limit 20
bun bin/vmem.js show personal "Note or alias" --max-bytes 16384
bun bin/vmem.js links personal "Note or alias" --limit 50 --json
```

All four commands require a registered vault id. They read only flat, regular `notes/*.md` files (case-sensitive `.md` extension), skip subdirectories and symlink files, and refuse a replaced vault/notes directory. Notes are limited to 2 MiB each. They never write note content, registry configuration or `.obsidian/`. `rebuild` rebuilds the derived cache; other commands scan metadata on every invocation and rehash new or metadata-changed files. Content-identical changes only update metadata; deleted/renamed paths leave the index. SQLite transactions make each scan atomic. A concurrently changing note aborts that scan, so retry after its writer finishes. No watcher, model calls or embeddings run.

The cache is `$VMEM_HOME/indexes/<canonical-vault-path-sha256>.sqlite` using the resolved home, not necessarily the environment variable. Cache files use mode 0600 on creation. The location must be outside every registered vault, including through symlinks; linked cache directories/files are refused. It contains note text and is disposable private derived state. Removing it while commands are stopped allows the next read to build it again. SQLite uses its own transaction lock and a five-second busy timeout. There is no automatic migration or live vault cutover.

Search uses FTS5 `unicode61` over title, description and body with BM25 weights 5:2:1, ascending score and path tie-breaking. Whitespace-separated query terms are literal AND terms, not a raw FTS expression; quote the query as one shell argument. `--type` and `--domain` are exact scalar frontmatter filters. Results include a bounded snippet and metadata, not the full body. Search queries and note targets accept at most 1024 UTF-8 bytes. Search/links default to 50 results, with an enforced 1..500 range. Show defaults to 16384 UTF-8 bytes and permits 1..65536, returning `truncated` and the full note SHA-256. Link string fields are capped at 1024 bytes in command results. Oversized arguments fail instead of silently raising a bound.

Link resolution uses NFC and case-insensitive filename stems or frontmatter `aliases` (string or string array; legacy `alias` accepted). An optional `notes/` prefix and `.md` suffix are accepted. `[[target|label]]`, `[[target#heading]]`, `[[target#^block]]`, `![[target]]` and same-note anchors work. ATX/Setext headings and end-of-line block ids are checked; fenced code is skipped. Missing/ambiguous targets and missing anchors remain explicit with a reason. Alias collisions are ambiguous, including collisions with filenames. Links returns outgoing links in source order, with one-based body-relative `line` values (frontmatter excluded); it does not write backlinks or repair dead links.

`parseFrontmatter` retains source bytes alongside semantic YAML data using Bun's built-in YAML parser. `emitFrontmatter(document, changes)` returns the entire note, preserving omitted and semantically unchanged keys byte-identically (comments, quoting, sequences, one-level mappings, folded/literal/chomped scalars, BOM and line endings). Changed keys use canonical JSON-compatible YAML; `undefined` removes a key. Editing requires a block mapping, while an unchanged flow mapping round-trips. This is a library transformation only, not a note-write command. Synthetic fixtures and create/edit/delete/rename parity tests cover this increment; Linux/macOS CI remains the platform verification gate.


# Validated writes

All mutations use `applyWrite(home, request)`: per-vault `mutation.lock`, current-SHA checks, in-memory planning, final-snapshot validation/screening, same-directory flushed temporary files and atomic renames, directory flushes, derived-index refresh and a structured receipt. `write: mcp` allows CLI and future MCP providers; `cli` allows CLI only; `none` refuses mutations. `check` is read-only and works with `none`. No command requires a TTY or rejects agent environments. This increment runs on fixtures; it does not authorize a live vault cutover.

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
```

Syntax follows indexed reads: the vault id comes first. `new` supports `--title`, `--source`, `--confidence`, `--status`, `--extra JSON` and `--body file|-`; omitted body gets an H1/Relevant Notes/Topics skeleton. Patch accepts nonempty old/new strings up to 8192 bytes and requires exactly one occurrence (including overlapping occurrences). Append uses an existing section or inserts it before Topics; it refuses targeting or introducing a Topics H2. `frontmatter` supports `--set JSON`, `--unset key,key` and `--expected-sha`; append also supports `--expected-sha`. Link relations are `supports`, `contradicts`, `extends`, `applies-to`, `context-for`; links are bidirectional unless `--one-way`. Supersede sets `status`/`superseded_by` on the old note and adds a reverse link in the next note. Report permits plain paths below `reports/` or `ops/`, is schema-exempt and still screened. Inputs are bounded to 256 KiB, follow no file symlinks and accept stdin with `-`.

`--dry-run` plans and validates any writer without creating locks, temporary files, directories or caches. `check` always takes this path, even without `--dry-run`. Move, delete and tidy first return a preview with planned path/hash changes and a fingerprint; confirmation requires that fingerprint. It covers canonical operation input, the canonical vault path/identity and policy, expected SHAs, every scanned note and all touched files, so even a new inbound reference after preview forces another preview. Move rewrites visible wiki/alias/heading/block/embed targets and wiki references in frontmatter across the vault, preserving explicit `|label` text, anchors and code. Bare alias targets become the new stem (for example, `[[Alias]]` becomes `[[new-stem]]`), so their visible text changes. Tidy folds Connections sections into Relevant Notes. Delete refuses when it would newly break inbound links or MOC topics; fix those references first.

Validation returns named issues with severity and no matched secret text: V01 schema/enums/description; V02 existing MOC topics; V03 newly unresolved links; V04 flat ASCII note paths (maximum 200 bytes) and safe report paths; V05 final Topics placement/content (warning), with explicit append-to-Topics refusal; V06 pinned agent-mem secret regex parity and denied sources/input/snapshot paths; V07 email/phone/configured PII patterns when denied; V08 create duplicates (stem/NFKC H1); V09 256 KiB prospective size, exact patch and expected-SHA/drift; V10 supersession target integrity. Unchanged pre-existing broken links warn, including after a move. `possibleDuplicates` lists candidate paths for warnings from a disposable in-memory FTS5 query of title terms, with BM25 <= -0.000001, up to three paths; no disk cache is written for that check. `LOCKED`, `IO`, `ROLLBACK`, `INDEX` and `CLEANUP` identify operational failures. CLI returns exit 1 when `ok` is false.

A successful receipt reports `applied`, planned path/hash/byte changes, issues and `indexUpdated`. Unrelated malformed legacy YAML is skipped by duplicate hints and by writer index refresh, with a V01 warning naming the unchanged note; normal read/rebuild commands retain strict parsing. Move/tidy still require parseable inputs and name the offending path on refusal. Reads allocate each note's stat size plus one growth-probe byte, capped at the 2 MiB read limit plus one. A failed index refresh rolls back the file changes. Rollback first verifies each file still equals this operation's committed result; external edits are preserved. Failed/refused rollback retains the original backup and reports its relative recovery path. All files are staged before replacement and backups permit rollback of caught multi-file failures. Each individual rename is atomic; a machine/process crash between multiple renames can leave a partially completed batch. The retained lock and `.vmem-<uuid>.tmp` files require inspection and manual recovery after confirming the writer stopped. They are never automatically removed by registry recovery. Uncoordinated editors do not honor the lock; the pipeline rechecks SHAs before replacement, but this does not provide a filesystem transaction against concurrent external edits. Existing notes may be read up to the index's 2 MiB limit; prospective files are limited to 256 KiB, with at most 10000 flat notes per mutation snapshot. File/directory fsync has the platform guarantees described above. Successful changed mutations now append an event as described below; log failure is reported separately from note success.


# Append-only events

```sh
vmem log append personal EXTRACT - synthetic:source "A synthetic event" --dest notes/example.md
vmem log tail personal --limit 50 --json
vmem log grep personal "EXTRACT|CONNECT" --type EXTRACT --limit 20
```

Events keep the canonical local-time format `YYYY-MM-DD HH:MM  TYPE  project  source → dest  — note` (two spaces between fields, one LF at the end). Destination is optional. Allowed new types: `INGEST ROUTE EXTRACT CONNECT DIGEST LEARN LINT TASK GRAPH SYNC RETHINK SOURCE`. Project must be `-` or a lowercase alphanumeric/hyphen id; when `registry` is configured, ids must exist in its bounded YAML `projects`/nested `sub_projects` arrays. Registry files are limited to 1 MiB, eight nesting levels and 10000 unique ids; invalid or unavailable configuration fails closed. Invalid types/fields/projects use L09 issues, the 1000-byte line bound uses V09, and secret/PII refusals use V06/V07. Fields cannot inject pipes, control characters or two-space/column separators. Validation and screening run before a file or lock is created. The 1000 UTF-8-byte bound includes the LF and attribution.

Every MCP log append and CLI call with a nonempty `AGENTHUB_PEER_ID`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID` or `PI_SESSION_ID` adds ` (vmem:agent)` to the note. Ordinary CLI events have no automatic suffix. Being an agent never causes refusal. Complete ISO timestamps are excluded from phone-number candidates, while real email/phone/configured PII matches remain refused when the vault denies PII.

`appendLog` validates the registered canonical vault and write/channel policy, acquires a separate `log.lock` (bounded two-second contention wait), then makes one O_APPEND write and fsyncs the log. New log files are mode 0600 and their parent directory is flushed. Linked/nonregular files and an incomplete existing final line are refused. Cooperating appenders share the lock; a short write is truncated back only when the same file still has the expected size, and its tail still equals our exact prefix, then flushed. Error-after-write cases inspect at most one event's bytes. Failed/ambiguous writes or cleanup are explicit; the receipt reports `appended` (possibly null when unknown), `synced`, `bytesWritten` (possibly null) and `rolledBack` when a partial append was removed. Before reporting sync, the current log and vault identities are rechecked; rotation produces LOG_DRIFT and an unknown current-path append state. A synced event can coexist with a cleanup error. No existing event is rewritten. A crash can retain `log.lock`, and failed short-write recovery can retain an incomplete line; inspect the file and stopped writer before manual recovery. There is no automatic cleanup or new TTY requirement.

Successful changed mutations default to EXTRACT, link to CONNECT, move to ROUTE, and supersede/tidy to RETHINK. Default events use project `-`, affected paths and the operation name rather than note text. Library callers can supply `WriteRequest.log` to override the event or `false` to disable it; CLI writers accept `--log JSON` for overrides. Preview/check/no-op/refused mutations never append. The append is bound to the mutation's resolved vault identity/policy, so re-registration cannot route its event to another vault. After a committed mutation, log append is independent: `ok`/`applied` describe the note operation, `log` holds its append receipt, and `logged` is true only when the event was appended and synced. A log error does not roll back a successfully saved note. CLI exits 1 for a log failure even when the note receipt says `ok: true`; inspect the receipt before retrying to avoid duplicate mutations/events. An override is validated at append time, not during a note-only dry run.

Readers never create a home, log or lock, and work with `write: none`. They skip blank/comment lines, return the last matching 1..200 records (default 50), accept an optional canonical TYPE and non-backtracking regex subset up to 256 characters (`|`, `^`, `$`, `.`, character classes, `\d`/`\s`/`\w` and their inverses, escaped literals, and atom `*`/`+`/`?`; groups, backreferences and brace quantifiers are refused), and scan a fixed descriptor-size snapshot. Streaming is capped at 32 MiB; individual historical lines over 4096 bytes and incomplete final lines are omitted with warnings, and the serialized line array stays within 128 KiB. Above 20000 data lines, the manual-archival warning is preserved. Read failure returns `dataLines: null` rather than claiming a count. Golden synthetic fixtures and concurrent/fault persistence tests cover the format and actual append state; no live vault log was read or modified for this increment.
