import { mock } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SpecGitOptions } from "../../src/spec-git.ts";
const [home, mode, requestedPath] = process.argv.slice(2);
if (!home || !mode) throw new Error("synthetic create ancestor-lookup fixture needs home and mode");
const git = await import("../../src/spec-git.ts"), inspect = git.specGit;
const lookups: { ancestors: string[]; matched: boolean; bytes: number; records: number; phase: string }[] = [];
let rootChecks = 0, ignoreChecks = 0, lookupAttempt = 0, injected = false;
mock.module("../../src/spec-git.ts", () => ({ ...git,
  specGit: (root: string, args: string[], options: SpecGitOptions = {}) => {
    if (args.length === 2 && args[0] === "rev-parse" && args[1] === "--show-toplevel") rootChecks++;
    if (args[0] === "check-ignore") ignoreChecks++;
    return inspect(root, args, options);
  },
}));
const links = await import("../../src/spec-gitlinks.ts"), scan = links.specGitlinkAncestors;
mock.module("../../src/spec-gitlinks.ts", () => ({ ...links,
  specGitlinkAncestors: (root: string, ancestors: string[], env: NodeJS.ProcessEnv) => {
    const lock = join(home, "spec-mutations", createHash("sha256").update(root).digest("hex") + ".lock");
    const parent = dirname(join(root, requestedPath ?? "src/new/deep/SPEC.md"));
    const staged = existsSync(parent) && readdirSync(parent).some(file => file.startsWith(".spec-") && file.endsWith(".tmp"));
    const phase = !existsSync(lock) ? "initial" : staged ? "publication" : "locked";
    if (++lookupAttempt === 3 && mode.startsWith("late-")) {
      if (phase !== "publication") throw new Error("synthetic late ancestor mutation requires an existing staged .spec-*.tmp file under the held lock");
      if (mode === "late-gitlink") {
        const commit = inspect(root, ["rev-parse", "HEAD"], { env }).stdout.toString("utf8").trim();
        inspect(root, ["update-index", "--add", "--cacheinfo", `160000,${commit},src/new`], { env });
      } else if (mode === "late-nested-repo") inspect(join(root, "src/new"), ["-c", "init.templateDir=", "init", "--quiet"], { env });
      else throw new Error("unknown synthetic late ancestor mutation");
      injected = true;
    }
    if (mode === "overflow") throw Object.assign(new Error("gitlink index scan exceeded its bounded output limit; inspect git ls-files --stage for unexpected index entries, reduce the index size and retry the create"), { code: "LIMIT" });
    const result = scan(root, ancestors, env);
    lookups.push({ ancestors, ...result, phase });
    return result;
  },
}));
const { createSpec } = await import("../../src/spec-write.ts");
const result = createSpec(home, { path: requestedPath ?? "src/new/deep/SPEC.md", id: "child", type: "module", title: "Ancestor lookup fixture", parent: "root" }, { env: process.env });
console.log(JSON.stringify({ result, lookups, rootChecks, ignoreChecks, injected }));
