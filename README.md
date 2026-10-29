# vault-mem

An Obsidian-compatible knowledge vault tool for agents and people. Requires Bun >=1.4.2. The full check (`bun run check`) needs only Bun: package validation uses `bun pm pack --dry-run`, so Node and npm are not required. CI runs on Ubuntu and macOS for pull requests and for pushes to `main`.

This foundation implements configuration and vault registration only. It does not read or mutate note contents. Index/search, validated note writes, MCP, log, lint/graph, promotion, sync, setup and the `acon` console remain planned under issues [#1](https://github.com/STAIxBWLB/vault-mem/issues/1) and [#2](https://github.com/STAIxBWLB/vault-mem/issues/2). Do not use this increment to replace an existing vault writer.

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

Vault fields: `id`, absolute `path` (must contain a real `notes/` directory), `kind` (`personal|org`), `write` (`mcp|cli|none`), optional `pii` (`allow|deny`; default `allow` for personal and `deny` for org, and `status`/`vaults list` always report the effective value, including for unhealthy entries), optional `remote` (any nonempty string such as an `https://` or `git@host:path` URL; stored only) and optional `registry` (absolute path; stored only). No sync exists yet, so `remote` and `registry` are not validated against a server and doctor does not check them; reachability checks apply once sync is implemented. Policy fields are stored for later note-writing stages, not enforced on note operations in this foundation because no note operations exist yet. 

The only runtime dependency is the exact first-party pin `@staix/agent-mem@0.11.0`; it is not loaded by registry commands. Public library exports cover configuration, home resolution and registry operations. No console bin or UI contract is advertised before its implementation.
