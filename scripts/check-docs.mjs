// Ported from STAIxBWLB/agent-hub scripts/check-docs.mjs (MIT, same owner) at 2e97be2, without its
// agent-hub-only parts (committed-tree readback, JSON output, help and README status checks).
// Usage: bun scripts/check-docs.mjs [--require-fresh] [root]. Stale documents warn; --require-fresh refuses them.
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, readlinkSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Stamps record a human source review, not an automatic proof of the prose.
const REQUIRED = ["README.md", "docs/cutover-checklist.md", "docs/release-readiness.md", "docs/release-workflow.md"];
const args = process.argv.slice(2);
const requireFresh = args.includes("--require-fresh");
const root = resolve(args.find((arg) => arg !== "--require-fresh") ?? fileURLToPath(new URL("..", import.meta.url)));
// Every reference file needs a stamp too, so deleting its manifest entry cannot pass silently.
if (existsSync(join(root, "docs/reference")) && statSync(join(root, "docs/reference")).isDirectory()) REQUIRED.push(...readdirSync(join(root, "docs/reference")).filter((name) => name.endsWith(".md")).sort().map((name) => `docs/reference/${name}`));
const errors = [];
const reports = [];
// A readback must not execute repository-configured helpers.
const safeGitConfig = ["core.fsmonitor=false", "core.hooksPath=/dev/null", "diff.external=", "core.pager=cat", "credential.helper=", "core.askpass="];
const git = (...args) => spawnSync("git", ["--no-pager", ...safeGitConfig.flatMap(value => ["-c", value]), ...args], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, timeout: 2000, maxBuffer: 256 * 1024 });
const safePath = (path) => typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.startsWith("-") && !path.split("/").includes("..") && !path.includes("\\") && !path.includes(":");
const documentExists = (path) => existsSync(join(root, path)) && statSync(join(root, path)).isFile();
/** Never refresh the index through git status: it can run configured clean/process filters. */
const dirtiness = (paths) => {
  const unknown = { status: 1, stdout: "" }, dirty = { status: 0, stdout: "dirty" };
  const staged = git("diff-index", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--", ...paths);
  if (staged.status === 1) return dirty;
  if (staged.status !== 0) return unknown;
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z", "--", ...paths);
  if (untracked.status !== 0) return unknown;
  if (untracked.stdout) return dirty;
  const tracked = git("ls-files", "--stage", "-z", "--", ...paths);
  if (tracked.status !== 0) return unknown;
  const entries = tracked.stdout.split("\0").filter(Boolean);
  if (entries.length > 4096) return unknown;
  try {
    for (const entry of entries) {
      const match = /^([0-7]{6}) ([0-9a-f]{40}) ([0-3])\t([\s\S]+)$/.exec(entry);
      if (!match) return unknown;
      const [, mode, oid, stage, path] = match;
      if (stage !== "0") return dirty;
      // ponytail: gitlinks/large or transformed files stay unverified; never invoke a filter to establish equivalence.
      if (!["100644", "100755", "120000"].includes(mode)) return unknown;
      const file = resolve(root, path), within = relative(root, file);
      if (!within || within.startsWith("../") || within === "..") return unknown;
      for (let parent = dirname(file); parent !== root; parent = dirname(parent)) if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) return unknown;
      if (!existsSync(file) && mode !== "120000") return dirty;
      const info = lstatSync(file);
      let bytes;
      if (mode === "120000") { if (!info.isSymbolicLink()) return dirty; bytes = readlinkSync(file, { encoding: "buffer" }); }
      else { if (!info.isFile() || info.isSymbolicLink()) return dirty; if (info.size > 4 * 1024 * 1024) return unknown; bytes = readFileSync(file); }
      const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (hash !== oid || mode !== "120000" && !!(info.mode & 0o111) !== (mode === "100755")) return dirty;
    }
    return { status: 0, stdout: "" };
  } catch { return unknown; }
};

try {
  const manifest = JSON.parse(readFileSync(join(root, "docs/verified.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !manifest.documents || typeof manifest.documents !== "object" || Array.isArray(manifest.documents)) throw new Error("invalid docs/verified.json schema");
  for (const path of REQUIRED) if (!Object.hasOwn(manifest.documents, path)) errors.push(`missing manifest entry: ${path}`);
  if (git("rev-parse", "--verify", "HEAD").status !== 0) {
    const repository = git("rev-parse", "--git-dir");
    if (repository.status === 128 && repository.stderr.includes("not a git repository")) {
      // A source archive can still have malformed metadata; only history checks are skipped.
      for (const [doc, entry] of Object.entries(manifest.documents)) {
        if (!safePath(doc) || !documentExists(doc)) errors.push(`missing or invalid document: ${doc}`);
        if (!Array.isArray(entry?.paths) || entry.paths.length === 0 || entry.paths.some(path => !safePath(path))) errors.push(`${doc}: invalid covered paths`);
      }
      if (!requireFresh && errors.length === 0) {
        console.log("docs: skipped: no git history here; run in a full git checkout, or run bun scripts/check-docs.mjs --require-fresh in a full checkout before a release");
        process.exit(0);
      }
      throw new Error("no git history here; run bun scripts/check-docs.mjs --require-fresh in a full git checkout with history");
    }
    throw new Error("HEAD does not resolve; run in a full git checkout with a committed HEAD and history");
  }
  for (const [doc, entry] of Object.entries(manifest.documents).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!safePath(doc) || !documentExists(doc)) { errors.push(`missing or invalid document: ${doc}`); continue; }
    const stamp = entry?.verifiedAgainst;
    if (typeof stamp !== "string" || !/^[0-9a-f]{40}$/.test(stamp) || git("cat-file", "-e", `${stamp}^{commit}`).status !== 0) { errors.push(`${doc}: verified commit does not resolve: ${String(stamp)} (a shallow clone lacks it; fetch full history)`); continue; }
    if (git("merge-base", "--is-ancestor", stamp, "HEAD").status !== 0) { errors.push(`${doc}: verified commit is not an ancestor of HEAD: ${stamp} (stamp a commit on main, never a branch commit)`); continue; }
    if (!Array.isArray(entry.paths) || entry.paths.length === 0 || entry.paths.some((path) => !safePath(path))) { errors.push(`${doc}: invalid covered paths`); continue; }
    let valid = true;
    for (const path of entry.paths) {
      // Git pathspecs let a scope cover a directory or an explicit wildcard (release-*.ts).
      if (!/[?*\[]/.test(path) && existsSync(join(root, path))) continue;
      const files = git("ls-files", "-z", "--", path);
      const matches = files.stdout.split("\0").filter(Boolean);
      if (files.status !== 0 || matches.length === 0 || matches.some((file) => !existsSync(join(root, file)))) { errors.push(`${doc}: covered path no longer exists: ${path}`); valid = false; }
    }
    if (!valid) continue;
    const count = git("rev-list", "--count", `${stamp}..HEAD`, "--", ...entry.paths);
    const dirty = dirtiness(entry.paths);
    if (count.status !== 0 || dirty.status !== 0) { errors.push(`${doc}: cannot compute source drift`); continue; }
    const commits = Number(count.stdout.trim());
    if (!Number.isSafeInteger(commits) || commits < 0) { errors.push(`${doc}: invalid source commit count`); continue; }
    if (commits || dirty.stdout) reports.push(`${doc}: stale (${commits} source commit${commits === 1 ? "" : "s"}${dirty.stdout ? "; uncommitted source changes" : ""})`);
  }
} catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
for (const report of reports) console.log(`docs: ${report}`);
if (requireFresh && reports.length) errors.push("release refused: stale documentation. Recheck each stale document against origin/main, set its verifiedAgainst in docs/verified.json to that main commit in the release-prep PR, then rerun");
for (const error of errors) console.error(`docs: ERROR ${error}`);
if (errors.length) process.exitCode = 1;
else console.log(`docs: OK (${reports.length} stale document${reports.length === 1 ? "" : "s"})`);
