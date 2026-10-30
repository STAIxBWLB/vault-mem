# Changelog

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
- Add validated atomic note mutations, preview fingerprints and append-only attributed vault events.
- Add bounded CLI/MCP providers, reversible host setup and agent-mem promotion with provenance.
- Add indexed lint, deterministic graph reports, bounded neighborhoods and synthetic reference-parity checks.
- Reuse unchanged parsed notes and link analysis during write validation, refresh derived links only for affected sources, and recheck the staging snapshot by direct content comparison instead of rehashing.
- Resolve wiki links by note path only, matching Obsidian and lint L01; aliases remain lookup metadata for read commands, and new alias-only links are refused.
- Prepare release validation, clean-install package smoke and an opt-in npm OIDC workflow. Publication, private evidence and live cutover remain separate gates.
