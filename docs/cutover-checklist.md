# Vault cutover checklist

- Status: blocked. This PR prepares tooling and synthetic evidence only.
- Source contract: [issue #11](https://github.com/STAIxBWLB/vault-mem/issues/11), with dependencies #4-#10 and downstream integration tracked by [the parent plan](https://github.com/STAIxBWLB/vault-mem/issues/1).
- Release publication, host registration, reference retirement and live writer cutover are distinct actions. None is executed by this readiness work.

## Candidate and evidence gates

- Confirm all required dependency PRs are merged and freeze one candidate commit.
  - Record full commit, package version, runtime digest, Linux/macOS check URLs and results at that exact head.
  - Require strict TypeScript, `boundary: ok`, all tests, package dry-run and clean installed CLI/MCP smoke.
  - A source change invalidates prior runtime-bound measurements; evidence-only changes must preserve the recorded runtime/method digests.
- Run `bun run parity:release` on the fixed synthetic snapshot.
  - Require byte-identical frontmatter round-trip and incremental/cache-rebuild equality after create/edit/rename/delete.
  - Require two consecutive lint/graph finding/node/edge zero-diff comparisons against the unchanged reference tools; retain source hashes and snapshot hash.
  - Repeat on the authorized private corpus and store only private evidence in its approved location. Public evidence must contain no real note bodies.
  - Keep every reference implementation until the separate retirement gate is accepted. Fixture-only results do not retire a tool.
- Run `bun run bench:release --output <evidence.json>` serially on dgx02.
  - Require 5000 synthetic notes, MCP idle RSS <100 MB, MCP peak RSS <200 MB and search p95 <50 ms.
  - Preserve environment, CPU/memory quotas, raw samples, warmup policy and nearest-rank method. Failed or missing telemetry cannot pass.
  - Measure the authorized representative-vault write p95 separately and require <150 ms. The synthetic write diagnostic is not this acceptance result.
- Inspect an isolated Obsidian fixture without editing application settings, templates or self notes.
  - Open every fixture note; verify no invalid-frontmatter badge, property parsing, aliases, headings, embeds and wiki-link navigation.
  - Record application version, fixture snapshot and native readback. Provider/parser tests alone do not establish native UI acceptance.
  - Load the emitted graph in the actual downstream consumer and record its version/head and successful community overlay.
- Confirm agent/non-TTY writes and stale-fingerprint refusals on both CLI and MCP through the installed package.
- Confirm all reader/UI/host integrations in the parent plan are accepted. A successful package release does not prove integration readiness.

## Release and install

- Prepare a reviewed version and dated changelog entry; confirm intended npm visibility, publisher ownership, required environment reviewers and trusted-publisher binding.
  - Keep `NPM_PUBLISH_ENABLED` unset/false until explicit publication authorization.
  - Follow [the release workflow](release-workflow.md); create no tag while a gate above is missing.
  - After authorized publication, verify registry version, integrity/provenance and a clean install of that exact published version. Preserve the prior installed version for rollback.
- Record the chosen package executable, Bun version and expected `vmem --version` output.
  - Install only the approved version in the approved location. Confirm executable resolution so another binary is not used accidentally.
  - Verify `vmem --help` and an isolated CLI/MCP read/write smoke before any live registration.
  - No install or upgrade of a live writer was performed by this PR.

## Registration and canary

- Capture approved backups of note files, append-only log, current writer/host config, registry config and setup receipts before changes.
  - Confirm backup persistence and restore procedure. Derived indexes are rebuildable; note/log backups are not replaceable by an index.
  - Do not include credentials or private note bodies in public artifacts.
- Choose a `VMEM_HOME` outside every registered vault and verify its home/pointer precedence.
  - Review each vault id, canonical path, kind, write policy, effective PII policy, registry path and optional remote.
  - Use `vmem vaults add` only in an explicitly authorized registration step. `vmem vaults remove --confirm` unregisters only and preserves all vault files.
  - Resolve live log project ids against the approved registry mapping; do not silently normalize old history.
- With the host closed, inspect `vmem setup <host>` dry-run and its exact entry/receipt paths.
  - Apply only after that host registration is authorized; verify saved bytes and preserve unrelated host entries.
  - Restart the client because MCP vault enums/defaults are fixed at startup. Read tools/list, default vault and effective policies back.
- Run one authorized canary against the intended vault/channel.
  - Preview first; verify expected SHA/fingerprint and returned report paths.
  - Confirm persisted note bytes, derived index/search, and the exact appended event. Treat note success and log failure separately.
  - Check Obsidian and downstream consumer readback before expanding use.
- Switch the live writer only after release/parity/native/integration/canary acceptance.
  - Avoid concurrent old/new writers during the switch. Do not add a scheduler or automatic push.
  - Org provisioning, visibility, remotes/deploy keys and external sync authorization remain separate deployment decisions.

## Retirement and rollback

- Retire a reference or old MCP writer only after the two consecutive private parity runs and all acceptance readbacks are approved.
  - Record the exact registration or entry removed, retain the prior executable/config and keep vault files intact.
  - Do not remove templates, self notes or unrelated app settings as cleanup.
- If a canary fails, stop new writes and preserve all receipts, locks, backups and partial-failure evidence.
  - Do not retry a partially successful mutation until persisted state and its log are reconciled.
  - Undo only the setup entry owned by its unchanged receipt; preserve foreign edits and use manual recovery when undo refuses.
  - Unregister the new vault only when authorized; unregistering never deletes its files.
  - Restore the previous package/host writer from the verified backup, restart the client and verify reader behavior before resuming writes.
  - Restore note/log data only from an approved backup/reconciliation plan. Never erase concurrent edits or force-remove a live lock.
- Keep publication disabled and live cutover blocked when evidence is failed, missing or stale. A new candidate requires a new exact-head check record.
