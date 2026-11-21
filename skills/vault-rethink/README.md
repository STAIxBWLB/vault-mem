SKILL.md is the instruction source for this skill. This file is background for maintainers; it holds no directives.

# vault-rethink background

## Retired aging check

An earlier review step checked inline task aging and warned at a reminder-file cap. Inline tasks later moved to the workspace task files, so the step had nothing left to measure and was removed.

## Skill list source

Drift mode used to carry a hardcoded list of the vault skills to audit. The list now comes from the bundle's `SKILL_INDEX.md` "Vault workflows" line, so adding, merging or removing a skill needs no edit here.

## Rename workflow

Note renames moved into `/vault-refactor rename` after a rethink round found manual renames leaving stale references.
