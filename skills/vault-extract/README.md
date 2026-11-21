SKILL.md is the instruction source for this skill. This file is background for maintainers; it holds no directives.

# vault-extract background

## Why the preconditions are strict

- An L02 incident: two notes created by an automated EXTRACT run lacked the required frontmatter fields and were caught only by a later `/vault-lint`.
- An L01 incident: about twenty notes accumulated dead `topics` wiki-links because `topics` was copied verbatim from summary frontmatter without a MOC existence check. The MOC check in the preconditions prevents a recurrence at the write site, and vmem now refuses the same entry (V02).

## Sibling meeting merge rule

The merge-or-split rule for sibling meetings was added after two complementary meeting sources on one initiative were extracted as fragmented notes.

## Change history

- 2026-11-15: Issue #150 aligned meeting frontmatter and extraction handoffs.
  The template lacked extraction-required fields, registry project notes were
  mistaken for MOC topics, and workspace links could be treated as vault links.
  The updated contract separates those namespaces and exposes unresolved
  metadata during review before an extraction proposal is offered.
