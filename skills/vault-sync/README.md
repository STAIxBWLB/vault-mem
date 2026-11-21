SKILL.md is the instruction source for this skill. This file is background for maintainers; it holds no directives.

# vault-sync background

## Deduplication history

The multi-signal deduplication was revised on 2026-04-16. In that round, `/vault-sync` proposed re-extracting three meetings from 04-14 that were already reflected in vault notes: their `source` fields did not point at the original meeting paths, so the source-field match missed them. Recent update-section detection was added then as a content-level check.

## R4 method evidence update

Step 3.5 (introduced 2026-04-24 as M10) came out of the 2026-04-24 Rethink O2 finding: after four rounds of R4 sibling merges, the method note's evidence table had drifted from the real count (recorded N=5, actual N=13). Updating the table in the same round as the merge keeps the two in step.

## Submodule list

The submodule list is not copied into SKILL.md. `.gitmodules` is the source, and a copy here would drift from it.
