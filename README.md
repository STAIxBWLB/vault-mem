# vault-mem

An Obsidian-compatible knowledge vault tool for agents and people. Requires Bun >=1.4.2.

This foundation implements configuration and vault registration only. It does not read or mutate note contents. Index/search, validated note writes, MCP, log, lint/graph, promotion, sync, setup and the `acon` console remain planned under issues [#1](https://github.com/STAIxBWLB/vault-mem/issues/1) and [#2](https://github.com/STAIxBWLB/vault-mem/issues/2). Do not use this increment to replace an existing vault writer.

```sh
bun install
bun bin/vmem.js --help
bun bin/vmem.js vaults add personal /absolute/vault --kind personal --write mcp
bun bin/vmem.js status --json
bun bin/vmem.js doctor
bun bin/vmem.js vaults remove personal
bun bin/vmem.js vaults remove personal --confirm
bun run check
```

The first remove prints a preview; `--confirm` unregisters the vault. It never deletes vault files. Commands work without a TTY and in agent environments. Add requires an existing `notes/` directory, stores the canonical vault path, and rejects duplicate ids and paths. Doctor returns a nonzero status when a registered vault becomes unavailable or its notes directory is replaced by a symlink.

Home precedence: `VMEM_HOME`, then `home` in the default home's `vmem.config.json`, then `$AGENTHUB_HOME/vmem`, then `~/.agenthub/vmem`. Environment paths and configured paths must be absolute. A redirect file contains only `home`; the target contains the registry and policy, and cannot redirect again. Missing config means an empty registry. Malformed, oversized, linked or nonregular config files fail closed.

```json
{"vaults":[{"id":"personal","path":"/absolute/vault","kind":"personal","write":"mcp"}],"denyPaths":[],"piiPatterns":[]}
```

Configuration is limited to 64 KiB, rejects unknown keys, and is updated under an exclusive lock using a flushed temporary file and atomic rename. A lock is never removed automatically after a crash; verify that no writer is running before removing `config.lock`. Policy fields are stored for later note-writing stages, not enforced on note operations in this foundation because no note operations exist yet. `pii` defaults to `allow` for personal vaults and `deny` for org vaults.

The only runtime dependency is the exact first-party pin `@staix/agent-mem@0.11.0`; it is not loaded by registry commands. Public library exports cover configuration, home resolution and registry operations. No console bin or UI contract is advertised before its implementation.
