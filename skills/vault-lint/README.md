SKILL.md is the instruction source for this skill. This file is background for maintainers; it holds no directives.

# vault-lint background

## Origin

The skill implements the lint stage of Karpathy's "LLM Wiki Method": a periodic consistency check over the workspace and the vault that reports problems and leaves fixes to other skills.

## Retired checks

- **L05** was retired on 2026-08-19. Its input, `inbox/INDEX.md`, was replaced by `inbox/_state/index.jsonl` (the intake receipt log), and routing-receipt consistency moved to inbox-intake and inbox-process.
- **L11b** (workspace-graph freshness) was retired on 2026-08-19 because nothing queried that output (the workspace rules directory, `ssot.rules`). The `--work-root` graph build remains available on demand.

## Script history

- On 2026-10-31 `scripts/lint.py` was removed and the vault scope moved to `vmem lint` (STAIxBWLB/skills#88). On the live personal vault both reported the same findings (0 errors, 0 warnings), and vault-mem's parity checks had already compared their finding sets twice on the private corpus. vmem adds L13 (filename), L14 (source paths) and L15 (`confidence: proven` without a `source`). The entries below describe the retired script.
- `scripts/lint.py` parses frontmatter with PyYAML (block sequences, flow arrays, folded scalars). The switch on 2026-08-19 removed the cause of L02 false positives.
- The MOC-only rule for `topics:` (checked by L01) dates from 2026-05-22.
- The script's TYPE lists for L09 carry a keep-aligned comment pointing at the workspace ingest-chain rule, so the rule table and the constants in `scripts/lint.py` change together.
- Measured cost: one script run covered 456 notes in under a second, so the work-scope globbing (L07, L08) dominates run time.

## Why L06 uses a frontmatter marker

`*-summary.md` names are used by inbox-process output and also by human-written retrospectives, reviews, and reference notes (`99-review/`, `06-refs/`, `drafts/`). Treating frontmatter presence as the marker catches real regressions (frontmatter present, required field missing) and leaves hand-written, non-chain summaries out of scope without a path list.

## Why L09 warns only on new violations

`vault/log` is append-only, so past lines cannot be corrected after the fact. Warnings are limited to violations that can still be resolved; legacy TYPEs listed in the normalization table appear as a single information line instead.

## Run cadence

The skill was designed for one `/vault-lint full` run per week and a `/vault-lint vault` run after a large ingest. CI registration is ruled out (see SKILL.md 가드레일) because every run needs local vault access.
