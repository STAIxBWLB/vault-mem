import { execFileSync } from "node:child_process";

export interface CheckRun {
  id: number;
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
}

// A PR run (including a fork's main branch) is never main-push acceptance.
export function checkState(runs: CheckRun[], sha: string): "waiting" | "success" {
  const latest = runs.filter(run => run.head_sha === sha && run.head_branch === "main" && run.event === "push")
    .sort((a, b) => b.id - a.id)[0];
  if (!latest || latest.status !== "completed") return "waiting";
  if (latest.conclusion !== "success") throw new Error(`Main Check run ${latest.id} ended ${latest.conclusion}`);
  return "success";
}

export async function waitForCheck(
  repo: string, sha: string,
  options: { timeoutMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<unknown>; read?: () => CheckRun[] } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 8 * 60_000);
  const read = options.read ?? (() => JSON.parse(execFileSync("gh", ["api",
    `repos/${repo}/actions/workflows/check.yml/runs?head_sha=${sha}&branch=main&event=push&per_page=100`,
  ], { encoding: "utf8", timeout: 20_000 })).workflow_runs as CheckRun[]);
  while (now() < deadline) {
    if (checkState(read(), sha) === "success") return;
    await (options.sleep ?? Bun.sleep)(Math.min(options.pollMs ?? 10_000, Math.max(0, deadline - now())));
  }
  throw new Error(`Timed out waiting for successful main Check on ${sha}`);
}

if (import.meta.main) {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!repo || !sha) throw new Error("GITHUB_REPOSITORY and GITHUB_SHA are required");
  await waitForCheck(repo, sha);
  console.log(`Main Check succeeded on ${sha}`);
}
