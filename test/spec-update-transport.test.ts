import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSpec } from "../src/registry.ts";
import { CONFIG_FILE } from "../src/config.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { createSpecMcp, runSpecCommand } from "../src/mcp-spec.ts";
import { argumentError } from "../src/mcp.ts";
import { SPEC_COMMANDS, specCommandSchema } from "../src/spec-command-table.ts";
import { COMMANDS, commandUsage, completionScript } from "../src/commands-table.ts";
import { specGit } from "../src/spec-git.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(write: "mcp" | "cli" | "none" = "mcp") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-spec-update-transport-"))); roots.push(root);
  const home = join(root, "state"), repo = join(root, "repo"); mkdirSync(repo);
  const git = (args: string[]) => specGit(repo, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args]);
  git(["-c", "init.templateDir=", "init", "--quiet"]);
  const file = join(repo, "SPEC.md");
  writeFileSync(file, '---\nid: root\ntype: goal\ntitle: Original\nstatus: draft\ntags: [alpha, beta]\n---\n# Body stays unchanged\n');
  git(["add", "."]); git(["commit", "--quiet", "-m", "Synthetic update fixture"]);
  addSpec(home, { id: "fixture", path: repo, write, pii: "allow" });
  const env = { HOME: root, PATH: process.env.PATH, VMEM_HOME: home };
  const sha = () => createHash("sha256").update(readFileSync(file)).digest("hex");
  return { root, home, repo, file, env, sha };
}

test("spec update shares one bounded closed schema and advertises a write in MCP/help/manifest metadata", () => {
  const f = fixture(), server = createSpecMcp(f.home, f.env);
  const command = SPEC_COMMANDS.find(item => item.command === "update")!;
  const update = server.tools.find(tool => tool.name === "vmem_spec_update")!;
  expect(update.inputSchema).toEqual(command.inputSchema);
  expect(update.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  for (const tool of server.tools.filter(tool => tool.name !== "vmem_spec_update")) expect(tool.annotations.readOnlyHint).toBe(true);
  expect(server.tools.some(tool => ["vmem_spec_create", "vmem_spec_delete"].includes(tool.name))).toBe(false);
  expect(COMMANDS.find(item => item.name === "spec update")!.mutates).toBe(true);
  expect(commandUsage("spec update")).toContain("--expected-sha");
  expect(completionScript("bash")).toContain("--unset");
  for (const request of [
    { id: "root", set: { id: "renamed" } }, { id: "root", unset: ["title"] },
    { id: "root", add: { title: ["bad"] } }, { id: "root", remove: { tags: [1] } },
    { id: "root", set: { status: "done" } }, { id: "root", expectedSha: "short" },
  ]) expect(argumentError(request, specCommandSchema("update"))).toBeDefined();
});

test("spec update CLI parses all JSON operation flags, returns human receipts and keeps JSON opt-in", () => {
  const f = fixture();
  const human = runSpecCommand(["update", "root", "--expected-sha", f.sha(), "--set", '{"title":"Updated"}', "--unset", '["status"]', "--add", '{"tags":["gamma"]}', "--remove", '{"tags":["alpha"]}'], f.env);
  expect(human.code).toBe(0);
  expect(human.text).toContain("spec update root: updated");
  expect(human.text).toContain("SPEC.md");
  expect(human.text).toContain("person");
  expect(human.text.startsWith("{")).toBe(false);
  const data = parseFrontmatter(readFileSync(f.file, "utf8")).data;
  expect(data).toMatchObject({ id: "root", title: "Updated", tags: ["beta", "gamma"] });
  expect(data.status).toBeUndefined();
  const json = runSpecCommand(["update", "root", "--set", '{"title":"Updated"}', "--json"], f.env);
  expect(json.code).toBe(0);
  expect(JSON.parse(json.text)).toMatchObject({ ok: true, changed: false, actor: "person", path: "SPEC.md", sha256: f.sha() });
  expect(() => runSpecCommand(["update", "root", "--set", "not-json"], f.env)).toThrow("invalid JSON");
  expect(() => runSpecCommand(["update", "root", "--set", '{"id":"renamed"}'], f.env)).toThrow("unknown argument: id");
  expect(() => runSpecCommand(["update", "root", "--unset", '["title"]'], f.env)).toThrow("not an allowed value");
});

test("MCP updates are agent writes and respect the channel policy while CLI refusals exit nonzero", () => {
  const f = fixture(), server = createSpecMcp(f.home, f.env);
  const receipt = server.handlers.vmem_spec_update!({ id: "root", set: { title: "MCP update" }, expectedSha: f.sha() }) as { ok: boolean; changed: boolean; actor: string };
  expect(receipt).toMatchObject({ ok: true, changed: true, actor: "agent" });
  expect(() => server.handlers.vmem_spec_update!({ id: "root", set: { rogue: "field" } })).toThrow("unknown argument: rogue");
  const cliOnly = fixture("cli"), blocked = createSpecMcp(cliOnly.home, cliOnly.env);
  const before = readFileSync(cliOnly.file, "utf8");
  const denied = blocked.handlers.vmem_spec_update!({ id: "root", set: { title: "Forbidden" } }) as { ok: boolean; changed: boolean; issues: { message: string }[] };
  expect(denied).toMatchObject({ ok: false, changed: false });
  expect(denied.issues.some(issue => issue.message.includes("cli"))).toBe(true);
  expect(readFileSync(cliOnly.file, "utf8")).toBe(before);
  expect(runSpecCommand(["update", "root", "--set", '{"title":"CLI allowed"}'], cliOnly.env).code).toBe(0);
  const none = fixture("none"), refused = runSpecCommand(["update", "root", "--set", '{"title":"Forbidden"}'], none.env);
  expect(refused.code).toBe(1);
  expect(refused.text).toContain("refused");
  expect(refused.text).toContain("none");
});

test("MCP spec update refuses a changed startup registry binding before writing", () => {
  const f = fixture(), server = createSpecMcp(f.home, f.env), before = readFileSync(f.file, "utf8");
  const config = JSON.parse(readFileSync(join(f.home, CONFIG_FILE), "utf8"));
  config.specs[0].write = "none";
  writeFileSync(join(f.home, CONFIG_FILE), JSON.stringify(config));
  expect(() => server.handlers.vmem_spec_update!({ id: "root", set: { title: "Forbidden" } })).toThrow("registry changed since server startup");
  expect(readFileSync(f.file, "utf8")).toBe(before);
});
