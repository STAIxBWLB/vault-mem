import { readAssertions, ASSERTIONS_PAGE_LIMIT } from "./assertion-read.ts";
import { vaultBrief } from "./vault-brief.ts";
import { applyProposal, confirmProposalReconciliation, listProposals, previewProposalApply, previewProposalReject, reconcileProposal, rejectProposal, showProposal, submitProposal, type ProposalContext } from "./proposal-provider.ts";
import { evidenceReport } from "./evidence.ts";
import { appendAssertions, assertFrameBytes, ASSERT_FRAME_BYTES, purgeAssertions, type AssertReceipt, type PurgeReceipt } from "./assertions.ts";
import { scanAssertionExposure, type ExposureReceipt } from "./assertion-exposure.ts";
import { explainGraphPath } from "./graph-evidence.ts";
import { createSpecMcp } from "./mcp-spec.ts";
import { SPEC_COMMANDS } from "./spec-command-table.ts";
import { analysisInput } from "./analysis-input.ts";
import { buildGraph, graphNeighbors, graphPath, LINK_RELATIONS } from "./vault-graph.ts";
import { lintVault } from "./vault-lint.ts";
import { writeAnalysisReports } from "./analysis-reports.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import type { VaultSpec } from "./config.ts";
import { loadRegistry, registryStatus } from "./registry.ts";
import { VaultIndex, MAX_NOTE_BYTES } from "./vault-index.ts";
import { CHANGES_PAGE_LIMIT, HISTORY_PAGE_LIMIT, SNAPSHOT_CURSOR_CHARS, readChanges, readHistory, readRevision } from "./vault-history.ts";
import { listVaultFiles, readVaultFile } from "./vault-files.ts";
import { appendLog, logBinding, readLog } from "./vault-log.ts";
import { STATS_MAX_DAYS, vaultStats } from "./vault-stats.ts";
import { applyWrite } from "./writer.ts";
import { notePath } from "./write-operations.ts";
import type { LogEvent } from "./log-types.ts";
import { LOG_EVENT_SCHEMA } from "./log-format.ts";
import type { PatchEdit, WriteOp, WriteReceipt, WriteRequest } from "./write-types.ts";
import type { McpHandler, McpTool } from "./mcp.ts";

const string = (maxLength: number, minLength = 1) => ({ type: "string", minLength, maxLength });
const integer = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const tool = (name: string, description: string, inputSchema: Record<string, unknown>, kind: "read" | "write" | "confirm" = "read"): McpTool => ({
  name, description, inputSchema, annotations: { readOnlyHint: kind === "read", destructiveHint: kind === "confirm", idempotentHint: kind === "read", openWorldHint: false },
});
const RELATIONS = ["supports", "contradicts", "extends", "applies-to", "context-for"];
const LOG_TYPES = ["INGEST", "ROUTE", "EXTRACT", "CONNECT", "DIGEST", "LEARN", "LINT", "TASK", "GRAPH", "SYNC", "RETHINK", "SOURCE"];
const note = string(1024), sha = { type: "string", minLength: 64, maxLength: 64 };
const evidenceItem = object({ source: string(512), sha256: sha, quote: string(2048), section: string(1024) }, ["source", "sha256", "quote"]);
const dateValue = string(10);
/** One assertion operation; the closed op-specific checks follow in `appendAssertions`. */
const ASSERT_OP = object({ op: { type: "string", enum: ["declare", "relink", "assert", "revise", "retract"] }, subject: string(66), label: string(200), note: string(1024), relation: string(64), value: string(1024),
  kind: { type: "string", enum: ["state", "event"] }, from: dateValue, to: dateValue, held_on: dateValue, on: dateValue, id: string(40),
  expected_heads: { type: "array", minItems: 1, maxItems: 32, items: sha }, reason: { type: "string", enum: ["recorded_in_error", "evidence_withdrawn", "other"] },
  evidence: { type: "array", minItems: 1, maxItems: 16, items: evidenceItem }, source: { type: "array", minItems: 1, maxItems: 32, items: string(512) } }, ["op"]);
const oid = { type: "string", minLength: 40, maxLength: 64, pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" };
const logEvent = LOG_EVENT_SCHEMA;
const scalar = { type: ["string", "number", "boolean", "null", "array"], maxLength: 4096, maxItems: 64, items: { type: ["string", "number", "boolean"], maxLength: 1024 } };
const metadata = { type: "object", maxProperties: 32, properties: { authors: { type: "array", minItems: 1, maxItems: 100, items: string(1024) } }, additionalProperties: scalar };
const proposalMetadata = { ...metadata, properties: { ...metadata.properties, evidence: { type: "array", maxItems: 16, items: object({ source: string(512), sha256: sha, quote: string(2048), section: string(1024) }, ["source", "sha256", "quote"]) } } };
const proposalOperation = object({ op: { type: "string", enum: ["create", "patch"] }, path: string(200), frontmatter: proposalMetadata, body: string(32768, 0), expectedSha: sha,
  edits: { type: "array", minItems: 1, maxItems: 32, items: object({ oldString: string(8192), newString: string(8192, 0) }, ["oldString", "newString"]) } }, ["op", "path"]);

/** Tool names for the implemented read, write, log, analysis and promotion providers. */
export const VMEM_TOOL_NAMES = ["vmem_status", "vmem_search", "vmem_brief", "vmem_read", "vmem_read_many", "vmem_list", "vmem_links", "vmem_history", "vmem_changes", "vmem_mocs", "vmem_check", "vmem_log_tail",
  "vmem_create", "vmem_patch", "vmem_append", "vmem_set_frontmatter", "vmem_link", "vmem_supersede", "vmem_log_append", "vmem_move", "vmem_merge", "vmem_delete", "vmem_promote_from_amem", "vmem_lint", "vmem_graph_build", "vmem_graph_neighbors", "vmem_graph_path", "vmem_graph_explain", "vmem_promote", "vmem_skills_mine", "vmem_read_file", "vmem_list_files", "vmem_report", "vmem_evidence", "vmem_stats", "vmem_proposal_submit", "vmem_proposal_list", "vmem_proposal_show", "vmem_proposal_apply", "vmem_proposal_reject", "vmem_proposal_reconcile", "vmem_assert", "vmem_assertions", "vmem_assertions_purge", "vmem_assertions_exposure", ...SPEC_COMMANDS.map(item => item.name)] as const;

/** Server `initialize` instructions: purpose, navigation order and the write contract. Pinned by a test, under 400 bytes. */
export const VMEM_INSTRUCTIONS = "vmem is a vault of durable, linked knowledge: notes with frontmatter, wiki-links and an append-only log. Search first with vmem_search, then read the best match with vmem_read, using section for one H2. Writes are validated and receipted: a refusal lists issues, and a failure after publication can leave changes behind, so read the receipt and its issues before retrying.";

/** Tool definitions for a fixed vault set: `vault` is an enum of the registered ids. */
export function vaultTools(ids: readonly string[], orgIds: readonly string[] = []): McpTool[] {
  const vault = ids.length ? { type: "string", enum: [...ids] } : string(32);
  const twoStep = { confirm: { type: "boolean" }, fingerprint: sha };
  const orgVault = orgIds.length ? { type: "string", enum: [...orgIds] } : string(32);
  return [
    tool("vmem_status", "Registered vaults with health, write policy, effective pii and the piiPolicy matrix (read-only).", object({})),
    tool("vmem_search", "Full-text (BM25) search over indexed notes. Literal AND terms.", object({ query: string(1000), vault, limit: integer(1, 50), type: string(64), domain: string(64) }, ["query"])),
    tool("vmem_brief", "Intent-ranked note pointers and one-hop neighbors, with metadata PII/deny screening and whole-line byte cap including the result JSON. No note bodies; read a selected pointer with vmem_read.", object({ vault, intent: string(1024), paths: { type: "array", maxItems: 16, items: string(1024) }, bytes: integer(256, 4096) }, ["intent"])),
    tool("vmem_read", "Read one note by stem, alias or notes/ path: frontmatter, body, sha256. Bounded by maxBytes; section selects an exact H2, offset pages UTF-8 byte ranges, and truncated reads list H2 headings/nextOffset. With revision, read that full commit id's blob for the path instead: the result carries revision, blob and content sha256 plus basis git_snapshot, within the 48 KiB transport bound.", object({ path: note, vault, maxBytes: integer(1, 65536), section: string(1024), offset: integer(0, MAX_NOTE_BYTES), revision: oid }, ["path"])),
    tool("vmem_read_many", "Read up to 20 notes (8 KiB each).", object({ paths: { type: "array", minItems: 1, maxItems: 20, items: note }, vault }, ["paths"])),
    tool("vmem_list", "List indexed notes under notes/ in path order, optionally by stem prefix, with each note's mtime and the filtered total. Pass the returned nextCursor as cursor for the next page.", object({ vault, prefix: string(256, 0), limit: integer(1, 500), cursor: string(1024) })),
    tool("vmem_links", "Outgoing links (with resolution) and/or incoming backlinks of a note. Each dead link carries at most one suggested existing target from the title search, with its score; it is a hint and the link is never rewritten.", object({ path: note, vault, direction: { type: "string", enum: ["out", "in", "both"] }, limit: integer(1, 200) }, ["path"])),
    tool("vmem_history", "Read-only Git snapshot history of one note path, newest first: full commit ids reachable from the vault HEAD, blob ids, sizes and Git commit metadata (never assertion time). Pinned to the HEAD the first page saw; pass the returned continuation as cursor. First-parent only, exact path only, at most 1000 commits traversed. Non-repositories, shallow history, unavailable Git, unreachable or pruned objects, revision expressions, symlinked and denied paths are reported or refused explicitly, never replaced with current content.", object({ vault, path: note, limit: integer(1, HISTORY_PAGE_LIMIT), cursor: string(SNAPSHOT_CURSOR_CHARS) }, ["path"])),
    tool("vmem_changes", "Compare two pinned commits over notes/ only: path, status and before/after blob ids, never a content diff. Both ids must be full commits reachable from the vault HEAD. At most 500 paths per page with a continuation cursor; denied and symlinked entries stay out.", object({ vault, from: oid, to: oid, limit: integer(1, CHANGES_PAGE_LIMIT), cursor: string(SNAPSHOT_CURSOR_CHARS) }, ["from", "to"])),
    tool("vmem_mocs", "MOC notes with incoming link counts.", object({ vault })),
    tool("vmem_check", "Validate a prospective note text without writing.", object({ vault, path: string(200), text: string(262144, 0) }, ["text"])),
    tool("vmem_log_tail", "Read the newest vault log lines, optionally filtered.", object({ vault, n: integer(1, 200), type: { type: "string", enum: LOG_TYPES }, grep: string(256) })),
    tool("vmem_create", "Create a validated note. Requires a vault with write=mcp.", object({ vault, stem: string(200), type: string(64), domain: string(64), topics: { type: "array", maxItems: 32, items: string(200) }, description: string(1000), title: string(300), body: string(65536, 0), source: { type: ["string", "array"], minLength: 1, maxLength: 512, minItems: 1, maxItems: 32, items: string(512) }, confidence: string(32), status: string(32), created: string(32, 0), extra: metadata, log: logEvent }, ["stem", "type", "domain", "description"]), "write"),
    tool("vmem_patch", "Replace exact strings in a note: one oldString/newString pair, or edits (1..32 pairs, each matching once in the original text, non-overlapping) applied all-or-nothing with one receipt and one log event.", object({ vault, path: note, oldString: string(8192), newString: string(8192, 0), edits: { type: "array", minItems: 1, maxItems: 32, items: object({ oldString: string(8192), newString: string(8192, 0) }, ["oldString", "newString"]) }, expectedSha: sha, log: logEvent }, ["path"]), "write"),
    tool("vmem_append", "Append markdown to a section of a note.", object({ vault, path: note, section: string(120), markdown: string(16384), expectedSha: sha, log: logEvent }, ["path", "section", "markdown"]), "write"),
    tool("vmem_set_frontmatter", "Set or unset frontmatter keys of a note.", object({ vault, path: note, set: metadata, unset: { type: "array", maxItems: 32, items: string(64) }, expectedSha: sha, log: logEvent }, ["path"]), "write"),
    tool("vmem_link", "Add a typed relation link between two notes (bidirectional by default).", object({ vault, from: note, to: note, relation: { type: "string", enum: RELATIONS }, context: string(500), bidirectional: { type: "boolean" }, log: logEvent }, ["from", "to", "relation"]), "write"),
    tool("vmem_supersede", "Mark a note superseded by another.", object({ vault, old: note, next: note, log: logEvent }, ["old", "next"]), "write"),
    tool("vmem_log_append", "Append one validated event line to the vault log.", object({ vault, type: { type: "string", enum: LOG_TYPES }, project: string(64), source: string(512), dest: string(512), note: string(500) }, ["type", "project", "source", "note"]), "write"),
    tool("vmem_move", "Two-step rename with link rewrites: without confirm returns preview and fingerprint; then confirm=true with that fingerprint (pass log on the confirm call).", object({ vault, from: note, to: note, ...twoStep, log: logEvent }, ["from", "to"]), "confirm"),
    tool("vmem_merge", "Two-step note merge: without confirm returns merged body, source/topic unions, inbound link rewrites and fingerprint without writing. Then confirm=true with that fingerprint writes keep, repoints inbound links and marks absorb superseded under one mutation lock (pass log on the confirm call). Different types, person/moc notes and oversized results refuse.", object({ vault, keep: note, absorb: note, ...twoStep, log: logEvent }, ["keep", "absorb"]), "confirm"),
    tool("vmem_delete", "Two-step delete: without confirm returns preview (or refusal), backlinks and fingerprint; then confirm=true with that fingerprint (pass log on the confirm call).", object({ vault, path: note, ...twoStep, log: logEvent }, ["path"]), "confirm"),
    tool("vmem_promote_from_amem", "Two-step promotion of one durable agent-mem entry (id from amem_vault_candidates) into a vault note: without confirm returns the full note text, possible duplicates and fingerprint; confirm=true with that fingerprint creates the note, logs LEARN and records the agent-mem vault link. linkTo links an existing note instead. Configured canonTables add advisory canonical row matches and link-existing choices, outside the fingerprint and never blocking confirm.",
      object({ vault, id: { type: "string", minLength: 32, maxLength: 36 }, stem: string(120), type: string(64), domain: string(64), topics: { type: "array", maxItems: 32, items: string(200) }, description: string(1000), title: string(300), body: string(65536, 0), linkTo: note, project: string(400), ...twoStep }, ["id"]), "confirm"),
    tool("vmem_lint", "Lint a private derived snapshot; write=true writes a screened report.", object({ vault, write: { type: "boolean" }, dryRun: { type: "boolean" } }), "write"),
    tool("vmem_graph_build", "Build a deterministic graph and screened reports; dryRun changes nothing.", object({ vault, dryRun: { type: "boolean" }, workspace: { type: "boolean" } }), "write"),
    tool("vmem_graph_neighbors", "Read a bounded graph neighborhood.", object({ vault, path: note, hops: integer(1,2), limit: integer(1,500), relation: { type: "string", enum: ["wiki_link", ...LINK_RELATIONS] } }, ["path"])),
    tool("vmem_graph_path", "Read the shortest undirected link path between two notes (BFS, code-point tie order). MOC/bu hubs are not intermediates unless viaHubs. found=false when no path within maxHops (default 6).", object({ vault, from: note, to: note, maxHops: integer(1,6), relation: { type: "string", enum: ["wiki_link", ...LINK_RELATIONS] }, viaHubs: { type: "boolean" } }, ["from", "to"])),
    tool("vmem_graph_explain", "Explain the vmem_graph_path selection hop by hop from the same snapshot: each hop lists the link occurrences behind its edge (origin note path and sha256, line, UTF-8 byte range, body or frontmatter field, declared relation, authored from/to and forward/reverse traversal). legacy_graph_match marks the matches the graph used, with authored=true when also a validated link; anchored and frontmatter references are annotations that add no edge. structuralOnly=true: no quote proves a link and nothing is a probability. 20 occurrences per hop and 48 KiB total, with omitted counts. Writes nothing.", object({ vault, from: note, to: note, maxHops: integer(1,6), relation: { type: "string", enum: ["wiki_link", ...LINK_RELATIONS] }, viaHubs: { type: "boolean" } }, ["from", "to"])),
    tool("vmem_promote", "Two-step promotion of a personal note into a local org vault clone (never pushes): without confirm returns the full transformed text, dropped links, screen result and fingerprint; confirm=true with that fingerprint writes the org note, source provenance and SYNC log lines. Configured target-vault canonTables add advisory canonical row matches and link-existing choices; personal rows are never included and matches do not affect the fingerprint or block confirm. Publishing is the separate `vmem sync` CLI.",
      object({ path: note, to: orgVault, topics: { type: "array", maxItems: 32, items: string(200) }, again: { type: "boolean" }, ...twoStep }, ["path", "to"]), "confirm"),
    tool("vmem_skills_mine", "Read-only skill-candidate mining over amem curated entries, amem capture rows and vault notes: dictionary matching, deterministic communities and novelty scoring. Returns counts, masked candidates and a markdown report; writes nothing.",
      object({ vault, days: integer(1, 3650), project: string(400), allProjects: { type: "boolean" }, vocab: string(4096), skills: { type: "array", maxItems: 16, items: string(4096) }, minSize: integer(1, 10000), minNovelty: { type: "number", minimum: 0, maximum: 1 } })),
    tool("vmem_read_file", "Read one UTF-8 file outside notes/: ops/, reports/, self/, templates/, AGENTS.md or README.md. Same bounds and paging as vmem_read (maxBytes, offset, nextOffset); notes/ use vmem_read, the log vmem_log_tail. Never locks or writes.", object({ vault, path: string(1024), maxBytes: integer(1, 65536), offset: integer(0, MAX_NOTE_BYTES) }, ["path"])),
    tool("vmem_list_files", "List one directory level under ops/, reports/, self/ or templates/ (up to 500 entries; dot, linked and denied entries omitted). Never locks or writes.", object({ vault, dir: string(1024) }, ["dir"])),
    tool("vmem_report", "Write a screened report file under reports/ or ops/ (the MCP form of `vmem report`): same path rules, screening, write policy (write=mcp), receipt and EXTRACT log event; log overrides it, for example a LINT or GRAPH event. dryRun changes nothing.", object({ vault, path: string(200), body: string(65536, 0), dryRun: { type: "boolean" }, log: logEvent }, ["path", "body"]), "write"),
    tool("vmem_evidence", "Verify a note's version-1 evidence entries (source, sha256, quote, optional section): flat notes/*.md sources in the same vault are re-read on every call and reported verified, stale, missing, ambiguous or unsupported with UTF-8 byte offsets; other references are unverified_external without I/O. Proves that quoted bytes occur in a source version, not that a claim is true. Writes nothing, takes no lock, keeps no cache.", object({ vault, path: note }, ["path"])),
    tool("vmem_stats", "Read-only vault statistics: note counts by type, domain and status, note bytes and words in total and by type and domain, and the note-to-source byte ratio (median, p90 and the largest notes) over the workspace files the notes cite. A source counts at its own byte size on disk, so a decoded byte count never inflates a file that is not UTF-8; non-file, unreadable and over-cap sources are skipped and counted, and `truncatedNotes` counts the sourced notes the ratio's 10000-note cap left out. Also notes modified in the last 7 and 30 days, and log event counts by type over the last `days` (default 30). Writes no vault file or log and takes no vault or log lock.", object({ vault, days: integer(1, STATS_MAX_DAYS) })),
    tool("vmem_proposal_submit", "Screen and save one create or exact-patch proposal without modifying vault notes or the log. Agent labels are unverified.", object({ vault, operation: proposalOperation, agentLabel: string(256) }, ["operation"]), "write"),
    tool("vmem_proposal_list", "List screened proposal summaries, pending by default; pass nextCursor as after.", object({ vault, state: { type: "string", enum: ["pending", "applied", "rejected", "apply_unknown"] }, limit: integer(1, 100), after: string(36) })),
    tool("vmem_proposal_show", "Read a screened proposal operation in UTF-8 pages, with the complete encoded response bounded to 48 KiB.", object({ vault, id: string(36), offset: integer(0, 32768), maxBytes: integer(1, 16384) }, ["id"])),
    tool("vmem_proposal_apply", "Preview an apply, then confirm with its fingerprint. An interrupted apply remains apply_unknown and is never replayed automatically.", object({ vault, id: string(36), ...twoStep }, ["id"]), "confirm"),
    tool("vmem_proposal_reject", "Preview rejection with a reason, then confirm with the returned fingerprint; rejection does not change vault notes or log.", object({ vault, id: string(36), reason: string(4096), ...twoStep }, ["id", "reason"]), "confirm"),
    tool("vmem_proposal_reconcile", "Preview an uncertain apply using the target and durable writer receipt; confirm only with the preview fingerprint. Matching content alone does not prove attribution.", object({ vault, id: string(36), ...twoStep }, ["id"]), "confirm"),
    tool("vmem_assert", "Append one all-or-nothing batch of 1..32 temporal assertion operations (declare, relink, assert, revise, retract) to the vault's append-only assertions/ journal; the MCP form of `vmem assert`. Relink changes a declared subject's note while retaining its identity and label. vmem assigns ids, rev, recorded_at and hashes. Each assert or revise needs evidence (path sources verified at append) or source references; revise and retract need expected_heads equal to the current head set. Writes no note; a log line only with log. dryRun validates without lock or append. Requires write=mcp. Request and reply stay within 48 KiB.",
      object({ vault, ops: { type: "array", minItems: 1, maxItems: 32, items: ASSERT_OP }, dryRun: { type: "boolean" }, log: logEvent }, ["ops"]), "write"),
    tool("vmem_assertions", "Read verified temporal assertions with current policy and bounded pages. The journal is the source of truth; results include a verified pin and coverage. Pass continuation as cursor.", object({ vault, subject: string(66), relation: string(64), at: string(10), asOf: string(20), history: { type: "boolean" }, limit: integer(1, ASSERTIONS_PAGE_LIMIT), cursor: string(512) })),
    tool("vmem_assertions_purge", "Two-step purge of one assertion's payloads from the append-only journal: without confirm it returns the affected entries, segment counts and a fingerprint and writes nothing. confirm=true with that fingerprint rewrites each affected segment through a temporary file and a rename under assertions.lock, removes payload, keeps payload_sha256 and every hashed field, and adds purged {at, reason}, so the chain still verifies; reads then show the assertion as unavailable and count it in coverage.purged. The reason stays in the journal. Bytes in Git history, other clones or remotes need a history rewrite outside vmem. Requires write=mcp.", object({ vault, id: string(40), reason: string(200), ...twoStep }, ["id", "reason"]), "confirm"),
    tool("vmem_assertions_exposure", "Read-only exposure report for purged assertion payloads: does a commit reachable from local branches, tags or remote-tracking refs still hold a purged entry's line with a payload, matched by seg, seq and hash with the payload's SHA-256 equal to payload_sha256? Reads only assertions/*.jsonl blobs and reports position, hash, commit count and refs per entry, the scanned counts, clean and truncated. It never prints payload text. Bounded per blob (8 MiB), per commit (64 MiB) and overall (100000 commits); crossing a bound sets truncated and is never clean. A vault that is not a Git repository reports clean: null. The scan covers this local repository only. The history rewrite, the force push, reflog expire and gc stay with the person: vmem never runs them. Replies stay within 48 KiB by dropping refs first, then rows with an omitted count.", object({ vault, assertion: string(40) })),
  ];
}
type Issue = { code: string; severity: "error"; message: string };
const refusal = (code: string, message: string) => ({ refused: true as const, issues: [{ code, severity: "error", message } as Issue] });
/** Keep a `vmem_assert` reply inside the 48 KiB frame bound without hiding a batch that was already applied. */
export function assertReply(reply: AssertReceipt & { refused?: true }): unknown {
  if (assertFrameBytes(reply, "result") <= ASSERT_FRAME_BYTES) return reply;
  const count = reply.entries.length;
  const note: Issue = { code: "LIMIT", severity: "error", message: `the reply exceeds ${ASSERT_FRAME_BYTES} bytes as an encoded JSON-RPC frame; ${count} ${count === 1 ? "row was" : "rows were"} ${reply.applied ? `appended to segment ${reply.segment} and the rows are omitted` : "not appended and the rows are omitted"}. Read the journal for their ids, and send smaller batches` };
  const trimmed = [{ ...reply, entries: [], issues: [...reply.issues.slice(0, 4), note] }, { ...reply, entries: [], issues: [note] },
    { ok: reply.ok, applied: reply.applied, dryRun: reply.dryRun, segment: reply.segment, ...(reply.recordedAt ? { recordedAt: reply.recordedAt } : {}), ...(reply.refused ? { refused: reply.refused } : {}), entries: [], recovery: [], indexUpdated: false as const, issues: [note] }];
  return trimmed.find(candidate => assertFrameBytes(candidate, "result") <= ASSERT_FRAME_BYTES) ?? trimmed[trimmed.length - 1];
}
/** Keep a `vmem_assertions_purge` reply inside the 48 KiB frame bound without hiding what was rewritten. */
export function purgeReply(reply: PurgeReceipt & { refused?: true }): unknown {
  if (assertFrameBytes(reply, "result") <= ASSERT_FRAME_BYTES) return reply;
  const entries = reply.entries.length, segments = reply.segments.length;
  const note: Issue = { code: "LIMIT", severity: "error", message: `the reply exceeds ${ASSERT_FRAME_BYTES} bytes as an encoded JSON-RPC frame; ${entries} ${entries === 1 ? "entry" : "entries"} in ${segments} ${segments === 1 ? "segment" : "segments"} are omitted and ${reply.applied ? "those segments were rewritten by this confirm" : "the preview wrote nothing"}. Read vmem_assertions --history for the ids, and purge fewer entries at a time` };
  const trimmed = [{ ...reply, recovery: [], issues: [...reply.issues.slice(0, 4), note] },
    { ...reply, entries: [], recovery: [], issues: [note] },
    { ok: reply.ok, applied: reply.applied, preview: reply.preview, vault: reply.vault, assertion: reply.assertion, reason: reply.reason, ...(reply.at ? { at: reply.at } : {}), fingerprint: reply.fingerprint, entries: [], segments: reply.segments, alreadyPurged: reply.alreadyPurged, omitted: reply.omitted, recovery: [], ...(reply.refused ? { refused: reply.refused } : {}), issues: [note] },
    { ok: reply.ok, applied: reply.applied, preview: reply.preview, vault: reply.vault, assertion: reply.assertion, reason: reply.reason, ...(reply.at ? { at: reply.at } : {}), fingerprint: reply.fingerprint, entries: [], segments: [], alreadyPurged: reply.alreadyPurged, omitted: reply.omitted, recovery: [], ...(reply.refused ? { refused: reply.refused } : {}), issues: [note] }];
  return trimmed.find(candidate => assertFrameBytes(candidate, "result") <= ASSERT_FRAME_BYTES) ?? trimmed[trimmed.length - 1];
}
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

/** Keep a `vmem_assertions_exposure` reply inside the 48 KiB frame bound: refs first, then rows with an omitted count. */
export function exposureReply(reply: ExposureReceipt & { refused?: true }): unknown {
  if (assertFrameBytes(reply, "result") <= ASSERT_FRAME_BYTES) return reply;
  const stripped = { ...reply, exposed: reply.exposed.map(row => ({ ...row, refs: [] })), refsOmitted: true as const };
  if (assertFrameBytes(stripped, "result") <= ASSERT_FRAME_BYTES) return stripped;
  for (let keep = stripped.exposed.length - 1; keep >= 0; keep--) {
    const candidate = { ...stripped, exposed: stripped.exposed.slice(0, keep), omitted: reply.exposed.length - keep };
    if (assertFrameBytes(candidate, "result") <= ASSERT_FRAME_BYTES) return candidate;
  }
  return { ...reply, exposed: [], refsOmitted: true as const, omitted: reply.exposed.length };
}

/**
 * Handlers over the shared providers (VaultIndex, applyWrite, appendLog/readLog). The vault set and
 * the default (first personal) are fixed when the server starts; later registry changes need a restart.
 */
export function createVaultMcp(home: string, env: NodeJS.ProcessEnv = process.env): { tools: McpTool[]; handlers: Record<string, McpHandler>; vaults: VaultSpec[]; defaultVault: string | undefined; instructions: string } {
  const startup = loadRegistry(home), vaults = startup.vaults, ids = vaults.map(v => v.id);
  const proposalBindings = new Map(vaults.map(v => { try { return [v.id, logBinding(v, startup)] as const; } catch { return [v.id, null] as const; } }));
  const defaultVault = (vaults.find(v => v.kind === "personal") ?? vaults[0])?.id;
  const pick = (args: Record<string, unknown>): VaultSpec => {
    const id = str(args.vault) ?? defaultVault;
    const spec = vaults.find(v => v.id === id);
    if (!spec) throw Object.assign(new Error(ids.length ? "unknown vault id" : "no vaults registered"), { code: "V04" });
    return spec;
  };
  const read = <T>(args: Record<string, unknown>, body: (index: VaultIndex) => T): T => {
    const spec = pick(args), index = new VaultIndex(home, spec, vaults.map(v => v.path));
    try { index.scan(); return body(index); } finally { index.close(); }
  };
  const write = (args: Record<string, unknown>, operation: WriteOp, extra: Partial<WriteRequest> = {}): WriteReceipt | ReturnType<typeof refusal> & Partial<WriteReceipt> => {
    const request: WriteRequest = { vault: pick(args).id, operation, channel: "mcp", ...extra, ...(args.log ? { log: args.log as LogEvent } : {}) };
    const receipt = applyWrite(home, request, { env });
    return receipt.ok || receipt.applied ? receipt : { ...receipt, refused: true };
  };
  const twoStep = (args: Record<string, unknown>) => ({ confirm: args.confirm === true, ...(str(args.fingerprint) ? { fingerprint: str(args.fingerprint) } : {}) });
  const document = (result: ReturnType<VaultIndex["show"]>) => {
    const { path, content, hash, truncated, ...metadata } = result;
    if (truncated || result.section !== undefined || result.offset !== undefined) return { path, sha256: hash, truncated, frontmatter: null, body: content, ...metadata };
    const parsed = parseFrontmatter(content);
    return { path, sha256: hash, truncated, frontmatter: parsed.data, body: parsed.body };
  };
  const handlers: Record<string, McpHandler> = {
    vmem_proposal_submit: args => { const spec = pick(args), context: ProposalContext = { channel: "mcp", env, expectedVault: spec, expectedBinding: proposalBindings.get(spec.id) ?? null }; return submitProposal(home, { vault: spec.id, operation: args.operation, ...(str(args.agentLabel) !== undefined ? { agentLabel: str(args.agentLabel)! } : {}) }, context); },
    vmem_proposal_list: args => { const spec = pick(args), context: ProposalContext = { channel: "mcp", env, expectedVault: spec, expectedBinding: proposalBindings.get(spec.id) ?? null }; return listProposals(home, { vault: spec.id, ...(str(args.state) ? { state: str(args.state) as "pending" | "applied" | "rejected" | "apply_unknown" } : {}), ...(typeof args.limit === "number" ? { limit: args.limit } : {}), ...(str(args.after) ? { after: str(args.after) } : {}) }, context); },
    vmem_proposal_show: args => { const spec = pick(args), context: ProposalContext = { channel: "mcp", env, expectedVault: spec, expectedBinding: proposalBindings.get(spec.id) ?? null }; return showProposal(home, { vault: spec.id, id: str(args.id)!, ...(typeof args.offset === "number" ? { offset: args.offset } : {}), ...(typeof args.maxBytes === "number" ? { maxBytes: args.maxBytes } : {}) }, context); },
    vmem_proposal_apply: args => { const spec = pick(args), context: ProposalContext = { channel: "mcp", env, expectedVault: spec, expectedBinding: proposalBindings.get(spec.id) ?? null }; if (args.confirm === true && !str(args.fingerprint)) throw new Error("proposal apply: confirm requires a fingerprint; request a new preview"); if (args.confirm !== true && args.fingerprint !== undefined) throw new Error("proposal apply: fingerprint requires confirm; request a new preview"); if (args.confirm !== true) return previewProposalApply(home, { vault: spec.id, id: str(args.id)! }, context); const result = applyProposal(home, { vault: spec.id, id: str(args.id)!, fingerprint: str(args.fingerprint)! }, context); return result.ok || result.applied !== false || result.state === "apply_unknown" ? result : { ...result, refused: true }; },
    vmem_proposal_reject: args => { const spec = pick(args), context: ProposalContext = { channel: "mcp", env, expectedVault: spec, expectedBinding: proposalBindings.get(spec.id) ?? null }; if (args.confirm === true && !str(args.fingerprint)) throw new Error("proposal reject: confirm requires a fingerprint; request a new preview"); if (args.confirm !== true && args.fingerprint !== undefined) throw new Error("proposal reject: fingerprint requires confirm; request a new preview"); if (args.confirm !== true) return previewProposalReject(home, { vault: spec.id, id: str(args.id)!, reason: str(args.reason)! }, context); const result = rejectProposal(home, { vault: spec.id, id: str(args.id)!, reason: str(args.reason)!, fingerprint: str(args.fingerprint)! }, context); return result.ok || result.rejected ? result : { ...result, refused: true }; },
    vmem_proposal_reconcile: args => { const spec = pick(args), context: ProposalContext = { channel: "mcp", env, expectedVault: spec, expectedBinding: proposalBindings.get(spec.id) ?? null }; if (args.confirm === true && !str(args.fingerprint)) throw new Error("proposal reconcile: confirm requires a fingerprint; request a new preview"); if (args.confirm !== true && args.fingerprint !== undefined) throw new Error("proposal reconcile: fingerprint requires confirm; request a new preview"); if (args.confirm !== true) return reconcileProposal(home, { vault: spec.id, id: str(args.id)! }, context); const result = confirmProposalReconciliation(home, { vault: spec.id, id: str(args.id)!, fingerprint: str(args.fingerprint)! }, context); return result.ok || result.resolved ? result : { ...result, refused: true }; },
    vmem_brief: args => vaultBrief(home, { vault: pick(args).id, intent: args.intent as string, paths: args.paths as string[] | undefined, bytes: args.bytes as number | undefined }, pick(args)),
    vmem_promote: async args => {
      const { promoteToOrg } = await import("./org-promote.ts");
      const source = vaults.find(v => v.id === defaultVault && v.kind === "personal");
      if (!source) return refusal("POLICY", "no personal vault registered");
      const result = promoteToOrg(home, { from: source.id, note: str(args.path)!, to: str(args.to)!, channel: "mcp", again: args.again === true, confirm: args.confirm === true,
        ...(Array.isArray(args.topics) ? { topics: args.topics as string[] } : {}), ...(str(args.fingerprint) ? { fingerprint: str(args.fingerprint) } : {}) }, { env });
      return result.ok || result.applied ? result : { ...result, refused: true };
    },
    vmem_promote_from_amem: async args => {
      const { promoteFromAmem } = await import("./promote.ts");
      const id = str(args.id)!.replace(/^mem:/, "");
      const result = await promoteFromAmem(home, { vault: pick(args).id, id, channel: "mcp", confirm: args.confirm === true,
        ...Object.fromEntries(["stem", "type", "domain", "description", "title", "body", "linkTo", "fingerprint"].filter(key => str(args[key]) !== undefined).map(key => [key, str(args[key])])),
        ...(Array.isArray(args.topics) ? { topics: args.topics as string[] } : {}) }, { env, ...(str(args.project) ? { project: str(args.project) } : {}) });
      return result.ok || result.applied ? result : { ...result, refused: true };
    },
    vmem_skills_mine: async args => {
      const { mineSkills } = await import("./skills-mine.ts");
      return mineSkills(home, { vault: pick(args).id, expectedVault: pick(args), env, allProjects: args.allProjects === true, ...(str(args.project) ? { project: str(args.project) } : {}), ...(str(args.vocab) ? { vocab: str(args.vocab) } : {}),
        ...(Array.isArray(args.skills) ? { skills: args.skills as string[] } : {}), ...(typeof args.days === "number" ? { days: args.days } : {}),
        ...(typeof args.minSize === "number" ? { minSize: args.minSize } : {}), ...(typeof args.minNovelty === "number" ? { minNovelty: args.minNovelty } : {}) });
    },
    vmem_read_file: args => readVaultFile(pick(args), loadRegistry(home).denyPaths ?? [], str(args.path)!, (args.maxBytes as number | undefined) ?? 16384, args.offset as number | undefined),
    vmem_list_files: args => listVaultFiles(pick(args), loadRegistry(home).denyPaths ?? [], str(args.dir)!),
    vmem_report: args => write(args, { op: "report", path: str(args.path)!, text: str(args.body)! }, args.dryRun === true ? { dryRun: true } : {}),
    vmem_lint: args => args.write === true ? writeAnalysisReports(home,{vault:pick(args).id,kind:"lint",channel:"mcp",expectedVault:pick(args),dryRun:args.dryRun === true},env) : lintVault(analysisInput(home,pick(args).id,{expectedVault:pick(args),hints:true}).snapshot),
    vmem_graph_build: args => writeAnalysisReports(home,{vault:pick(args).id,kind:"graph",workspace:args.workspace === true,channel:"mcp",expectedVault:pick(args),dryRun:args.dryRun === true},env),
    vmem_graph_neighbors: args => graphNeighbors(buildGraph(analysisInput(home,pick(args).id,{expectedVault:pick(args)}).snapshot),str(args.path)!, (args.hops as 1|2|undefined) ?? 1, (args.limit as number|undefined) ?? 50, str(args.relation)),
    vmem_graph_path: args => graphPath(buildGraph(analysisInput(home,pick(args).id,{expectedVault:pick(args)}).snapshot),str(args.from)!,str(args.to)!,{maxHops:(args.maxHops as number|undefined) ?? 6,viaHubs:args.viaHubs === true,...(str(args.relation) === undefined ? {} : {relation:str(args.relation)!})}),
    vmem_graph_explain: args => explainGraphPath(analysisInput(home,pick(args).id,{expectedVault:pick(args)}).snapshot,str(args.from)!,str(args.to)!,{maxHops:(args.maxHops as number|undefined) ?? 6,viaHubs:args.viaHubs === true,...(str(args.relation) === undefined ? {} : {relation:str(args.relation)!})}),
    vmem_status: () => ({ defaultVault: defaultVault ?? null, vaults: registryStatus(home).filter(v => ids.includes(v.id)) }),
    vmem_search: args => read(args, index => ({ hits: index.search(str(args.query)!, { limit: (args.limit as number | undefined) ?? 20, type: str(args.type), domain: str(args.domain) }) })),
    vmem_read: args => str(args.revision) === undefined
      ? read(args, index => { const r = index.show(str(args.path)!, (args.maxBytes as number | undefined) ?? 16384, str(args.section), args.offset as number | undefined); return document(r); })
      : readRevision({ vault: pick(args), home, env, denyPaths: loadRegistry(home).denyPaths ?? [], note: str(args.path)!, revision: str(args.revision)!,
        ...(typeof args.maxBytes === "number" ? { maxBytes: args.maxBytes } : {}), ...(typeof args.offset === "number" ? { offset: args.offset } : {}), ...(str(args.section) ? { section: str(args.section)! } : {}) }),
    vmem_read_many: args => read(args, index => ({ notes: (args.paths as string[]).map(path => {
      try { const r = index.show(path, 8192); return document(r); }
      catch (error) { return { path, ...refusal("V04", error instanceof Error ? error.message : "unreadable") }; }
    }) })),
    vmem_list: args => read(args, index => index.list(str(args.prefix) ?? "", (args.limit as number | undefined) ?? 100, str(args.cursor))),
    // Registry is reloaded per call so the source root is rebound on every verification.
    vmem_assertions: args => readAssertions(home, { vault: pick(args).id, ...(str(args.subject) ? { subject: str(args.subject)! } : {}), ...(str(args.relation) ? { relation: str(args.relation)! } : {}), ...(str(args.at) ? { at: str(args.at)! } : {}), ...(str(args.asOf) ? { asOf: str(args.asOf)! } : {}), ...(args.history === true ? { history: true } : {}), ...(typeof args.limit === "number" ? { limit: args.limit } : {}), ...(str(args.cursor) ? { cursor: str(args.cursor)! } : {}) }, { env }),
    vmem_assertions_purge: args => {
      const receipt = purgeAssertions(home, { vault: pick(args).id, id: str(args.id)!, reason: str(args.reason)!, channel: "mcp", ...twoStep(args) }, { env });
      return purgeReply(receipt.ok || receipt.applied ? receipt : { ...receipt, refused: true });
    },
    vmem_assertions_exposure: args => exposureReply(scanAssertionExposure(home, { vault: pick(args).id, ...(str(args.assertion) ? { assertion: str(args.assertion)! } : {}) }, { env }).receipt),
    vmem_evidence: args => { const registry = loadRegistry(home), spec = registry.vaults.find(v => v.id === pick(args).id); if (!spec) throw Object.assign(new Error("unknown vault id; list registered vaults with vmem status"), { code: "V04" }); return evidenceReport(spec, str(args.path)!, registry.denyPaths ?? []); },
    vmem_assert: args => {
      const receipt = appendAssertions(home, { vault: pick(args).id, ops: args.ops, channel: "mcp", dryRun: args.dryRun === true, ...(args.log ? { log: args.log as LogEvent } : {}) }, { env });
      return assertReply(receipt.ok || receipt.applied ? receipt : { ...receipt, refused: true });
    },
    vmem_stats: args => vaultStats(home, pick(args).id, { expectedVault: pick(args), ...(typeof args.days === "number" ? { days: args.days } : {}) }),
    vmem_links: args => read(args, index => {
      const direction = str(args.direction) ?? "both", limit = (args.limit as number | undefined) ?? 50;
      const out = direction === "in" ? [] : index.links(str(args.path)!, limit);
      return { out: out.filter(l => l.resolved), dead: out.filter(l => !l.resolved), in: direction === "out" ? [] : index.backlinks(str(args.path)!, limit) };
    }),
    vmem_history: args => readHistory({ vault: pick(args), home, env, denyPaths: loadRegistry(home).denyPaths ?? [], note: str(args.path)!,
      ...(typeof args.limit === "number" ? { limit: args.limit } : {}), ...(str(args.cursor) ? { cursor: str(args.cursor)! } : {}) }),
    vmem_changes: args => readChanges({ vault: pick(args), home, env, denyPaths: loadRegistry(home).denyPaths ?? [], from: str(args.from)!, to: str(args.to)!,
      ...(typeof args.limit === "number" ? { limit: args.limit } : {}), ...(str(args.cursor) ? { cursor: str(args.cursor)! } : {}) }),
    vmem_mocs: args => read(args, index => ({ mocs: index.mocs() })),
    vmem_check: args => write(args, { op: "check", path: notePath(str(args.path) ?? "checked-note"), text: str(args.text)! }),
    vmem_log_tail: args => readLog(home, { vault: pick(args).id, limit: (args.n as number | undefined) ?? 50, ...(str(args.type) ? { type: str(args.type) } : {}), ...(str(args.grep) ? { grep: str(args.grep) } : {}) }),
    vmem_create: args => {
      if (args.created !== undefined) {
        const created = str(args.created), time = typeof created === "string" && /^\d{4}-\d{2}-\d{2}$/.test(created) ? Date.parse(created + "T00:00:00Z") : NaN;
        if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== created) return refusal("V01", "created: expected YYYY-MM-DD");
      }
      const frontmatter: Record<string, unknown> = { ...(args.extra as Record<string, unknown> | undefined ?? {}) };
      for (const key of ["type", "domain", "description", "title", "source", "confidence", "status", "created"]) if (str(args[key]) !== undefined) frontmatter[key] = args[key];
      if (Array.isArray(args.source)) frontmatter.source = args.source as string[];
      if (Array.isArray(args.topics)) frontmatter.topics = (args.topics as string[]).map(v => v.startsWith("[[") ? v : `[[${v}]]`);
      return write(args, { op: "create", path: str(args.stem)!, frontmatter, ...(str(args.body) !== undefined ? { body: str(args.body) } : {}) });
    },
    vmem_patch: args => write(args, { op: "patch", path: str(args.path)!, ...(args.oldString !== undefined ? { oldString: str(args.oldString) } : {}), ...(args.newString !== undefined ? { newString: str(args.newString) } : {}), ...(args.edits !== undefined ? { edits: args.edits as PatchEdit[] } : {}), expectedSha: str(args.expectedSha) }),
    vmem_append: args => write(args, { op: "append", path: str(args.path)!, section: str(args.section)!, markdown: str(args.markdown)!, expectedSha: str(args.expectedSha) }),
    vmem_set_frontmatter: args => write(args, { op: "frontmatter", path: str(args.path)!, set: (args.set as Record<string, unknown> | undefined) ?? {}, ...(args.unset ? { unset: args.unset as string[] } : {}), expectedSha: str(args.expectedSha) }),
    vmem_link: args => write(args, { op: "link", from: str(args.from)!, to: str(args.to)!, relation: args.relation as Extract<WriteOp, { op: "link" }>["relation"], ...(str(args.context) ? { context: str(args.context) } : {}), bidirectional: args.bidirectional !== false }),
    vmem_supersede: args => write(args, { op: "supersede", old: str(args.old)!, next: str(args.next)! }),
    vmem_log_append: args => {
      const event: LogEvent = { type: str(args.type)!, project: str(args.project)!, source: str(args.source)!, note: str(args.note)!, ...(str(args.dest) ? { dest: str(args.dest) } : {}) };
      const receipt = appendLog(home, { vault: pick(args).id, event, channel: "mcp" }, { env });
      return receipt.ok ? receipt : { ...receipt, refused: true };
    },
    vmem_move: args => write(args, { op: "move", from: str(args.from)!, to: str(args.to)! }, twoStep(args)),
    vmem_merge: args => write(args, { op: "merge", keep: str(args.keep)!, absorb: str(args.absorb)! }, twoStep(args)),
    vmem_delete: args => {
      const receipt = write(args, { op: "delete", path: str(args.path)! }, twoStep(args));
      if (args.confirm === true) return receipt;
      let backlinks: { source: string; line: number }[] = [];
      try { backlinks = read(args, index => index.backlinks(str(args.path)!, 200).map(l => ({ source: l.source, line: l.line }))); } catch { /* preview stays valid without backlinks */ }
      return { ...receipt, backlinks };
    },
  };
  const specs = createSpecMcp(home, env);
  Object.assign(handlers, specs.handlers);
  // Every handler returns a structured value; provider errors become refusals, never protocol errors.
  const guarded: Record<string, McpHandler> = {};
  for (const [name, handler] of Object.entries(handlers)) guarded[name] = async args => {
    try { return await handler(args); }
    catch (error) { return refusal((error as { code?: unknown }).code === "V04" ? "V04" : "REFUSED", error instanceof Error ? error.message.slice(0, 500) : "operation refused"); }
  };
  return { tools: [...vaultTools(ids, vaults.filter(v => v.kind === "org").map(v => v.id)), ...specs.tools], handlers: guarded, vaults, defaultVault, instructions: VMEM_INSTRUCTIONS };
}
