import type { AssertionsReadResult } from "./assertion-read.ts";

export interface CoverageWarning { tone: "err" | "warn" | "neutral"; message: string }

/** Describe coverage once for both the console and the CLI. */
export function assertionCoverageWarnings(coverage: AssertionsReadResult["coverage"] | undefined): CoverageWarning[] {
  if (!coverage) return [];
  const out: CoverageWarning[] = [];
  if (coverage.untrusted.length) {
    const count = coverage.untrusted.reduce((n, item) => n + item.entries, 0);
    const details = coverage.untrusted.slice(0, 3).map(u => `${u.segment}#${u.seq}, failed #${u.failedSeq}, ${u.entries} left out: ${u.reason}`).join("; ");
    out.push({ tone: "err", message: `${count} journal ${count === 1 ? "entry is" : "entries are"} untrusted and left out (${details}); run \`vmem assertions <vault> --history --json\` and inspect the journal segments` });
  }
  if (coverage.unsupported.length) {
    const count = coverage.unsupported.reduce((n, item) => n + item.entries, 0);
    const details = coverage.unsupported.slice(0, 3).map(u => `${u.segment}#${u.seq}, failed #${u.failedSeq}, ${u.entries} left out`).join("; ");
    out.push({ tone: "warn", message: `${count} journal ${count === 1 ? "entry is" : "entries are"} left out after an unsupported schema (${details}); upgrade vmem to read them` });
  }
  if (coverage.tornTail.length) out.push({ tone: "warn", message: `torn journal tail in ${coverage.tornTail.join(", ")}: the incomplete last entry is ignored; the next append repairs it` });
  for (const batch of coverage.partialBatch) out.push({ tone: "warn", message: `batch ${batch.segment}:${batch.seq} has ${batch.entries} of ${batch.size} entries; all ${batch.entries} are left out; resubmit the batch` });
  if (coverage.purged) out.push({ tone: "neutral", message: `${coverage.purged} purged ${coverage.purged === 1 ? "payload is" : "payloads are"} not shown` });
  if (coverage.unsynced) out.push({ tone: "warn", message: `${coverage.unsynced} assertion ${coverage.unsynced === 1 ? "file is" : "files are"} not committed; run \`vmem sync\` to share them` });
  if (coverage.unsynced === null) out.push({ tone: "neutral", message: "journal sync state is unknown (no Git repository or Git unavailable)" });
  if (coverage.indexIssue) out.push({ tone: "warn", message: coverage.indexIssue });
  return out;
}
