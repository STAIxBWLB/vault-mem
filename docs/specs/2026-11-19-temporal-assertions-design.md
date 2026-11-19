---
id: temporal-assertions-design
type: architecture
title: Temporal assertions design
status: active
paths:
  - src/assertions.ts
  - src/assert-command.ts
  - src/assertion-index.ts
  - src/assertion-policy.ts
  - src/assertion-read.ts
  - src/assertions-command.ts
  - test/assertions.test.ts
  - test/assertion-index.test.ts
  - test/assertion-policy.test.ts
  - test/assertion-read.test.ts
  - test/assertion-evidence-budget.test.ts
  - test/fixtures/temporal-design
---

# Temporal assertions design

Status: accepted on 2026-11-19. The owner selected alternative C and answered O2 to O6 (issue 237 D5); the answers are under Owner decisions. The independent read-only review (issue 237 D4) took place on PR 244 before merge.

- Contract: issue 237 in STAIxBWLB/vault-mem, parent plan issue 232.
- Read contracts reviewed: issue 233 (evidence anchors) and issue 235 (Git snapshot history). Issue 233 is implemented in PR 243 (merge 32495c0, `src/evidence.ts#verifyEvidenceEntry` verifies one entry independent of a note). Issue 235 was treated here as a proposed contract; it merged later in PR 245 (7abe644).
- Source read: `src/` at commit 53ac9af for the writer, index, log and snapshot contracts; `src/` was unchanged between 9a789a8, the commit issue 237 cites, and 53ac9af. `src/evidence.ts` and `src/source.ts` were read at 24cdd49 (main after PRs 243, 241, 246 and 248), where the cited writer, validation and log symbols still exist.
- Concept reference: the Utopia time design pinned by issue 237 (commit 4fec6cb).
- Implementation: issue 249 (P2, `vmem sync` staging), issue 250 (journal, write contract, evaluation, `vmem assert`), issue 251 (`vmem assertions`, derived index, read-time policy) and issue 252 (purge).

## Summary

- Recommend alternative C: a vmem-owned, append-only assertion journal in the vault with a derived SQLite index, limited to manually authored, evidence-backed state and event assertions.
- C is the only alternative whose record-time (`as_of`) answers come from a store that vmem appends to and can check for tampering. A cannot answer `as_of`. B keeps record time in note fields that any editor can change or delete without a trace.
- C is gated on prerequisites P1 to P3 below: issue 233 implemented, `vmem sync` staging the journal, and owner acceptance of a second vmem-owned file area in the vault beside `log`.
- If the owner declines C, keep snapshot history only (alternative A over issue 235). The missing prerequisite is then a vmem-owned, append-only, tamper-evident record-time store in the vault.

## Boundaries

- Three domains stay separate (issue 237 decision):
  - Note change history: what a note file contained at a Git commit (issue 235).
  - World time: when an asserted state held or an event occurred, read through `at`.
  - Record time: when this vault's journal recorded a revision of an assertion, read through `as_of`.
- In scope: manually authored assertions with an explicit subject, relation and value, plus evidence references.
- Out of scope (issue 237): automatic extraction, LLM calls, embeddings, PostgreSQL, OWL/SPARQL, inference, entity resolution, retroactive fabricated history, workspace or vault policy changes, deployment.
- Never used as world time or record time: note `created`/`updated`, file mtimes, Git author or committer dates, `confidence`, graph `confidence_tag`.

## Current time guarantees

What the code does at 53ac9af, cited as file#symbol.

- Note dates
  - `src/write-operations.ts#stampNoteContent` sets `updated` to the writer's date on authored writes and sets `created` on create only when the author did not supply one. A header it cannot rewrite losslessly stays unstamped, with a warning.
  - `src/write-operations.ts#stampContentChanges` skips `check`, `report`, `move`, `tidy` and `sanitize`, and for a merge stamps only the keep and absorb notes. `supersede` and `merge` stamp `updated` like any authored write.
  - `src/local-date.ts#localDate` produces a local calendar date with no time zone.
  - Meaning: `created`/`updated` say when a vmem write touched the note, or what an author typed. External edits do not update them, and any editor can change them.
- Frontmatter schema
  - `src/write-validation.ts#KEYS` is a closed key set with no validity-interval or record-time field. Its date-like keys (`decided_at`, `last_contact`, `received`, `promoted_at`, `year`) describe notes or documents.
  - `src/write-validation.ts#schema` refuses a newly introduced unknown key or note type (V01); `src/write-validation.ts#schemaIssues` downgrades unchanged legacy findings to warnings.
  - `src/write-validation.ts#CONFIDENCE` (`proven`, `likely`, `experimental`) is an epistemic label on a note. It carries no time.
  - `src/frontmatter.ts#parseFrontmatter` uses Bun YAML, which parsed an unquoted `2026-04-01` as a string in a local check with Bun 1.4.4.
- Note identity and relations
  - `src/write-operations.ts#notePath`: identity is the flat path `notes/<slug>.md`. There is no stable note id.
  - `src/write-operations.ts#planOperation`: `move` rewrites references to the new path, `delete` removes the file, and `supersede` calls `src/write-operations.ts#supersededNote`, which sets `status: superseded` and `superseded_by` with no date, then appends a `Supersedes` line to the newer note.
  - `src/write-operations.ts#planMerge` keeps both files, marks the absorbed note superseded and unions `source` and `topics`.
- Writer and receipts
  - `src/writer.ts#applyWrite` is the single note mutation path: exclusive `mutation.lock`, snapshot, validation, date stamping, revalidation, staged rename publication, rollback on failure, index refresh, then a log append whose failure (LOG_IO) does not undo the write.
  - `src/writer.ts#snapshot` reads only flat `notes/*.md`, at most 10000 notes, and refuses denied note paths.
  - `src/writer.ts#receipts` returns per-file before and after SHA-256 values to the caller. vmem does not persist receipts.
- Log
  - `src/log-format.ts#formatLogEvent` writes minute-precision local time with no zone, and note-level fields only (type, project, source, dest, note).
  - `src/vault-log.ts#appendLog` appends one line with `O_APPEND` under a cooperative lock and truncates a short write. It is the existing precedent for a vmem-owned append-only file in the vault.
- Derived index
  - `src/vault-index.ts#VaultIndex` is a cache under `<VMEM_HOME>/indexes/`, named per `LINK_RESOLUTION` and `INDEX_SCHEMA`, holding current note files only. `src/vault-index.ts#VaultIndex.scan` with `rebuild` reconstructs it from files.
  - `src/vault-index.ts#VaultIndex.list` exposes each note's file `mtime`, read from the stat stamp by `src/vault-index.ts#stampMtime`.
  - `src/vault-index.ts#VaultIndex.show` returns stored note bytes, including frontmatter `source` values, without re-screening them against current `denyPaths`.
- Sources and policy
  - `src/source.ts#sourceReferences` accepts path, `mem:` and URL references, with no version, hash or time. `src/source.ts#missingSourceWarnings` checks path existence at write time only.
  - `src/write-validation.ts#validateChanges` refuses a denied `source` at write time (V06), using the current config through `src/platform.ts#isDenied` (re-exported from agent-mem).
- Sync and Git
  - `src/sync.ts#syncVault` is an explicit preview and confirm step. It stages only `STAGE_PREFIXES` (`notes/`, `reports/`) and `STAGE_FILES` (`log`), commits all pending changes in one commit, and rebases onto the upstream when behind.
  - A commit therefore marks when a sync ran, not when an edit happened or a fact was learned. A rebase replaces committer dates.
- Graph
  - `src/vault-graph.ts#GraphEdge` carries a constant `confidence_tag: "EXTRACTED"` and `confidence: 1`. They label how an edge was extracted and carry no time and no truth value.

Not guaranteed today:

- No assertion-level record, no validity interval, no record-time history.
- No note history beyond what the owner committed through Git. Uncommitted and externally edited intermediate states are not kept.
- No read-time re-screening of stored `source` values after the policy becomes stricter.

## Synthetic corpus and answer key

Subjects `s:person-a`, `s:person-b`, `s:person-c` and organizations `org-x`, `org-z` are synthetic. Recorded times are UTC instants assigned by the writer clock at append. Valid dates are civil dates.

| Entry | Recorded at (UTC) | Content |
|---|---|---|
| E1 | 2025-09-02T09:00:00Z | batch: declare subject person-a; assert A0: person-a `role` = member, from 2025-09-01, to open |
| E2 | 2026-04-10T09:00:00Z | batch: revise A0 to 2026-04-01; assert A1: person-a `role` = lead, from 2026-04-01, to open |
| E3 | 2026-05-02T09:00:00Z | batch: revise A1 from 2026-03-28; revise A0 to 2026-03-28 |
| E4 | 2026-05-10T09:00:00Z | batch: declare subjects person-b and person-c; A3 person-b `member-of` = org-x, from unknown, to 2026-06-01; A4 person-b `role` = editor, from 2026-01-15, to unknown; A5 person-b `location` = city-y, from 2026-02-01, to open; A6 person-c `joined` = org-z, event on 2026-03; A7 person-c `member-of` = org-z, from 2026-03-01, to 2026-04-01 |
| E5 | 2026-06-01T09:00:00Z | batch: A8 person-a `team` = platform, from 2026-05-01, to open; A9 person-a `team` = research, from 2026-05-15, to open, with different evidence |

A state answer says whether the state held on `at`. An event answer says whether the event occurred on or before `at`. Each answer is `yes`, `no` or `unknown`.

Scenario 1, late recording:

- Q1 `at=2026-04-05`, `as_of=2026-04-06`: role = member (A0 revision 1 answers yes). E2 is not yet recorded.
- Q2 `at=2026-04-05`, `as_of=2026-04-11`: role = lead (A1 revision 1 answers yes; A0 revision 2 answers no). Q1 and Q2 differ only in `as_of`.
- Q3 `at=2026-04-01`, `as_of=2026-04-11`: lead. `from` is inclusive and `to` exclusive, so the two revisions do not overlap on the change day.
- Q4 `at=2026-04-05`, `as_of=2026-04-10` (a date): lead, because a date covers the whole UTC day. With `as_of=2026-04-10T08:59:59Z`: member.
- Q5 `at=2026-04-05`, `as_of=2025-09-01`: no items, coverage `before_first_entry`. Empty means nothing was recorded, not that no role held.

Scenario 2, correction:

- Q6 `at=2026-03-30`, `as_of=2026-04-11`: member (A0 revision 2 runs to 2026-04-01).
- Q7 `at=2026-03-30`, `as_of=2026-05-03`: lead (A1 revision 2 runs from 2026-03-28; A0 revision 3 answers no).
- Q8 history of A1: revision 1 (from 2026-04-01, recorded 2026-04-10T09:00:00Z, replaced 2026-05-02T09:00:00Z) and revision 2 (from 2026-03-28, recorded 2026-05-02T09:00:00Z, current). Both remain readable, so the earlier belief stays distinguishable.

Scenario 3, precision and unknown bounds, `as_of` omitted:

| at | A3 unknown start | A4 unknown end | A5 open end | A6 event, month precision | A7 interval covering March |
|---|---|---|---|---|---|
| 2026-01-15 | unknown | yes | no | no | no |
| 2026-03-15 | unknown | unknown | yes | unknown | yes |
| 2026-04-15 | unknown | unknown | yes | yes | no |
| 2026-06-15 | no | unknown | yes | yes | no |

- A4 and A5 differ on every day after 2026-01-15: an unknown end is not an open end.
- A6 and A7 differ on 2026-03-15 and 2026-04-15: a month-precision event is not the month-long interval.
- A3 never answers yes: without `held_on`, an unknown start is never known to precede `at`.

Scenario 4, coexisting values:

- Q9 `at=2026-05-20`, relation `team`: A8 platform (yes) and A9 research (yes) are both returned with one overlap group `{subject: s:person-a, relation: team, ids: [A8, A9], size: 2}` when they fit on one page. No winner is chosen.
- Q10 `at=2026-05-10`: A8 yes, A9 no, no overlap.

Scenario 5, coverage under the recommendation (A and B are in the coverage matrix):

- Uncommitted: an appended entry answers immediately. The response counts journal files with changes not yet synced. Losing the vault directory before a sync loses those entries.
- Deleted evidence note: evidence status `unavailable`. The assertion is still returned as a recorded claim.
- Renamed or merged subject note: answers do not change, because subject ids do not depend on paths. The subject's note link reports `missing`, or `superseded` with the current `superseded_by` value.
- Assertion removal: `retract` excludes it for every `as_of` at or after the retraction; `purge` removes its payload and leaves a verifiable tombstone.
- SQLite cache deleted: a rebuild returns identical answers to Q1 through Q10.
- External edit of a journal line: that line and every later line of the same file are reported `untrusted` and excluded.

Scenario 6, current policy and evidence:

- Evidence whose source matches current `denyPaths` returns `{status: withheld, reason: denied_by_current_policy}` with no path, quote or hash, whatever policy applied when it was recorded.
- Evidence whose source was deleted or purged returns `unavailable`. The SHA-256 stored at record time is never presented as proof of what the source said.
- A denied journal path refuses the whole read (V06), as a denied `log` path does.

## Alternatives

### A: documentation conventions plus Git snapshot reads

- Source of truth: notes as today. Assertions are prose by convention, for example a dated bullet that cites its source. History comes from commits through issue 235.
- Obsidian edits: unrestricted. An edit becomes history only when a sync commits it.
- Schema compatibility: no change.
- Persistence and backup: Git after `vmem sync`. Uncommitted states never become history.
- Atomicity and recovery: per write, as today. History granularity is one sync commit.
- Identity through move, merge and delete: exact path only. Issue 235 does not follow renames and reads merges first-parent; deleted notes stay readable at older commits.
- Export and rebuild: Git is the store; there is nothing derived to rebuild for history.
- Limit: issue 235 rules out an `as_of` API and any timestamp-based truth claim, and prose bounds are not machine-checked.

### B: temporal metadata on separate assertion notes

- Source of truth: one note per assertion revision, for example:

```yaml
---
type: assertion
description: person-a role, revision 2 after the March correction
subject: "[[person-a]]"
relation: role
value: lead
valid_from: "2026-03-28"
valid_to: open
recorded: "2026-05-02T09:00:00Z"
revises: "[[a-person-a-role-1]]"
source: notes/meeting-2026-05-01.md
topics: ["[[people]]"]
---
```

- Schema compatibility: needs a new `assertion` type and new keys in `src/write-validation.ts#KEYS`. Every revision must still satisfy description, topics (V02) and Topics placement (V05). Older vmem versions report the unknown type and keys as retained warnings through `src/write-validation.ts#schemaIssues`, so they can still edit these notes.
- Obsidian edits: assertions are visible and editable as properties. For the same reason `recorded`, `valid_from` and `revises` can be changed in place, or the file deleted, leaving a trace only in a later Git diff.
- Persistence and backup: `notes/` is already synced.
- Atomicity and recovery: closing A0 and opening A1 together needs a new multi-note operation through `src/writer.ts#applyWrite`. External editors offer no atomicity.
- Identity: the path. vmem move rewrites links; whether Obsidian does depends on its settings (unverified). `merge` must be refused for assertion notes. A delete removes the assertion from every past `as_of` answer.
- Record time: vmem writes `recorded` at create, but the value sits in an editable file. `supersede` stores no time, so B also needs an equally editable supersession time field.
- Export and rebuild: the note index rebuilds from files and reproduces whatever the files claim now.
- Cost: each revision counts toward the 10000-note bound of `src/writer.ts#snapshot`, which every note write reads in full.

### C: append-only assertion journal with a derived index

- Source of truth: `assertions/<segment>.jsonl` in the vault root, appended only by vmem. Notes are not touched.
- Obsidian edits: assertions are not edited as properties. The hash chain detects external edits to a segment. Whether Obsidian lists `.jsonl` files depends on its settings (unverified).
- Schema compatibility: no note schema change. Older vmem never reads `assertions/`, because `src/writer.ts#snapshot` and `src/vault-index.ts#VaultIndex.scan` read only `notes/`. Older `vmem sync` reports it under `ignored`.
- Persistence and backup: fsync on append. Git backup only once `src/sync.ts#STAGE_PREFIXES` includes `assertions/` (prerequisite P2).
- Atomicity and recovery: a batch commits all or nothing. Torn tails and partial batches are ignored and reported (see forward recovery).
- Identity: assertion ids `a:<segment>:<seq>` and subject ids `s:<slug>` never change. Note links are advisory and revisable, so a note move, merge or delete cannot change an assertion.
- Export and rebuild: the segment files are the export. The index rebuilds deterministically from them.

### Scenario coverage

| Scenario | A | B | C |
|---|---|---|---|
| 1 late recording | Unsupported: no `at` or `as_of`; issue 235 forbids mapping a date to a commit | Answered only by convention: `recorded` is editable, and in-place edits or deletions change past answers silently | Answered: `as_of` filters by writer-clock `recorded_at` (Q1 to Q5) |
| 2 correction | Unsupported as a dated belief; the old text is readable at a pinned commit if a sync committed it before the correction | Answered only by convention: needs revise-by-new-note plus an editable supersession time | Answered: revisions are appended, never replaced (Q6 to Q8) |
| 3 precision and unknown bounds | Unsupported: prose only, not validated | Answered: the same bound grammar in frontmatter | Answered: bound grammar with three-valued evaluation |
| 4 coexisting values | Answered trivially: no resolution logic exists; a person reads both | Answered: overlap groups, no winner | Answered: overlap groups, no winner (Q9, Q10) |
| 5 coverage | Answered by issue 235: dirty-note count, deleted notes readable at older commits, exact-path renames, first-parent merges; the cache is irrelevant | Partly unsupported: deletions and external edits rewrite record-time answers; only vmem renames are followed; the cache rebuild is sound | Answered with stated gaps: whole-segment deletion and valid-prefix truncation of another clone's segment are visible only through Git |
| 6 current policy and evidence | Answered by issues 235 and 233: current-policy refusal, missing evidence labelled | Answered only with a new read-time screen; `VaultIndex.show` does not re-screen today | Answered: read-time withholding and `unavailable` labels |

## Decisions

- Recommendation: alternative C, scoped to manually authored, evidence-backed state and event assertions, implemented only after P1 to P3 and the owner's selection.
- A is not enough for this scope: it cannot answer scenarios 1 to 3.
- B is not recommended: its record time lives in fields that anyone can edit or delete, so `as_of` answers would be claims made by the current files, not records. B also multiplies full notes and needs special cases for merge.
- Adopted from the Utopia time design: two clocks (world time read by `at`, record time read by `as_of`), an unknown end kept distinct from an open end, explicit precision, a source-stated holding date (here `held_on`, comparable to its attested dates), and `at` absent meaning no world-time filter.
- Not adopted: automatic closing of an open value when a new value arrives (scenario 4 forbids latest-wins), backward-dated corrections of record time, and database storage.

### Clocks and fields

| Field | Clock | Set by | Changeable later | Used for |
|---|---|---|---|---|
| `from`, `to`, `held_on`, `on` | world time, civil date | author | only by a new revision | `at` |
| `recorded_at` | record time, writer clock, UTC, second precision | vmem at append | no (chain-protected) | `as_of` |
| `seg`, `seq`, `prev`, `hash` | none | vmem at append | no | ordering, tamper evidence |
| `parents` (`revise` and `retract` only) | none | vmem at append, from the heads the client read | no (in `hash`) | revision order, concurrent revisions |
| `channel`, `actor` | none | vmem, unauthenticated | no | attribution only |
| note `created`/`updated` | vmem write date or author text | vmem or author | yes | never |
| Git author and committer dates | commit metadata | Git | yes (rebase, amend) | never |
| file mtime | filesystem | any process | yes | never |

### `at` semantics

- `at` is a civil date `YYYY-MM-DD` from 0001-01-01 to 9999-12-31, with no time zone. Day is the finest precision; time of day is unsupported in v1.
- A state holds on the interval from `from` inclusive to `to` exclusive.
- Default: when `at` is omitted there is no world-time filter. Every current revision is returned with its bounds and without an `answer` field.

### `as_of` semantics

- `as_of` is either a UTC instant `YYYY-MM-DDTHH:MM:SSZ`, which includes entries with `recorded_at` at or before it, or a date `YYYY-MM-DD`, which includes entries recorded before 00:00:00Z of the next UTC day. The response echoes the resolved cutoff.
- Date-only values are UTC, not local time, so answers do not depend on the reading host. Near local midnight a person may see a one-day shift; the echoed cutoff shows it.
- Default: when `as_of` is omitted the read uses every complete, verified entry present when the read starts.
- Every response, with or without `as_of`, reports a pin: each segment's last verified (seq, hash) at read start. Reading back by pin is deferred.
- An `as_of` answer describes the segments present in this clone, stamped by the clock of the clone that appended each entry. An entry appended elsewhere and synced later appears in a rerun of the same query. The pin shows which segments contributed.

### Precision and unknown values

- A date value is `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. It denotes a set of candidate days: the whole year, the whole month or one day.
- `from` is a date value or `unknown`, and is required.
- `to` is a date value, `unknown` or `open`, and is required, so the author must choose between an unknown end and an open end. For `to`, the candidate day is the first day on which the state no longer holds.
  - `unknown`: an end exists but its date is unknown.
  - `open`: no end has been asserted; the state holds onward until a revision says otherwise.
- `held_on` is optional, day precision: a day on which the evidence states the state held.
- An event has `kind: event` and `on`, a date value; `unknown` and `open` are refused for `on`.
- State evaluation for day `t`:
  - Start candidates: the days of `from`, or every day when `from` is `unknown`. End candidates: the days of `to`, every day when `to` is `unknown`, or no end when `to` is `open`.
  - Keep only pairs with start before end; with `held_on` also require start at or before `held_on` and end after it.
  - `yes` when every remaining pair has start at or before `t` and end after `t`; `no` when every remaining pair has `t` before start or at or after end; `unknown` otherwise.
  - Equivalently, compare `t` with the latest possible start and the earliest possible end after the constraints.
- Event evaluation for day `t`: `yes` when the last candidate day of `on` is at or before `t`, `no` when `t` is before its first candidate day, `unknown` otherwise.
- Refused at write: bounds that leave no pair, and a state that is `unknown` on every day (`from: unknown` with `to` `unknown` or `open` and no `held_on`).

### Late-arriving facts

- A validity start earlier than `recorded_at` is normal. Cutoffs before the recording do not see the fact (Q1, Q2).
- A future validity start is stored as stated. It is an assertion about the future, not a prediction made by vmem.
- There is no backfill of record time. `recorded_at` is always the append time, so importing older knowledge takes today's time. A source date goes in `held_on` or in evidence, never in `recorded_at`.
- Entries from other clones can arrive after a query was first answered (see `as_of` semantics).

### Correction and retraction

- `revise` appends a complete new revision of the world-time fields (`value`, kind fields, evidence) of an existing assertion. Subject and relation are fixed for an assertion id. Earlier revisions remain and answer cutoffs before the revision.
- Ending a state in the world is a revision with a `to` date (A0 revision 2). It is a world-time statement.
- `retract` appends a record-time withdrawal with a `reason` of `recorded_in_error`, `evidence_withdrawn` or `other`. From its `recorded_at` on, the assertion is left out of answers; history still shows it. It does not claim the state stopped holding.
- A new value for the same subject and relation never ends an existing assertion. Overlaps are reported instead.
- Revising or retracting a retracted assertion is refused; assert a new id instead.
- Every `revise` and `retract` records `parents`: the hashes of the entries it supersedes. Its `rev` is one more than the highest `rev` among them. An assertion's heads are its kept entries that no other kept entry names as a parent.
- Concurrent revisions: two clones that both revise the same head produce two heads. Both are returned, each with its own `answer`, flagged `revisionConflict`; none is dropped or chosen. A concurrent `retract` head is reported in the same conflict set, and the revision heads are still answered. The conflict is resolved only by a later `revise` or `retract` whose `parents` name every head.
- Record time follows the parents. A `revise` or `retract` must be recorded at or after every parent, whichever segment holds it. The write contract refuses a local append that would break this (`CLOCK`). An entry from another clone with a skewed clock can still break it. Such an entry gets an effective record time: the later of its own `recorded_at` and the effective record times of its parents. `as_of` and ordering use the effective time, so a revision never counts before the entry it revises. The response flags it `clockInverted: true` and shows both times.

### Limits on historical proof

- `recorded_at` is what a vmem writer clock said at append. Clocks can be wrong. `actor` comes from the channel and agent markers (`src/log-format.ts#AGENT_MARKERS`) and is not authenticated; a fingerprint confirms a payload, not a person (issue 232).
- The hash chain detects partial edits, reordering, torn writes and partial batches within a segment. It does not detect a consistent rewrite of a whole segment, deletion of a whole segment, or truncation to a valid prefix, except that the local clone's own segment tail is checked against its writer record.
- The strongest available evidence that an entry existed is its presence in a commit reachable from the remote branch. That needs P4 or manual Git, and even then Git dates are not record time.
- Evidence `verified` (issue 233) means the quote occurs in the current source bytes. It does not show the quote existed at record time, and it does not show the claim is true. A stored source hash that no current or committed blob matches is `unavailable`.
- No answer is a claim about the world beyond "this vault recorded this assertion at this writer time".

## Recommended design details

### Storage and schema

- Directory `assertions/` in the vault root. Files `assertions/<segment>.jsonl`, where a segment id is 16 random lowercase hex digits.
- One segment is appended by one clone only. The clone's current segment and last (seq, hash) live in `<VMEM_HOME>/assertion-writers/<vault-id>.json`. Losing that file only starts a new segment.
- A new segment starts when there is no writer record, when the recorded segment fails verification, or when the segment reaches its size bound.
- Encoding: UTF-8, LF line ends, no BOM, one canonical JSON object per line with sorted keys, as `src/writer.ts#canonical` produces.
- Lock: an exclusive `assertions.lock` in the vault root, acquired like the log lock in `src/vault-log.ts#appendLog` and independent of `mutation.lock`.
- `hash` is the SHA-256 of the canonical entry without `hash`, `payload` and `purged`. `payload_sha256` is the SHA-256 of the canonical payload, so a purge can drop the payload and keep the chain.

In the examples one segment `3f9c2e1d0a4b5c6d` holds the corpus: E1 is seq 1 and 2, E2 is seq 3 and 4, E3 is seq 5 and 6. An assertion id names the seq of its `assert` entry.

Entry E2, first line (hash values are placeholders):

```json
{
  "v": 1,
  "seg": "3f9c2e1d0a4b5c6d",
  "seq": 3,
  "prev": "<64-hex hash of seq 2>",
  "recorded_at": "2026-04-10T09:00:00Z",
  "channel": "cli",
  "actor": "person",
  "op": "revise",
  "batch": { "id": "3f9c2e1d0a4b5c6d:3", "size": 2, "index": 0 },
  "payload_sha256": "<64-hex>",
  "payload": {
    "id": "a:3f9c2e1d0a4b5c6d:2",
    "rev": 2,
    "value": "member",
    "kind": "state",
    "from": "2025-09-01",
    "to": "2026-04-01",
    "evidence": [
      { "source": "vault/notes/meeting-2026-04-09.md", "sha256": "<64-hex>", "quote": "moves to lead on April 1", "section": "Decisions" }
    ]
  },
  "hash": "<64-hex>"
}
```

Payloads of the scenario 1 and 2 entries, seq 1 to 6 in append order:

```json
{"op":"subject","payload":{"subject":"s:person-a","label":"Person A","note":"notes/person-a.md"}}
{"op":"assert","payload":{"id":"a:3f9c2e1d0a4b5c6d:2","rev":1,"subject":"s:person-a","relation":"role","value":"member","kind":"state","from":"2025-09-01","to":"open","evidence":[]}}
{"op":"revise","payload":{"id":"a:3f9c2e1d0a4b5c6d:2","rev":2,"value":"member","kind":"state","from":"2025-09-01","to":"2026-04-01","evidence":[]}}
{"op":"assert","payload":{"id":"a:3f9c2e1d0a4b5c6d:4","rev":1,"subject":"s:person-a","relation":"role","value":"lead","kind":"state","from":"2026-04-01","to":"open","evidence":[]}}
{"op":"revise","payload":{"id":"a:3f9c2e1d0a4b5c6d:4","rev":2,"value":"lead","kind":"state","from":"2026-03-28","to":"open","evidence":[]}}
{"op":"revise","payload":{"id":"a:3f9c2e1d0a4b5c6d:2","rev":3,"value":"member","kind":"state","from":"2025-09-01","to":"2026-03-28","evidence":[]}}
```

Evidence lists are shortened to `[]` above; under owner decision O2 each assert carries at least one entry. Other payload forms, with illustrative ids outside the corpus:

```json
{"op":"assert","payload":{"id":"a:3f9c2e1d0a4b5c6d:90","rev":1,"subject":"s:person-b","relation":"member-of","value":"org-x","kind":"state","from":"unknown","to":"2026-06-01","held_on":"2026-02-15","evidence":[]}}
{"op":"assert","payload":{"id":"a:3f9c2e1d0a4b5c6d:91","rev":1,"subject":"s:person-c","relation":"joined","value":"org-z","kind":"event","on":"2026-03","evidence":[]}}
{"op":"retract","payload":{"id":"a:3f9c2e1d0a4b5c6d:91","reason":"recorded_in_error"}}
```

The `held_on` example is not part of the corpus; with it, A3 would answer yes from 2026-02-15 through 2026-05-31.

A purged line keeps every hashed field, drops `payload` and adds `"purged": {"at": "<UTC instant>", "reason": "<text>"}`.

### Write contract

- Proposed surface: `vmem assert <vault> --batch FILE|- [--dry-run] [--log JSON] [--json]` and MCP `vmem_assert` with the same schema. Final names must be reconciled with the CLI presentation work in issue 228.
- Input is `{ops: [...]}` with 1 to 32 operations. The client never supplies `recorded_at`, `seg`, `seq`, `id`, `rev`, `prev`, `hash` or `actor`. An input op `declare` is stored as journal entry op `subject`: the declaration is the entry that records a subject, so its stored `op` is `subject` and its payload is `{subject, label?, note?}`. `revise` and `retract` carry `expected_heads`, the hashes of the assertion's heads as the client read them (one hash unless it saw a `revisionConflict`). vmem records them as `parents`.
- Validation runs before any append, and any error refuses the whole batch:
  - Vault write policy (`none`, `cli`, `mcp`), as in `src/writer.ts#applyWrite`.
  - Shapes and bounds; the subject declared earlier or in the same batch; the target of `revise` or `retract` exists and is not retracted, and `expected_heads` equals its current head set computed from the verified segments under `assertions.lock` (the same read the append uses), never from the derived SQLite index, which is issue 251's surface and can lag the segments. A stale or partial set is refused, naming the current heads and the next step: re-read the assertion and resend with every head. A partial set would leave a conflict silently unresolved.
  - Temporal rules from the precision section.
  - Evidence in the issue 233 version 1 shape, each entry checked with `src/evidence.ts#verifyEvidenceEntry`. `src/evidence.ts#evidenceProblem` is not reused: its rule that every evidence source is also listed in the note `source` field has no counterpart in an assertion.
  - A path source is workspace-relative, resolved against `src/source.ts#sourceWorkspaceRoot` (the workspace that holds the vault registry), never against the vault. A vault note is therefore cited as, for example, `vault/notes/x.md`; a bare `notes/x.md` resolves outside the vault and fails.
  - Sources denied by current policy are refused (V06). A path source must be `verified` at append; any other result refuses the whole batch with the entry index and reason. That includes `unresolved_source_root` for a vault with no resolvable workspace root, and the refusal names the next step: register the workspace root, or cite the source as an external reference.
  - Non-path references are stored as `unverified_external` without I/O, as `verifyEvidenceEntry` classifies them before resolving any root.
  - Screening with `src/write-validation.ts#screenContent` over the canonical payload (secrets always, PII per vault policy), plus a traversal like `src/write-validation.ts#screenMetadata`.
  - Clock: `recorded_at` must not precede the segment's last `recorded_at`. For a `revise` or `retract`, it also must not precede the `recorded_at` of any parent, whichever segment holds it, including entries synced from other clones. Otherwise the batch is refused with `CLOCK`, naming the later time to wait for or the clock to correct. There is no clamping.
  - Segment health: the clone's segment tail must match the writer record and verify; otherwise the batch goes to a new segment and the receipt says so.
- Append: under `assertions.lock`, verify the tail, write the whole batch with one `O_APPEND` write, fsync the file (and the directory when the file is new), then update the writer record. A short write is truncated back, as in `src/vault-log.ts#appendLog`.
- Receipt: `{ok, applied, segment, recordedAt, entries: [{seq, id, rev, op, hash}], issues, indexUpdated}`. A dry run validates without lock or append and has no `recordedAt`.
- No note is written and no `updated` stamp changes. No log line is written unless `--log` supplies an event, which is checked like `log append`.

### Read contract

- Proposed surface: `vmem assertions <vault> [--subject S] [--relation R] [--at DATE] [--as-of INSTANT|DATE] [--history] [--limit N] [--cursor C] [--json]` and the read-only MCP tool `vmem_assertions`.
- Response for Q1, read after E5 (the corpus fills seq 1 to 15):

```json
{
  "schemaVersion": 1,
  "basis": "assertion_journal",
  "vault": "example",
  "at": "2026-04-05",
  "asOf": { "requested": "2026-04-06", "cutoff": "2026-04-07T00:00:00Z", "cutoffInclusive": false },
  "pin": [{ "segment": "3f9c2e1d0a4b5c6d", "seq": 15, "hash": "<64-hex>" }],
  "coverage": { "journal": "present", "untrusted": [], "unsupported": [], "tornTail": [], "purged": 0, "unsynced": 0 },
  "items": [{
    "id": "a:3f9c2e1d0a4b5c6d:2", "rev": 1, "subject": "s:person-a", "relation": "role",
    "value": "member", "kind": "state", "from": "2025-09-01", "to": "open", "answer": "yes",
    "recordedAt": "2025-09-02T09:00:00Z",
    "evidence": [{ "source": "vault/notes/onboarding-2025-09.md", "status": "verified", "quote": "joins as member" }],
    "subjectNote": { "path": "notes/person-a.md", "status": "present" }
  }],
  "overlaps": [],
  "truncated": false
}
```

- `unsynced` counts journal files with uncommitted changes when the vault is a Git repository, and is `null` otherwise. No other paths are read or reported.
- Items are ordered by subject, relation, id and revision.
- `--history` returns every revision and retraction with `recordedAt` and `replacedAt` (the `recorded_at` of the next revision or retraction, or null), plus `answer` when `at` is given.
- `overlaps` is present only with `at`: groups of two or more assertion ids with the same subject and relation, different values, and an answer of `yes` or `unknown`. Each page includes only groups touching its items, with the ids on that page and `size` giving the total number of group members. Page the subject and relation query to collect the full membership. A group with any `unknown` member is marked `possible: true`.
- Evidence and values pass current policy at read time: denied sources become `withheld`; a value that fails current secret or PII screening is replaced by `{withheld: "secret"}` or `{withheld: "pii_policy"}`.
- Reads write no note, journal line, log line or append lock. Like other reads, they may refresh the derived index.
- No journal: `coverage.journal: "absent"` and no items.

### Evaluation

1. Verify each segment from seq 1: contiguous seq, `prev`, `hash`, `payload_sha256` unless purged, non-decreasing `recorded_at`, supported `v`. Stop the segment at the first failure and report `untrusted`, or `unsupported` for an unknown version, from that seq. Ignore a final line without LF (`tornTail`) and any batch with missing entries.
2. Compute each entry's effective record time: its `recorded_at`, raised to the latest effective record time of its `parents`. Flag a raised entry `clockInverted`. Parents are resolved across segments; a parent missing from every verified segment marks the entry `untrusted`.
3. Keep entries whose effective record time is within the `as_of` cutoff, and order them by (effective record time, segment, seq).
4. For each assertion id, find its heads among the kept entries: the entries no other kept entry names as a parent. One revision head is the current revision. Several heads are all returned with `revisionConflict`, each answered. A retraction head excludes the assertion only when it is the sole head. Drop retracted and purged assertions except in history.
5. Evaluate `answer` at `at`.
6. Group overlaps, apply current policy, page within bounds.

### Migration, rollback and forward recovery

- Migration: none. No note, frontmatter key or note index changes. The directory appears on the first append.
- Compatibility: older vmem ignores `assertions/`. Older `vmem sync` lists it under `ignored` and never stages it, so a clone running an older version provides no backup for the journal.
- Rollback: stop appending and remove the surfaces. The owner may remove `assertions/` with Git, whose history keeps it. Notes are unaffected; the index file is disposable.
- Forward recovery:
  - Torn tail: reads ignore it; the next append, holding the lock, truncates exactly the bytes after the last LF and reports it.
  - Partial batch at the end of the clone's own segment: reads ignore it; the next append truncates it back to the batch start and reports it.
  - Chain failure in the clone's own segment: no repair and no re-sealing. Appends move to a new segment and the verified prefix still answers. The owner may restore the file from Git, for example `git checkout <commit> -- assertions/<segment>.jsonl`, after which it verifies again. Issue 235 excludes non-note paths, so vmem cannot perform this historical read today.
  - Lost writer record: a new segment starts; the truncation check for the old segment is lost.
  - Lost or corrupt index: rebuild from segments.
  - Clock regression: appends refuse with `CLOCK` until the clock passes the segment's last `recorded_at`.

### Retention and deletion

- No operation edits or deletes an entry in place.
- `retract` hides an assertion from answers at and after its time; its bytes remain.
- `purge` is a two-step operation (preview, fingerprint, confirm, as for `merge`). It rewrites the affected segment files by temporary file and rename under `assertions.lock`, held for the whole rewrite and for the index refresh below, removes `payload` from the named assertion's entries, keeps `payload_sha256` and adds `purged`. The chain still verifies. A purged assertion is left out of answers, shown as `unavailable` in history and counted in `coverage.purged`. An interrupted rewrite leaves the original segment intact; its preview fingerprint still matches that segment, so a retry completes the purge.
- A purged entry keeps no copy of the subject or relation. Its assertion id stays derivable as `a:<seg>:<seq>` for an assert, and a purged revision resolves its id through `parents`, so identity and chain survive without the payload. The subject and relation strings still appear where other entries hold them: the `declare` entry of that subject, and any other assertion about the same subject or relation.
- The derived read index at `<VMEM_HOME>/indexes/assertions-<digest>-v1.sqlite` stores canonical entries, payloads included. The purge deletes it and rebuilds it from the purged journal while the lock is held, so the disposable cache keeps no purged payload; a failed rebuild is a warning naming the file, and the next read rebuilds it. A read that started before the purge and renamed its own pre-purge cache afterwards is the residual window: the next read rebuilds from the purged journal, and deleting `VMEM_HOME/indexes/assertions-*.sqlite` clears it.
- Purge does not remove bytes from Git history, other clones or remotes. Complete erasure needs a Git history rewrite outside vmem.
- Deleting a note never deletes assertions. A deleted subject note reports `missing`.
- When PII policy becomes stricter, existing entries stay, reads withhold failing values, and purge can remove them.
- When the total journal bound is reached, appends refuse. History is never rotated out silently.

### Bounds

These are proposed limits, not measurements. No performance has been measured, and implementation must measure before quoting any.

- Batch: 1 to 32 operations, canonical batch at most 64 KiB.
- Entry payload: at most 16 KiB canonical JSON. `value` 1 to 1024 UTF-8 bytes without control characters. `label` at most 200 characters.
- Ids: subject `s:[a-z0-9][a-z0-9-]{0,63}`, relation `[a-z0-9][a-z0-9-]{0,63}`, assertion ids assigned by vmem.
- Evidence: the issue 233 version 1 limits (at most 16 entries and 16 KiB serialized, quotes 1 to 2048 bytes).
- Segment: at most 8 MiB, then a new segment.
- Journal per vault: at most 64 MiB and 100000 entries across segments, mirroring the 64 MiB snapshot bound in `src/vault-index.ts#VaultIndex.scan`. Beyond it, appends and rebuilds refuse with an explicit error instead of reading partial history.
- Dates: years 0001 to 9999.
- Reads: at most 100 items or revisions per page with a continuation cursor; each serialized CLI or MCP response at most 48 KiB including the envelope, matching the transport bound in issue 235.

### Expected test cases

Proposed `test/assertions.test.ts` with synthetic fixtures under `test/fixtures/temporal-design/`, isolated homes and isolated vaults only.

- T1 corpus: Q1 to Q10 and the scenario 3 table, exactly.
- T2 boundaries: `from` inclusive, `to` exclusive; a date `as_of` covers the whole UTC day; an instant `as_of` is inclusive; a cutoff before the first entry reports `before_first_entry`.
- T3 precision: unknown start, unknown end, open end, month event, month interval and `held_on` give distinct answers; always-unknown and unsatisfiable bounds are refused.
- T4 no latest-wins: coexisting values return one overlap group. Two clones revising the same head each return a head with `revisionConflict` and neither is dropped. A revision naming only one of two heads is refused. A revision naming both resolves the conflict. A concurrent retraction head is reported in the conflict set.
- T5 correction and retraction: revisions keep earlier answers under earlier cutoffs; a retraction excludes from its time on and stays in history; revising a retracted id and a stale `expected_heads` are refused.
- T6 clock independence: changing note `created`/`updated`, file mtimes, Git commit dates, `confidence` or graph output changes no answer.
- T7 tamper evidence: an edited value, a reordered line, a removed middle line and a changed `recorded_at` each mark that entry and later ones `untrusted`; a torn tail and a partial batch are ignored and truncated on the next append; truncation of the local segment is detected through the writer record; whole-segment deletion is documented as undetected.
- T8 clock regression: refused with `CLOCK`, nothing appended. Also refused: a local revision whose clock is behind a parent synced from another clone's segment. A synced revision recorded before its parent is answered at its parent's effective time, flagged `clockInverted`, and never counted at a cutoff before its parent.
- T9 rebuild: deleting the SQLite index and rebuilding yields byte-identical JSON for every T1 query.
- T10 policy: denied evidence returns `withheld` with no path, quote or hash; deleted or purged evidence returns `unavailable`; a denied `assertions/` path refuses reads (V06); secrets and PII are refused at append and withheld at read after a policy change.
- T11 identity: vmem move and merge of a subject note leave answers unchanged and report `missing` or `superseded` links.
- T12 purge: preview, fingerprint and confirm; the chain still verifies; purged entries show `unavailable` and count in `coverage.purged`; a stale fingerprint is refused; an interrupted rewrite leaves the segment intact and a retry completes it; the derived index holds no purged payload after confirm.
- T13 compatibility: note writes, reads, lint and the note index behave the same with and without `assertions/`; `vmem sync` stages `assertions/` only after the P2 change.
- T14 bounds and transport: each bound refuses with guidance; escape-heavy Unicode responses stay within 48 KiB with continuation.
- T15 read-only: reads create no note, journal line, log line or lock.

## Trust after external edits and index rebuild

After an external edit in Obsidian or any other editor:

- Still trustworthy: journal entries before the first chain failure of each segment, their `recorded_at` values as writer-clock claims, assertion and subject ids, and answers computed from them.
- Recomputed on every read rather than trusted from the past: evidence status (issue 233) and subject note links.
- Not detected: a consistent rewrite of a whole segment, deletion of a whole segment, and truncation of another clone's segment to a valid prefix. Only a comparison against Git history can reveal them.
- Notes: any note edit is possible and none affects the journal. Note dates and mtimes stay unusable as time evidence.

After an index rebuild:

- Every answer is reproduced from the segment files. Nothing in the index is authoritative, and only cache contents are lost.

Durable state that cannot be reconstructed:

- The journal segments. Record-time history cannot be derived from notes, note dates, mtimes or Git dates. Its only backup is Git, once a sync stages it.
- Appends made after the last sync, if the vault directory is lost.
- Purged payloads, by design, apart from copies left in Git history or other clones.
- The writer record in VMEM_HOME. Losing it only costs the local truncation check for the old segment.
- For comparison: under B, record time lives in editable notes and is lost on edit or deletion; under A, only committed snapshots exist.

## Prerequisites and fallback

Before C can be implemented:

- P1: issue 233 implemented (evidence entry shape and verifier). Met by PR 243 (merge 32495c0).
- P2: `vmem sync` stages `assertions/` through a change to `src/sync.ts#STAGE_PREFIXES`. Without it the journal has no backup. Tracked in issue 249.
- P3: the owner accepts a vmem-owned, non-Markdown `assertions/` area in the vault beside `log`, and answers O2 to O6. Met on 2026-11-19.
- P4 (optional): issue 235 extended to read journal blobs at a pinned commit, for recovery and existence evidence.

Fallback if C is not selected: retain snapshot history only, meaning alternative A through issue 235 plus documentation conventions for prose assertions, with no `at` or `as_of` surface. The missing prerequisite is a vmem-owned, append-only, tamper-evident record-time store in the vault. Without one, record-time answers cannot be honest, and B cannot provide one.

## Owner decisions

Recorded on issue 237 on 2026-11-19.

- O1: alternative C.
- O2: every assertion carries at least one evidence entry or `source` reference.
- O3: when current policy withholds evidence, only that evidence is withheld; the assertion is still returned.
- O4: the directory is `assertions/` at the vault root. vmem changes no Obsidian settings.
- O5: in v1, vmem move and merge do not remap subject notes. A moved or merged subject reports `missing` or `superseded`.
- O6: commands `vmem assert` and `vmem assertions`, MCP tools `vmem_assert` and `vmem_assertions`, with output following the issue 228 standard.

## Unverified items

- Obsidian behavior: whether it lists `.jsonl` files and whether it rewrites wiki links on rename depend on its settings and were not tested.
- The Utopia time design was read through a fetched summary of the pinned document, not line by line.
- `isDenied` was read in agent-mem 0.25.0 from the main checkout; the pinned 0.28.0 is not installed in this worktree. The design relies only on it being a path policy evaluated at call time.
- Bun YAML date parsing was observed with Bun 1.4.4 locally; no repository test covers it.
- Issue 235 merged in PR 245 (7abe644) after this design was written. References to its outcomes and bounds follow its proposed contract and were not rechecked against the merged code. Issue 233 is merged (PR 243), and its contract is cited from the code.
- Whether `vmem lint` or the workspace graph would react to an `assertions/` directory was not checked.
- All bounds are proposals; nothing was measured.
