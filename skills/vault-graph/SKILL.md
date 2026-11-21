---
name: vault-graph
trigger: /vault-graph
description: >
  지식그래프 빌드·분석·질의 스킬. vault 그래프와 workspace 레이어를 `vmem graph build`로 빌드한다.
  커뮤니티 탐지, god node 분석, surprising connections를 제공한다.
---

# /vault-graph [command]

> Before the first vmem call, read `references/vault-adapter.md` §Runtime Discovery and select and bind the vmem vault id; pass it as `vault` on every vmem tool call and as the `<vault>` argument of every `vmem` CLI command.
>
> Graph builds and queries require vmem >= 0.8.0. Check the version as described in the adapter; if the MCP host does not expose it, report it as unknown and check tool availability.

Knowledge graph build, query, and report for vault notes and the workspace layer. Run workspace builds and workspace weekly-job steps only when a workspace exists; otherwise skip and report them, and use the vault-only build. No code graph and no graph MCP server.

`vault-graph` owns the graph workflow.

## Shared Runtime

| Item | Path |
|------|------|
| Vault/workspace builder | `vmem graph build <vault> [--workspace]` (MCP `vmem_graph_build`) |

## Commands

### Query Commands (vmem reads, always available)
- **orphans**: notes with no incoming links (`vmem_lint` L03 — an in-link-0, topics-0 finding, so the count matches `/vault-lint`)
- **hubs**: notes with most connections (`vmem_graph_neighbors` `hops: 1` returns `degree` per node; a hub sweep uses the graph report's god-node table)
- **domain [name]**: all notes in a domain (`vmem_search` with `domain`)
- **cross [domain1] [domain2]**: notes linking across domains (`vmem_graph_neighbors` per note with `hops: 1`, comparing the two neighbours' domains)
- **backlinks [note]**: all notes linking to a specific note (`vmem_links` with `direction: "in"`)
- **density**: connection density metrics (graph report totals: nodes, edges, communities, isolates, density)
- **stale [days]**: notes not modified in N days (`vmem_list` `mtime`)

### Build Commands
- **build**: Run community detection + analysis pipeline. Outputs:
  - `vault/reports/vault-graph.json` (node-link JSON)
  - `vault/reports/graph-report-YYMMDD.md` (audit report; 구 리포트는 보존되고 `graph-trend.md`에 빌드마다 행 1개가 추가된다)
- **build --workspace**: Add the work operational layer → `vault/reports/workspace-graph.json` (vault-graph.json untouched; no report written). **On demand only**; the weekly ritual does not build it. See below.
- **neighbors [note]**: 1-hop neighborhood + community of a note through `vmem_graph_neighbors` (no build, no report or `vault-graph.json` read).
- **path [note-a] [note-b]**: shortest link path between two notes through `vmem_graph_path` (no build, no report or `vault-graph.json` read)
- **report**: Read the latest graph report (if < 7 days old)
- **communities**: List detected communities from latest build
- **surprises**: List cross-community surprising connections
- **god-nodes**: Show most-connected non-MOC nodes

## Build Process (`/vault-graph build`)

Options:
- `--vault`: build the vault graph
- `--workspace`: build the vault layer **plus** the work operational layer → `workspace-graph.json`

1. Execute:
   ```bash
   vmem graph build <vault>               # --vault (MCP: vmem_graph_build)
   vmem graph build <vault> --workspace   # --workspace (MCP: vmem_graph_build workspace: true)
   ```
2. Pipeline: read notes → extract graph → deterministic Leiden community detection → god node analysis → surprising connections → report. vmem's graph block carries `partitioner: "leiden"` and its report prints the same name, so use Leiden everywhere (MOCs and business-unit hubs excluded). 커뮤니티 제목은 **anchor 노트**(degree 최대 멤버)로 붙고 정수 id는 "do not cite" 줄에만 남는다(빌드마다 재배정되므로 인용 금지).
3. Outputs:
   - vault: `<vault.path>/reports/vault-graph.json`, `<vault.path>/reports/graph-report-YYMMDD.md` (+ `graph-trend.md` 행 추가, 구 리포트 보존)
   - workspace: `<vault.path>/reports/workspace-graph.json` only (no report or trend row; the result lists the work counters)
4. vmem writes the vault and workspace outputs and records the GRAPH event itself; add no log line. A build whose receipt is `ok: false` names the rule that stopped it; stop and report it.
   The weekly ritual is a **single** vault build, run by the workspace's weekly job (`--workspace` is on-demand only). Order: build → lint → vault push → work pointer bump.

## Neighbors Process (`/vault-graph neighbors <note>`)

1-hop neighborhood + community of a note, read through `vmem_graph_neighbors`, which builds the graph from the current index on each call (no report read, no `jq`, no rebuild). Used by the workspace's context-enrichment graph-neighborhood step.

```text
vmem_graph_neighbors(path: "<stem>", hops: 1, limit: 50)   # MCP
vmem graph neighbors <vault> <stem> --hops 1 --limit 50     # CLI
```

- The result carries `nodes` (each with `community` and `degree`), the `edges` among them and `truncated`; `hops: 2` widens the walk and `relation` (`wiki_link` or one typed relation) narrows the edge set.
- Report the node's `community`, its degree-ranked neighbors (≤10), and same-community co-members.
- Backlinks, orphans and staleness come from vmem too: `vmem_links(path, direction: "in")`, `vmem_lint` L03, and `vmem_list` `mtime` — never a ripgrep pass over `notes/`.
- expect: vmem refuses `hops` outside 1–2, a `limit` outside 1–500, an unknown `relation` and an unknown note.

## Path Process (`/vault-graph path <note-a> <note-b>`)

Shortest link path between two notes, read through `vmem_graph_path`, which builds the graph from the current index on each call (no report read, no `jq`, no rebuild).

```text
vmem_graph_path(from: "<stem-a>", to: "<stem-b>", maxHops: 6)                        # MCP
vmem graph path <vault> <stem-a> <stem-b> [--max-hops 1..6] [--relation REL] [--via-hubs] [--json]   # CLI
```

- The walk is undirected BFS with neighbours visited in code-point order, so the same pair and options always return the same path. The result carries `found`, `length` in hops, the ordered `nodes` and the `edges` between them (each edge keeping its `relation`).
- `maxHops` is 1–6 and defaults to 6: a pair farther apart than that comes back `found: false`, not as an error.
- `viaHubs` is off by default, so `moc` and `bu` hubs are not intermediate steps; set it when the only route runs through a MOC. `relation` (`wiki_link` or one typed relation) narrows the edge set.
- expect: vmem refuses `maxHops` outside 1–6, an unknown `relation` (`use wiki_link or supports, contradicts, extends, applies-to, context-for`), and an unknown `from` or `to` note. `from` equal to `to` returns `found: true, length: 0`; a pair with no route within `maxHops` returns `found: false` with `length: 0` and empty `nodes`/`edges`, a result and not a refusal.

## Report Process (`/vault-graph report [target]`)

1. Resolve report directory: `<vault.path>/reports/graph-report-*.md`.
2. Select newest report and warn if older than 7 days.
3. Read it with `vmem_read_file`.
4. Summarize overview, god nodes, top communities, surprising connections, and isolate count.

## Query Process (`/vault-graph query "<question>" [options]`)

An ad-hoc graph question is a vmem read, never a pass over `graph.json`. Pick the read that matches the question:

| Question | Read |
|---|---|
| open question about a topic | `vmem_brief` with the question as `intent` |
| words that must appear in a note | `vmem_search` |
| what surrounds one note | `vmem_graph_neighbors` (`hops: 2`, optional `relation`) |
| what links to one note | `vmem_links` with `direction: "in"` |
| how two notes are connected | `vmem_graph_path` (`from`/`to` stems; `maxHops` 1–6, `relation`, `viaHubs`) |
| vault-wide shape (hubs, communities, cross-community links) | latest graph report, after `/vault-graph build` when it is stale |

## Integration

- `/vault-connect` Step 0 discovers candidates with `vmem_brief` and `vmem_graph_neighbors`, never by reading this report
- `/vault-sync` duplicates come from `vmem_brief` with the source path; the graph report is not a dedup signal
- `/vault-lint` checks L11 (graph staleness > 7 days), L12 (island communities, reported by member list)
- `skill-mine` mines skill candidates with `vmem skills mine`, which uses the same deterministic Leiden communities
- The workspace agent guide may point T2/T3 operations at the graph report before a full vault search
