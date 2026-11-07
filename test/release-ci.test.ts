import { expect, test } from "bun:test";
import { checkState, waitForCheck, type CheckRun } from "../scripts/release-ci.ts";
const sha = "abc123";
const run = (changes: Partial<CheckRun> = {}): CheckRun => ({ id: 1, head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success", ...changes });

test("release CI requires the latest main push run on the exact SHA", () => {
  expect(checkState([run()], sha)).toBe("success");
  for (const changes of [{ head_sha: "other" }, { head_branch: "topic" }, { event: "pull_request" }]) {
    expect(checkState([run(changes)], sha)).toBe("waiting");
  }
  expect(checkState([run(), run({ id: 2, status: "in_progress", conclusion: null })], sha)).toBe("waiting");
  for (const conclusion of ["failure", "cancelled", "skipped", "neutral", "timed_out", null]) {
    expect(() => checkState([run(), run({ id: 2, conclusion })], sha)).toThrow(`Main Check run 2 ended ${conclusion}`);
    expect(() => checkState([run({ conclusion })], sha)).toThrow(conclusion === "cancelled"
      ? "Re-run that Check run or tag the latest main commit."
      : "Fix main and tag a later green commit.");
  }
});

test("release CI waits for completion, fails on red, and has a deadline even with no run", async () => {
  let time = 0;
  const clock = { now: () => time, sleep: async (ms: number) => { time += ms; }, timeoutMs: 25, pollMs: 10 };
  let calls = 0;
  await waitForCheck("example/repo", sha, { ...clock, read: () => ++calls < 3 ? [] : [run()] });
  expect(calls).toBe(3);
  time = 0;
  await expect(waitForCheck("example/repo", sha, { ...clock, read: () => [] })).rejects.toThrow(`Timed out waiting for successful main Check on ${sha}. Re-run this release workflow once the main Check on ${sha} is green`);
  expect(time).toBe(25);
  time = 0;
  await expect(waitForCheck("example/repo", sha, { ...clock, read: () => [run({ conclusion: "failure" })] })).rejects.toThrow("failure");
  expect(time).toBe(0);
  await expect(waitForCheck("example/repo", sha, { ...clock, read: () => { throw new Error("API denied"); } })).rejects.toThrow("Verify GH_TOKEN has actions:read access to example/repo, then re-run this release workflow.");
});

test("default CI deadline allows 20 minutes of queueing and links to recovery runs", async () => {
  let time = 0;
  let polls = 0;
  await expect(waitForCheck("example/repo", sha, {
    now: () => time,
    sleep: async (ms: number) => { time += ms; },
    pollMs: 60_000,
    read: () => { polls++; return []; },
  })).rejects.toThrow("https://github.com/example/repo/actions/workflows/check.yml");
  expect(time).toBe(20 * 60_000);
  expect(polls).toBe(20);
});
