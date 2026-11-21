---
name: vault-stats
trigger: /vault-stats
description: Show vault statistics and health, then recommend the highest-value next action
---

# /vault-stats

> Before the first vmem call, read `references/vault-adapter.md` §Runtime Discovery and select and bind the vmem vault id; pass it as `vault` on every vmem tool call and as the `<vault>` argument of every `vmem` CLI command.

Without a workspace, skip the work git scan and workspace-dependent source comparisons when unavailable, report them as skipped, and rank the remaining available conditions. Display comprehensive vault statistics, then recommend the most valuable next action from them (§Next action). `/vault-stats next` skips the full report and gives only the recommendation.

## Metrics

1. **Size**: total notes, by type, by domain; bytes and words per group (`vmem_stats` `size`)
2. **MOCs**: domain MOC note counts, topic MOC list
3. **Connections**: average links per note, orphan count/ratio
4. **Sync lag**: days since `ops/sessions/last-sync-timestamp`
5. **Activity**: recently created/modified notes
6. **Growth**: notes per week/month trend
7. **Quality**: schema compliance rate
8. **Note-to-source ratio**: note bytes over the bytes of the workspace files the notes cite (`vmem_stats` `ratio`: median, p90, `overOne`, `largest`, and the `skipped` / `emptySourceNotes` / `truncatedNotes` caveats)

## Process

Do not recompute what the lint/graph pipeline already produces:

1. Size / ratio / Activity / Growth: `vmem_stats` — `size` (bytes and words, total and by type and domain), `ratio` (median and p90 of note bytes over readable source bytes, `overOne`, `largest` notes, and what the pass left out: `skipped`, `skippedNonFile`, `emptySourceNotes`, `truncatedNotes`), notes by status, notes modified in the last 7 and 30 days, log events by type; `vmem_mocs` for MOC sizes; the recently created/modified notes themselves from `vmem_log_tail`. A ratio question is answered from `ratio`, never from a hand count of source files. Growth beyond those windows: read-only vault git history, or report it as unavailable
2. Connections (edges, density, top hubs): read the latest `reports/graph-report-YYMMDD.md` and `reports/graph-trend.md` — report totals only; neighbour or community questions go to `vmem_graph_neighbors`
3. Orphan count, broken links, schema compliance and proven-without-source notes: run `vmem lint <vault> --json` (or `vmem_lint`) and take the L03 / L01 / L02 / L15 counts (same numbers `/vault-lint vault` reports)
4. Read `ops/sessions/last-sync-timestamp`
5. For the next-action conditions: notes whose `mtime` is older than 90 days from a paged `vmem_list`; observation and tension counts from `vmem_list_files` on `ops/observations` and `ops/tensions` (a directory that does not exist yet counts as 0), and their thresholds from `ops/config.yaml` (`vmem_read_file`); work files changed since the sync timestamp from a read-only `git log --since` in the workspace (count only, as `/vault-sync` Step 1B scans)
6. Assemble metrics

## Next action

Rank maintenance conditions from the metrics above and recommend one action:

- Orphan notes or island communities → `/vault-connect`
- Notes not updated for more than 90 days → `/vault-update`
- Work sources changed since `ops/sessions/last-sync-timestamp` → `/vault-sync` (or `/vault-sync targets` for a known list)
- Observation or tension count at or above the `ops/config.yaml` thresholds → `/vault-rethink`

Priority: 1. critical (schema violations, broken links); 2. high (unsynced work sources, orphan drift); 3. medium (stale notes, pending observations); 4. low (optimization, MOC refinement).

## Output
- Formatted statistics report: notes and bytes/words by type and domain, note-to-source ratio (median, p90, `overOne` with its largest offenders, and the skipped/truncated counts next to them so a partial pass never reads as full coverage)
- Highlight any metrics outside healthy thresholds
- Recommended next action with reasoning, estimated effort and the command to run
