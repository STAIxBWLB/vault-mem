# Configuration and registry

Read before registering a vault or spec source, changing `vmem.config.json`, a vault's PII policy or domains, or recovering a crashed registry write.

## Registry

The first `vmem vaults remove` prints a preview; `--confirm` unregisters the vault. It never deletes vault files. Commands work without a TTY and in agent environments. Add requires an existing `notes/` directory, stores the canonical vault path, and rejects duplicate ids and paths. Doctor returns a nonzero status when a registered vault becomes unavailable or its notes directory is replaced by a symlink.

## Home and configuration file

Home precedence: `VMEM_HOME` (the pointer is not consulted), else a `home` pointer in the default home's `vmem.config.json`, else the default home itself. The default home is `$AGENTHUB_HOME/vmem` when `AGENTHUB_HOME` is set, otherwise `~/.agenthub/vmem`. Home paths are reported absolute and lexically normalized (`.`, `..` and trailing slashes removed, symlinks not resolved); registered vault paths are stored and reported canonical (symlinks resolved). Environment paths and configured paths must be absolute. A redirect file contains only `home`; the target contains the registry and policy, and cannot redirect again. Missing config means an empty registry. Malformed, oversized, linked or nonregular config files fail closed.

```json
{"vaults":[{"id":"personal","path":"/absolute/vault","kind":"personal","write":"mcp"}],"denyPaths":[],"piiPatterns":[]}
```

Configuration is limited to 64 KiB both on read and after serialization (a change whose pretty-printed result exceeds the limit is refused and the file is unchanged), rejects unknown keys, and is updated under an exclusive lock using a flushed temporary file and atomic rename. An optional top-level `version` (positive integer, absent means 1) names the config format; this build supports format 4. Registry writes add `version: 4` when a vault declares `canonTables`, at least `version: 3` for `domains`, or at least `version: 2` for `specs`. Configurations without these fields keep their existing version field (or its absence). A config whose `version` is newer than this build's format is read tolerantly: unknown keys at the top level, in vaults and in PII policies are kept and written back unchanged by registry commands, while the keys this build knows are still validated. A PII policy with members this build does not know cannot be enforced, so it fails closed: every write on that vault (note writes and `check`, two-step previews and confirms, tidy, `promote-from-amem`, `promote` and log appends) is refused with `PII_POLICY`, naming the members, until the newer vmem that wrote the policy does the write. Reads and `vaults pii` show are unaffected. `vaults pii --set` refuses to replace a policy that carries such members, since the replacement would drop them; change it with the newer vmem. Versions that add a key bump the format. Errors name the config file or vault id and path but never echo config or note contents.

A vault entry may declare `"domains": ["finance", "health", "household"]` in `vmem.config.json` (or in the object passed to `addVault`). This adds at most 16 ids matching `[a-z][a-z0-9-]{0,31}` to the built-ins `research`, `projects`, `teaching`, `operations`, `people`, `ai-practice`; an empty or omitted array leaves the built-ins available. Duplicate ids count toward the 16-entry declaration bound and appear once in the effective set. `status --json`, MCP `vmem_status` and `vaults list` report the effective set as `domains` (the text list has a DOMAINS column). Reads do not rewrite config. Writers and lint check domain values against the selected vault; missing-domain lint behavior is unchanged. `promote` and `promote-from-amem` check the target vault's set and name an undeclared domain with how to fix it; a personal-only domain is refused by an org vault that does not declare it. The existing per-vault PII policy applies to every domain; note types remain fixed.

## Durability and crash recovery

Durability: the temporary file is fsynced before the rename and the home directory is fsynced after it. On Linux this makes the new config durable once the command returns. On macOS directory fsync succeeds but does not flush the drive cache (no `F_FULLFSYNC`), so a power loss right after a change can revert to the previous complete config, never to a partial one. Windows is not a supported platform for durability claims; the rename stays atomic.

Crash recovery: the lock file records the writer's pid, host and start time. Nothing is cleaned up automatically. `vmem recover` previews the state; `vmem recover --confirm` removes the lock only when it names this host and a pid that no longer runs, and then removes leftover `.config-<uuid>.tmp` files. A live lock, a lock from another host, or an unreadable (older-format) lock is never removed and the command exits 1; confirm no writer runs, then delete `config.lock` by hand. No other file in the home or any vault is touched. If cleanup fails after an operation (for example the lock cannot be removed), the original error is kept and the cleanup failure, including a retained lock, is appended to it.

## Vault fields

Vault fields: `id`, absolute `path` (must contain a real `notes/` directory), `kind` (`personal|org`), `write` (`mcp|cli|none`), optional `pii` (the `allow|deny` shorthand or a policy object, see PII policy below; default `allow` for personal and `deny` for org, and `status`/`vaults list` always report the effective shorthand and `piiPolicy` matrix, including for unhealthy entries), optional `remote` (any nonempty string such as an `https://` or `git@host:path` URL) and optional `registry` (absolute path). For healthy vaults, `doctor` checks locally that the vault is a git repository root with an origin whose fetch and push URLs all match `remote` (URL rewrites are refused), and that `registry` passes the same deny-path, size and project-id validation as log appends. Results appear under each vault's `checks.remote` and `checks.registry`. Doctor also runs the tidy planning pass for writable vaults and reports pending counts and unparsable paths, without per-note writer validation or writes. Planning failures appear as `checks.tidy`; a failed check exits 1. Actual tidy previews validate planned notes and identify skipped notes. These checks use no network and do not test reachability. `status` is unchanged. Policy fields are stored for later note-writing stages, not enforced by the read commands. Writer commands enforce write/channel policy and configured deny/PII screening.

## Canonical tables

A vault may declare `canonTables` in format 4, with no default note names:

```json
{"version":4,"vaults":[{"id":"personal","path":"/absolute/vault","kind":"personal","write":"mcp","canonTables":[{"path":"notes/entities.md"},{"path":"notes/roster.md","keyColumn":2}]}]}
```

Each entry names a literal flat `notes/<name>.md` path in that vault (at most 256 UTF-8 bytes); absolute/traversing/dot paths, backslashes and controls are config errors. Up to 16 entries are allowed, with `keyColumn` defaulting to the first column and otherwise 1..64. Duplicate path/column pairs are refused. Missing, unreadable or denied table notes at preview time contribute no rows and produce an advisory warning with a repair step. They never become a promotion refusal. Other write policy and note validation remain enforced.

## PII policy

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
