import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";

for (const source of ["org", "amem"]) for (const state of ["applied", "refused"]) test(`${source} MCP promotion preserves ${state} failure receipt semantics`, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-promotion-receipt-")));
  try {
    const home = join(root, "state"), mine = join(root, "mine"), team = join(root, "team");
    mkdirSync(join(mine, "notes"), { recursive: true }); mkdirSync(join(team, "notes"), { recursive: true });
    addVault(home, { id: "mine", path: mine, kind: "personal", write: "mcp" });
    addVault(home, { id: "team", path: team, kind: "org", write: "mcp" });
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/promotion-receipt-fault.ts"), home, source, state], {
      env: { HOME: root, PATH: process.env.PATH, VMEM_HOME: home, AMEM_HOME: join(root, "memory"), AGENTHUB_HOME: join(root, "family") }, stdout: "pipe", stderr: "pipe", timeout: 20_000,
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result).toMatchObject({ ok: false, applied: state === "applied", issues: [{ code: "SYNTHETIC" }] });
    if (state === "applied") expect(result).not.toHaveProperty("refused");
    else expect(result.refused).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
