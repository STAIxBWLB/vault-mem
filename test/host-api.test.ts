import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHostApi, amemVersion } from "../src/amem/host-api.ts";
import { agentMemInfo } from "../src/platform.ts";
import { run } from "../src/cli.ts";

describe("agent-mem host API", () => {
  test("accepts the supported API within the library interval", () => {
    expect(() => checkHostApi({ HOST_API_MIN: 1, HOST_API_VERSION: 2 }, "0.99.0")).not.toThrow();
    expect(agentMemInfo.version).toBe(amemVersion());
    expect(agentMemInfo.hostApi).toBeGreaterThanOrEqual(1);
  });
  test("refuses missing, invalid, or non-overlapping versions with a remedy", () => {
    for (const api of [{}, { HOST_API_MIN: 2, HOST_API_VERSION: 2 }, { HOST_API_MIN: 1, HOST_API_VERSION: 0 }, { HOST_API_MIN: "1", HOST_API_VERSION: 1 }]) {
      expect(() => checkHostApi(api, "0.99.0")).toThrow(/agent-mem 0.99.0: host API .* vmem host API 1; update/);
    }
  });
  test("both entry points refuse an incompatible installed package before opening a store", () => {
    const root = mkdtempSync(join(tmpdir(), "vmem-host-api-"));
    try {
      mkdirSync(join(root, "src/amem"), { recursive: true });
      const pkg = join(root, "node_modules/@staix/agent-mem");
      mkdirSync(pkg, { recursive: true });
      for (const file of ["src/platform.ts", "src/amem/host-api.ts", "src/amem/seam.ts"]) copyFileSync(file, join(root, file));
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: "0.99.0", type: "module", exports: { ".": "./root.js", "./platform": "./platform.js" } }));
      writeFileSync(join(pkg, "platform.js"), "export const HOST_API_MIN=2, HOST_API_VERSION=2;");
      writeFileSync(join(pkg, "root.js"), "export const HOST_API_MIN=2, HOST_API_VERSION=2; export function memoryHome(){throw Error('store accessed')}");
      for (const source of ["await import('./src/platform.ts')", "await (await import('./src/amem/seam.ts')).openAmem()"] ) {
        const child = Bun.spawnSync([process.execPath, "-e", `try { ${source} } catch (e) { console.error(e.message); process.exit(3) }`], { cwd: root, stdout: "pipe", stderr: "pipe" });
        expect(child.exitCode).toBe(3);
        expect(child.stderr.toString()).toContain("agent-mem 0.99.0: host API 2..2 is incompatible");
        expect(child.stderr.toString()).not.toContain("store accessed");
        expect(child.stderr.toString()).not.toContain("    at ");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("bootstrap keeps stacks except for host API refusals", () => {
    const root = mkdtempSync(join(tmpdir(), "vmem-bootstrap-"));
    try {
      mkdirSync(join(root, "bin"), { recursive: true });
      mkdirSync(join(root, "src/amem"), { recursive: true });
      copyFileSync("bin/vmem.js", join(root, "bin/vmem.js"));
      copyFileSync("src/amem/host-api.ts", join(root, "src/amem/host-api.ts"));
      const cli = join(root, "src/cli.ts");
      writeFileSync(cli, 'import { checkHostApi } from "./amem/host-api.ts"; checkHostApi({}, "0.99.0");');
      const refused = Bun.spawnSync([process.execPath, join(root, "bin/vmem.js")], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toMatch(/^vmem: agent-mem 0.99.0: host API .* update .*\n$/);
      writeFileSync(cli, 'throw new Error("synthetic load failure");');
      const failed = Bun.spawnSync([process.execPath, join(root, "bin/vmem.js")], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(failed.exitCode).toBe(1);
      expect(failed.stderr.toString()).toContain("synthetic load failure");
      expect(failed.stderr.toString()).toMatch(/\s+at .*cli\.ts/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("status and doctor expose the loaded version and API", () => {
    const home = mkdtempSync(join(tmpdir(), "vmem-host-api-home-"));
    try {
      for (const command of ["status", "doctor"]) {
        const output = JSON.parse(run([command, "--json"], { VMEM_HOME: home }).text);
        expect(output.agentMem).toEqual(agentMemInfo);
        const text = run([command], { VMEM_HOME: home }).text;
        expect(text).toContain(`agent-mem:  ${agentMemInfo.version}`);
        expect(text).toContain(`Host API:   ${agentMemInfo.hostApi}`);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
