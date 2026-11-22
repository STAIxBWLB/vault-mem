---
name: skill-mine
description: >
  여러 세션에 걸쳐 반복되는 업무를 찾아 새 스킬 후보로 뽑을 때
  (스킬 채굴, skill mine, 반복 패턴 감지, /skill-mine): amem 기억(curated·capture)과
  vault 노트를 `vmem skills mine`으로 사전 매칭·Leiden 커뮤니티·novelty 점수로 묶어
  순위를 매긴 스킬 후보 마크다운 리포트를 만든다. LLM·API 호출 없이 로컬·결정론적으로 동작.
---

# skill-mine: 기억 기반 스킬 후보 채굴 (LLM-free)

> Before the first vmem call, read `references/vault-adapter.md` §Runtime Discovery and select and bind the vmem vault id; pass it as the `<vault>` argument of the `vmem` CLI command (or `vault` on `vmem_skills_mine`).
>
> This skill requires vmem >= 0.8.0. Check the version as described in the adapter; if the MCP host does not expose it, report it as unknown and check tool availability.

## 언제 사용

- "자주 반복되는 업무를 스킬로 뽑아달라", "스킬 채굴", "반복 패턴 감지" 요청
- 주기 점검(주 1회 권장)으로 누락된 스킬 후보를 찾을 때
- 대상은 세션 1건이 아니라 여러 세션·프로젝트에 걸친 반복 패턴

## 실행

설치된 skill 디렉토리의 `vocab/`와 비교할 호스트 skill 디렉토리를 사용한다:

```bash
vmem skills mine <vault> --days 30 \
  --vocab <installed skill directory>/vocab \
  --skills <host skill directory>
```

- MCP만 있으면 `vmem_skills_mine`에 `vault`, `days`, `vocab`, `skills`를 전달한다. amem 데이터가 없으면 이용 가능한 vault 노트로 실행하고 누락된 입력을 보고한다.
- 입력: amem curated(decision·finding·contract·fail), amem capture(사용자 프롬프트·observation·summary), vault 노트(person·moc·reference 제외). 기간은 `--days`(기본 30), 프로젝트는 기본 전체이고 `--project <key>`로 좁힌다.
- 호스트가 `UserPromptSubmit`으로 주입한 합성 프롬프트(`<task-notification>`, `<channel `, `<agent-message `로 시작)는 사람 프롬프트가 아니므로 제외되고 리포트 `dropped:` 줄의 `synthetic N`으로 집계된다.
- 상한(20,000건·총 64 MiB)을 넘으면 실패하지 않고 최신 레코드만 남긴다. 리포트 머리의 `over cap:` 줄이 남긴 건수와 제외한 건수를 알려 준다. 그 줄이 보이면 `--days`를 줄이거나 `--project <key>`로 프로젝트별로 나눠 다시 실행한다.
- 표준출력이 리포트 본문(markdown)이다. `--json`은 후보·점수·출처별 건수를 구조화해 돌려준다. MCP에서는 `vmem_skills_mine`.
- workspace가 있으면 리포트를 `<workspace-root>/_meta/reports/skill-candidates-YYMMDD.md`로 저장한다. 없으면 사용자에게 결과를 보여주고 workspace 저장을 건너뛰었다고 보고한다. 같은 날 재실행은 덮어쓴다.
- `--skills`는 novelty 비교용 기존 스킬 카탈로그다. 사용 가능한 호스트 스킬 설치 디렉토리를 반복해서 넘긴다.
- 임계치 조정: `--min-size N`(기본 3), `--min-novelty X`(기본 0.3).
- expect: vmem refuses an unknown option, a missing `--vocab` file and, through MCP, a vault re-registered after the server started. 명령은 vault·vmem home·amem home에 아무것도 쓰지 않는다.

## 결과 해석

- **Candidates**: 커뮤니티 하나 = 한 업무 패턴. `rank`가 높을수록 재사용 가치가 크다. `novelty > 0.7`이면 신규 스킬 후보, `0.3~0.7`이면 기존 스킬 확장 여지(overlap 목록 확인), `cohesion > 0.3`이면 패턴이 뚜렷하다. `sources`는 curated·capture·vault 출처별 건수다.
- **God nodes**: 전체에서 가장 많이 연결된 어휘. 최근 업무의 공통 어휘를 보여준다.
- **Surprising connections**: 커뮤니티 경계를 넘는 어휘 쌍. 교차 영역 스킬 아이디어의 단서.
- **Rejected**: 크기·novelty 미달 클러스터(관찰용).
- samples는 마스킹되어 있다(registry 인물 `[PERSON]`, 이메일 `[EMAIL]`, 절대경로 `[PATH]`, vault `piiPatterns` `[PII]`). 리포트를 외부로 내보내기 전에 한 번 더 확인한다.

## 후속 작업

1. **승격**: 적합한 후보 1건을 골라 SKILL.md를 쓰고 스킬 소스 repo에 issue·PR로 추가한다(런타임 설치본 직접 수정 금지).
2. **확장**: 기존 스킬과 overlap이 높으면 그 스킬의 description·트리거에 새 표현을 더한다.
3. **사전 보강**: god nodes에 기대한 어휘가 없으면 `vocab/actions.yaml`·`vocab/objects.yaml`에 표제어를 추가한다.
