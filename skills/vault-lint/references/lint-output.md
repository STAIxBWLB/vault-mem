# Lint 출력 노트 구조

`vault/reports/lint-report-YYMMDD.md` 구조. vault 스코프 섹션(L01·L02·L03·L09·L10·L11·L12·L13·L14·L15)은 `vmem lint`의 `markdown`과 `findings`를 그대로 옮기고, work 스코프 섹션(L04·L06·L07·L08)은 에이전트가 채운다.

```markdown
---
type: report
generated: YYYY-MM-DDTHH:MM
scope: full
summary:
  errors: N
  warnings: N
---

# Lint Report YYYY-MM-DD

## 요약

- error: N건
- warn: N건
- scope: full

## L01 — dead wiki-link (error, N건)

- `notes/foo.md`: `[[missing-target]]` → 대상 노트 없음 — suggested `notes/foo-bar.md` (score 0.812)
- ...

## L02 — 필수 frontmatter 누락 (error, N건)

- `notes/bar.md`: `type` 필드 없음
- ...

## L03 — orphan (warn, N건)

- `notes/baz.md`: in-link 0, topics 0

## L04 — stale seed (warn, N건)

- `work/scratchpad/ideation/seeds/YYYY-MM-DD-foo.md`: 146일 미갱신

## L06 — 신 스키마 불일치 (warn, N건)

- `work/projects/example/admin/YYMMDD-report-summary.md`: frontmatter 없음 (구 포맷)

## L07 — 명명 규칙 (warn, N건)

- `work/projects/foo/Report Draft.md`: 공백 포함, 소문자 아님

## L08 — 한글 파일명 (error, N건)

- `work/projects/bar/보고서.pdf`

## L09 — 로그 포맷 (warn, N건)

- `log:42`: TYPE `FOO` 미등록 (정규 12종·정규화표 모두 없음)
- `log:1798`: 구조 위반 (불릿 접두, 시각 컬럼 누락)

정보: legacy TYPE 45건 (정규화표 등재), 최종 사용 YYYY-MM-DD, 신규 발생 없음

## L10 — project 미등록 (warn, N건)

- `notes/xyz.md`: `project: unknown-project` (registry 없음)

## L11 — graph report staleness (warn, N건)

- `vault/reports/graph-report-YYMMDD.md`: 7일 초과 (최신: YYMMDD, 현재: YYMMDD). `/vault-graph build` 재실행 권장

## L12 — island community (warn, N건)

- island community (2 notes): `person-a`, `person-b` — `/vault-connect` 필요

nodes 446 / edges 2457 / communities 9; singleton 6개: `concept-a`, `person-c`, ...

## L13 — 명명 규칙 (vault note, error, N건)

- `notes/Project Brief.md`: 소문자 ASCII kebab-case 아님 → `vmem_move`로 `notes/project-brief.md`

## L14 — source 미해소 (warn, N건)

- `notes/abc.md`: `source: work/projects/gone/file.md` 경로 없음

## L15 — proven confidence의 source (warn, N건)

- `notes/def.md`: `confidence: proven`인데 `source` 없음

## 제안 조치

- L01: finding이 제안한 `suggested` 타깃을 먼저 검토 — 맞으면 wiki-link 수정, 없으면 대상 노트 생성 (`/vault-extract`); 한 노트만 볼 때는 `vmem_links(path)`가 같은 제안을 dead link마다 하나씩 준다
- L02: `vault-adapter.md` 정책에 맞춰 frontmatter 보강
- L03: `/vault-connect` 재실행 또는 topics 추가
- L11: `/vault-graph build` 재실행으로 graph report 갱신
- L12: `/vault-connect` 재실행으로 island community 노트에 cross-community wiki-link 추가
- L13: `vmem_move`로 kebab-case stem으로 rename (링크 재작성 포함)
- L15: 근거(memory id·URL·workspace 경로)를 `source`에 넣거나 confidence를 낮춘다
- L06: 신 스키마로 점진 마이그레이션 (수동)
- L08: 파일명 영문화 (즉시 수정 권장)
```
