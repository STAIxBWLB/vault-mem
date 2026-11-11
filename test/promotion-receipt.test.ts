import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";

for (const source of ["org", "amem"]) for (const state of ["applied", "refused"]) test(`${source} MCP promotion preserves ${state} failure receipt semantics`, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-promotion-receipt-")));
  try {
    const home = join(root, "state"), mine = join(root, "mine"), team = join(root, "team");
    mkdirSync(join(mine, "notes"), { recursive: true }); mkdirSync(join(team, "notes"), { recursive: true });
    const moc = "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n";
    for (const vault of [mine, team]) writeFileSync(join(vault, "notes", "research.md"), moc);
    writeFileSync(join(mine, "notes", "alpha.md"), "---\ntitle: Synthetic Org Promotion\ntype: insight\ndomain: research\ndescription: Synthetic promotion source.\ntopics: ['[[research]]']\n---\n# Synthetic Org Promotion\n\nSynthetic method.\n\n## Topics\n\n- [[research]]\n");
    addVault(home, { id: "mine", path: mine, kind: "personal", write: "mcp" });
    addVault(home, { id: "team", path: team, kind: "org", write: "mcp" });
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/promotion-receipt-fault.ts"), home, source, state], {
      env: { HOME: root, PATH: process.env.PATH, VMEM_HOME: home, AMEM_HOME: join(root, "memory"), AGENTHUB_HOME: join(root, "family") }, stdout: "pipe", stderr: "pipe", timeout: 20_000,
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const output = JSON.parse(child.stdout.toString()), result = output.reply;
    expect(output.injected).toBe(true);
    expect(result).toMatchObject({ ok: false, applied: state === "applied" });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "SYNTHETIC" }));
    const target = source === "org" ? join(team, "notes", "alpha.md") : join(mine, "notes", "amem-promotion.md");
    expect(result.note).toMatchObject({ ok: false, applied: state === "applied" });
    if (state === "applied") {
      expect(result).not.toHaveProperty("refused");
      expect(readFileSync(target, "utf8")).toContain(source === "org" ? "Synthetic Org Promotion" : "Synthetic Amem Promotion");
      expect(output.text).not.toContain("refused: nothing written");
      expect(output.text).toMatch(/with problems|promotion is incomplete/);
    } else {
      expect(result.refused).toBe(true); expect(existsSync(target)).toBe(false);
      expect(output.text).toContain("refused: nothing written");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
