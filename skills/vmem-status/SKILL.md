---
name: vmem-status
description: Use when asked which vmem version is installed, whether vmem is up to date, or whether the vmem install and its vault registry are healthy (not note content; that is vault-stats). Reports the running vmem build, installed skill version, other installs on PATH, registered vaults and doctor findings, read-only.
---

# vmem-status

Answer "what vmem runs here and is it healthy" in one report. Every step is read-only: give repairs as commands for the person to run.

## Process

When only MCP is available, call `vmem_status` for its registered vaults and health; use MCP server version metadata if the host exposes it. Compare that version with the local marker when both are available. Report the CLI build, PATH, doctor, recover and other CLI-only checks as unavailable, not healthy or failed. Do not infer fields absent from the MCP response. When only the CLI is available, run steps 1–5 and skip the MCP comparison.


1. **Build**: run `vmem --version`. Read `version` from `.vmem-skill.json` in this installed skill directory and compare it with the running version. Report a mismatch as stale skills and suggest `vmem setup <host> --apply` for the actual host. If the marker is missing or unreadable, report the skill version as unknown.
2. **Other installs**: list every `vmem` on PATH (`which -a vmem`, `where vmem` on Windows) and run `--version` on each distinct resolved file. When versions differ, the lower one is stale. A stale install that runs is replaced by fixing PATH order or removing it; a stale shadowed install runs whenever PATH order changes, so remove it.
3. **Registry**: run `vmem status --json`. Take `version`, `home`, `source`, `healthy`, and per vault `id`, `kind`, `write`, `pii`, `healthy`, `path`.
4. **Doctor**: run `vmem doctor --json`. Its top-level `healthy` and exit code (1 means unhealthy, a finding to report, not a failure of this skill) are the verdict. Report each vault with `healthy: false` and its `issue`, each `vaults[].checks.<name>` with `ok: false` and its `issue`, each `specs[]` entry with `healthy: false` and its `issue`, and each vault's `tidy` (pending migration) as a warning.
5. **Leftovers**: run `vmem recover --json` without `--confirm`; it only previews. Report `lock.state` and any `temporaryFiles`. Exit 1 with `blocked` is a finding: a `live` lock means a writer is running, so wait and rerun; an `unknown` owner (unreadable, or another host's lock) means the person confirms no writer runs on any host, then removes `lock.path` by hand.
6. **MCP**: when the vmem MCP tools are available, call `vmem_status`. If step 3 also ran, a vault list that differs from step 3 means the MCP server started before the last registry change (restart the host session) or runs another build or home; report which fits. A `vaults remove` does not show as a mismatch, so after one the server needs a restart either way.

A matching skill marker and running version proves only local consistency, not that either is the latest release. When asked whether vmem is up to date, compare the running version with a verifiable current release from the package registry or release source when available; identify that source. If it cannot be checked, report latest-release status as unknown.

## Output

- One line: running version, installed skill version and local match verdict; separately report latest-release status as current, outdated, or unknown with its evidence.
- Other installs with versions, only when step 2 found any.
- Vaults table: id, kind, write, pii, health, path.
- Doctor failures and tidy warnings from step 4; "healthy" only when doctor's `healthy` is true.
- At most one next action with its command: repair stale skills with `vmem setup <host> --apply`, the repair a doctor `issue` names, `vmem recover --confirm` when step 5 is not `blocked` and shows a `stale` lock or `temporaryFiles`, rerunning `vmem recover --json` after a live writer finishes, or removing the file at `lock.path` once no writer runs, `vmem tidy <vault> --all` (preview) for pending migration, or removing a stale install with the package manager that owns it.
