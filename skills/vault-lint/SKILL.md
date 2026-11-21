---
name: vault-lint
trigger: /vault-lint
description: >
  work/ + vault/ 정합성 검증 리포트 생성. dead wiki-link, orphan note,
  스키마 위반, 명명규칙 위반, 스테일 seed, 로그 포맷 위반, 그래프 신선도 등 체크셋을
  실행하여 vault/reports/lint-report-YYMMDD.md로 리포트. vault 스코프는 `vmem lint`가
  판정하고 work 스코프는 에이전트가 검사. 자동 수정 하지 않음(제안만).
  트리거: vault-lint, /vault-lint, lint, 정합성 검사, 건강검진, vault lint, work lint,
  스키마 검사, 명명 검사, orphan 검사, 교차참조 검사, 린트
---

# /vault-lint 스킬

> Before the first vmem call, read `references/vault-adapter.md` §Runtime Discovery and select and bind the vmem vault id; pass it as `vault` on every vmem tool call and as the `<vault>` argument of every `vmem` CLI command.

work/ + vault/ 정합성 검증 리포트 생성기. workspace가 없으면 기본 `full`은 vault 범위만 검사하고 work 검사와 workspace 설정 의존 검사를 건너뛰었다고 보고한다. 명시적인 work 전용 범위는 workspace가 없으면 건너뛰고 보고한다.

## 기본 원칙

- **읽기 전용**: 자동 수정 하지 않는다. 제안만 한다.
- **리포트 출력 1곳**: `vault/reports/lint-report-YYMMDD.md`
- **log append**: `vault/log`에 `LINT` 이벤트 1줄 추가
- **vault 스코프 판정은 vmem**: `vmem lint`(=`vmem_lint`)가 vmem 인덱스로 L01·L02·L03·L09·L10·L11·L12·L13·L14·L15를 판정한다.
  vault 쓰기(리포트)도 vmem만 사용.
- **work/ 접근**: Read / Grep / Glob (서브모듈 내부 깊이 검사는 위임)

## 호출 형식

```
/vault-lint [scope]
/vault-lint note=<notes/path.md>
```

| scope | 대상 |
|-------|------|
| `full` (기본) | vault + work 전체 |
| `vault` | vault/notes/ + vault/log |
| `work` | work/ 전체 (서브모듈 루트까지) |
| `inbox` | inbox summary 스키마 (L06) |
| `names` | 파일명 규칙만 (work/ + vault/) |
| `note=<path>` | 단일 vault note 품질·스키마 검증 |

## 체크셋 (L01-L15)

`<ideation>` = `<paths.scratchpad>/<scratchpad.ideation_subdir>` (기본
`work/scratchpad/ideation`). workspace 설정에서 경로를 해석한다. 설정이 없으면 해당 scratchpad 검사를 건너뛰고 보고한다.
임계값도 설정에서 읽는다 (`scratchpad.ideation_review_days`,
`scratchpad.temp_stale_days`).

| ID | 대상 | 내용 | 심각도 |
|----|------|------|--------|
| L01 | `vault/notes/` 본문 + frontmatter `topics:` | dead wiki-link (`[[x]]` 대상 부재). frontmatter는 `topics`/`project`/`projects` 등 wiki-link 값 필드 모두 포함 | **error** |
| L02 | `vault/notes/` | 필수 frontmatter 누락 (`type`, `topics`) + 허용값 이탈 (`type`, `confidence`, `status`) | **error** |
| L03 | `vault/notes/` | orphan (in-link 0, topics 0) | warn |
| L04 | `<ideation>/seeds/`, `vault/` ideation | `scratchpad.ideation_review_days` 초과 미갱신 seed | warn |
| L05 | - | **폐지**. 라우팅 영수증 정합성은 inbox-intake/inbox-process 소관 | - |
| L06 | `work/**/*-summary.md` (frontmatter 보유분) | 신 스키마 필수 필드 누락 (marker-based scope) | warn |
| L07 | `work/**/*` | `YYMMDD-type-desc.ext` 명명 위반 | warn |
| L08 | `work/**/*` | 한글 파일명 (macOS NFD) | **error** |
| L09 | `vault/log` | **미등록 TYPE**(정규 12종·정규화표 모두 없음)·구조 위반·라인 수 20k 초과만 warn. 정규화표 등재 legacy TYPE은 정보 1줄 | warn |
| L10 | `vault/notes/*` | `project:` frontmatter 값이 vault 노트(wiki-link)도, `project-registry.yaml` id도 아님 | warn |
| L11 | `vault/reports/` | graph report 7일 초과 stale (`graph-report-YYMMDD.md`) | warn |
| L12 | `vault/reports/vault-graph.json` | island community (cross-community edge 0개인 커뮤니티) — 멤버 목록으로 보고, 번호 인용 금지 | warn |
| L13 | `vault/notes/` | 파일명이 소문자 ASCII kebab-case가 아님 (`vmem move`로 수정) | **error** |
| L14 | `vault/notes/` | frontmatter `source:` 경로가 해소되지 않음 | warn |
| L15 | `vault/notes/` | `confidence: proven`인데 `source`가 비어 있음 — 근거(memory id·URL·workspace 경로)를 넣거나 confidence를 낮춘다 | warn |

## 실행 절차

### 1단계: scope 해석

| scope | 활성 체크 |
|-------|----------|
| `full` | L01~L15 (L05 제외) |
| `vault` | L01, L02, L03, L09~L15 — 전부 `vmem lint` |
| `work` | L06, L07, L08 |
| `inbox` | L06 |
| `names` | L07, L08 |
| `note=<path>` | L01·L02·L03·L10·L13·L14·L15 (CLI `--note` 전용) + 단일 note quality gates |

### 2단계: vault 스코프 — `vmem lint` (L01, L02, L03, L09~L15)

```bash
vmem lint <vault> --json
# 단일 노트(CLI 전용): vmem lint <vault> --note notes/<x>.md --json
```

- 결과 JSON: `findings`(코드별 목록), `errors`, `warnings`, `markdown`(리포트 본문, 체크별 섹션), `summary`(`SUMMARY errors=N warnings=M`). `findings`는 vmem이 만든 판정이고, 스킬이 다시 계산하지 않는다
- 읽기 전용. project id는 vault에 등록된 `registry`로 검사한다
- finding을 설명하거나 수정 제안을 쓰기 전, `note=<path>` 결과를 판정하기 전에 `references/vault-scope-rules.md`를 읽는다.
- L01 finding은 해결 후보를 함께 준다: vmem이 제안한 `suggested` 타깃(존재하는 노트, 점수 포함)을 먼저 검토하고, 없거나 틀렸을 때만 직접 후보를 찾는다. 한 노트만 볼 때는 `vmem_links(path)`가 같은 제안을 dead link마다 하나씩 준다
- `note=<path>` 스코프: `--note`로 L01/L02/L03/L10/L13/L14/L15를 해당 노트로 제한한 뒤, 에이전트가 note quality gates(description test·composability·source)를 추가 검토
- MCP `vmem_lint` 인자는 `{vault, write, dryRun}`뿐이라 note를 좁힐 수 없다: `note=<path>`는 CLI 전용이고, MCP만 쓰는 경로는 vault 전체 lint 결과를 요청한 노트로 필터해 보고하고 범위 제한을 명시한다.

### 3단계: work 스코프 — 에이전트 검사 (L04, L06, L07, L08)

scope가 `full`·`work`·`inbox`·`names`이면 검사 전에 `references/work-scope-checks.md`를 읽고 활성 체크의 절차, Legacy Exemptions, 표준 OSS 메타 파일 allowlist를 따른다.

### 4단계: 리포트 생성

`vault/reports/lint-report-YYMMDD.md`를 생성한다. 두 경로 중 하나만 쓴다: (a) work 스코프 포함 리포트는 `vmem_report(path: "reports/lint-report-YYMMDD.md", body, log)`(5단계 LINT 1줄 기록), (b) vault 스코프만이면 `vmem_lint(write: true)`가 같은 파일에 쓴다(LINT 1줄 기록). expect: vmem refuses secret-looking text and an unsafe report path. vault 스코프 섹션은 2단계 `markdown`을 그대로 붙이고, work 스코프 섹션(L04·L06·L07·L08)을 에이전트가 채운다. 작성 전에 `references/lint-output.md`를 읽고 그 구조(frontmatter, 요약, 체크별 섹션, 제안 조치)를 따른다.

### 5단계: log append

(a) 경로는 4단계 `vmem_report`에 `log: {type: "LINT", project: "-", source: "vault/ + work/", note: "E errors, W warnings"}`를 넘겨 LINT 1줄을 기록한다((b)는 `vmem_lint`가 이미 LINT를 기록한다). 별도 `vmem_log_append`는 하지 않는다:

```
YYYY-MM-DD HH:MM  LINT  -  vault/ + work/  — E errors, W warnings
```

log 파일 직접 append(`>>`) 금지.

## 가드레일

- **자동 수정 금지**: 리포트만 생성. 수정은 사용자가 별도 스킬(`/vault-extract`, `/vault-connect`, `inbox-process`)로 실행.
- **vault 쓰기는 vmem만**: 리포트는 `vmem_report`(또는 CLI `vmem report`), 노트 수정은 `vmem_*` 쓰기 도구. 파일시스템 `Write`/`Edit` 금지.
- **서브모듈 내부 깊이 검사 안 함**: 서브모듈은 해당 저장소의 자체 lint로 위임.
- **CI 등록 금지**: 로컬 vault 접근이 필요하므로 CI 파이프라인에 등록하지 않는다. 권장 주기는 주간 `full` 1회, 대규모 ingest 후 `vault`.
- **성능**: vault 스코프는 `vmem lint` 1회 실행. work 스코프(L07/L08 `Glob work/**/*`)가 비용의 대부분이므로 필요 시 `/vault-lint vault`로 분리.
- **대용량 log**: L09가 라인 수 20k 초과 감지 시 "수동 아카이브 권장" warn만 추가 (자동 롤오버 안 함).
- **중복 리포트**: 같은 날 여러 번 실행 시 `vault/reports/lint-report-YYMMDD.md`를 덮어쓴다 (최신 상태 유지). 이력은 `vault/log`의 `LINT` 이벤트로 추적.

## 응답 원칙

1. **한국어 소통**
2. **실행 전 scope 확인**: 사용자에게 scope 선택 제시 (기본 full)
3. **진행 상황**: 각 체크 완료 시 한 줄 요약 (`L01: 0 error`)
4. **최종 요약**: error/warn 건수 + 리포트 경로 + log append 확인

## 관련 문서

- `references/vault-adapter.md` §Log Append — log 포맷 (체인 전체 그림은 워크스페이스 `ssot.ingest_chain`)
- `references/vault-adapter.md` — vault 접근·스키마 정책
- workspace 설정이 있을 때만 scratchpad 경로·임계값을 읽는다
- `inbox-process` 스킬 — inbox 처리와 요약 스키마
- `ssot.project_registry` — 프로젝트 id 단일 소스
