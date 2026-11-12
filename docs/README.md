# vault-mem documentation

The [README](../README.md) is the entry point. Open a document when the task needs it:

- [Configuration and registry](reference/configuration.md): read before registering a vault or spec source, changing `vmem.config.json`, a vault's PII policy or domains, or recovering a crashed registry write.
- [Reads](reference/reads.md): read before relying on search ranking, link resolution, paging, the derived index cache, `brief`, `stats` or the frontmatter library. Paging over MCP and frontmatter escape handling are also covered under [Core operating compatibility](reference/writes.md#core-operating-compatibility).
- [Writes and the log](reference/writes.md): read before a note write, merge, move, delete or tidy, before interpreting a write receipt or issue code, or before appending to the vault log.
- [MCP server and host setup](reference/mcp-and-setup.md): read before calling vmem over MCP, registering it in an agent host, or using the console plugin.
- [Promotion and sync](reference/promotion-and-sync.md): read before promoting from agent-mem, promoting a note to an org vault, or running `vmem sync`.
- [Lint, graph and skill mining](reference/analysis.md): read before running or interpreting `vmem lint`, `vmem graph`, the workspace graph, parity scripts or `vmem skills mine`.
- [Spec sources](reference/specs.md): read before registering a spec repository or reading, validating, creating, updating or deleting specs.
- [Release readiness](release-readiness.md): read before a release, or before quoting what is verified and which gates remain open.
- [Release workflow](release-workflow.md): read before tagging a release or changing `.github/workflows/release.yml`.
- [Cutover checklist](cutover-checklist.md): read before replacing an existing vault writer with vmem.
- `verified.json`: the source commit each document was last checked against; `scripts/check-docs.mjs` reports a document as stale when its covered paths change after that commit.
- `evidence/`: committed release evidence read by `bun run release:verify`.
