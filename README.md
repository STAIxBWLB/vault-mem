# vault-mem

An Obsidian-compatible knowledge vault tool for agents and people. Requires Bun >=1.4.2. The full check (`bun run check`) needs only Bun: package validation uses `bun pm pack --dry-run`, so Node and npm are not required. CI runs on Ubuntu and macOS for pull requests and for pushes to `main`.

Implemented: configuration, vault registration, lossless frontmatter parsing/emission, wiki-link resolution and derived SQLite FTS5 indexing with bounded read commands. Validated note writes, MCP, log, lint/graph, promotion, sync, setup and the `acon` console remain planned under issues [#1](https://github.com/STAIxBWLB/vault-mem/issues/1) and [#2](https://github.com/STAIxBWLB/vault-mem/issues/2). Do not use this increment to replace an existing vault writer.

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

Vault fields: `id`, absolute `path` (must contain a real `notes/` directory), `kind` (`personal|org`), `write` (`mcp|cli|none`), optional `pii` (`allow|deny`; default `allow` for personal and `deny` for org, and `status`/`vaults list` always report the effective value, including for unhealthy entries), optional `remote` (any nonempty string such as an `https://` or `git@host:path` URL; stored only) and optional `registry` (absolute path; stored only). No sync exists yet, so `remote` and `registry` are not validated against a server and doctor does not check them; reachability checks apply once sync is implemented. Policy fields are stored for later note-writing stages, not enforced by these read commands; they do not grant note-writing permissions.

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
