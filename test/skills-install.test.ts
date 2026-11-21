import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSkills, installSkills, SKILL_NAMES, skillRoot } from "../src/skills-install.ts";

function fixture() { const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-skills-"))); return { root, target: join(root, "skills") }; }
test("install, idempotent apply, upgrade and undo respect markers", () => {
  const f = fixture();
  try {
    expect(installSkills(f.target, "dry-run").actions.every(a => a.change === "install")).toBe(true);
    expect(existsSync(f.target)).toBe(false);
    expect(installSkills(f.target, "apply").actions.every(a => a.change === "install")).toBe(true);
    for (const name of SKILL_NAMES) {
      const dir = join(f.target, name), marker = JSON.parse(readFileSync(join(dir, ".vmem-skill.json"), "utf8"));
      expect(marker).toMatchObject({ tool: "vmem", version: expect.any(String), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(existsSync(join(dir, "references", "vault-adapter.md"))).toBe(true);
    }
    expect(installSkills(f.target, "apply").actions.every(a => a.change === "unchanged")).toBe(true);
    expect(installSkills(f.target, "apply", undefined, "0.0.0-test").actions.every(a => a.change === "replace")).toBe(true);
    expect(installSkills(f.target, "undo").actions.every(a => a.change === "remove")).toBe(true);
    expect(SKILL_NAMES.every(name => !existsSync(join(f.target, name)))).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test("foreign and modified skills survive apply and undo", () => {
  const f = fixture();
  try {
    mkdirSync(f.target, { recursive: true });
    const foreign = join(f.root, "foreign"); mkdirSync(foreign); writeFileSync(join(foreign, "keep"), "foreign");
    symlinkSync(foreign, join(f.target, "vault-connect"));
    writeFileSync(join(f.target, "vault-learn"), "foreign file");
    mkdirSync(join(f.target, "vault-lint")); writeFileSync(join(f.target, "vault-lint", "keep"), "foreign directory");
    const first = installSkills(f.target, "apply");
    expect(first.actions.find(a => a.name === "vault-connect")).toMatchObject({ change: "foreign", reason: expect.stringContaining("vmem skills export") });
    expect(first.actions.find(a => a.name === "vault-learn")?.change).toBe("foreign");
    expect(first.actions.find(a => a.name === "vault-lint")?.change).toBe("foreign");
    writeFileSync(join(f.target, "vault-extract", "SKILL.md"), "local edit");
    const next = installSkills(f.target, "apply");
    expect(next.actions.find(a => a.name === "vault-extract")).toMatchObject({ change: "modified", reason: expect.stringContaining("vmem skills export") });
    const undone = installSkills(f.target, "undo");
    expect(undone.actions.find(a => a.name === "vault-connect")?.change).toBe("foreign");
    expect(undone.actions.find(a => a.name === "vault-extract")?.change).toBe("modified");
    expect(readFileSync(join(foreign, "keep"), "utf8")).toBe("foreign");
    expect(readFileSync(join(f.target, "vault-learn"), "utf8")).toBe("foreign file");
    expect(readFileSync(join(f.target, "vault-lint", "keep"), "utf8")).toBe("foreign directory");
    expect(readFileSync(join(f.target, "vault-extract", "SKILL.md"), "utf8")).toBe("local edit");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test("export refuses foreign root entries and host roots follow configuration", () => {
  const f = fixture();
  try {
    mkdirSync(f.target); writeFileSync(join(f.target, "foreign"), "keep");
    expect(() => exportSkills(f.target)).toThrow(/foreign entries/);
    expect(readFileSync(join(f.target, "foreign"), "utf8")).toBe("keep");
    const env = { HOME: f.root, CLAUDE_CONFIG_DIR: join(f.root, "claude"), CODEX_HOME: join(f.root, "codex"), KIMI_CODE_HOME: join(f.root, "kimi"), QWEN_HOME: join(f.root, "qwen") };
    for (const host of ["claude", "codex", "kimi", "qwen"] as const) expect(skillRoot(host, env)).toBe(join(f.root, host, "skills"));
    for (const host of ["pi", "jcode", "agy"] as const) expect(skillRoot(host, env)).toBeUndefined();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("empty local directories count as modifications and are preserved", () => {
  const f = fixture();
  try {
    installSkills(f.target, "apply");
    const dir = join(f.target, "vault-connect", "local-empty"); mkdirSync(dir);
    expect(installSkills(f.target, "apply", undefined, "0.0.0-test").actions.find(a => a.name === "vault-connect")?.change).toBe("modified");
    expect(installSkills(f.target, "undo").actions.find(a => a.name === "vault-connect")?.change).toBe("modified");
    expect(existsSync(dir)).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("replacement and undo restore the original when post-rename inspection fails", async () => {
  const fs = await import("node:fs"), { spyOn } = await import("bun:test"), f = fixture();
  try {
    installSkills(f.target, "apply");
    const old = readFileSync(join(f.target, "vault-connect", "SKILL.md"), "utf8"), original = fs.lstatSync;
    let tempCalls = 0;
    const spy = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      const name = String(args[0]);
      if (name.startsWith(join(f.target, ".vmem-skill-")) && !name.slice(f.target.length + 1).includes("/") && ++tempCalls === 2) throw new Error("synthetic inspection failure");
      return original(...args);
    }) as typeof fs.lstatSync);
    let result;
    try { result = installSkills(f.target, "apply", undefined, "0.0.0-test"); } finally { spy.mockRestore(); }
    expect(result.actions.find(a => a.name === "vault-connect")?.change).toBe("refused");
    expect(readFileSync(join(f.target, "vault-connect", "SKILL.md"), "utf8")).toBe(old);
    let first = true;
    const spy2 = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      const name = String(args[0]);
      if (first && name.startsWith(join(f.target, ".vmem-skill-"))) { first = false; throw new Error("synthetic inspection failure"); }
      return original(...args);
    }) as typeof fs.lstatSync);
    try { result = installSkills(f.target, "undo"); } finally { spy2.mockRestore(); }
    expect(result.actions.find(a => a.name === "vault-connect")?.change).toBe("refused");
    expect(readFileSync(join(f.target, "vault-connect", "SKILL.md"), "utf8")).toBe(old);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test("export uses a human table by default and keeps JSON and color modes", async () => {
  const { runAsync } = await import("../src/cli.ts");
  const { stripTerminal } = await import("../src/text-output.ts");
  const f = fixture();
  try {
    const target = join(f.root, "export space");
    const text = await runAsync(["skills", "export", target, "--color=never"], {});
    expect(text.code).toBe(0);
    expect(text.text).toContain("skills export:");
    for (const field of ["NAME", "CHANGE", "PATH", "REASON", "vault-connect"]) expect(text.text).toContain(field);
    expect(text.text.trimStart().startsWith("{")).toBe(false);
    const json = await runAsync(["skills", "export", target, "--json"], {});
    expect(JSON.parse(json.text).actions).toHaveLength(13);
    const colored = await runAsync(["skills", "export", target, "--color=always"], {});
    expect(stripTerminal(colored.text)).not.toBe(colored.text);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("export conflicts give an executable command for a path with spaces", () => {
  const f = fixture();
  try {
    const target = join(f.root, "export space"); mkdirSync(target);
    writeFileSync(join(target, "vault-connect"), "foreign file");
    const report = exportSkills(target), action = report.actions.find(item => item.name === "vault-connect")!;
    expect(action.change).toBe("foreign");
    expect(action.reason).toContain(`vmem skills export '${target}'`);
    expect(readFileSync(join(target, "vault-connect"), "utf8")).toBe("foreign file");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
