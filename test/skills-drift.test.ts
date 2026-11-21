import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { COMMANDS } from "../src/commands-table.ts";
import { VMEM_TOOL_NAMES } from "../src/mcp-vault.ts";
import { SKILL_NAMES } from "../src/skills-install.ts";

const root = resolve(import.meta.dir, "..");
const skillRoot = join(root, "skills");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}

// Inline and fenced code, shell lines, and explicit prose instructions are command
// examples. Ordinary prose such as "vmem reads" is not a command.
function commandReferences(text: string): string[] {
  const snippets = [...text.matchAll(/`([^`\n]+)`/g)].map(match => match[1]!);
  for (const block of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) snippets.push(block[1]!);
  for (const line of text.matchAll(/^\s*(?:[$#]\s*)?(vmem[ \t]+[a-z][^\n]*(?:<[^\n]*|--[^\n]*))/gm)) snippets.push(line[1]!);
  for (const instruction of text.matchAll(/\b(?:run|execute|invoke|command:)\s+(vmem[ \t]+[a-z][a-z-]*(?:[ \t]+[a-z][a-z-]*)?)/gi)) snippets.push(instruction[1]!);
  const groups = new Set(COMMANDS.map(c => c.name.split(" ")).filter(parts => parts.length > 1).map(parts => parts[0]!));
  return snippets.flatMap(snippet => [...snippet.matchAll(/\bvmem\s+([a-z][a-z-]*)(?:[ \t]+([a-z][a-z-]*))?/g)].map(match => {
    const first = match[1]!;
    return groups.has(first) && match[2] ? `${first} ${match[2]}` : first;
  }));
}

describe("bundled skill drift", () => {
  test("command extraction keeps unknown commands and subcommands", () => {
    expect(commandReferences("`vmem imaginary` and `vmem graph imaginary` and `vmem lint <vault>`\nvmem bogus <vault>\nrun vmem graph missing"))
      .toEqual(["imaginary", "graph imaginary", "lint", "bogus", "graph missing"]);
  });
  test("all tool and CLI references exist in the live tables", () => {
    const tools = new Set<string>(VMEM_TOOL_NAMES);
    const commands = new Set(COMMANDS.map(command => command.name));
    const errors: string[] = [];
    for (const file of files(skillRoot).filter(file => file.endsWith(".md"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/\bvmem_[a-z][a-z0-9_]*/g)) {
        if (!tools.has(match[0])) errors.push(`${file}: unknown tool ${match[0]}`);
      }
      for (const command of commandReferences(text)) {
        if (!commands.has(command)) errors.push(`${file}: unknown command vmem ${command}`);
      }
    }
    expect(errors).toEqual([]);
  });

  test("exported skills have matching names and resolve their local references", () => {
    const temp = mkdtempSync(join(tmpdir(), "vmem-skill-drift-"));
    try {
      const target = join(temp, "export");
      const run = Bun.spawnSync([process.execPath, join(root, "bin/vmem.js"), "skills", "export", target, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
      const names = readdirSync(skillRoot, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith("_")).map(e => e.name).sort();
      expect(names).toEqual([...SKILL_NAMES].sort());
      expect(SKILL_NAMES).toHaveLength(13);
      const report = JSON.parse(run.stdout.toString()) as { actions: { name: string; change: string }[] };
      expect(report.actions.map(action => [action.name, action.change]).sort()).toEqual(names.map(name => [name, "install"]).sort());
      expect(readdirSync(target).sort()).toEqual(names);
      for (const name of names) {
        const dir = join(target, name);
        const manifest = readFileSync(join(dir, "SKILL.md"), "utf8");
        const marker = JSON.parse(readFileSync(join(dir, ".vmem-skill.json"), "utf8"));
        expect(marker.tool).toBe("vmem");
        expect(typeof marker.version).toBe("string");
        expect(marker.sha256).toMatch(/^[a-f0-9]{64}$/);
        const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\n|$)/.exec(manifest)?.[1];
        expect(frontmatter).toBeDefined();
        const metadata = Bun.YAML.parse(frontmatter!) as { name?: unknown; description?: unknown };
        expect(metadata.name).toBe(name);
        expect(typeof metadata.description).toBe("string");
        expect((metadata.description as string).trim().length).toBeGreaterThan(0);
        expect(readFileSync(join(dir, "references/vault-adapter.md"), "utf8")).toBe(readFileSync(join(skillRoot, "_shared/vault-adapter.md"), "utf8"));
        for (const file of files(dir).filter(file => file.endsWith(".md"))) {
          const text = readFileSync(file, "utf8");
          const refs = [...text.matchAll(/\b(?:references|vocab)\/[a-zA-Z0-9_.\/-]+\.(?:md|ya?ml)\b/g)].map(m => m[0]);
          for (const ref of refs) {
            // Skill-relative references are written relative to the skill root.
            expect({ file, ref, exists: statSync(join(dir, ref), { throwIfNoEntry: false })?.isFile() ?? false }).toEqual({ file, ref, exists: true });
          }
          for (const link of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
            const ref = link[1]!;
            if (/^(?:[a-z]+:|\/|#)/i.test(ref)) continue;
            expect({ file, ref, exists: !!statSync(resolve(dirname(file), ref), { throwIfNoEntry: false }) }).toEqual({ file, ref, exists: true });
          }
        }
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
