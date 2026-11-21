# vault 스코프 판정 규칙 (L01, L02, L03, L09~L15)

`vmem lint`가 구현한 판정 규칙의 요약. finding을 설명하거나 수정 제안을 쓸 때, `note=<path>` 결과를 판정할 때 기준으로 쓴다.

- **L01**: 본문 `[[x]]` + frontmatter wiki-link 필드(`topics`·`project`·`projects`·`supersedes`·`superseded_by`; alias `[[name|display]]`는 `name`만)가 `notes/<x>.md`로 해소되지 않으면 error. 각 finding은 존재하는 노트 중 최대 하나를 `suggested <path>`(title 검색 점수)로 제안하므로, 수정 제안은 그 후보를 먼저 검토하고 없을 때만 직접 찾는다. **MOC 정책**: `topics:`는 MOC만 허용, 키워드 wiki-link는 L01 error(동일 가드: vault-extract §Preconditions, vault_adapter §Summary To Vault Fields)
- **L02**: `type` ∈ `insight | decision | observation | person | project | method | moc | reference`; `topics` 필수(단 `type: moc`는 `topics` 미요구 + `description` 필수); `confidence` ∈ `proven | likely | experimental`, `status` ∈ `active | superseded | archived`, **값이 있을 때만** 검사(없으면 통과). `status`는 노트 생애주기이지 사업 진행 상태가 아니다(작업 상태는 본문에). 정보 줄: `status: superseded` 건수(0이면 supersede 프로토콜 미가동 표시)
- **L03**: topics 0 AND in-link 0 → orphan. **hub MOC `notes/index.md`는 예외**(3-tier 루트, 설계상 in-link·topics 없음). 도메인 MOC는 예외 아님
- **L09**: 아래 §L09 참조
- **L10**: `project:` 값이 `[[x]]`면 `notes/x.md` 실존, plain이면 registry id, 둘 다 아니면 warn
- **L11**: 최신 `graph-report-YYMMDD.md`가 7일 초과/부재 → warn(`/vault-graph build` 권장)
- **L13**: 파일명이 소문자 ASCII kebab-case가 아니면 error. 이름 변경은 `vmem move`(legacy 이름 원본 허용)
- **L14**: frontmatter `source:` 경로가 해소되지 않으면 warn
- **L15**: `confidence: proven`인데 `source`가 비어 있으면 warn — 근거(memory id·URL·workspace 경로)를 넣거나 confidence를 낮춘다. `--note` 스코프에서도 함께 필터된다
- **L12**: `vault-graph.json`에서 cross-community edge 0인 커뮤니티 → warn, **멤버 목록(≤10 + N more)으로 보고**. 커뮤니티 번호는 빌드 로컬이라 인용 금지. singleton은 정보 줄

## L09

**L09: 로그 포맷** (스코프 정본: 워크스페이스 `ssot.ingest_chain` 규칙)

`vault/log`는 append-only라 과거 라인은 소급 수정하지 않는다(제안 조치에도 넣지 않음). warn은 **해결 가능한 신규 위반**에 한정한다:

1. **미등록 TYPE**: 정규 12종(`INGEST ROUTE EXTRACT CONNECT DIGEST LEARN LINT TASK GRAPH SYNC RETHINK SOURCE`)에도, 정규화표(`CREATE UPDATE MIGRATE REFACTOR MERGE MOVE RELOCATE RENAME DRAFT REVIEW RESEARCH REF CLEANUP CLOSE DONE SUPERSEDED DUPLICATE SKIP EDIT CORRECT`)에도 없는 TYPE
2. **구조 위반**: `YYYY-MM-DD HH:MM  TYPE  ...` 형태가 아닌 라인(불릿 접두, 시각 컬럼 누락 등; 경계 위반 라인도 여기서 잡힌다)
3. 라인 수 20k 초과 → "수동 아카이브 권장"

정규화표 등재 legacy TYPE은 warn이 아니라 **정보 1줄**(건수 + 최종 사용일 + "신규 발생 없음")로만 표기한다.
