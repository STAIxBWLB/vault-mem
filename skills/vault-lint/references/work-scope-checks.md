# work 스코프 검사 (L04, L06, L07, L08)

- `work/project-registry.yaml`, `Glob work/**/*-summary.md` (L06), `Glob work/**/*` (L07, L08), `Glob <ideation>/seeds/*.md` (L04)

**L04: stale seed**
1. `Glob <ideation>/seeds/*.md` + vault 쪽 ideation 노트 (있으면)
2. 각 파일 mtime 확인 (work은 Bash stat, vault 노트는 `vmem_list`가 주는 `mtime`, `reports/`·`ops/` 파일은 `vmem_list_files`)
3. 현재 - mtime > `scratchpad.ideation_review_days`(기본 90) → 위반

**L06: 신 스키마 불일치 (marker-based scope)**

inbox summary 스키마 강제는 inbox item에서 만든 파일에만 적용한다. **검사 대상 식별 marker는 frontmatter 존재 여부**.

1. `Glob work/**/*-summary.md`
2. 각 파일 Read → 첫 줄 `---` 확인
3. **`---` 없음 → 스킵** (inbox-process 출력 아님, 사람 손작업 회고/리뷰/refs 등)
4. `---` 있음 → frontmatter 파싱 → 필수 필드 누락 시 → warn
   - 필수: `title`, `received`, `type`, `project`
   - 출처 필수 (택1): `source` (inbox 경유) **또는** `source_url`/`source_detail_url` (웹 직접 참조). 둘 다 없으면 위반.
5. 구 포맷 H1 + `- **원본**:` 블록 검사는 폐기 (marker-based scope에서 자연 제외)

**L07: 명명 규칙**
1. `Glob work/**/*` (서브모듈 제외, 예외 파일/경로 제외, §Legacy Exemptions 참조)
2. 파일명이 `YYMMDD-[a-z0-9][a-z0-9-]*\.[a-z]+` 패턴에 맞는지
3. 예외: `README.md`, `AGENTS.md`, `CLAUDE.md`, `INDEX.md`, `.git*`, `_guides/*`, `_templates/*`, `templates/*`, 회의록(`YYMMDD-meeting-<slug>.md` 영문 패턴)
4. 패턴 위반 → 위반 (단 Legacy Exemptions 경로는 제외)

**L08: 한글 파일명**
1. `Glob work/**/*` 결과에서 파일명 또는 경로에 `[가-힣]` 포함 여부
2. 있으면 → 위반
3. 예외 (§Legacy Exemptions 참조): `trips/**`, legacy 계약/MOU/연구 과제 경로
4. `meetings/**` 는 **무조건 면제하지 않는다**. 날짜 게이트 적용 (워크스페이스 `ssot.rules`의 naming-and-placement 규칙이 권위):
   legacy 회의록(mtime/파일명 날짜가 2026-05-26 이전, 또는 신규 `YYMMDD-meeting-<slug>.md` 패턴에 맞지 않는 한글 파일)만 면제하고,
   영문화 대상(2026-05-26 이후 신규 생성 또는 마이그레이션 대상)인 한글 회의록 파일명은 여전히 위반으로 플래그한다.

## Legacy Exemptions (L07, L08 공통)

Legacy exemptions are workspace policy, not skill-package policy. Load them from the workspace rules directory when available. If no workspace rule exists, use only generic defaults:

- hidden/runtime directories such as `.git`, `.github`, `.obsidian`, `.vscode`, `.cache`, `.venv`, `node_modules`, framework build folders, and secret stores
- generated inbox/drop or raw-source folders
- independent submodules or vendored repositories with their own naming conventions
- legally preserved originals such as contracts, signed documents, travel receipts, and external forms

These exemptions are not permission to create new badly named files. They only prevent noisy lint output for historical or tool-owned content.

**[G3] 표준 OSS 메타 파일 (filename allowlist, 어디서나 허용)**

L07 명명 규칙에서 다음 파일명은 위치 무관하게 통과 (한글 미포함이라 L08 영향 없음):

```
README.md, README, AGENTS.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md,
CHANGELOG.md, LICENSE, LICENSE.md, NOTICE, SECURITY.md,
CLAUDE.md, INDEX.md, _index.md,
package.json, package-lock.json, pnpm-lock.yaml, yarn.lock,
tsconfig.json, jsconfig.json, tsconfig.*.json,
requirements.txt, requirements*.txt, pyproject.toml, poetry.lock, setup.py, setup.cfg,
uv.lock, Cargo.toml, Cargo.lock, go.mod, go.sum,
Makefile, Dockerfile, docker-compose.yml, docker-compose.*.yml,
*.code-workspace,
.gitignore, .gitmodules, .gitattributes, .editorconfig, .nvmrc, .gitkeep,
.dockerignore, .npmignore, .eslintrc*, .prettierrc*,
.pre-commit-config.yaml, .coveragerc, .copier-config.yaml, .copierignore,
manifest.json, mkdocs.yml, _config.yml,
dependabot.yml, dependabot.yaml
```

**신규 파일 규칙은 변함없다**:
- 위 경로 밖 신규 파일은 L07/L08 error
- 위 경로 내 신규 파일이라도 에이전트가 생성한 것이라면 리뷰에서 반려
- Exemption은 과거 누적분 + 도구 상태 영역에 대한 pragmatic 처리
