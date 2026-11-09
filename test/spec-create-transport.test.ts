import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE } from "../src/config.ts";
import { COMMANDS, commandUsage, completionScript } from "../src/commands-table.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { argumentError } from "../src/mcp.ts";
import { createSpecMcp, runSpecCommand } from "../src/mcp-spec.ts";
import { addSpec } from "../src/registry.ts";
import { SPEC_COMMANDS, specCommandSchema } from "../src/spec-command-table.ts";
import { specGit } from "../src/spec-git.ts";
import type { SpecWriteResult } from "../src/spec-write.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(write: "mcp" | "cli" | "none" = "mcp") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-spec-create-transport-"))); roots.push(root);
  const home = join(root, "state"), repo = join(root, "repo"); mkdirSync(repo);
  const env = { HOME: root, PATH: process.env.PATH, VMEM_HOME: home };
  const git = (args: string[]) => specGit(repo, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { env });
  git(["-c", "init.templateDir=", "init", "--quiet"]);
  writeFileSync(join(repo, "SPEC.md"), "---\nid: root\ntype: goal\ntitle: Root\nstatus: draft\n---\n# Root\n");
  git(["add", "."]); git(["commit", "--quiet", "-m", "Synthetic create fixture"]);
  addSpec(home, { id: "fixture", path: repo, write, pii: "allow" }, env);
  return { root, home, repo, env, git };
}
const input = { path: "child.md", id: "child", type: "module", title: "Created child", parent: "root" };
const cli = ["create", "child.md", "--id", "child", "--type", "module", "--title", "Created child", "--parent", "root"];

test("create shares a bounded closed schema, advertises mutation and keeps delete absent", () => {
  const f = fixture(), server = createSpecMcp(f.home, f.env), schema = specCommandSchema("create");
  expect(server.tools.find(tool => tool.name === "vmem_spec_create")).toMatchObject({
    inputSchema: SPEC_COMMANDS.find(item => item.command === "create")!.inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  });
  expect(server.tools.some(tool => tool.name === "vmem_spec_delete")).toBe(false);
  expect(COMMANDS.find(item => item.name === "spec create")!.mutates).toBe(true);
  expect(commandUsage("spec create")).toContain("<path> --id ID");
  expect(completionScript("bash")).toContain("--verified-against");
  expect(argumentError(input, schema)).toBeUndefined();
  for (const request of [
    { ...input, body: "not accepted" }, { ...input, type: "task-spec" }, { ...input, status: "done" },
    { ...input, title: "" }, { ...input, id: undefined }, { ...input, references: "root" },
    { ...input, tags: [1] }, { ...input, tags: Array(257).fill("x") },
    { ...input, expectedSha: "a".repeat(64) },
  ]) expect(argumentError(request, schema)).toBeDefined();
  const stampSchema = (schema.properties as unknown as Record<string, { pattern: string }>)["verified-against"]!;
  const pattern = new RegExp(stampSchema.pattern);
  for (const stamp of ["a".repeat(40), "A".repeat(64)]) {
    expect(pattern.test(stamp)).toBe(true);
    expect(argumentError({ ...input, "verified-against": stamp }, schema)).toBeUndefined();
  }
  const invalidStamp = "a".repeat(41);
  expect(pattern.test(invalidStamp)).toBe(false);
  expect(argumentError({ ...input, "verified-against": invalidStamp }, schema)).toContain("pattern");
  expect(() => server.handlers.vmem_spec_create!({ ...input, "verified-against": invalidStamp })).toThrow("required pattern");
  expect(existsSync(join(f.repo, "child.md"))).toBe(false);
});

test("create CLI parses optional fields and JSON lists, returning created receipts and JSON on request", () => {
  const f = fixture(), stamp = f.git(["rev-parse", "HEAD"]).stdout.toString().trim();
  const result = runSpecCommand([...cli, "--status", "deprecated", "--superseded-by", "root", "--depends-on", '["root"]', "--references", '["root"]', "--implements", '["root"]', "--covers", '["synthetic-token"]', "--tags", '["alpha"]', "--paths", '["SPEC.md"]', "--verified-against", stamp], f.env);
  expect(result.code).toBe(0);
  expect(result.text).toContain("spec create child: created");
  expect(result.text).toContain("child.md"); expect(result.text).toContain("person"); expect(result.text.startsWith("{")).toBe(false);
  const file = readFileSync(join(f.repo, "child.md"), "utf8"), document = parseFrontmatter(file);
  expect(document.data).toMatchObject({ id: "child", type: "module", title: "Created child", status: "deprecated", parent: "root", "superseded-by": "root", "depends-on": ["root"], references: ["root"], implements: ["root"], covers: ["synthetic-token"], tags: ["alpha"], paths: ["SPEC.md"], "verified-against": stamp });
  expect(result.text).toContain(createHash("sha256").update(file).digest("hex"));
  const json = runSpecCommand(["create", "another.md", "--id", "another", "--type", "architecture", "--title", "Another", "--parent", "root", "--json"], f.env);
  expect(json.code).toBe(0); expect(JSON.parse(json.text)).toMatchObject({ ok: true, changed: true, path: "another.md", actor: "person" });
  for (const args of [
    ["create", "third.md", "--type", "module", "--title", "Missing id"],
    ["create", "third.md", "--id", "third", "--type", "module", "--title", "Bad list", "--tags", "not-json"],
    [...cli, "--title", "Repeated"], [...cli, "--body", "Forbidden"], [...cli, "extra.md"],
  ]) expect(() => runSpecCommand(args, f.env)).toThrow();
});

test("MCP creates are agent writes and both transports enforce source policy with failure exit codes", () => {
  const f = fixture(), server = createSpecMcp(f.home, f.env);
  expect(server.handlers.vmem_spec_create!(input)).toMatchObject({ ok: true, changed: true, actor: "agent", path: "child.md" });
  const existing = runSpecCommand(cli, f.env);
  expect(existing.code).toBe(1); expect(existing.text).toContain("refused");
  for (const write of ["cli", "none"] as const) {
    const denied = fixture(write), mcp = createSpecMcp(denied.home, denied.env);
    const result = mcp.handlers.vmem_spec_create!(input) as SpecWriteResult;
    expect(result).toMatchObject({ ok: false, changed: false, actor: "agent", refused: true });
    expect(result.issues.some(issue => issue.message.includes(write))).toBe(true);
    expect(existsSync(join(denied.repo, "child.md"))).toBe(false);
    const resultCli = runSpecCommand(cli, denied.env);
    expect(resultCli.code).toBe(write === "cli" ? 0 : 1);
    expect(existsSync(join(denied.repo, "child.md"))).toBe(write === "cli");
  }
});

test("MCP create marks validation refusals while schema and source lookup errors still throw", () => {
  const f = fixture(), server = createSpecMcp(f.home, f.env);
  const result = server.handlers.vmem_spec_create!({ ...input, "depends-on": ["missing"] }) as SpecWriteResult;
  expect(result).toMatchObject({ ok: false, changed: false, refused: true, path: "child.md", actor: "agent" });
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "dangling_link", path: "child.md" }));
  expect(() => server.handlers.vmem_spec_create!({ ...input, source: "missing" })).toThrow("no matching source");
  expect(() => server.handlers.vmem_spec_create!({ ...input, rogue: "field" })).toThrow("unknown argument: rogue");
  expect(existsSync(join(f.repo, "child.md"))).toBe(false);
});

test("CLI create validation refusal names the missing id and a create-specific retry", () => {
  const f = fixture();
  const result = runSpecCommand([...cli, "--depends-on", '["missing"]'], f.env);
  expect(result.code).toBe(1);
  expect(result.text).toContain("spec create child: refused");
  expect(result.text).toContain("dangling_link"); expect(result.text).toContain("missing");
  expect(result.text).toMatch(/(?:create|source tree)[^\n]*retry/);
  expect(result.text).not.toContain("expectedSha");
  expect(result.text).not.toContain("retry the update");
  expect(result.text).not.toContain("correct the update");
  expect(existsSync(join(f.repo, "child.md"))).toBe(false);
});

test("MCP spec create rejects registry binding drift before writing", () => {
  const f = fixture(), server = createSpecMcp(f.home, f.env);
  const config = JSON.parse(readFileSync(join(f.home, CONFIG_FILE), "utf8"));
  config.specs[0].write = "none"; writeFileSync(join(f.home, CONFIG_FILE), JSON.stringify(config));
  expect(() => server.handlers.vmem_spec_create!(input)).toThrow("registry changed since server startup");
  expect(existsSync(join(f.repo, "child.md"))).toBe(false);
});
