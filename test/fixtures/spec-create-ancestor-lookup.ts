import { mock } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SpecGitOptions } from "../../src/spec-git.ts";
const [home, mode, requestedPath] = process.argv.slice(2);
if (!home || !mode) throw new Error("synthetic create ancestor-lookup fixture needs home and mode");
const git = await import("../../src/spec-git.ts"), inspect = git.specGit;
const stageQueries: { args: string[]; maxBuffer: number | undefined; bytes: number; records: number; phase: string }[] = [];
let rootChecks = 0, ignoreChecks = 0, stageAttempt = 0, injected = false;
mock.module("../../src/spec-git.ts", () => ({ ...git,
  specGit: (root: string, args: string[], options: SpecGitOptions = {}) => {
    const stage = args.includes("ls-files") && args.includes("--stage");
    const lock = join(home, "spec-mutations", createHash("sha256").update(root).digest("hex") + ".lock");
    const parent = dirname(join(root, requestedPath ?? "src/new/deep/SPEC.md"));
    const staged = existsSync(parent) && readdirSync(parent).some(file => file.startsWith(".spec-") && file.endsWith(".tmp"));
    const phase = !existsSync(lock) ? "initial" : staged ? "publication" : "locked";
    if (stage && ++stageAttempt === 3 && mode.startsWith("late-")) {
      if (phase !== "publication") throw new Error("synthetic late ancestor mutation requires an existing staged .spec-*.tmp file under the held lock");
      if (mode === "late-gitlink") {
        const commit = inspect(root, ["rev-parse", "HEAD"], options).stdout.toString("utf8").trim();
        inspect(root, ["update-index", "--add", "--cacheinfo", `160000,${commit},src/new`], options);
      } else if (mode === "late-nested-repo") inspect(join(root, "src/new"), ["-c", "init.templateDir=", "init", "--quiet"], options);
      else throw new Error("unknown synthetic late ancestor mutation");
      injected = true;
    }
    if (args.length === 2 && args[0] === "rev-parse" && args[1] === "--show-toplevel") rootChecks++;
    if (args[0] === "check-ignore") ignoreChecks++;
    if (stage && mode === "overflow") {
      // Match specGit's wrapped native spawn failure, retaining the errno in cause.
      throw new Error("spec source: git output exceeded 65536 bytes; make SPEC.md paths more specific, or inspect the failed Git command if its output is unexpected, before retrying", { cause: Object.assign(new Error("synthetic native Git output overflow"), { code: "ENOBUFS" }) });
    }
    const result = inspect(root, args, options);
    if (stage) stageQueries.push({ args, maxBuffer: options.maxBuffer, bytes: result.stdout.byteLength, records: result.stdout.toString("utf8").split("\0").filter(Boolean).length, phase });
    return result;
  },
}));
const { createSpec } = await import("../../src/spec-write.ts");
const result = createSpec(home, { path: requestedPath ?? "src/new/deep/SPEC.md", id: "child", type: "module", title: "Ancestor lookup fixture", parent: "root" }, { env: process.env });
console.log(JSON.stringify({ result, stageQueries, rootChecks, ignoreChecks, injected }));
