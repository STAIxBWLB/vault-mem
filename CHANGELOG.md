# Changelog

## Unreleased

- `vmem move` accepts an existing legacy-named note (lint L13) as its source, so the finding can be fixed with a normal rename.

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
