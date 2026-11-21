---
name: vault-sync
trigger: /vault-sync
description: Scan work/ for changes, or take an explicit list of work sources, and propose vault extractions with confirmation
---

# /vault-sync [scope] [path...]

> Before the first vmem call, read `references/vault-adapter.md` §Runtime Discovery and select and bind the vmem vault id; pass it as `vault` on every vmem tool call and as the `<vault>` argument of every `vmem` CLI command.

Scan work/ for new or changed content and propose vault extractions. Nothing is created without explicit user confirmation. Without a workspace, use `targets` with explicit source paths; skip workspace scans, registry and entity-resolution steps, task-log promotion and timestamp updates, and report the skipped steps. If no targets were supplied, ask for them.

## Input
- scope (optional): "full" (all work/), "meetings" (meetings only), "projects" (projects only), "diff" (git diff only), "targets" (the work files or directories that follow, no scan)
- Default: "full"
- Single work source: call `/vault-extract` directly. A work `inbox/` item is processed by `inbox-process` first and its summary is the target (the vault has no inbox).
- Without a workspace, a single explicit source follows the same proposal and confirmation steps as a batch; invoke `/vault-extract` only after the user accepts its create proposal.

Raw recordings and unreviewed transcripts are not scanned by `/vault-sync`. In a workspace, only refined meeting notes under `work/meetings/YYYY/YYYY-MM/` are considered vault-worthy sources. Any transcript provider output must be processed through `meeting-notes` first. When the workspace or `meeting-notes` skill is unavailable, skip and report that workspace preprocessing step, ask for a reviewed meeting note or summary, and do not process the raw transcript.

## Process

### Step 1: Scan

2-source parallel scan:

#### 1A: Meeting Notes (highest priority)
```bash
# List all meeting files in current month (YYYY/YYYY-MM = today)
ls <workspace-root>/meetings/YYYY/YYYY-MM/
```
- Cross-reference vault notes source fields to find unprocessed meetings
- Grep vault `notes/` for `source:.*work/meetings/YYYY/YYYY-MM` to identify already-extracted

#### 1B: Git Diff (Work Root + Submodules)
```bash
# Work root: changes since last sync timestamp
cd <workspace-root>
LAST_SYNC=$(cat <vault.path>/ops/sessions/last-sync-timestamp)
# Convert YYYYMMDDHHMI to git date format
SINCE_DATE=$(echo $LAST_SYNC | sed 's/\(....\)\(..\)\(..\)\(..\)\(..\)/\1-\2-\3 \4:\5/')

# Root repo changes (exclude system/meetings/tasks — those have dedicated scanners)
git log --oneline --since="$SINCE_DATE" --name-only -- . \
  ':!.claude' ':!.obsidian' ':!meetings' ':!tasks' \
  | grep -v '^\w\{7\} ' | grep -v '^$' | grep -v '\.json$' \
  | grep -v 'uv.lock' | grep -v 'pyproject.toml' \
  | sort -u
# The workspace system directory is dropped by the Step 1.5 filter rules

# Submodule changes: detect which submodules have new commits
git submodule status --recursive | grep '^+' | awk '{print $2}'
```

**Submodule change detection**:
- `+` prefix in `git submodule status` = submodule HEAD differs from recorded commit
- For each changed submodule, check its recent commits:
  ```bash
  cd <workspace-root>/$SUBMODULE
  git log --oneline --since="$SINCE_DATE" --name-only -- . ':!.claude' \
    | grep -v '^\w\{7\} ' | grep -v '^$' | sort -u
  ```

**Work repo submodules**: 목록은 `.gitmodules`가 정본. `vault`는 스캔 대상이 아니라 목적지이고, 코드 저장소 서브모듈은 명시 요청 시에만 스캔한다. 그 외 work 트리는 일반 디렉토리이므로 루트 git diff 스캔이 덮는다.

### Step 1.5: Filter & Classify

**Filter rules** (reduce noise):
- Skip: the workspace system directory, `.json`, `uv.lock`, `pyproject.toml`, `*.css`, `*.js`, `*.html`
- Skip: draft versions if final exists (e.g., `drafts/YYMMDD-v2-*` if `final/YYMMDD-v4-*` exists)
- Skip: personal and code-repository submodules unless explicitly requested
- Include: `README.md`, `*-plan-*.md`, `*-report-*.md`, `*-summary-*.md`, `*-strategy-*.md`
- Include: any `.md` under the workspace's configured document roots

**Classify** per `references/vault-adapter.md` §Project Registry Pattern (scoring and fallback). A match attaches the project name and `vault_note` to the proposal; ambiguity marks it "project: TBD (user confirm)".

> **Entity resolution**: people/orgs/projects 해소는 워크스페이스 context-enrichment 규칙(`ssot.rules`)의 절차 사용 (fast cache → registry → vault MOC, 충돌 시 vault 우선).

**Deduplication** (multi-signal):

0. **`vmem_brief` first**: `vmem_brief(intent: "<source title> <key topics>", paths: ["<source work file>"], bytes: 1024)` ranks screened pointer lines by the intent words plus the source file's basename words (`paths` is a word hint, not a citation filter). Run it once per source before the checks below, then confirm a pointer with `vmem_search`; the checks below decide the verdict
1. **source field exact match**: `source: work/meetings/...` 경로 직접 일치
2. **Title similarity ≥70%**: fuzzy compare against vault note titles
3. **Recent update-section detection**: 대상 회의 날짜 헤더(`## Update (YYYY-MM-DD)` 또는 `## YYYY-MM-DD ...`)가 vault 노트에 이미 존재하면 "이미 반영됨"으로 판정
4. **Entity overlap** (보조): 회의 제목의 주요 인물·기관 키워드가 vault 노트 본문에 ≥3회 등장 시 후보

**판정 로직**:
- 1, 2, 3 중 **임의 하나 hit** → "already reflected — skip" 제안
- 1 miss + 2 hit (≥70%) → "update" 제안 (source field 갱신 포함)
- 모두 miss → "create" 제안

Standalone explicit-source precedence: if 1 or 3 hits, propose "already reflected — skip". If 1 and 3 miss but 2 hits, inspect the candidate and propose "update" only when related; show an unclear candidate to the user. This precedence applies only without a workspace.

### Step 2: Propose

Present candidates grouped by source and priority:
```
EXTRACTION PROPOSALS
====================
Scanned: meetings 9건, git-diff 5건, submodules 1건

─── MEETINGS (HIGH) ───

[1] MEETING: MM-DD partner meeting - example platform
    -> Proposed: update [[example-partner-platform-mou]]
    -> Domain: projects

─── GIT DIFF (MEDIUM-HIGH) ───

[2] DIFF: admin/example-unit/YYMMDD-org-restructuring.md (new file)
    -> Proposed: update [[example-org-restructuring-decision]]
    -> Domain: operations

[3] DIFF: projects/example-project/planning/YYMMDD-plan-masterplan.md (new file)
    -> Proposed: update [[example-project-masterplan-idea]]
    -> Domain: projects

─── SUBMODULE CHANGES ───

[4] SUBMODULE: sites/example-site (+1 commit, requested)
    -> Changed: src/pages/
    -> Proposed: update [[example-site-home]]
    -> Domain: teaching

Accept: [a]ll, [1-4] select, [s]kip, [q]uit
```

### Step 3: Confirm
- User selects which proposals to execute
- Follow `/vault-extract` §Extraction Fidelity and Concurrent Writers on every extraction; its one-writer rule's condition, stated in that rule, decides when it applies
- For each confirmed proposal:
  1. Read the source document fully
  2. **create** proposals: extract insights per `/vault-extract` methodology → create vault note(s) → update relevant MOCs
  3. **update** proposals: hand off to the `/vault-update` procedure (MCP `vmem_patch`/`vmem_append`/`vmem_set_frontmatter` with the original insight preserved, `## Update YYYY-MM-DD` section, `/vault-lint note=` afterwards when the CLI is available) — this skill does not carry its own update path
  4. Show created/updated note for review

### Step 3.5: R4 Sibling Merge (Method Evidence 자동 갱신)

이번 라운드에서 **R4 sibling merge**(≥2 meetings → 1 노트 merge)가 1건 이상 실행됐으면, Step 4 전에 `references/r4-method-evidence.md`를 읽고 method 노트의 evidence 테이블을 갱신한다.

**Skip 조건**:
- R4 merge 0건인 세션 → Step 3.5 skip
- User가 /vault-sync --skip-method-update 플래그 사용 시

### Step 4: Record
- Update last-sync timestamp in `ops/sessions/last-sync-timestamp` (plain file, fs write)
- Log sync results in `ops/sessions/YYYYMMDD-sync.md` with `vmem_report(path: "ops/sessions/YYYYMMDD-sync.md", body)` (expect: vmem refuses secret-looking text and an unsafe path)
- Promote vault-relevant `TASK` events from the work-local `.maru/tasks-log.md`
  to `vault/log` with `vmem_log_append(type: "TASK", ...)` (task-management does not write the
  vault directly)
- **Graph freshness**: run vault-lint L11 (graph staleness). If `vault-graph.json`
  is > 7 days stale, propose `/vault-graph build`. Suggest only — do not auto-build.

## Scope Details

### /vault-sync meetings
- Scan work/meetings/YYYY/ (current year) for notes not yet in vault
- Cross-reference vault notes source fields
- Extract: decisions, insights, relationship updates

### /vault-sync projects
- Git diff on work root + project submodules
- Scan work/projects/ README and key doc changes
- Compare with existing vault project notes
- Propose updates to existing notes or new notes

### /vault-sync diff
- Git diff only (skip meeting scanners)
- Work root + all submodules
- Useful for catching project doc changes between meeting-heavy days

### /vault-sync targets <path>...
- Skip Step 1. Enumerate eligible sources under the given source paths (`.md` with frontmatter, or summary output); at most 20 per run (collector's-fallacy guard: split larger batches)
- Step 1.5 classification and deduplication run once for the whole batch, and the classification is passed to each extraction (no registry reload per item)
- The named targets are the user's choice of sources: Step 2 shows the proposal list once and one accept covers the batch (per-item select still works)
- Step 3 runs the `/vault-extract` method per accepted create proposal and hands accepted update proposals to `/vault-update` as in other scopes, then `/vault-connect` on the notes it created. Check quality once after the batch with one `vmem_lint` call (or the CLI `vmem lint <vault> --note <path>` per note when the CLI is available)
- Stop on a refusal or a persisted partial write (see `references/vault-adapter.md` §Write results); continue past warnings
- Output adds: sources skipped by vault-extract preconditions, per-note lint error/warning counts
- Step 4 writes the session record but does not move `ops/sessions/last-sync-timestamp`: a targets run covers only the named sources, not every change since the last sync

### /vault-sync full
- All of the above in priority order: meetings → git diff → submodules
- Limit: max 10 proposals per run (avoid overwhelm)
- Raw recordings and transcripts must be refined into `work/meetings/` first

## Quality Gates
- Same as /vault-extract quality gates
- Additional: deduplication check before creation
- Confirmation required for every note creation (in `targets`, the one batch accept is that confirmation)

## Output
- Summary of scan results (per source: meetings, diff, submodules)
- Numbered proposals with accept/skip interface
- After execution: list of created/updated notes
- Updated sync timestamp
