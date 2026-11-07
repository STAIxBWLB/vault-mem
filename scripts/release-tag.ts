import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function releaseTag(cwd: string, push: boolean): string {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 }).trim();
  if (git("branch", "--show-current") !== "main") throw new Error("Release tags require main");
  if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("Release tags require a clean tree");
  git("fetch", "origin", "+refs/heads/main:refs/remotes/origin/main", "--tags");
  const head = git("rev-parse", "HEAD");
  if (head !== git("rev-parse", "refs/remotes/origin/main")) throw new Error("Main must be up to date with origin/main");
  const { version } = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { version: string };
  if (typeof version !== "string" || !versionPattern.test(version)) throw new Error("Invalid package version");
  const tag = `v${version}`;
  const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
  if (tags.includes(tag)) throw new Error(`${tag} already exists`);
  const versions = tags.map(value => value.slice(1)).filter(value => versionPattern.test(value));
  if (versions.some(previous => Bun.semver.order(version, previous) <= 0)) throw new Error("Package version must be bumped above existing release tags");
  const prefix = `## [${version}] - `;
  if (!readFileSync(join(cwd, "CHANGELOG.md"), "utf8").split("\n")
    .some(line => line.startsWith(prefix) && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(line.slice(prefix.length)))) {
    throw new Error("CHANGELOG needs a dated entry for the package version");
  }
  git("tag", "-a", tag, head, "-m", `Release ${tag}`);
  if (push) git("push", "origin", `refs/tags/${tag}:refs/tags/${tag}`);
  return tag;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--push") || args.length > 1) throw new Error("Usage: bun run release:tag [--push]");
  const tag = releaseTag(process.cwd(), args.includes("--push"));
  console.log(`${tag} created${args.includes("--push") ? " and pushed" : " locally; use --push explicitly to publish the tag"}`);
}
