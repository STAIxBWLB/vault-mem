import { lstatSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { sourceReferences } from "./source.ts";
import { specGit } from "./spec-git.ts";

/** Source paths checked per lint run; later ones are counted as skipped, never checked unboundedly. */
export const SOURCE_AGE_MAX_PATHS = 2000;
/** Bound on one batched `git log` name listing; past it the tracked check is skipped and reported. */
const LOG_OUTPUT_BYTES = 8 * 1024 * 1024, LIST_OUTPUT_BYTES = 1024 * 1024;
/** Total literal pathspec bytes per git call, well under the smallest ARG_MAX (macOS, ~1 MiB with the environment). */
export const SOURCE_AGE_MAX_ARGV_BYTES = 256 * 1024;
/** Hardened read-only `git log`: no signature verification programs, no rename following from repo config. */
const LOG_FLAGS = ["-c", "log.showSignature=false", "-c", "log.follow=false"];

export interface SourceAge {
  /** Finding lines by note path (relative to notes/): source path and commit count, or `modified`. */
  findings: Record<string, string[]>;
  /** Notes with a workspace source path but no valid `updated` date: counted, never flagged. */
  unknownAge: number;
  /** Source paths not checked because of the per-run cap, or because git could not be inspected. */
  skipped: number;
  /** Why tracked sources were not checked, when that happened, with a next step. */
  gitUnavailable?: string;
}

/** The first moment after the note's `updated` local calendar day; a change at or after it is newer than the note. */
function dayAfter(updated: unknown): number | undefined {
  const text = updated instanceof Date ? updated.toISOString().slice(0, 10) : typeof updated === "string" ? updated.trim() : "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return undefined;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])], next = new Date(y, m - 1, d + 1);
  return new Date(y, m - 1, d).getDate() === d ? next.getTime() : undefined;
}

/**
 * L17 input: notes whose workspace source changed after the note's `updated` day. Metadata only: git history,
 * `git ls-files` and `lstat`; no source file is opened and nothing is written. Missing paths (L14), denied paths, URLs,
 * memory ids and paths that resolve outside the workspace root are skipped. Git work is two batched calls per run.
 */
export function sourceAgeFindings(notes: readonly { path: string; source: string }[], root: string, denyPaths: readonly string[], options: { env?: NodeJS.ProcessEnv; maxPaths?: number; maxArgvBytes?: number } = {}): SourceAge {
  const result: SourceAge = { findings: Object.create(null) as Record<string, string[]>, unknownAge: 0, skipped: 0 };
  let rootReal: string;
  try { rootReal = realpathSync(root); } catch { return result; }
  const maxPaths = options.maxPaths ?? SOURCE_AGE_MAX_PATHS, maxArgv = options.maxArgvBytes ?? SOURCE_AGE_MAX_ARGV_BYTES;
  let argvBytes = 0;
  // Per note: its threshold and the existing, allowed source paths, in source order without duplicates.
  const plan: { note: string; after: number; paths: string[] }[] = [], all = new Set<string>();
  for (const note of notes) {
    let data: Record<string, unknown>;
    try { data = parseFrontmatter(note.source).data; } catch { continue; }
    if (data.source === undefined) continue;
    let refs;
    try { refs = sourceReferences(data.source); } catch { continue; }
    const paths: string[] = [];
    for (const ref of refs) {
      if (ref.kind !== "path" || paths.includes(ref.value)) continue;
      const file = resolve(rootReal, ref.value);
      if (isDenied(ref.value, [...denyPaths]) || isDenied(canonicalPath(file), [...denyPaths])) continue;
      let real: string;
      try { lstatSync(file); real = realpathSync(file); } catch { continue; } // missing: L14 reports it
      if (real !== rootReal && !real.startsWith(rootReal + sep)) continue;
      paths.push(ref.value);
    }
    if (!paths.length) continue;
    const after = dayAfter(data.updated);
    if (after === undefined) { result.unknownAge++; continue; }
    const kept: string[] = [];
    for (const path of paths) {
      const cost = Buffer.byteLength(path) + 11; // ":(literal)" plus the argv terminator
      if (all.has(path)) kept.push(path);
      else if (all.size < maxPaths && argvBytes + cost <= maxArgv) { all.add(path); argvBytes += cost; kept.push(path); }
      else result.skipped++;
    }
    if (kept.length) plan.push({ note: note.path, after, paths: kept });
  }
  if (!plan.length) return result;
  // Tracked set: one `ls-files` over literal pathspecs (argv, never stdin), relative to the workspace root.
  const literal = [...all].map(path => `:(literal)${path}`);
  let tracked = new Set<string>(), commits: { time: number; files: string[] }[] = [];
  let inRepo = false;
  try {
    inRepo = specGit(rootReal, ["rev-parse", "--is-inside-work-tree"], { env: options.env, allowedExitCodes: [0, 128] }).status === 0;
    if (inRepo) {
      const listed = specGit(rootReal, ["ls-files", "--cached", "-z", "--", ...literal], { env: options.env, maxBuffer: LIST_OUTPUT_BYTES }).stdout.toString("utf8");
      tracked = new Set(listed.split("\0").filter(Boolean));
      if (tracked.size) {
        const since = Math.min(...plan.map(item => item.after));
        // The mainline only, each commit (merges included) diffed against its first parent: a change that reached the
        // workspace through a merge after `updated` counts once, at the merge, even when the branch commits are older.
        const log = specGit(rootReal, [...LOG_FLAGS, "log", "--no-show-signature", "--no-renames", "--first-parent", "--diff-merges=first-parent", "--relative", "-z", "--format=%x01%ct", "--name-only", `--since=@${Math.floor(since / 1000)}`, "--", ...literal], { env: options.env, maxBuffer: LOG_OUTPUT_BYTES }).stdout.toString("utf8");
        for (const record of log.split("\x01").slice(1)) {
          const [time, ...files] = record.split(/\0\n?|\n/).filter(Boolean);
          commits.push({ time: Number(time) * 1000, files });
        }
      }
    }
  } catch (error) {
    result.gitUnavailable = `${error instanceof Error ? error.message.slice(0, 200) : "git inspection failed"}; no source was checked. Check that git is installed and that the registry's workspace root is a readable repository, then rerun lint`;
    result.skipped += all.size;
    return result;
  }
  // One pass over listed files: each file credits every planned path that is it or one of its directories.
  const planned = new Set(all), prefixes = (file: string) => {
    const out = [file], parts = file.split("/");
    for (let i = parts.length - 1; i > 0; i--) out.push(parts.slice(0, i).join("/"));
    return out.filter(path => planned.has(path) || planned.has(path + "/"));
  };
  const key = (path: string) => path.replace(/\/$/, "");
  const trackedPaths = new Set<string>();
  for (const file of tracked) for (const path of prefixes(file)) trackedPaths.add(key(path));
  /** Commit times per planned path (one entry per commit). */
  const times = new Map<string, number[]>();
  for (const commit of commits) for (const path of new Set(commit.files.flatMap(prefixes).map(key))) (times.get(path) ?? times.set(path, []).get(path)!).push(commit.time);
  for (const item of plan) {
    const lines: string[] = [];
    for (const path of item.paths) {
      if (inRepo && trackedPaths.has(key(path))) {
        const count = (times.get(key(path)) ?? []).filter(time => time >= item.after).length;
        if (count) lines.push(`source \`${path}\` has ${count} commit${count === 1 ? "" : "s"} after updated; re-check the note against it, then save it to refresh updated`);
      } else {
        let mtime: number;
        try { mtime = lstatSync(resolve(rootReal, path)).mtimeMs; } catch { continue; }
        if (mtime >= item.after) lines.push(`source \`${path}\` modified after updated (not tracked by the workspace repository, judged by mtime); re-check the note against it, then save it to refresh updated`);
      }
    }
    if (lines.length) result.findings[item.note] = lines;
  }
  return result;
}
