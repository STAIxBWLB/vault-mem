import { expect, test } from "bun:test";

function inspect(result: { status: number | null; signal?: string; code?: string; stderr?: string }) {
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { mock } from "bun:test";
    const cp = await import("node:child_process"), fixture = ${JSON.stringify(result)};
    let timeout;
    mock.module("node:child_process", () => ({ ...cp, spawnSync: (_exe, _args, options) => {
      timeout = options.timeout;
      return { status: fixture.status, signal: fixture.signal ?? null, stdout: Buffer.alloc(0), stderr: Buffer.from(fixture.stderr ?? ""),
        ...(fixture.code ? { error: Object.assign(new Error("synthetic spawn failure"), { code: fixture.code }) } : {}) };
    } }));
    const { specGit } = await import("./src/spec-git.ts");
    try { specGit("/synthetic/repo", ["rev-parse", "--show-toplevel"]); throw new Error("expected refusal"); }
    catch (error) { console.log(JSON.stringify({ message: error.message, causeCode: error.cause?.code, timeout })); }
  `], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
  expect(child.exitCode).toBe(0);
  return JSON.parse(child.stdout.toString()) as { message: string; causeCode?: string; timeout: number };
}

test("signal-only Git termination names its signal, inspection budget and repair step", () => {
  const result = inspect({ status: null, signal: "SIGTERM" });
  expect(result.timeout).toBe(10000);
  expect(result.message).toContain("timed out or was interrupted");
  expect(result.message).toContain("signal SIGTERM");
  expect(result.message).toContain("inspection timeout 10000 ms");
  expect(result.message).toContain("parent/test timeout may be shorter");
  expect(result.message).toContain("inspect git -C <path> rev-parse --show-toplevel");
  expect(result.message).not.toContain("no diagnostic");
});

test("a native Git timeout includes the signal and preserves the underlying timeout cause", () => {
  const result = inspect({ status: null, signal: "SIGKILL", code: "ETIMEDOUT" });
  expect(result.timeout).toBe(10000);
  expect(result.message).toContain("timed out after 10000 ms (signal SIGKILL)");
  expect(result.message).toContain("check for a locked repository or slow mount");
  expect(result.causeCode).toBe("ETIMEDOUT");
});

test("missing signal metadata is explicit, while a normal Git refusal keeps exit status and redacted advice", () => {
  expect(inspect({ status: null }).message).toContain("signal unavailable; inspection timeout 10000 ms");
  const refusal = inspect({ status: 128, stderr: "fatal: /synthetic/repo: unavailable\n" });
  expect(refusal.message).toContain("git refused inspection (exit 128): fatal: <path>: unavailable");
  expect(refusal.message).not.toContain("timed out");
  expect(refusal.message).toContain("repair the repository or ownership configuration");
});
