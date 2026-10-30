# Release readiness evidence

- Status: 0.1.0 published to npm on 2026-10-30. Package, parity, private-corpus and native fixture gates passed; live cutover remains open.
- Contract: [issue #11](https://github.com/STAIxBWLB/vault-mem/issues/11). No host registration or live vault write was performed. Publication does not authorize registration or cutover.
- Runtime and method digests in the raw evidence bind measurements to source bytes. Evidence-only documentation changes do not alter measured runtime; a runtime/method change requires a new measurement.

## Verification record

| Gate | Current evidence | Status |
|---|---|---|
| Strict TypeScript, boundaries, tests, package dry-run | 0.1.0 candidate source `3b005e8`: local `bun run check` (204 pass, boundary ok, package smoke) and `bun run release:verify` passed; tag validation reruns both on Linux/macOS | Candidate passed |
| Exact-head Linux/macOS CI | Tag `v0.1.0` (`6ebf691`) [release run 40977053105](https://github.com/STAIxBWLB/vault-mem/actions/runs/40977053105): Linux and macOS validation passed, including `release:verify` | Passed |
| Clean installed CLI/MCP | Fresh consumer install of packed tarball, exact installed byte comparison, CLI version/help/create/search, MCP read/tools and stale-fingerprint refusal | Bun and npm tarball installations passed |
| Frontmatter round-trip | Four release fixture notes, original comments/folded descriptions/Unicode retained byte-identically | Provider fixture passed |
| Incremental index vs rebuild | Baseline/create/edit/rename/delete compare notes, FTS and links | Provider fixture passed |
| Two Python parity runs | [External parity record](evidence/external-parity.json), same code/input hashes and two zero-diff rounds | Synthetic passed; private corpus passed (two zero-diff lint/graph rounds against the unchanged references, evidence kept private) |
| Obsidian properties and links | Obsidian 1.12.7 on an isolated synthetic fixture plus vmem-written notes: no invalid-property badge; properties, aliases, folded descriptions, headings, embeds, heading navigation, backlinks and graph view read back. An alias-only link mismatch was found and fixed by resolving links by path only (#29) | Native fixture passed |
| Consumer graph loading | [Consumer record](evidence/consumer.json), actual Maru enrichGraph module loads emitted fixture and overlays communities | Module readback passed; UI unverified |
| Agent/non-TTY and stale preview | Existing CLI/MCP regression suite plus clean installed package smoke | Candidate suite required |
| Representative private-vault write p95 <150 ms | CLI patch round-trip including startup on a copy of the authorized private vault: p95 139.0 ms over 30 samples at `3b005e8` (125.1 ms at `5634406`; 222 ms before PR #28) (evidence kept private) | Passed |
| npm trust/environment/public package | `@staix/vault-mem@0.1.0` published by GitHub Actions OIDC from the `npm-production` environment (required reviewer, `v*` tags only) with provenance; dist-tag `latest`. Registry tarball SHA-256 `b3fd27d2…` equals the validated artifact; `npm audit signatures` verified; clean install reports `vmem --version` 0.1.0. Two placeholder versions published by a maintainer before the trusted publisher could be configured remain on the registry: `0.0.0-stage` (first publish, which created the package) and `0.0.0-bootstrap.0` (dist-tag `bootstrap`, a retry after the first publish's result was misread) | Published |
| Reader/host/live writer integration | Separate parent-plan acceptance; no cutover attempted | Unverified |

## Performance record

The [raw synthetic report](evidence/synthetic-performance.json) contains every search/write/RSS sample, runtime/method digests, Bun/kernel/CPU details and container quotas. RSS uses decimal byte thresholds; search p95 is the nearest-rank statistic over 30 measured MCP queries after five warmups, including metadata refresh and transport. The derived index is prebuilt before the MCP process starts.

The 0.2.0 run (fine-grained PII policy) measured MCP idle RSS 29.36 MB, high-water 90.26 MB and search p95 29.63 ms; all three synthetic gates passed. The 0.1.3 run measured 29.36 MB, 91.39 MB and 36.30 ms; the 0.1.2 run measured 29.36 MB, 93.12 MB and 33.00 ms; the 0.1.1 run 29.36 MB, 90.53 MB and 34.63 ms. The 0.1.0 report is preserved as [v0.1.0 evidence](evidence/v0.1.0-synthetic-performance.json). The 0.1.0 candidate run (source `3b005e8`, after the write-path and path-only link changes) measured MCP idle RSS 31.20 MB, kernel high-water RSS 95.68 MB and MCP search p95 28.71 ms. The three synthetic gates passed. Synthetic 5000-note CLI write p95 was 562.48 ms as a diagnostic; the representative private-vault write gate passed separately (table above). The report's `representativePrivateWrite` field is written by the synthetic harness and stays `unverified` there because private results are kept out of public evidence. The previous complete-core run (idle 29.36 MB, high-water 90.28 MB, search p95 37.03 ms, synthetic write p95 700.09 ms) is preserved as [pre-write-path evidence](evidence/pre-write-path-synthetic-performance.json). The measured snapshot revision is a temporary remote verify commit; the runtime/method digests are checked against the candidate checkout by `bun run release:verify` in tag validation.

The preserved [pre-org baseline](evidence/pre-org-synthetic-performance.json) used Bun 1.4.2, Intel Xeon Platinum 8480CL, a 16-CPU/32GiB container on dgx02. Its MCP idle RSS was 29.36 MB, high-water RSS 91.72 MB and search p95 33.54 ms, passing the synthetic limits 100 MB/200 MB/50 ms. Synthetic CLI write p95 was 693.66 ms over five samples. That diagnostic does not meet 150 ms, and it is not the authorized representative-vault measurement. It cannot be used to mark that private acceptance passed.

The candidate is rebased onto merged org/sync main `70c4e2f`. The earlier [measurement before moving freshness to the release gate](evidence/before-release-gate-split-performance.json) is retained; adding the explicit release command changed package metadata, so a new runtime-bound measurement was recorded. A release must retain the recorded runtime/method digests or repeat the authorized measurement. Preserve the baseline instead of replacing inconvenient values. Missing private data, unsupported YAML, native UI evidence or integration acceptance remains incomplete rather than being inferred from fixture results.

## Scope and reproduction

- Run `bun install --frozen-lockfile && bun run check` on the exact candidate. Ordinary checks include package smoke, evidence shape/sample checks and synthetic parity checks, but do not require historical evidence digests to match current source and do not rerun the 5000-note benchmark. Run `bun run release:verify` explicitly before a release; tag validation requires it.
- Run `bun scripts/release-parity.ts --output <synthetic-evidence.json>` for aggregate fixture proof. Use the two explicit external reference flags to cross-check unchanged Python tools; reference SHA256s are recorded with evidence.
- Run `bun scripts/release-performance.ts --output <synthetic-evidence.json>` serially on dgx02. Do not run it on the Mac or launch a duplicate slow run. The harness only generates/removes its own temporary synthetic vault.
- Reference tools remain installed and unretired. The public corpus and reports contain synthetic data only. Private parity/write evidence must stay in the approved private project location and must not expose note bodies here.
- Native Obsidian acceptance used Obsidian on a Mac with no existing Obsidian profile. The app support folder created by that first launch was removed afterwards; no live vault, settings, templates or self notes were touched.
- Follow [the cutover checklist](cutover-checklist.md) for installation, registration, persistence readback, retirement and rollback. Publication and live cutover remain blocked while any required gate is missing.
