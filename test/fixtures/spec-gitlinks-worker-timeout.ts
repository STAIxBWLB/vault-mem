import { mock } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const [mode, pidFile] = process.argv.slice(2);
if (!pidFile) throw new Error("synthetic worker-timeout fixture needs a pid file");
if (mode === "blocked-worker") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(pidFile, JSON.stringify({ worker: process.pid, git: child.pid }));
  // Simulate a worker unable to service its timer while its Git child stays alive.
  for (;;) { /* synthetic blocked worker, bounded by the outer parent timeout */ }
}
const original = spawnSync;
mock.module("node:child_process", () => ({ spawn,
  spawnSync: (command: string, args: string[], options: Parameters<typeof spawnSync>[2]) => {
    if (!args[0]?.endsWith("spec-gitlinks.ts")) throw new Error("synthetic fixture expected the scanner worker");
    return original(command, [import.meta.path, "blocked-worker", pidFile], { ...options, timeout: 200 });
  },
}));
const { specGitlinkAncestors } = await import("../../src/spec-gitlinks.ts");
try { specGitlinkAncestors(process.cwd(), ["src"], process.env); }
catch (error) { console.log(JSON.stringify({ code: (error as { code?: string }).code, message: (error as Error).message })); }
