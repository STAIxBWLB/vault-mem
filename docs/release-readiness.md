# Release readiness evidence

- Status: incomplete for publication and live cutover. Tooling and synthetic fixture evidence are reviewable; private, native and deployment gates below remain open.
- Contract: [issue #11](https://github.com/STAIxBWLB/vault-mem/issues/11). No package publication, tag creation, host registration or live vault write was performed.
- Runtime and method digests in the raw evidence bind measurements to source bytes. Evidence-only documentation changes do not alter measured runtime; a runtime/method change requires a new measurement.

## Verification record

| Gate | Current evidence | Status |
|---|---|---|
| Strict TypeScript, boundaries, tests, package dry-run | Complete-core dgx02 Bun 1.4.2 gate passed; exact final candidate gate recorded in PR/hub handoff | Final candidate pending |
| Exact-head Linux/macOS CI | Both OS jobs remain in Check; tag workflow validates the triggering commit on both OSes | Hosted candidate result pending |
| Clean installed CLI/MCP | Fresh consumer install of packed tarball, exact installed byte comparison, CLI version/help/create/search, MCP read/tools and stale-fingerprint refusal | Bun and npm tarball installations passed |
| Frontmatter round-trip | Four release fixture notes, original comments/folded descriptions/Unicode retained byte-identically | Provider fixture passed |
| Incremental index vs rebuild | Baseline/create/edit/rename/delete compare notes, FTS and links | Provider fixture passed |
| Two Python parity runs | [External parity record](evidence/external-parity.json), same code/input hashes and two zero-diff rounds | Synthetic passed; private unverified |
| Obsidian properties and links | Deterministic fixture YAML and link resolver tests; no native badge/navigation readback | Native application unverified |
| Consumer graph loading | [Consumer record](evidence/consumer.json), actual Maru enrichGraph module loads emitted fixture and overlays communities | Module readback passed; UI unverified |
| Agent/non-TTY and stale preview | Existing CLI/MCP regression suite plus clean installed package smoke | Candidate suite required |
| Representative private-vault write p95 <150 ms | No authorized representative corpus measurement performed | Unverified |
| npm trust/environment/public package | Workflow authored; no configuration or publication performed | Unverified |
| Reader/host/live writer integration | Separate parent-plan acceptance; no cutover attempted | Unverified |

## Performance record

The [raw synthetic report](evidence/synthetic-performance.json) contains every search/write/RSS sample, runtime/method digests, Bun/kernel/CPU details and container quotas. RSS uses decimal byte thresholds; search p95 is the nearest-rank statistic over 30 measured MCP queries after five warmups, including metadata refresh and transport. The derived index is prebuilt before the MCP process starts.

The complete-core run includes the approved org/sync implementation. It measured MCP idle RSS 29.36 MB, kernel high-water RSS 90.28 MB and MCP search p95 37.03 ms. The three synthetic gates passed. Synthetic CLI write p95 was 700.09 ms; representative private-vault write acceptance remains unverified. The measured snapshot revision is a temporary remote verify commit; the runtime/method digests are checked against the candidate checkout by `bun run release:verify` in tag validation.

The preserved [pre-org baseline](evidence/pre-org-synthetic-performance.json) used Bun 1.4.2, Intel Xeon Platinum 8480CL, a 16-CPU/32GiB container on dgx02. Its MCP idle RSS was 29.36 MB, high-water RSS 91.72 MB and search p95 33.54 ms, passing the synthetic limits 100 MB/200 MB/50 ms. Synthetic CLI write p95 was 693.66 ms over five samples. That diagnostic does not meet 150 ms, and it is not the authorized representative-vault measurement. It cannot be used to mark that private acceptance passed.

The candidate is rebased onto merged org/sync main `70c4e2f`. The earlier [measurement before moving freshness to the release gate](evidence/before-release-gate-split-performance.json) is retained; adding the explicit release command changed package metadata, so a new runtime-bound measurement was recorded. A release must retain the recorded runtime/method digests or repeat the authorized measurement. Preserve the baseline instead of replacing inconvenient values. Missing private data, unsupported YAML, native UI evidence or integration acceptance remains incomplete rather than being inferred from fixture results.

## Scope and reproduction

- Run `bun install --frozen-lockfile && bun run check` on the exact candidate. Ordinary checks include package smoke, evidence shape/sample checks and synthetic parity checks, but do not require historical evidence digests to match current source and do not rerun the 5000-note benchmark. Run `bun run release:verify` explicitly before a release; tag validation requires it.
- Run `bun scripts/release-parity.ts --output <synthetic-evidence.json>` for aggregate fixture proof. Use the two explicit external reference flags to cross-check unchanged Python tools; reference SHA256s are recorded with evidence.
- Run `bun scripts/release-performance.ts --output <synthetic-evidence.json>` serially on dgx02. Do not run it on the Mac or launch a duplicate slow run. The harness only generates/removes its own temporary synthetic vault.
- Reference tools remain installed and unretired. The public corpus and reports contain synthetic data only. Private parity/write evidence must stay in the approved private project location and must not expose note bodies here.
- Native Obsidian acceptance was not claimed: this task does not alter application settings or register/open a new fixture vault in the user's existing profile. The isolated fixture is ready for an authorized native acceptance environment.
- Follow [the cutover checklist](cutover-checklist.md) for installation, registration, persistence readback, retirement and rollback. Publication and live cutover remain blocked while any required gate is missing.
