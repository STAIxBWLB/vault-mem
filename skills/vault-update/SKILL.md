---
name: vault-update
trigger: /vault-update
description: Refresh an outdated note with new context while preserving core insight (via vmem)
---

# /vault-update [note]

> Before the first vmem call, read `references/vault-adapter.md` §Runtime Discovery and select and bind the vmem vault id; pass it as `vault` on every vmem tool call and as the `<vault>` argument of every `vmem` CLI command.

Update a note with new information while preserving original meaning. This is the single-note leaf; batch discovery of notes that need updating is `/vault-sync` (its "update" proposals run this procedure). Every update follows `/vault-extract` §Extraction Fidelity and Concurrent Writers, and step 3 applies its rules to a revision.

## Input
- note: filename or path in `notes/`

## Process

1. Read target note via `vmem_read` (keep its `sha256` for `expectedSha`)
2. Identify what's changed (new context, superseded info, additional evidence)
3. Draft the update:
   - preserve core insight
   - add new content in an explicit section (e.g., `## Update YYYY-MM-DD`) OR inline-revise with preservation: a revised value that came from a source keeps the earlier value and its source beside it, e.g. `amount 3,000,000 (source: work/<contract>.md); revised 4,000,000 (source: work/<minutes>.md)`
4. Apply via vmem:
   - minor edit → `vmem_patch(path, oldString, newString, expectedSha)`
   - new section → `vmem_append(path, section: "Update YYYY-MM-DD", markdown)`
   - major rewrite → there is no overwrite tool: patch section by section, or create a replacement note with `vmem_create` and retire the old one with `vmem_supersede(old, next)`
   - the new information duplicates another note → do not update into a copy: offer `vmem_merge(keep, absorb)` at the approval gate, preview first and confirm with the fingerprint; it unions source and topics and repoints inbound links itself
   - frontmatter change → `vmem_set_frontmatter(path, set, unset, expectedSha)`
   - expect: vmem refuses a stale `expectedSha`, an invalid frontmatter value, a new unresolved wiki link, an edit inside `## Topics`, and a `vmem_merge` of different types, a person or MOC note, or an oversized result
5. Check connected notes (via `vmem_links(path)` and `vmem_brief(intent: "<title> <description>", bytes: 1024)`); propose cascading updates if needed
6. Record update in note body (timestamp or changelog line)
7. Run `/vault-lint note=<path>` on the updated note; `--note` is CLI-only, so an MCP-only run finishes with one vault-wide `vmem_lint` instead
8. vmem logs every write with a default `EXTRACT` line; when wiki-links changed, pass `log: {type: "CONNECT", ...}` on the write that changed them (see §Log Append)

## Vault Access

Use vmem through the transport in the adapter. No filesystem Read/Write/Edit on vault paths. Use:

| Operation | vmem tool |
|-----------|---------|
| Read | `vmem_read` |
| Full rewrite | section `vmem_patch` calls, or `vmem_create` + `vmem_supersede` |
| Append | `vmem_append` |
| Targeted edit | `vmem_patch` |
| Frontmatter and tags | `vmem_set_frontmatter` |
| Search for impact | `vmem_links`, `vmem_search` |

## Quality Gates

- Original insight must be preserved OR explicitly superseded with `status: superseded` frontmatter + link to replacement note
- All existing wiki-links must remain valid
- New wiki-links added where relevant
- Changelog/timestamp line appended to body when content changes materially

## Log Append

Each vmem write records exactly one line: its default `EXTRACT` event, or the event the call passes in `log`. Nothing suppresses it, so a body-only edit is logged too and is never silent. When the edit adds or removes a wiki link or MOC membership, pass `log: {type: "CONNECT", project, source: "notes/<note>.md", dest, note: "updated: <summary>"}` on the write that changed them:

```
YYYY-MM-DD HH:MM  CONNECT  <project>  notes/<note>.md  — updated: <summary>
```

## Output

- Summary of changes made
- Connected notes reviewed (and any cascading proposals)
- note-level `/vault-lint` result
- log append status (if applicable)
