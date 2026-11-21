---
name: vault-learn
trigger: /vault-learn
description: Query→Wiki 환원 — research a topic (or promote a conversation answer) into vault with user approval gate and LEARN event logging
---

# /vault-learn [topic]

> Before the first vmem call, read `references/vault-adapter.md` §Runtime Discovery and select and bind the vmem vault id; pass it as `vault` on every vmem tool call and as the `<vault>` argument of every `vmem` CLI command.

Promote a research finding or conversation answer into the vault graph **only after explicit user approval**. Implements the Query→Wiki 환원 루프 defined in `vault/AGENTS.md` §"Query → Wiki 환원 루프".

**Not for**: observations about how the vault/methodology itself is working (friction, surprises, process notes) — those go to `ops/observations/` via `/vault-remember` (no approval gate, no LEARN line; they feed `/vault-rethink`). `/vault-learn` writes knowledge into `notes/`.

## When to invoke

1. **Automatic trigger**: user question required cross-referencing 2+ work/ files and synthesizing a conclusion
2. **Manual trigger**: user says `/vault-learn` or `$learn` to promote the current conversation
3. **Research trigger**: user says `/vault-learn <topic>` to initiate web research + vault promotion

## Input
- topic: subject to research or promote (optional if current conversation context is the source)

## Process

### Step 1: Source gather
- If research mode: WebSearch / WebFetch the topic, collect primary sources
- If conversation mode: collect the question, the files cross-referenced, and the synthesized answer

### Step 2: Vault duplicate check
- `vmem_brief(intent: "<topic> <key terms>", paths: ["<work file or the source of the answer>"], bytes: 1024)` — screened pointer lines over titles, descriptions and types; `paths` adds the file's basename words to the ranked terms (a hint, not a citation filter)
- `vmem_search(query: "...")` on the topic + key terms to confirm a pointer, and `vmem_read(path: "glossary", section: "<term>")` for a term collision
- A pointer that already carries this insight makes the proposal an UPDATE (Option B) or a `vmem_merge`, not a new note

### Step 3: Propose (user approval gate — MANDATORY)
Present a proposal block:
```
LEARN PROPOSAL
==============
topic: <topic>
type: insight | observation | decision
domain: research | projects | teaching | operations | people | ai-practice
confidence: experimental (new research, default) | likely (consensus) | proven (verified sources) — schema values only (vault/AGENTS.md §Schema)

Option A (NEW note):
  - path: notes/<kebab-case-stem>.md (lowercase letters, digits, hyphens)
  - description: <one-line>
  - topics: [[<moc>]]
  - source: <url | work/ path | conversation:<date>>

Option B (UPDATE existing):
  - path: notes/<existing-note>.md
  - change: <add wiki-link to [[new-term]] + 1 paragraph>

Option C (PROMOTE an agent-mem entry):
  - candidate: mem:<id> — <title> (kind, project), from `amem_vault_candidates`
  - path: notes/<kebab-case-stem>.md (prefilled from the entry: title → H1 and stem, text → body)
  - source: mem:<id> (the confirm writes `promoted_from: mem:<id>` and the back-link itself)

Accept: [a] new, [b] update, [c] promote, [s] skip, [q] quit
```

**Do NOT write to vault without explicit accept.** If user skips, append `— proposed, skipped` LEARN line anyway (see Step 6).

### Step 4: Execute (on accept)
- New note: `vmem_create(stem, type, domain, topics, description, confidence, source, body, log: {type: "LEARN", project, source, note: "promoted: <type>"})`
- Update: `vmem_patch(path, oldString, newString, expectedSha, log)` or `vmem_append(path, section, markdown, log)` with `log: {type: "LEARN", project, source, dest, note: "updated: <title>"}`
- Promote an agent-mem entry (Option C): list candidates with `amem_vault_candidates` (CLI `amem vault-candidates`), then call `vmem_promote_from_amem(id: "mem:<id>", stem, type, domain, topics, description, body, project)` for the preview — full note text, the possible duplicates and a fingerprint — and confirm with `vmem_promote_from_amem(..., confirm: true, fingerprint)`. A listed duplicate is not a refusal: the preview carries `choices` (`create` or `link-existing <path>`), so pick one before confirming, or pass `linkTo` to link an existing note instead of creating one. That confirm creates the note, writes `promoted_from` and its back-link, and records the `LEARN  <project>  mem:<id> → notes/<stem>.md  — promoted: <kind>` line itself; pass no `log`, and add none afterwards. expect: vmem refuses a stale fingerprint, and a `stem`, `type` or `domain` outside the schema; an existing stem or the same normalized H1 (hard V08) makes the preview `ok: false`, so change the stem or H1 before confirming
- Body: atomic insight, context, relevant notes section
- expect: vmem refuses a missing or duplicated note field, a `confidence` outside the schema, a `topics` entry that is not an existing MOC, a new unresolved wiki link and secret-looking text; report the named issues instead of retrying with guessed values

### Step 5: Connect
- Call `/vault-connect note=<new-note>` to wire wiki-links (delegates log append to /vault-connect for CONNECT event)

### Step 6: LEARN event in vault/log

Always record one LEARN line — even when user skips — so the query history is preserved. A Step 4 create or update records it through its `log` argument, and an Option C promotion records its own `LEARN  mem:<id> → notes/<stem>.md` line on confirm, so add none for either; for `proposed, skipped` and `failed: <reason>` call `vmem_log_append(type: "LEARN", project, source, dest, note)`. Never append to the log file directly.

**Format**:

```
YYYY-MM-DD HH:MM  LEARN  <project>  <source> → <vault/notes/x.md>  — <note>
```

- `<source>`: `query` (conversation origin), `url:<hash>` (web research), or `work/<path>` (file cross-ref)
- `<note>`: one of
  - `promoted: <type>` (new note created)
  - `updated: <title>` (existing note updated)
  - `proposed, skipped` (user declined the proposal)
  - `failed: <reason>` (write error)

**Vault access**: use vmem through the transport in the adapter; no direct vault writes.

## Quality Gates
- Each promoted note must be a single atomic insight (composability test: "This note argues that [title]")
- Source must be recorded (`source:` frontmatter for notes; `— <source>` column in log)
- Confidence field required; default `experimental` for new research
- Must link to at least 1 existing note or MOC
- **User approval is non-negotiable** — never auto-promote

## Output
- Research/conversation summary
- Proposal block (Step 3)
- On accept: created/updated note path + /vault-connect result
- LEARN event confirmation (log append status)

## Related

- `vault/AGENTS.md` §"Query → Wiki 환원 루프" — the policy
- `references/vault-adapter.md` §Log Append — log line format
- `/vault-extract`, `/vault-connect` — downstream skills invoked in steps 4-5
