import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE } from "../src/config.ts";
import { COMMANDS, commandUsage, completionScript } from "../src/commands-table.ts";
import { argumentError } from "../src/mcp.ts";
import { createSpecMcp, runSpecCommand } from "../src/mcp-spec.ts";
import { addSpec } from "../src/registry.ts";
import { SPEC_COMMANDS, specCommandSchema } from "../src/spec-command-table.ts";
import { SPEC_EDGE_KINDS } from "../src/spec-graph.ts";
import { specGit } from "../src/spec-git.ts";
import type { SpecDeleteResult } from "../src/spec-write.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(write: "mcp" | "cli" | "none" = "mcp") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-spec-delete-transport-"))); roots.push(root);
  const home = join(root, "state"), repo = join(root, "repo"); mkdirSync(repo);
  const env = { HOME: root, PATH: process.env.PATH, VMEM_HOME: home };
  const git = (args: string[]) => specGit(repo, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { env });
  git(["-c", "init.templateDir=", "init", "--quiet"]);
  const file = join(repo, "SPEC.md");
  const original = "---\nid: root\ntype: goal\ntitle: Root\nstatus: active\n---\n# Root\n";
  writeFileSync(file, original);
  writeFileSync(join(repo, "child.md"), "---\nid: child\ntype: module\ntitle: Child\nstatus: deprecated\nparent: root\ndepends-on: [root]\nreferences: [root]\nimplements: [root]\nsuperseded-by: root\n---\n# Child\n\n[[root]]\n");
  git(["add", "."]); git(["commit", "--quiet", "-m", "Synthetic delete fixture"]);
  addSpec(home, { id: "fixture", path: repo, write, pii: "allow" }, env);
  return { root, home, repo, file, original, env, git };
}

test("delete shares a bounded closed schema and advertises a destructive non-idempotent mutation", () => {
  const f = fixture(), server = createSpecMcp(f.home, f.env), schema = specCommandSchema("delete");
  expect(server.tools.find(tool => tool.name === "vmem_spec_delete")).toMatchObject({
    inputSchema: SPEC_COMMANDS.find(item => item.command === "delete")!.inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  });
  expect(COMMANDS.find(item => item.name === "spec delete")!.mutates).toBe(true);
  expect(commandUsage("spec delete")).toContain("--confirm");
  expect(completionScript("bash")).toContain("--fingerprint");
  expect(argumentError({ id: "root" }, schema)).toBeUndefined();
  expect(argumentError({ id: "root", confirm: true, fingerprint: "a".repeat(64) }, schema)).toBeUndefined();
  for (const request of [
    {}, { id: "" }, { id: "root", confirm: "true" }, { id: "root", fingerprint: "short" },
    { id: "root", path: "SPEC.md" }, { id: "root", title: "Not accepted" },
    { id: "root", body: "Not accepted" }, { id: "root", limit: 5 },
  ]) expect(argumentError(request, schema)).toBeDefined();
});

test("delete CLI preview lists every relation and a confirm command, then deletes with the same fingerprint", () => {
  const f = fixture(), human = runSpecCommand(["delete", "root"], f.env);
  expect(human.code).toBe(0); expect(human.text).toContain("spec delete root: preview");
  expect(human.text).toContain("Backlinks"); expect(human.text).toContain("Children");
  expect(human.text).toContain("child.md"); expect(human.text).toContain("--confirm --fingerprint");
  for (const edge of SPEC_EDGE_KINDS) expect(human.text).toContain(edge);
  expect(readFileSync(f.file, "utf8")).toBe(f.original);
  expect(existsSync(join(f.home, "spec-mutations"))).toBe(false);
  const preview = runSpecCommand(["delete", "root", "--json"], f.env), receipt = JSON.parse(preview.text) as SpecDeleteResult;
  expect(preview.code).toBe(0);
  expect(receipt).toMatchObject({ ok: true, changed: false, preview: true, path: "SPEC.md", actor: "person", sha256: createHash("sha256").update(f.original).digest("hex") });
  expect(receipt.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.backlinks).toHaveLength(SPEC_EDGE_KINDS.length); expect(receipt.children).toHaveLength(1);
  expect(human.text).toContain(receipt.fingerprint!);
  const missing = runSpecCommand(["delete", "root", "--confirm"], f.env);
  expect(missing.code).toBe(1); expect(missing.text).toContain("refused"); expect(existsSync(f.file)).toBe(true);
  const result = runSpecCommand(["delete", "root", "--confirm", "--fingerprint", receipt.fingerprint!], f.env);
  expect(result.code).toBe(0); expect(result.text).toContain("spec delete root: deleted");
  expect(existsSync(f.file)).toBe(false); expect(existsSync(join(f.repo, "child.md"))).toBe(true);
  for (const args of [["delete"], ["delete", "root", "extra"], ["delete", "root", "--confirm", "--confirm"], ["delete", "root", "--title", "Unknown"]]) expect(() => runSpecCommand(args, f.env)).toThrow();
});

test("MCP delete preview and confirm preserve agent attribution and reject a stale fingerprint", () => {
  const f = fixture(), server = createSpecMcp(f.home, f.env);
  const preview = server.handlers.vmem_spec_delete!({ id: "root" }) as SpecDeleteResult;
  expect(preview).toMatchObject({ ok: true, changed: false, preview: true, actor: "agent" });
  expect(existsSync(join(f.home, "spec-mutations"))).toBe(false);
  const denied = server.handlers.vmem_spec_delete!({ id: "root", confirm: true, fingerprint: "0".repeat(64) }) as SpecDeleteResult;
  expect(denied).toMatchObject({ ok: false, changed: false, actor: "agent" }); expect(existsSync(f.file)).toBe(true);
  const confirmed = server.handlers.vmem_spec_delete!({ id: "root", confirm: true, fingerprint: preview.fingerprint! }) as SpecDeleteResult;
  expect(confirmed).toMatchObject({ ok: true, changed: true, actor: "agent", path: "SPEC.md" });
  expect(existsSync(f.file)).toBe(false);
});

test("delete transports enforce source policy for previews and confirmations", () => {
  for (const write of ["cli", "none"] as const) {
    const f = fixture(write), server = createSpecMcp(f.home, f.env);
    for (const request of [{ id: "root" }, { id: "root", confirm: true, fingerprint: "a".repeat(64) }]) {
      const refused = server.handlers.vmem_spec_delete!(request) as SpecDeleteResult;
      expect(refused).toMatchObject({ ok: false, changed: false });
      expect(refused.issues.some(issue => issue.message.includes(write))).toBe(true);
    }
    const preview = runSpecCommand(["delete", "root", "--json"], f.env);
    expect(preview.code).toBe(write === "cli" ? 0 : 1);
    expect(readFileSync(f.file, "utf8")).toBe(f.original);
    if (write === "cli") {
      const receipt = JSON.parse(preview.text) as SpecDeleteResult;
      expect(runSpecCommand(["delete", "root", "--confirm", "--fingerprint", receipt.fingerprint!], f.env).code).toBe(0);
    }
  }
});

test("MCP delete rejects changed startup binding before previewing or mutating", () => {
  const f = fixture(), server = createSpecMcp(f.home, f.env);
  const config = JSON.parse(readFileSync(join(f.home, CONFIG_FILE), "utf8"));
  config.specs[0].write = "none"; writeFileSync(join(f.home, CONFIG_FILE), JSON.stringify(config));
  expect(() => server.handlers.vmem_spec_delete!({ id: "root" })).toThrow("registry changed since server startup");
  expect(readFileSync(f.file, "utf8")).toBe(f.original);
  expect(existsSync(join(f.home, "spec-mutations"))).toBe(false);
});
