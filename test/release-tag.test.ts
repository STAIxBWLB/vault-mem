import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTag } from "../scripts/release-tag.ts";

function fixture(body: (root: string, git: (...args: string[]) => string, remote: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "vmem-release-tag-"));
  const root = join(dir, "repo"), remote = join(dir, "remote.git");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    execFileSync("git", ["init", "--bare", remote], { env, stdio: "ignore" });
    execFileSync("git", ["init", "-b", "main", root], { env, stdio: "ignore" });
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    git("config", "tag.gpgSign", "false"); git("config", "commit.gpgSign", "false");
    git("remote", "add", "origin", remote);
    writeFileSync(join(root, "package.json"), '{"version":"1.0.0"}');
    writeFileSync(join(root, "CHANGELOG.md"), "## [1.0.0] - 2026-11-07\n");
    git("add", "."); git("commit", "-m", "Initial release"); git("tag", "v1.0.0");
    writeFileSync(join(root, "package.json"), '{"version":"1.0.1"}');
    writeFileSync(join(root, "CHANGELOG.md"), "## [1.0.1] - 2026-11-07\n");
    git("add", "."); git("commit", "-m", "Bump version"); git("push", "origin", "main", "--tags");
    body(root, git, remote);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("release tag is annotated at current main and stays local unless push is explicit", () => {
  fixture((root, git, remote) => {
    expect(releaseTag(root, false)).toBe("v1.0.1");
    expect(git("cat-file", "-t", "v1.0.1")).toBe("tag");
    expect(git("rev-parse", "v1.0.1^{}")).toBe(git("rev-parse", "HEAD"));
    expect(execFileSync("git", ["--git-dir", remote, "tag", "--list", "v1.0.1"], { encoding: "utf8" }).trim()).toBe("");
    expect(() => releaseTag(root, false)).toThrow("already exists. Bump package.json and add ## [x.y.z] - YYYY-MM-DD to CHANGELOG.md via a release-prep PR first.");
  });
  fixture((root, git) => {
    expect(releaseTag(root, true)).toBe("v1.0.1");
    expect(git("ls-remote", "origin", "refs/tags/v1.0.1")).toContain("refs/tags/v1.0.1");
  });
});

test("release tag refuses topic branches, dirty trees, local-only commits and stale main", () => {
  fixture((root, git) => {
    git("switch", "-c", "topic"); expect(() => releaseTag(root, false)).toThrow("require main. Run git switch main."); git("switch", "main");
    writeFileSync(join(root, "untracked"), "x"); expect(() => releaseTag(root, false)).toThrow("clean tree. Commit or stash all changes"); rmSync(join(root, "untracked"));
    git("commit", "--allow-empty", "-m", "Local only"); expect(() => releaseTag(root, false)).toThrow("up to date with origin/main. Run git pull --ff-only");
    git("reset", "--hard", "HEAD~2"); expect(() => releaseTag(root, false)).toThrow("up to date with origin/main. Run git pull --ff-only");
    expect(git("tag", "--list", "v1.0.1")).toBe("");
  });
});

test("release tag requires a version bump and a dated changelog before mutation", () => {
  for (const [file, content, error] of [
    ["package.json", '{"version":"0.9.0"}', "bumped"],
    ["package.json", '{"version":"invalid"}', "Invalid package version"],
    ["CHANGELOG.md", "## [Unreleased]\n", "dated entry"],
  ]) fixture((root, git) => {
    writeFileSync(join(root, file!), content!); git("add", "."); git("commit", "-m", "Invalid candidate"); git("push", "origin", "main");
    expect(() => releaseTag(root, false)).toThrow(error!);
    expect(() => releaseTag(root, false)).toThrow("Bump package.json");
    expect(() => releaseTag(root, false)).toThrow("## [x.y.z] - YYYY-MM-DD to CHANGELOG.md via a release-prep PR first.");
    expect(git("tag", "--list", "v1.0.1")).toBe("");
  });
});
