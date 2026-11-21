---
name: vault-connect
trigger: /vault-connect
description: Find and create wiki link connections between vault notes
---

# /vault-connect [note]

> Before the first vmem call, read `references/vault-adapter.md` §Runtime Discovery and select and bind the vmem vault id; pass it as `vault` on every vmem tool call and as the `<vault>` argument of every `vmem` CLI command.

Find relationships between a note and existing vault notes, create wiki links.

## Input
- note: filename or path of a note in vault/notes/
- entities_hint (optional): list of 인물/기관 names from source summary.md — used as wiki-link candidate seeds in step 2 first pass

## Process

0. **Candidate pre-fetch through vmem** (never a graph-report or `vault-graph.json` read):
   a. `vmem_brief(intent: "<target note title> <description>", bytes: 2048)` returns screened pointer lines `notes/<path> | title | type | description` — no note bodies — with one-hop rows marked `[neighbor]`, so this is the cheap first pass.
   b. `vmem_graph_neighbors(path: "<stem>", hops: 1)` returns the note's community and its one-hop neighbours (each node carries `community` and `degree`, so rank by degree); widen with `hops: 2` or narrow with `relation` (`wiki_link` or one typed relation). expect: vmem refuses `hops` outside 1–2, a `limit` outside 1–500, an unknown `relation` and an unknown note.
   c. Obsidian Smart Connections 플러그인이 활성 상태면 대상 노트의 semantic neighbors 상위 5개를 추가 연결 후보로 포함 (키워드 매칭으로 놓치는 cross-domain 연결 보완)
   d. 위 후보를 Step 2의 검색 결과와 병합 (중복 제거)
1. Read the target note completely (`vmem_read`); `vmem_links(path, direction: "in", limit: 200)` lists its in-links, and each in-link that lacks a back-link is a link candidate for step 3. A full page of 200 may be cut off: then report this page's back-link check as incomplete.
2. Search vault/notes/ for related notes by:
   - **entities_hint first pass** (if provided): for each entity name, run `vmem_brief(intent: "<entity>", bytes: 1024)` and confirm a hit with `vmem_search`; its pointers already cover `glossary`, `people` and note titles, so no manual grep of those notes. These are highest-priority link candidates since they're pre-identified by summaries or source metadata.
   - **Backref seeds** (if present in target frontmatter): `relatedMeetings`, `relatedTasks`, `source_doc` / `meetingSourcePath` are pre-identified origins — treat their resolved `[[targets]]` as high-priority bidirectional link candidates.
   - Title keyword matching
   - Description similarity
   - Shared topics/MOCs
   - Same domain or cross-domain relevance
   - Project affinity via registry: if source is from work/, classify it per `references/vault-adapter.md` §Project Registry Pattern (scoring and fallback), then prioritize sibling notes sharing the same `vault_note` topic as connection candidates
3. For each discovered relationship:
   - Determine relationship type (supports, contradicts, extends, applies-to, context-for)
   - **Existing short path**: when the proposed link joins two notes that already sit close together, read `vmem_graph_path(from: "<x>", to: "<y>", maxHops: 3)` and show the hops beside the proposal (`x -[supports]-> m -[context-for]-> y`, 2 hops), in the same step and with no extra approval gate. `found: false` means no short route to show (raise `maxHops` to 6, or set `viaHubs` for a route through a MOC).
   - `vmem_link(from, to, relation, context, log: {type: "CONNECT", project, source: "notes/<x>.md", dest: "notes/<y>.md", note: "linked [[y]] (<relation>)"})` adds the typed link to both notes (bidirectional by default) and skips a side that already links the target; `from` is always a note this run owns or stands in for (vmem_link always writes `from`); when `to` is a page another writer owns, pass `bidirectional: false` and let its owner add the back-link, per `/vault-extract` §Extraction Fidelity and Concurrent Writers rule 3
   - expect: vmem refuses a relation outside `supports | contradicts | extends | applies-to | context-for` and an unknown or ambiguous note; an already-linked pair returns `unchanged: true`
4. Update relevant MOCs if new connections span topics (`vmem_append` into the MOC's list section)
5. **CONNECT events in vault/log** come from each `vmem_link` call (ingest chain audit trail)
6. Report connections made and any cross-domain patterns discovered

## Log Append (Step 5 — REQUIRED)

Every wiki link /vault-connect creates produces one `log` line, written by `vmem_link` itself; set its content with the `log` argument. `vmem_link` links one `from` to one `to`, so one call writes one line naming that one target: a note that gains three links takes three calls and three lines. Never append to the log file directly.

**Format** (`references/vault-adapter.md` §Log Append):

```
YYYY-MM-DD HH:MM  CONNECT  <project>  <vault/notes/x.md>  — linked `[[a]]`
```

- `<project>`: project id from the target note's source registry classification, or `-` if unclassified
- `<vault/notes/x.md>`: the `from` note this call linked from (vmem uses it as the line's source even when the link is bidirectional)
- `[[a]]`: the one target this call linked

**No connections made**: no line is written (an `unchanged: true` link writes nothing). Report zero-connection runs in chat output instead.

**Bidirectional links**: a bidirectional `vmem_link` call updates both notes, and a `bidirectional: false` call updates only `from`; each call writes one line.

**Failure**: `references/vault-adapter.md` §Log failure handling, per link; keep the links that succeeded.

**Vault access**: use vmem through the transport in the adapter; no direct vault writes.

## Quality Gates

- Every connection must have stated reasoning
- Bidirectional: if A links to B, B should link to A, except a link this run wrote with `bidirectional: false` (step 3)
- Don't force connections — quality over quantity
- **CONNECT event appended to log for every run with ≥1 link created**

## Output
- List of connections made with reasoning
- Cross-domain patterns noted (if any)
- Updated MOCs (if any)
- log append status
