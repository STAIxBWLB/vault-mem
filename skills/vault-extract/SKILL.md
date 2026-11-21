---
name: vault-extract
trigger: /vault-extract
description: Extract insights from a source document into vault notes
---

# /vault-extract [source]

> Before the first vmem call, read `references/vault-adapter.md` §Runtime Discovery and select and bind the vmem vault id; pass it as `vault` on every vmem tool call and as the `<vault>` argument of every `vmem` CLI command.

Extract insights, decisions, observations from a source document and create vault notes.

## Input
- source: path to a source file or a URL

## Preconditions (MANDATORY — enforce before any vault write)

Before writing ANY vault note, verify the source frontmatter (summary or canonical meeting note) has **all three required fields with non-empty values**:

1. **`description`** — string, ≥10 chars, not equal to title
2. **`domain`** — ∈ `{research | projects | teaching | operations | people | ai-practice}`
3. **`topics`** — array containing ≥1 `[[wiki-link]]` **AND every `[[target]]` must be an existing MOC in the bound vault** (MOC enforcement — topics carry hub navigation only, not keyword tags)
   - vmem checks this at write time; `vmem_mocs` lists the existing MOCs when you need to choose one. expect: vmem refuses (V02) a `topics` entry that is not an existing MOC
   - If any `[[target]]` is missing: **ABORT** (do NOT auto-create the MOC) — the caller (or user) must either fix the summary's topics or create the MOC note first
   - Concept/keyword tags (e.g., `credit-recognition`, `partnership-mapping`) belong in body text, NOT in `topics`. Schema is "topics = MOC only" per `vault/AGENTS.md §Schema`.

**Read the supplied summary's frontmatter with a YAML parse BEFORE building the vault note body, regardless of its location.** expect: vmem refuses (V01) a missing `description`, `type` or `domain` and an enum value outside the vocabulary.

If any check fails:
- **ABORT** the extract for this summary
- Emit failed event with `vmem_log_append(type: "EXTRACT", project: <proj>, source: <summary>, note: "failed: <reason>")` (reasons include: `missing required fields: <field list>`, `dead topic: [[<target>]] not in vault/notes/`)
- Return error to caller (`inbox-process`, /vault-sync) — caller decides whether to continue with other items
- **Do NOT synthesize empty values. Do NOT guess. Do NOT proceed to write.**
- User must fix summary.md and re-run. `inbox-process` must re-emit summary with correct fields when the summary came from an inbox item.

## Extraction Fidelity and Concurrent Writers

These rules govern every extraction:

1. **Key facts stay verbatim.** Quote numbers, dates, amounts, contract terms and named obligations exactly as the source states them, with the source path on the same line. Keep analysis in a separate `## Synthesis` section, required whenever the note quotes key facts.
2. **Conflicts stay conflicts.** When two sources disagree on a value, record both values with their sources; `## Synthesis` may say which source is later or more authoritative, and both attributed values remain.
3. **One writer per entity page**, when more than one agent or session writes vault notes in one pass: assign each entity (person, organization, project, document, contract) to one writer, and every other writer links to that page from the notes it owns and writes only the pages it owns. Owners create, or confirm the existence of, their entity pages at the start of the pass, and another writer adds its link only after that create succeeded; vmem refuses a new unresolved wiki link (V03), so until then it records the pending link as plain text in the run output (never as a `[[link]]` in a note), adds it once the target resolves, and reports it as unresolved if the owner's create never succeeds. A non-owner links into an owned page only from its own notes (with `vmem_link(..., bidirectional: false)` or a body link), because the default bidirectional call would write into a page the non-owner does not own; once the other writers finish, each owner (or the session coordinating the pass, if that owner has ended) runs `/vault-connect` on each of its pages another writer linked into, to add the back-links.

## Process

1. Read the source document completely
2. If workspace registry is available, classify the source document's project per `references/vault-adapter.md` §Project Registry Pattern (scoring and fallback); otherwise skip registry classification, report it, and use content-based classification or project `-`.
3. Identify extractable items by domain:
   - research: claims, methods, contradictions, open-questions, tech-trends
   - projects: decisions, rationale, lessons-learned, risks, milestones
   - teaching: pedagogy-insights, curriculum-patterns, student-feedback, course-design
   - operations: policies, process-improvements, resource-decisions, institutional-strategy
   - people: collaboration-patterns, preferences, expertise, relationship-dynamics
   - ai-practice: gap-patterns, effective-prompts, tool-comparisons, workflow-optimizations
4. **Run Preconditions** (see §Preconditions above). ABORT on failure before any write.
5. For each item, create a note in vault/notes/:
   - Filename: prose-as-title (lowercase, hyphens, .md)
   - YAML frontmatter with required fields (`description`, `type`, `domain`, `topics`)
   - **Copy source-derived fields verbatim**: `description`, `domain`, `topics` are copied directly from summary.md frontmatter (verified in preconditions above). See `references/vault-adapter.md` §Summary To Vault Fields.
   - **type remapping**: summary `type` (regulation|report|plan|...) maps to vault `type` (insight|decision|observation|person|project|method|moc|reference) based on semantic intent. Common mappings: report→observation, plan→decision, memo→insight, proposal→decision, regulation→observation, meeting→decision for actual decisions or observation for other meeting insights; `meeting_kind` is descriptive metadata, not a vault type.
   - If registry matched in step 2, follow `references/vault-adapter.md` §Project Registry Pattern for MOC validation; an ordinary `vault_note` never becomes a topic.
   - Set `source` to a real workspace-relative path, URL, or `mem:` id accepted by vmem. For a standalone local file outside a configured workspace, do not invent a workspace path or use an absolute path: use a real stable URL or `mem:` id when supplied; otherwise omit source metadata, use `-` for the log source, and report that provenance is unavailable. Follow the adapter log-field rules. If the source carries backref
     frontmatter (`source_doc`, `meetingSourcePath`, `relatedMeetings`,
     `relatedTasks`), preserve workspace
     origins as plain paths, including body links; retain vault links only
     after resolving them in the bound vault. The same stem in both namespaces
     does not make a workspace link a vault link.
   - Body: the insight with context, with quoted facts and `## Synthesis` placed per §Extraction Fidelity and Concurrent Writers
   - Relevant Notes section with wiki links
   - Topics section with MOC wiki links
6. **Pre-validate, write, and read the receipt** (MANDATORY):
   a. `vmem_check(path: "notes/<stem>.md", text: <the full note text>)` validates the prospective note without writing, so an invalid frontmatter (V01), a `topics` entry that is not an existing MOC (V02), a new unresolved wiki link (V03) and secret-looking text (V06) cost no write. It does not see a stem collision; only the create does.
   b. Duplicate check: `vmem_brief(intent: "<title> <description>", paths: ["<source work file>"], bytes: 1024)`. `paths` only adds the file's basename words to the ranked terms (a hint, not a citation filter), so also confirm a pointer with `vmem_search`. A pointer that is already this insight is a merge, not a second note: run `vmem_merge(keep, absorb)` as a preview, then confirm it with the fingerprint.
   c. Create with `vmem_create(stem, type, domain, topics, description, source, body, log: {type: "EXTRACT", project, source, dest: "notes/<stem>.md", note: "<type>"})`. Omit the note `source` argument when no valid reference exists; set `log.source` to `-` in that case. vmem validates the full frontmatter before it saves, so a stripped or invalid note is never written.
   d. Read the whole receipt. `possibleDuplicates` is a warning, not a refusal: the note was written, and vmem lists the notes whose indexed title terms match it (V08 at warning severity). Surface that list with the merge option (keep the existing note, absorb the new one) or keep both and link them — never write a second copy of the same insight. The hard V08 (`same stem or normalized H1 already exists`) is the refusing form and stops before anything is written. `ok: false` with `applied: false` wrote nothing: record `failed: <issue codes>` with `vmem_log_append` and return the issues. `ok` false with `applied: true` persisted: reconcile per `references/vault-adapter.md` §Write results.
   e. expect: vmem refuses the V01/V02/V03/V06 issues `vmem_check` reports, V08 on a duplicate stem or normalized H1, and V09 on a note over 256 KiB; `vmem_merge` refuses two notes of different types, a person or MOC note, and a merged result over the size bound. Report the named issues; never retry with guessed values.
7. After creating notes, invoke /vault-connect with entities hint (from summary.md):
   - Read `entities` field from source summary.md (if present — list of 인물/기관 names)
   - Pass entities list to `/vault-connect` as wiki-link candidate seeds (`entities_hint` parameter)
   - `/vault-connect` uses entities to prioritize wiki-link discovery in its first pass
   - **Note**: `keywords` field is NOT carried forward to vault notes — it exists only for route scoring reproducibility
8. **EXTRACT event in vault/log** (ingest chain audit trail) comes from the step 6 `log` argument

## Log Append (Step 8 — REQUIRED)

Every note created or updated by /vault-extract must produce one `log` line. `vmem_create` writes it from its `log` argument. An update (`vmem_patch` / `vmem_append`) records a default EXTRACT line; when the contract needs the `updated: <type>` note text, pass it as that write's `log` argument. Failures use `vmem_log_append`. Never append to the log file directly.

**Format** (`references/vault-adapter.md` §Log Append):

```
YYYY-MM-DD HH:MM  EXTRACT  <project>  <source> → <vault/notes/x.md>  — <type>
```

- `<source>`: real workspace-relative source path, URL or `mem:` id as described above; use `-` when no valid reference is available, never invent a workspace path
- `<vault/notes/x.md>`: newly created note path (use `notes/x.md` form)
- `<type>`: note type (`insight | decision | observation | person | project | method | moc | reference`)

**Multiple notes from single source**: one log line per note created.

**Update vs create**: for updates, use `— updated: <type>` to distinguish.

**Failure**: `references/vault-adapter.md` §Log failure handling.

**Vault access**: use vmem through the transport in the adapter; no direct vault writes. No filesystem Write/Edit on vault paths.

## Sibling Meeting Merge Rule

복수 회의 소스(같은 프로젝트·같은 날·보완적 관점)를 **단일 vault 노트**로 merge할지, **분리**할지 결정:

**Merge 조건 (모두 충족 시)**:
1. 같은 이니셔티브/프로젝트 (registry score 동일 결과)
2. 같은 날 또는 ±1일 이내
3. 보완적 관점 (한쪽이 다른 쪽의 전제·후속·다른 stakeholder view)
4. 각 회의만으로는 독립된 vault 노트로 composability 성립 안 함

**분리 조건 (하나라도 해당)**:
- 서로 다른 프로젝트/도메인
- 동일 주제의 **독립 의사결정** 또는 시간 간격 ≥7일
- 각 회의 독립 composability 성립 (각자 "This note argues that ..." 문장 성립)

**Merge 시 구조**:
- 단일 frontmatter `source`는 **주도 회의** 하나 경유
- 본문에 `## Update (YYYY-MM-DD, AM/PM): 출처: ...` 형태로 **각 회의 출처 명시**
- EXTRACT 로그는 **노트당 1줄** + 회의 각각 별도 `SOURCE`로 기록

**Purpose**: prevent fragmented notes when two source documents describe the same initiative from complementary perspectives.

## Quality Gates

- description must add information beyond the title (max 200 chars)
- Composability test: "This note argues that [title]" must make sense
- Each note must link to at least 1 domain MOC
- source field must be set when a valid reference is available; otherwise report the missing provenance
- **EXTRACT event appended to log for every created/updated note**

## Output
- List of created notes with descriptions
- Count of log lines appended
- Suggestion to run /vault-connect on new notes
