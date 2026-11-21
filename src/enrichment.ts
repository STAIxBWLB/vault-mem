/** Explicit, offline enrichment work and intake. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { hostname } from "node:os";
import { cleanupOwnedFile } from "./write-files.ts";
import { applyWrite, MUTATION_LOCK } from "./writer.ts";
import { loadRegistry } from "./registry.ts";
import { isDenied } from "./platform.ts";
import { notePath } from "./write-operations.ts";
import { screenMetadata } from "./write-validation.ts";
import { VaultIndex, MAX_NOTE_BYTES } from "./vault-index.ts";
import { readEnrichmentStore, writeEnrichmentRecord, validateEnrichmentRecord, type EnrichmentKind, type EnrichmentProducer, type EnrichmentRecord } from "./enrichment-store.ts";
import type { VaultSpec } from "./config.ts";
import { appendAssertions, readJournal } from "./assertions.ts";
import { submitProposal, showProposal } from "./proposal-provider.ts";
import { visibleProseLines } from "./links.ts";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const kinds: readonly EnrichmentKind[] = ["embedding", "summary", "community-label", "inferred-link", "fact"];
function fail(message: string): never { throw new Error(`enrichment: ${message}`); }
function context(home: string, id: string, channel?: "cli" | "mcp") {
  const config = loadRegistry(home), vault = config.vaults.find(v => v.id === id);
  if (!vault) return fail("vault is not registered; choose an id from vmem vaults list");
  if (!vault.enrichment?.enabled) return fail("enrichment is disabled; enable it for this vault in settings");
  if (channel && (vault.write === "none" || (channel === "mcp" && vault.write !== "mcp"))) return fail("vault write policy refuses this channel; change the policy in settings or use an allowed channel");
  return { config, vault };
}
function sourcePath(path: string): string {
  if (typeof path !== "string") return fail("source path is missing; choose a note from vmem list");
  const result = path.startsWith("notes/") ? path : `notes/${path.endsWith(".md") ? path : `${path}.md`}`;
  if (!/^notes\/(?!\.)[^/\\\p{Cc}]+\.md$/u.test(result) || Buffer.byteLength(result) > 1024) return fail("source path is not a flat note path; choose a note from vmem list");
  return result;
}
function noteBytes(vault: VaultSpec, path: string, denied: string[]): Buffer {
  const normalized = sourcePath(path);
  let root: string;
  try { root = realpathSync(vault.path); } catch { return fail("vault root is unavailable; restore the registered vault and retry"); }
  const notes = join(root, "notes"), file = join(root, normalized);
  let plainNotes = false; try { plainNotes = realpathSync(notes) === notes; } catch { /* Missing notes are refused below. */ }
  if (root !== vault.path || !plainNotes || isDenied(file, denied)) fail("note path is denied or vault identity changed; inspect the registered vault and policy");
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return fail("source note is unavailable or linked; inspect its path and retry"); }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_NOTE_BYTES) fail("source note is not a bounded regular file; inspect or split the note");
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, null); if (!n) break; length += n; }
    const after = fstatSync(fd), named = lstatSync(file);
    if (named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino || length !== before.size || before.size !== after.size || before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("source note changed while reading; reread it and retry");
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
function withMutationLock<T>(vault: VaultSpec, denied: string[], work: (fd: number) => T): T {
  const file = join(vault.path, MUTATION_LOCK);
  if (isDenied(file, denied)) fail("vault mutation lock is denied; inspect configured deny paths");
  let fd: number;
  try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { return fail("vault mutation lock is unavailable; stop concurrent writers and inspect the lock"); }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), created: new Date().toISOString() }) + "\n"); fsyncSync(fd); return work(fd); }
  finally { try { cleanupOwnedFile(file, fd); } finally { closeSync(fd); } }
}
export interface EnrichmentWorkRequest { vault: string; kind: EnrichmentKind; limit?: number; after?: string }
export function listEnrichmentWork(home: string, request: EnrichmentWorkRequest) {
  if (!request || typeof request !== "object" || Object.keys(request).some(k => !["vault", "kind", "limit", "after"].includes(k))) fail("invalid work request; supply a vault and enrichment kind");
  if (request.after !== undefined && (typeof request.after !== "string" || !/^notes\/(?!\.)[^/\\\p{Cc}]+\.md$/u.test(request.after) || Buffer.byteLength(request.after) > 1024)) fail("work cursor is invalid; restart without a cursor");
  if (!kinds.includes(request.kind)) fail("unknown work kind; choose embedding, summary, community-label, inferred-link or fact");
  const limit = request.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("work limit is outside 1..100; choose a smaller page");
  const { config, vault } = context(home, request.vault), store = readEnrichmentStore(home, vault, config.vaults, config.denyPaths ?? []);
  const index = new VaultIndex(home, vault, config.vaults.map(v => v.path), { memory: true });
  try {
    index.scan(false, { captureInvalidFrontmatter: true, denyPaths: config.denyPaths });
    const snapshot = index.analysisSnapshot({ today: "", logPath: "", log: null, registryIds: null, reports: {} });
    const records = new Map<string, EnrichmentRecord[]>();
    for (const record of store.records) if (record.kind === request.kind) {
      const group = records.get(record.path) ?? []; group.push(record); records.set(record.path, group);
    }
    const pending = snapshot.notes.map(n => {
      const path = `notes/${n.path.replace(/^notes\//, "")}`, contentHash = sha256(n.source), relevant = records.get(path) ?? [];
      const uncertain = relevant.some(r => (r.value as { state?: unknown } | undefined)?.state === "pending");
      const current = relevant.some(r => r.contentHash === contentHash && (r.value as { state?: unknown } | undefined)?.state !== "released");
      return { path, contentHash, current, ...(uncertain ? { status: "needs-reconciliation" as const } : {}) };
    }).filter(n => (n.status || !n.current) && (!request.after || n.path > request.after)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(({ current: _, ...item }) => item);
    const items = pending.slice(0, limit);
    return { vault: vault.id, kind: request.kind, items, ...(pending.length > limit ? { next: items.at(-1)!.path } : {}) };
  } finally { index.close(); }
}
export interface EnrichmentIntakeRequest { vault: string; path: string; contentHash: string; kind: EnrichmentKind; producer: EnrichmentProducer; createdAt: string; value: unknown; channel: "cli" | "mcp" }
export function intakeEnrichment(home: string, request: EnrichmentIntakeRequest, options: { env?: NodeJS.ProcessEnv } = {}) {
  if (!request || typeof request !== "object" || Object.keys(request).some(k => !["vault", "path", "contentHash", "kind", "producer", "createdAt", "value", "channel"].includes(k)) || !kinds.includes(request.kind) || (request.channel !== "cli" && request.channel !== "mcp") || typeof request.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(request.contentHash)) fail("invalid intake request; supply a vault, source path, SHA-256, kind, producer, creation time and value");
  const { config, vault } = context(home, request.vault, request.channel), path = sourcePath(request.path);
  const candidate: EnrichmentRecord = { path, contentHash: request.contentHash, kind: request.kind, producer: request.producer, createdAt: request.createdAt, value: request.value };
  validateEnrichmentRecord(candidate);
  const issues = screenMetadata({ producer: request.producer, ...(request.kind === "embedding" ? {} : { value: request.value }) }, { vault, config }, path);
  if (issues.some(issue => issue.severity === "error")) fail("intake text is refused by the secret or PII policy; remove prohibited content or correct the vault policy");
  if (sha256(noteBytes(vault, path, config.denyPaths ?? [])) !== request.contentHash) fail("source content hash is stale; reread the note and regenerate the result");
  if (request.kind === "fact" || request.kind === "inferred-link") {
    let operation: unknown;
    const origin = { path, sha256: request.contentHash, producer: request.producer, createdAt: request.createdAt };
    const checkSource = () => { if (sha256(noteBytes(vault, path, config.denyPaths ?? [])) !== request.contentHash) fail("source content hash is stale; reread the note and regenerate the result"); };
    if (request.kind === "fact") {
      if (!Array.isArray(request.value) || !request.value.some(op => op && typeof op === "object" && ["assert", "revise"].includes(String((op as { op?: unknown }).op)))) fail("fact intake requires assertion operations; include an assert or revise operation with evidence");
      const dry = appendAssertions(home, { vault: vault.id, ops: request.value, channel: request.channel, dryRun: true }, { env: options.env, origin });
      if (!dry.ok) return { ok: false, applied: false, kind: request.kind, receipt: dry };
    } else {
      try { notePath(path); } catch { fail("proposal targets require a lowercase ASCII note name; rename the note before proposing a link"); }
      const target = request.value && typeof request.value === "object" && !Array.isArray(request.value) && Object.keys(request.value).join(",") === "target" ? (request.value as { target?: unknown }).target : undefined;
      if (typeof target !== "string" || !/^[a-z0-9][a-z0-9-]{0,190}$/.test(target) || `notes/${target}.md` === path) fail("inferred link target is invalid; provide a different flat note stem");
      const bytes = noteBytes(vault, path, config.denyPaths ?? []), source = bytes.toString("utf8");
      if (!Buffer.from(source).equals(bytes)) fail("source note is not UTF-8; correct the note before submitting an inferred link");
      const lines = source.split("\n"), visible = visibleProseLines(source), headings = lines.flatMap((line, i) => line === "## Topics" && visible[i] === line ? [i] : []);
      if (headings.length !== 1 || source.split("## Topics").length !== 2) fail("source needs one unambiguous Topics heading; repair the note before proposing a link");
      const marker = `- [[${target}]] <!-- vmem:inferred -->`;
      if (source.split("\n").includes(marker)) fail("inferred link is already declared; inspect the note before proposing it again");
      operation = { op: "patch", path, expectedSha: request.contentHash, edits: [{ oldString: "## Topics", newString: `${marker}\n\n## Topics` }] };
      const dry = applyWrite(home, { vault: vault.id, operation: operation as import("./write-types.ts").WriteOp, channel: request.channel, dryRun: true }, { env: options.env });
      if (!dry.ok) return { ok: false, applied: false, kind: request.kind, receipt: dry };
    }
    // Reserve a durable intent before calling a second store. A crash or lost response can never auto-replay it.
    const token = randomUUID(), pending: EnrichmentRecord = { path, contentHash: request.contentHash, kind: request.kind, producer: request.producer, createdAt: request.createdAt, value: { state: "pending", token } };
    const reserved = writeEnrichmentRecord(home, vault, pending, checkSource, store => {
      const previous = store.records.filter(r => r.path === path && r.kind === request.kind);
      if (previous.some(r => (r.value as { state?: unknown } | undefined)?.state === "pending")) fail("a prior intake has an unresolved outcome; inspect the journal or proposals and reconcile it before retrying");
      if (previous.some(r => r.contentHash === request.contentHash && (r.value as { state?: unknown } | undefined)?.state === "complete")) fail("this note version already has an intake record; inspect the existing result before retrying");
    });
    if (reserved.issues.length) return { ok: false, applied: false, kind: request.kind, issues: reserved.issues, issue: "intake reservation needs inspection; inspect the sidecar before retrying" };
    const releaseReservation = () => {
      const released: EnrichmentRecord = { ...pending, value: { state: "released", token } };
      return writeEnrichmentRecord(home, vault, released, () => {}, store => {
        const prior = store.records.find(r => r.path === path && r.kind === request.kind && r.contentHash === request.contentHash)?.value as { state?: unknown; token?: unknown } | undefined;
        if (prior?.state !== "pending" || prior.token !== token) fail("intake reservation changed; inspect it before retrying");
      });
    };
    let started = false, sourceRefusal: unknown;
    try {
      const result = withMutationLock(vault, config.denyPaths ?? [], mutationFd => {
        checkSource();
        const currentConfig = loadRegistry(home), currentVault = currentConfig.vaults.find(v => v.id === vault.id);
        if (!currentVault || JSON.stringify(currentVault) !== JSON.stringify(vault)) fail("vault binding changed; reload settings and retry");
        const activeStore = readEnrichmentStore(home, currentVault, currentConfig.vaults, currentConfig.denyPaths ?? []);
        const active = activeStore.records.find(r => r.path === path && r.kind === request.kind && r.contentHash === request.contentHash)?.value as { state?: unknown; token?: unknown } | undefined;
        if (active?.state !== "pending" || active.token !== token) fail("intake reservation changed; inspect its outcome and request new work");
        started = true;
        const receipt = request.kind === "fact"
          ? appendAssertions(home, { vault: vault.id, ops: request.value, channel: request.channel }, { env: options.env, origin: { ...origin, intakeId: token } })
          : submitProposal(home, { vault: vault.id, operation, agentLabel: `enrichment:${token}` }, { channel: request.channel, env: options.env, proposalId: token, validateBeforeStore: () => { try { checkSource(); } catch (error) { sourceRefusal = error; throw error; } } });
        const applied = "stored" in receipt ? receipt.stored === true : receipt.applied === true;
        if (!applied) return { receipt, applied: "stored" in receipt && receipt.stored === null ? null : false, trackingIssues: [] as string[] };
        const complete: EnrichmentRecord = { ...pending, value: { state: "complete", token, receipt } };
        try {
          const stored = writeEnrichmentRecord(home, vault, complete, checkSource, store => {
            const prior = store.records.find(r => r.path === path && r.kind === request.kind && r.contentHash === request.contentHash)?.value as { state?: unknown; token?: unknown } | undefined;
            if (prior?.state !== "pending" || prior.token !== token) fail("intake reservation changed; inspect the journal or proposals and sidecar before retrying");
          }, mutationFd);
          return { receipt, applied: true, trackingIssues: stored.issues };
        } catch { return { receipt, applied: true, trackingIssues: ["result was published but local intake tracking failed; inspect the journal or proposals and reconcile before retrying"] }; }
      });
      const { receipt, applied, trackingIssues } = result;
      if (!applied) {
        if (applied === false) {
          try { const released = releaseReservation(); if (!released.issues.length) return { ok: false, applied: false, kind: request.kind, receipt }; } catch { /* Keep the reservation when cleanup cannot be confirmed. */ }
        }
        return { ok: false, applied, kind: request.kind, receipt, issue: "intake reservation remains unresolved; inspect the journal or proposals and reconcile before retrying" };
      }
      return { ok: receipt.ok && trackingIssues.length === 0, applied: true, kind: request.kind, receipt, ...(trackingIssues.length ? { issues: trackingIssues } : {}) };
    } catch (error) {
      if (!started || sourceRefusal) {
        try { const released = releaseReservation(); if (!released.issues.length) throw (sourceRefusal ?? error); } catch (cleanup) { if (cleanup === (sourceRefusal ?? error)) throw cleanup; }
        return { ok: false, applied: false, kind: request.kind, issue: `${error instanceof Error ? error.message : "intake failed before publication; inspect the source and retry"}; reservation cleanup failed, inspect and reconcile it before retrying` };
      }
      return { ok: false, applied: null, kind: request.kind, issue: "intake outcome is uncertain; inspect the journal or proposals and reconcile before retrying" };
    }
  }
  if (request.kind !== "embedding" && (typeof request.value !== "string" || !request.value.trim() || Buffer.byteLength(request.value) > 8192)) fail("summary or community label must be nonempty text of at most 8192 bytes; shorten the result");
  const record: EnrichmentRecord = { path, contentHash: request.contentHash, kind: request.kind, producer: request.producer, createdAt: request.createdAt, value: request.value };
  const stored = writeEnrichmentRecord(home, vault, record, () => {
    if (sha256(noteBytes(vault, path, config.denyPaths ?? [])) !== request.contentHash) fail("source content hash is stale; reread the note and regenerate the result");
  });
  return { ok: stored.issues.length === 0, applied: true, vault: vault.id, path, contentHash: request.contentHash, kind: request.kind, producer: request.producer, createdAt: request.createdAt, issues: stored.issues };
}

/** Return one current record after rechecking path and disclosure policy. */
export function readEnrichment(home: string, request: { vault: string; path: string; kind: EnrichmentKind }) {
  if (!request || typeof request !== "object" || Object.keys(request).some(k => !["vault", "path", "kind"].includes(k)) || !kinds.includes(request.kind)) fail("invalid record request; supply a vault, note path and enrichment kind");
  const { config, vault } = context(home, request.vault), path = sourcePath(request.path);
  const current = sha256(noteBytes(vault, path, config.denyPaths ?? []));
  const store = readEnrichmentStore(home, vault, config.vaults, config.denyPaths ?? []);
  const candidates = store.records.filter(r => r.path === path && r.kind === request.kind);
  const record = candidates.find(r => r.contentHash === current) ?? candidates.at(-1);
  if (!record) return { vault: vault.id, path, kind: request.kind, status: "missing" as const };
  if (record.contentHash !== current) return { vault: vault.id, path, kind: request.kind, status: "stale" as const };
  const issues = screenMetadata({ producer: record.producer, ...(record.kind === "embedding" ? {} : { value: record.value }) }, { vault, config }, path);
  if (issues.some(issue => issue.severity === "error")) fail("current secret or PII policy refuses the stored result; inspect the vault policy");
  return { vault: vault.id, path, kind: request.kind, status: "current" as const, producer: record.producer, createdAt: record.createdAt, contentHash: record.contentHash, value: record.value };
}

/** Explicitly release an uncertain intake only after the caller has inspected its journal or proposal. */
export function reconcileEnrichment(home: string, request: { vault: string; path: string; kind: "fact" | "inferred-link"; resolution: "published" | "not_published"; confirm?: boolean; fingerprint?: string; channel: "cli" | "mcp" }) {
  if (!request || typeof request !== "object" || Object.keys(request).some(k => !["vault", "path", "kind", "resolution", "confirm", "fingerprint", "channel"].includes(k)) || !["fact", "inferred-link"].includes(request.kind) || !["published", "not_published"].includes(request.resolution) || !["cli", "mcp"].includes(request.channel) || (request.confirm !== undefined && typeof request.confirm !== "boolean")) fail("invalid reconciliation request; choose fact or inferred-link and preview first");
  const { config, vault } = context(home, request.vault, request.channel), path = sourcePath(request.path);
  if (isDenied(path, config.denyPaths ?? []) || isDenied(join(vault.path, path), config.denyPaths ?? [])) fail("source path is denied; inspect the vault policy before reconciling");
  const store = readEnrichmentStore(home, vault, config.vaults, config.denyPaths ?? []), prior = store.records.find(r => r.path === path && r.kind === request.kind && (r.value as { state?: unknown } | undefined)?.state === "pending");
  const value = prior?.value as { state?: unknown; token?: unknown } | undefined;
  if (!prior || value?.state !== "pending" || typeof value.token !== "string") fail("no unresolved intake reservation exists; inspect the work list before retrying");
  const fingerprint = sha256(JSON.stringify([config, prior, request.resolution]));
  if (request.confirm !== true) {
    if (request.fingerprint !== undefined) fail("fingerprint requires confirmation; request a fresh preview first");
    return { ok: true, applied: false, fingerprint, path, kind: request.kind, resolution: request.resolution, intakeId: value.token, warning: "Inspect the journal or proposals first. An incorrect resolution can cause a duplicate or suppress needed work." };
  }
  if (request.fingerprint !== fingerprint) fail("reconciliation fingerprint is missing or stale; inspect the outcome and request a fresh preview");
  const released: EnrichmentRecord = { ...prior, value: { state: request.resolution === "published" ? "complete" : "released", token: value.token, reconciled: request.resolution } };
  const stored = writeEnrichmentRecord(home, vault, released, () => {}, current => {
    const now = current.records.find(r => r.path === path && r.kind === request.kind && r.contentHash === prior.contentHash);
    if (!now || sha256(JSON.stringify([loadRegistry(home), now, request.resolution])) !== fingerprint) fail("intake reservation changed; inspect the outcome and request a fresh preview");
    if (request.resolution === "not_published") {
      if (request.kind === "fact") {
        const journal = readJournal(vault.path, config.denyPaths ?? []);
        if (journal.ignored.length || journal.segments.some(segment => segment.untrusted || segment.unsupported || segment.tornTail || segment.partialBatch || segment.entries.some(entry => entry.purged))) fail("journal coverage cannot prove non-publication; inspect and repair the journal before reconciling");
        if (journal.segments.some(segment => segment.entries.some(entry => (entry.payload?.origin as { intakeId?: unknown } | undefined)?.intakeId === value.token))) fail("the intake was published to the journal; reconcile it as published");
      } else {
        try {
          showProposal(home, { vault: vault.id, id: value.token as string }, { channel: request.channel });
          fail("the intake proposal was published; reconcile it as published");
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (!((error as NodeJS.ErrnoException).code === "ENOENT" || message === "proposal: no proposal store for this vault; use proposal list to find an id")) throw error;
        }
      }
    }
  });
  return { ok: stored.issues.length === 0, applied: true, path, kind: request.kind, issues: stored.issues };
}
