---
name: vault-rethink
trigger: /vault-rethink
description: Review accumulated observations and tensions for methodology evolution.
---

# /vault-rethink [mode]

> Before the first vmem call, read `references/vault-adapter.md` §Runtime Discovery and select and bind the vmem vault id; pass it as `vault` on every vmem tool call and as the `<vault>` argument of every `vmem` CLI command.

Review observations, tensions, and methodology drift.

## Modes

- **review**: Process pending observations and tensions + aging check
- **drift**: Detect configuration drift from derivation
- **full**: Complete methodology review (review + drift + aging)

## Process

### review mode

1. **Observations 처리**: `ops/observations/` + `ops/tensions/` 파일 읽기 (`vmem_list_files`·`vmem_read_file`). `tensions/`는 첫 긴장 기록 전까지 디렉토리 자체가 없다 — 부재는 드리프트가 아니라 미사용 상태
2. **Patterns 식별**: methodology·process·friction·surprise·quality 5 카테고리 그룹핑
3. **Methodology changes 제안**: evidence 기반, `M{N}` ID 부여
4. **Decisions 기록**: `ops/methodology/YYMMDD-rethink-report.md`를 `vmem_report(path: "ops/methodology/YYMMDD-rethink-report.md", body)`로 생성(vmem이 내용 검사 후 저장하고 기본 EXTRACT log를 남긴다). expect: vmem refuses secret-looking text and an unsafe `ops/` path (frontmatter + state snapshot + observations + tensions + proposed changes + drift check)

### drift mode

1. **Config ↔ Derivation 일치**: `ops/derivation.md` **§Design Dimensions 표** ↔ `ops/config.yaml` `dimensions`(8키) + `domains`(6) 를 키별로 대조. 한쪽에만 있는 키도 mismatch. 출력은 키별 match/mismatch 표 + 최종 판정(예: "8/8 dimensions + 6/6 domains match")
2. **AGENTS.md consistency**: vault AGENTS.md·work AGENTS.md 규칙이 최신 methodology와 일치하는지
3. **Skill SKILL.md vs 실제 사용**: spec-practice audit. 정식 스킬 목록은 스킬 번들의 `SKILL_INDEX.md` "Vault workflows" 줄에서 읽고, 그중 하나를 순환 선택하여 audit한다
4. **Report deviations**: drift table (Check / Status / Action)

### full mode

Review + drift 모두 실행.

## Triggers

- 10+ unprocessed observations (`ops/config.yaml` `maintenance.rethink_observations_threshold`)
- 5+ unprocessed tensions

## Output

- Pattern analysis from observations
- Proposed methodology changes (M{N} IDs, never auto-applied)
- Decision record if changes accepted
- Drift table (item 1은 키별 verdict 포함)

## Rule Zero

Changes require explicit approval. This skill proposes, user decides.

## 관련

- `ops/methodology/*-rethink-report.md` — 이전 라운드의 결정 기록 (`vmem_list_files`로 찾는다)
- `/vault-refactor rename` — note rename 워크플로우
