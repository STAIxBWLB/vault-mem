# Release workflow

Tag pushes publish through this workflow. The `npm-production` environment (required reviewer, `v*` tag policy), `NPM_PUBLISH_ENABLED=true` and the npm trusted publisher for `@staix/vault-mem` (`release.yml`, `npm-production`) are configured; 0.1.0 was the first release published this way. Live vault cutover remains blocked by the separate integration and canary gates in issue #11.

## Validation and artifact

- A deliberate future `v*` tag triggers `.github/workflows/release.yml`. Both Ubuntu and macOS check out the triggering commit, rather than a moving branch.
- The tag must equal `v` plus `package.json` version. `CHANGELOG.md` must contain the matching `## [VERSION] - YYYY-MM-DD` heading; `Unreleased` cannot authorize a release.
- Both systems run frozen Bun installation and npm package dry-run, then stage an npm tarball with a manifest containing package identity, tag, commit and SHA-256.
- Both run `bun run check` with `VMEM_SMOKE_TARBALL` pointing at that staged npm artifact. The check includes `bun scripts/package-smoke.ts`, which installs that exact tarball in a clean directory and verifies CLI/MCP behavior. No second smoke invocation is added.
- Linux uploads its validated tarball and manifest only after its check passes. The publish job waits for both validation jobs and consumes that same Linux artifact without rebuilding it.
- Tag validation additionally runs `bun run release:verify` for runtime/method and external-parity evidence freshness and the declared synthetic thresholds. Ordinary PR tests check evidence shape and sample consistency, so routine code edits do not require rerunning the benchmark.
- Before publication, the job checks artifact hash, embedded package identity and tag/commit binding. Stable versions use the `latest` npm dist-tag; prerelease versions use `next`.
- After npm publication succeeds, the `github-release` job (the only job with `contents: write`) checks the same artifact's tag and commit, then creates the GitHub release for the tag with the tarball and manifest attached as `staix-vault-mem-<version>.tgz` and `.manifest.json`. Notes are the version's CHANGELOG section, the install line, the tarball SHA-256 and a compare link from the previous CHANGELOG version. Prereleases are marked prerelease; a rerun replaces the assets and notes of an existing release.

## Deployment prerequisites

- Repository variable `NPM_PUBLISH_ENABLED` is `true`. Set it to `false` to stop publication; the publish job is skipped without the literal value `true`. Every publish still waits for an `npm-production` reviewer approval.
- A maintainer must configure the GitHub `npm-production` environment with required reviewers and appropriate release-tag deployment restrictions. A workflow's `environment` field alone does not prove these protections exist; an absent environment may be created without them.
- A maintainer must confirm npm package ownership and configure a GitHub Actions trusted publisher for organization `STAIxBWLB`, repository `vault-mem`, workflow filename `release.yml`, and environment `npm-production`. Its allowed actions must permit the direct `npm publish` used here. Package bootstrap, publisher configuration and any expiry recovery require separate authorization.
- The GitHub-hosted publish job uses Node 24 and verifies npm >=11.5.1. Only that job receives `id-token: write`; no long-lived npm token is supplied. npm documents trusted publishing's minimum versions and publisher fields in [Trusted publishing](https://docs.npmjs.com/trusted-publishers/).
- Publication explicitly requests provenance and public access. Confirm intended package visibility before enabling the job. See [npm provenance](https://docs.npmjs.com/generating-provenance-statements/).

## Authorized release procedure

- Before requesting a tag, collect exact-head Linux/macOS check results, package file-list and smoke evidence, reference parity evidence, measured performance data, and the cutover checklist's unresolved gates. Missing representative-vault or native Obsidian evidence stays unverified.
- Prepare the version and dated changelog entry through a reviewed PR. Revalidate the resulting candidate commit and confirm environment/trusted-publisher prerequisites through authenticated readback.
- Obtain explicit authorization for publication, then have the authorized maintainer create the matching tag and enable publication. Review the staged artifact and required environment approval before the publish job starts.
- After publication, separately verify registry version, integrity/provenance and clean installation of the published version. A successful workflow or npm release does not authorize writer registration, reference-tool retirement or live vault cutover.
- If validation or approval fails, leave publication disabled and preserve the failure evidence. Do not move a release tag or overwrite a published version; prepare a new reviewed version when necessary.
