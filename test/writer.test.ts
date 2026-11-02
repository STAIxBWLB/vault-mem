import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { applyWrite, sha256, MUTATION_LOCK } from "../src/writer.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { run } from "../src/cli.ts";
import type { WriteOp, WriteRequest } from "../src/write-types.ts";
const roots: string[] = [];
function note(title: string, body = "A synthetic finding.", extra: Record<string, unknown> = {}): string {
  return `---\n# preserved comment\ntitle: ${JSON.stringify(title)}\ndescription: Synthetic evidence for navigation.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\n${Object.entries(extra).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join("")}---\n# ${title}\n\n${body}\n\n## Topics\n\n- [[research]]\n`;
}
function fixture(write: "cli" | "mcp" | "none" = "mcp") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-writer-"))); roots.push(root);
  const home = join(root, "state"), vault = join(root, "vault"), notes = join(vault, "notes"); mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
  writeFileSync(join(notes, "old.md"), note("Old Finding", "Original text.\n\n## Anchor\n\nA block. ^block", { aliases: ["Prior Alias"] }));
  writeFileSync(join(notes, "next.md"), note("Next Finding", "Replacement text."));
  addVault(home, { id: "test", path: vault, kind: "personal", write });
  return { root, home, vault, notes, env: { VMEM_HOME: home }, request: (operation: WriteOp, extra: Partial<WriteRequest> = {}) => applyWrite(home, { vault: "test", operation, ...extra }) };
}
function disk(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(dir: string, prefix = "") {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name), path = prefix + name;
      if (lstatSync(file).isDirectory()) visit(file, `${path}/`);
      else if (!lstatSync(file).isSymbolicLink()) result[path] = readFileSync(file).toString("base64");
    }
  }
  visit(root); return result;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const create = (): WriteOp => ({ op: "create", path: "new-finding", frontmatter: { title: "New Finding", description: "A separate synthetic result.", type: "insight", domain: "research", topics: ["[[research]]"] } });
test("dry-run, read-only check and refusal make no filesystem changes including locks/cache", () => {
  const f = fixture(), before = disk(f.root);
  expect(f.request(create(), { dryRun: true }).ok).toBe(true); expect(disk(f.root)).toEqual(before);
  expect(f.request({ op: "check", path: "old", text: readFileSync(join(f.notes, "old.md"), "utf8") }).ok).toBe(true);
  expect(disk(f.root)).toEqual(before);
  const readonly = fixture("none"), original = disk(readonly.root);
  expect(readonly.request(create()).issues[0]!.code).toBe("POLICY");
  expect(readonly.request({ op: "check", path: "old", text: readFileSync(join(readonly.notes, "old.md"), "utf8") }).ok).toBe(true);
  expect(disk(readonly.root)).toEqual(original);
  const cli = fixture("cli"); expect(cli.request(create(), { channel: "mcp" }).ok).toBe(false);
  expect(cli.request(create(), { channel: "cli" }).ok).toBe(true);
});
test("agent/non-TTY create persists atomically, returns receipt and updates FTS", () => {
  const f = fixture(), body = join(f.root, "body.md"); writeFileSync(body, "# Agent finding\n\nCreated via synthetic stdin.\n\n## Topics\n\n- [[research]]\n");
  const output = Bun.spawnSync([process.execPath, "bin/vmem.js", "new", "test", "agent-finding", "--type", "insight", "--domain", "research", "--topics", "research", "--description", "A safe synthetic creation.", "--body", "-", "--json"], { env: { ...process.env, ...f.env, CODEX_THREAD_ID: "synthetic-agent" }, stdin: readFileSync(body), stdout: "pipe", stderr: "pipe" });
  expect(output.exitCode).toBe(0); const result = JSON.parse(output.stdout.toString());
  expect(result.applied).toBe(true); expect(result.indexUpdated).toBe(true);
  const text = readFileSync(join(f.notes, "agent-finding.md"), "utf8");
  expect(result.changes[0].sha256).toBe(sha256(text));
  expect(JSON.parse(run(["search", "test", "stdin"], f.env).text)[0].path).toBe("agent-finding.md");
  expect(existsSync(join(f.vault, MUTATION_LOCK))).toBe(false);
  expect(readdirSync(f.notes).some(file => file.startsWith(".vmem-"))).toBe(false);
});
test("patch exact-match and SHA gates; append inserts before Topics; frontmatter preserves neighbors", () => {
  const f = fixture(), file = join(f.notes, "old.md"), original = readFileSync(file, "utf8");
  const badSha = f.request({ op: "patch", path: "old", oldString: "Original text.", newString: "Changed text.", expectedSha: "0".repeat(64) });
  expect(badSha.issues.some(issue => issue.code === "V09")).toBe(true); expect(readFileSync(file, "utf8")).toBe(original);
  for (const oldString of ["", "missing", "\n"]) expect(f.request({ op: "patch", path: "old", oldString, newString: "replacement" }).ok).toBe(false);
  const patched = f.request({ op: "patch", path: "old", oldString: "Original text.", newString: "Changed text.", expectedSha: sha256(original) }); expect(patched.ok).toBe(true);
  expect(f.request({ op: "append", path: "old", section: "Evidence", markdown: "More evidence." }).ok).toBe(true);
  const appended = readFileSync(file, "utf8"); expect(appended.indexOf("## Evidence")).toBeLessThan(appended.indexOf("## Topics"));
  for (const [section, markdown] of [["Topics", "x"], ["Topics ###", "x"], ["topics   ##", "x"], ["Evidence", "## Topics\n- [[research]]"]]) expect(f.request({ op: "append", path: "old", section: section!, markdown: markdown! }).ok).toBe(false);
  expect(f.request({ op: "frontmatter", path: "old", set: { confidence: "likely" } }).ok).toBe(true);
  expect(readFileSync(file, "utf8")).toContain("# preserved comment\ntitle: \"Old Finding\"\ndescription:");
  expect(parseFrontmatter(readFileSync(file, "utf8")).data.confidence).toBe("likely");
  const before = readFileSync(file, "utf8"); expect(f.request({ op: "frontmatter", path: "old", set: {}, unset: ["description"] }).ok).toBe(false); expect(readFileSync(file, "utf8")).toBe(before);
});
test("link relations and supersession use the same pipeline with both files updated", () => {
  const f = fixture();
  expect(f.request({ op: "link", from: "old", to: "next", relation: "supports", context: "Synthetic comparison" }).ok).toBe(true);
  expect(readFileSync(join(f.notes, "old.md"), "utf8")).toContain("[[next]] (supports): Synthetic comparison");
  expect(readFileSync(join(f.notes, "next.md"), "utf8")).toContain("[[old]] (supports)");
  expect(f.request({ op: "link", from: "old", to: "next", relation: "unknown" as "supports" }).ok).toBe(false);
  expect(f.request({ op: "supersede", old: "old", next: "next" }).ok).toBe(true);
  const old = parseFrontmatter(readFileSync(join(f.notes, "old.md"), "utf8"));
  expect(old.data.status).toBe("superseded"); expect(old.data.superseded_by).toBe("[[next]]");
  expect(readFileSync(join(f.notes, "next.md"), "utf8")).toContain("Supersedes [[old]]");
  expect(f.request({ op: "supersede", old: "old", next: "old" }).ok).toBe(false);
});
test("move previews, rejects drift and rewrites wiki/heading/block/embed and frontmatter, leaving alias-only links", () => {
  const f = fixture(), ref = join(f.notes, "references.md");
  writeFileSync(ref, note("References", "[[./old]] [[old|label]] [[old#Anchor]] ![[old#^block]] [[Prior Alias]]\n`[[old]]`\n```md\n[[old]]\n```", { source_ref: "[[old]]" }));
  const before = disk(f.root), op: WriteOp = { op: "move", from: "old", to: "renamed" };
  const preview = f.request(op); expect(preview.ok).toBe(true); expect(preview.preview).toBe(true); expect(disk(f.root)).toEqual(before);
  expect(f.request(op, { confirm: true }).issues.some(issue => issue.code === "V09")).toBe(true);
  writeFileSync(join(f.notes, "unrelated.md"), note("Unrelated", "Created after preview."));
  expect(f.request(op, { confirm: true, fingerprint: preview.fingerprint }).ok).toBe(false); expect(existsSync(join(f.notes, "old.md"))).toBe(true);
  const fresh = f.request(op); const moved = f.request(op, { confirm: true, fingerprint: fresh.fingerprint }); expect(moved.ok).toBe(true); expect(moved.indexUpdated).toBe(true);
  expect(existsSync(join(f.notes, "old.md"))).toBe(false); expect(existsSync(join(f.notes, "renamed.md"))).toBe(true);
  const text = readFileSync(ref, "utf8");
  // Links resolve by path only, so an alias-only link was never resolved and is not rewritten.
  expect(text).toContain("[[renamed]] [[renamed|label]] [[renamed#Anchor]] ![[renamed#^block]] [[Prior Alias]]");
  expect(text).toContain("`[[old]]`\n```md\n[[old]]\n```");
  expect(parseFrontmatter(text).data.source_ref).toBe("[[renamed]]");
  const links = JSON.parse(run(["links", "test", "references"], f.env).text) as { target: string; resolved: string | null }[];
  expect(links.filter(link => link.target === "renamed").every(link => link.resolved === "renamed.md")).toBe(true);
  expect(links.map(link => link.resolved)).toEqual(["renamed.md", "renamed.md", "renamed.md", "renamed.md", null, "research.md"]);
});
test("an alias-only link is refused by the writer, unresolved in links and dead in lint", () => {
  const f = fixture(), body = "Cites [[Prior Alias]].";
  const refused = f.request({ op: "create", path: "cites-alias", frontmatter: { title: "Cites Alias", description: "Synthetic alias citation.", type: "insight", domain: "research", topics: ["[[research]]"] }, body: `# Cites Alias\n\n${body}\n\n## Topics\n\n- [[research]]\n` });
  expect(refused.ok).toBe(false); expect(refused.issues.some(issue => issue.code === "V03" && issue.severity === "error")).toBe(true);
  writeFileSync(join(f.notes, "cites-alias.md"), note("Cites Alias", body));
  expect(JSON.parse(run(["links", "test", "cites-alias"], f.env).text)[0]).toMatchObject({ target: "Prior Alias", resolved: null, reason: "missing-note" });
  expect(JSON.parse(run(["lint", "test", "--json"], f.env).text).findings.L01.some((finding: string) => finding.includes("[[Prior Alias]]"))).toBe(true);
});
test("delete/tidy preview-confirm and report path/schema rules", () => {
  const f = fixture(); writeFileSync(join(f.notes, "lonely.md"), note("Lonely", "An isolated finding."));
  const deletion: WriteOp = { op: "delete", path: "lonely" }, preview = f.request(deletion);
  expect(preview.preview).toBe(true); expect(existsSync(join(f.notes, "lonely.md"))).toBe(true);
  expect(f.request(deletion, { confirm: true, fingerprint: preview.fingerprint }).ok).toBe(true); expect(existsSync(join(f.notes, "lonely.md"))).toBe(false);
  const blocked: WriteOp = { op: "delete", path: "research" }; expect(f.request(blocked).issues.some(issue => issue.code === "V02" || issue.code === "V03")).toBe(true);
  const file = join(f.notes, "old.md"); writeFileSync(file, note("Old Finding", "## Connections (evidence)\n\n- [[next]]\n\n## Connections\n\n- [[research]]\n"));
  const tidy: WriteOp = { op: "tidy" }, tidyPreview = f.request(tidy); expect(tidyPreview.preview).toBe(true);
  expect(f.request(tidy, { confirm: true, fingerprint: tidyPreview.fingerprint }).ok).toBe(true);
  const text = readFileSync(file, "utf8"); expect(text).not.toContain("## Connections"); expect(text).toContain("## Relevant Notes"); expect(text.indexOf("## Relevant Notes")).toBeLessThan(text.indexOf("## Topics"));
  expect(f.request({ op: "report", path: "reports/nested/result.json", text: '{"synthetic":true}' }).ok).toBe(true); expect(readFileSync(join(f.vault, "reports/nested/result.json"), "utf8")).toBe('{"synthetic":true}');
  for (const path of ["../outside.md", ".obsidian/config.json", "self/test.md", "ops/../notes/old.md", "reports//x.md"]) expect(f.request({ op: "report", path, text: "x" }).ok).toBe(false);
  symlinkSync(f.root, join(f.vault, "ops")); expect(f.request({ op: "report", path: "ops/out.md", text: "x" }).ok).toBe(false); expect(existsSync(join(f.root, "out.md"))).toBe(false);
});
test("existing foreign lock and unsafe note paths are preserved", () => {
  const f = fixture(), lock = join(f.vault, MUTATION_LOCK); writeFileSync(lock, "another writer");
  expect(f.request(create()).issues[0]!.code).toBe("LOCKED"); expect(readFileSync(lock, "utf8")).toBe("another writer");
  rmSync(lock);
  for (const path of ["../escape", "Bad Name", "notes/nested/x.md", ".obsidian/config", "한글"]) expect(f.request({ ...create(), path } as WriteOp).ok).toBe(false);
  const target = join(f.notes, "linked.md"); symlinkSync(join(f.notes, "old.md"), target);
  expect(f.request({ op: "patch", path: "linked", oldString: "Original", newString: "Changed" }).ok).toBe(false);
  expect(readFileSync(join(f.notes, "old.md"), "utf8")).toContain("Original text.");
});
test("CLI exposes all writers with closed options and check is a no-write path", () => {
  const f = fixture(), source = join(f.root, "candidate.md"); writeFileSync(source, note("Candidate", "Safe candidate."));
  const before = disk(f.root); expect(run(["check", "test", source], f.env).code).toBe(0); expect(disk(f.root)).toEqual(before);
  expect(run(["new", "test", "cli-new", "--type", "insight", "--domain", "research", "--topics", "research", "--description", "An additional safe finding."], f.env).code).toBe(0);
  expect(run(["patch", "test", "cli-new", "--old", "This note argues that", "--new", "This finding states that"], f.env).code).toBe(0);
  expect(run(["append", "test", "cli-new", "--section", "Evidence", "--markdown", "Synthetic."], f.env).code).toBe(0);
  expect(run(["frontmatter", "test", "cli-new", "--set", '{"confidence":"likely"}'], f.env).code).toBe(0);
  expect(run(["link", "test", "cli-new", "next", "--relation", "extends", "--one-way"], f.env).code).toBe(0);
  expect(run(["supersede", "test", "cli-new", "next"], f.env).code).toBe(0);
  const preview = JSON.parse(run(["move", "test", "cli-new", "cli-moved"], f.env).text);
  expect(run(["move", "test", "cli-new", "cli-moved", "--confirm", "--fingerprint", preview.fingerprint], f.env).code).toBe(0);
  expect(run(["tidy", "test", "--connections"], f.env).code).toBe(0);
  expect(run(["report", "test", "reports/result.md", "--body", source], f.env).code).toBe(0);
  for (const args of [["patch", "test", "old", "--old", "x"], ["new", "test"], ["tidy", "test", "--bogus"], ["check", "test", source, "--confirm"], ["new", "test", "x", "--json", "--json"]]) expect(() => run(args, f.env)).toThrow();
});
test("caught filesystem/index failures roll back complete notes and release owned lock", () => {
  for (const mode of ["temp-open", "temp-write", "temp-fsync", "directory-fsync", "second-rename", "index"]) {
    const f = fixture(); const operation = mode === "second-rename" ? { op: "link", from: "old", to: "next", relation: "supports" } : { op: "patch", path: "old", oldString: "Original text.", newString: "Changed text." };
    const original = Object.fromEntries(readdirSync(f.notes).map(path => [path, readFileSync(join(f.notes, path), "utf8")]));
    const output = Bun.spawnSync([process.execPath, "test/fixtures/writer-fault.ts", f.home, f.vault, mode, JSON.stringify(operation)], { stdout: "pipe", stderr: "pipe" });
    expect(output.exitCode).toBe(0); const result = JSON.parse(output.stdout.toString());
    expect(result.ok).toBe(false); expect(result.applied).toBe(false); expect(existsSync(join(f.vault, MUTATION_LOCK))).toBe(false);
    expect(Object.fromEntries(readdirSync(f.notes).map(path => [path, readFileSync(join(f.notes, path), "utf8")]))).toEqual(original);
  }
});

test("fingerprints bind the canonical vault identity, not just an id and identical content", () => {
  const f = fixture(), op: WriteOp = { op: "delete", path: "old" }, preview = f.request(op);
  const clone = join(f.root, "clone"); mkdirSync(join(clone, "notes"), { recursive: true });
  for (const file of readdirSync(f.notes)) writeFileSync(join(clone, "notes", file), readFileSync(join(f.notes, file)));
  const configFile = join(f.home, "vmem.config.json"), config = JSON.parse(readFileSync(configFile, "utf8")); config.vaults[0].path = clone; writeFileSync(configFile, JSON.stringify(config));
  const result = f.request(op, { confirm: true, fingerprint: preview.fingerprint });
  expect(result.ok).toBe(false); expect(result.issues.some(issue => issue.code === "V09")).toBe(true);
  expect(existsSync(join(clone, "notes", "old.md"))).toBe(true); expect(existsSync(join(f.notes, "old.md"))).toBe(true);
});
test("failed rollback retains original backups and never overwrites external edits", () => {
  for (const mode of ["rollback-fail", "external-edit"]) {
    const f = fixture(), original = [readFileSync(join(f.notes, "old.md"), "utf8"), readFileSync(join(f.notes, "next.md"), "utf8")];
    const output = Bun.spawnSync([process.execPath, "test/fixtures/writer-fault.ts", f.home, f.vault, mode, JSON.stringify({ op: "link", from: "old", to: "next", relation: "supports" })], { stdout: "pipe", stderr: "pipe" });
    expect(output.exitCode).toBe(0); const result = JSON.parse(output.stdout.toString());
    expect(result.ok).toBe(false); expect(result.applied).toBe(true); expect(existsSync(join(f.vault, MUTATION_LOCK))).toBe(false);
    const issue = result.issues.find((issue: { code: string }) => issue.code === "ROLLBACK"); expect(issue).toBeDefined();
    expect(original).toContain(readFileSync(join(f.vault, issue.path), "utf8"));
    if (mode === "external-edit") expect(readFileSync(join(f.notes, "next.md"), "utf8")).toContain("External edit preserved.");
  }
});
test("an unrelated note edited during staging refuses the commit, even when no stat field moves", () => {
  for (const mode of ["silent-edit", "mmap-edit"]) {
    const f = fixture();
    const output = Bun.spawnSync([process.execPath, "test/fixtures/writer-fault.ts", f.home, f.vault, mode, JSON.stringify({ op: "patch", path: "old", oldString: "Original text.", newString: "Changed text." })], { stdout: "pipe", stderr: "pipe" });
    expect(output.exitCode).toBe(0); const result = JSON.parse(output.stdout.toString());
    expect(result.ok).toBe(false); expect(result.applied).toBe(false);
    expect(result.issues.some((issue: { code: string; message: string }) => issue.code === "V09" && issue.message === "vault changed while staging")).toBe(true);
    expect(readFileSync(join(f.notes, "old.md"), "utf8")).toContain("Original text.");
    expect(readFileSync(join(f.notes, "next.md"), "utf8")).toContain("Replacemant");
  }
});
test("cleanup errors report retained files/locks without hiding the operation result", () => {
  for (const mode of ["temp-cleanup", "lock-cleanup"]) {
    const f = fixture();
    const output = Bun.spawnSync([process.execPath, "test/fixtures/writer-fault.ts", f.home, f.vault, mode, JSON.stringify({ op: "patch", path: "old", oldString: "Original text.", newString: "Changed text." })], { stdout: "pipe", stderr: "pipe" });
    expect(output.exitCode).toBe(0); const result = JSON.parse(output.stdout.toString());
    expect(result.ok).toBe(false); expect(result.issues.some((issue: { code: string }) => issue.code === "CLEANUP")).toBe(true);
    expect(existsSync(join(f.vault, MUTATION_LOCK))).toBe(mode === "lock-cleanup");
    if (mode === "temp-cleanup") { expect(result.applied).toBe(false); expect(result.issues.some((issue: { code: string }) => issue.code === "IO")).toBe(true); }
    else { expect(result.applied).toBe(true); expect(readFileSync(join(f.notes, "old.md"), "utf8")).toContain("Changed text."); }
  }
});
test("invalid request flags, denied inputs and denied snapshot paths fail closed", () => {
  const f = fixture(), before = disk(f.root);
  expect(f.request(create(), { dryRun: "true" as unknown as boolean }).issues[0]!.code).toBe("V01");
  expect(applyWrite(f.home, { vault: "test", operation: create(), dryrun: true } as unknown as WriteRequest).issues[0]!.code).toBe("V01");
  expect(disk(f.root)).toEqual(before);
  const denied = join(f.root, ".env"); writeFileSync(denied, "synthetic-value");
  expect(() => run(["check", "test", denied, "--path", "candidate"], f.env)).toThrow("V06");
  writeFileSync(join(f.notes, "credentials.md"), "synthetic-value");
  expect(f.request(create()).issues.some(issue => issue.code === "V06")).toBe(true); expect(existsSync(join(f.notes, "new-finding.md"))).toBe(false);
});

test("denied create/move destinations refuse before writing and FTS duplicate hints stay read-only", () => {
  const f = fixture(), configFile = join(f.home, "vmem.config.json"), config = JSON.parse(readFileSync(configFile, "utf8"));
  config.denyPaths = ["blocked-note"]; writeFileSync(configFile, JSON.stringify(config));
  const before = disk(f.root);
  const creation = f.request({ ...create(), path: "blocked-note" } as WriteOp);
  expect(creation.ok).toBe(false); expect(creation.issues.some(issue => issue.code === "V06")).toBe(true);
  const move = f.request({ op: "move", from: "old", to: "blocked-note" }); expect(move.ok).toBe(false); expect(move.issues.some(issue => issue.code === "V06")).toBe(true);
  // Both failed operations may update directory timestamps only, never file contents.
  expect(disk(f.root)).toEqual(before);
  const duplicate = f.request({ op: "create", path: "similar-title", frontmatter: { title: "Old Finding", description: "An independent supporting observation.", type: "insight", domain: "research", topics: ["[[research]]"] }, body: "# Distinct H1\n\nDifferent text.\n\n## Topics\n\n- [[research]]\n" }, { dryRun: true });
  expect(duplicate.ok).toBe(true); expect(duplicate.possibleDuplicates).toContain("notes/old.md"); expect(disk(f.root)).toEqual(before);
});

test("unrelated legacy YAML is skipped by duplicate hints and writer refresh, without blocking actual create", () => {
  const f = fixture(), legacy = join(f.notes, "legacy.md"); writeFileSync(legacy, note("Legacy Finding"));
  expect(f.request(create()).ok).toBe(true); // Seed an index row that must not survive malformed replacement.
  const malformed = "---\ndescription: [PRIVATE_SYNTHETIC\n---\n# Legacy\n"; writeFileSync(legacy, malformed);
  const operation: WriteOp = { op: "create", path: "second-result", frontmatter: { title: "Second Result", type: "insight", domain: "research", description: "A separate and valid observation.", topics: ["[[research]]"] } };
  const before = disk(f.root), preview = f.request(operation, { dryRun: true });
  expect(preview.ok).toBe(true); expect(preview.issues.some(issue => issue.code === "IO")).toBe(false); expect(disk(f.root)).toEqual(before);
  const result = f.request(operation); expect(result.ok).toBe(true); expect(result.indexUpdated).toBe(true);
  expect(result.issues.some(issue => issue.code === "V01" && issue.severity === "warning" && issue.path === "notes/legacy.md")).toBe(true);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SYNTHETIC"); expect(readFileSync(legacy, "utf8")).toBe(malformed);
  const database = readdirSync(join(f.home, "indexes")).find(file => file.endsWith(".sqlite"))!;
  const db = new Database(join(f.home, "indexes", database), { readonly: true });
  try {
    expect(db.query("SELECT path FROM notes WHERE path='second-result.md'").get()).toEqual({ path: "second-result.md" });
    expect(db.query("SELECT path FROM notes WHERE path='legacy.md'").get()).toBeNull();
  } finally { db.close(); }
  expect(() => run(["rebuild", "test"], f.env)).toThrow("invalid frontmatter"); // Read surfaces remain strict.
});
test("move/tidy malformed YAML refusals identify the offending note without its contents", () => {
  const f = fixture(); writeFileSync(join(f.notes, "broken.md"), "---\ndescription: [PRIVATE_SYNTHETIC\n---\n");
  for (const op of [{ op: "move", from: "old", to: "renamed" }, { op: "tidy" }] as WriteOp[]) {
    const result = f.request(op);
    expect(result.ok).toBe(false); expect(result.issues.find(issue => issue.code === "V01")?.path).toBe("notes/broken.md");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SYNTHETIC");
  }
});
test("move renames a legacy-named note to a valid stem and rewrites inbound links", () => {
  const f = fixture();
  writeFileSync(join(f.notes, "a-1.5-b.md"), note("Legacy Name", "Legacy body."));
  writeFileSync(join(f.notes, "cites.md"), note("Cites", "See [[a-1.5-b]] and [[a-1.5-b#Topics|label]]."));
  expect(f.request({ op: "move", from: "a-1.5-b", to: "a-1.6-b" }).issues.some(issue => issue.code === "V04")).toBe(true);
  expect(f.request({ op: "move", from: "no-such.5-note", to: "a-1-5-b" }).ok).toBe(false);
  const op: WriteOp = { op: "move", from: "a-1.5-b", to: "a-1-5-b" }, preview = f.request(op);
  expect(preview.ok).toBe(true);
  const moved = f.request(op, { confirm: true, fingerprint: preview.fingerprint });
  expect(moved.ok).toBe(true); expect(moved.applied).toBe(true); expect(moved.logged).toBe(true);
  expect(existsSync(join(f.notes, "a-1.5-b.md"))).toBe(false); expect(existsSync(join(f.notes, "a-1-5-b.md"))).toBe(true);
  expect(readFileSync(join(f.notes, "cites.md"), "utf8")).toContain("See [[a-1-5-b]] and [[a-1-5-b#Topics|label]].");
  expect(readFileSync(join(f.vault, "log"), "utf8")).toContain("notes/a-1.5-b.md → notes/a-1-5-b.md");
});
test("move rewrites inbound links in another legacy-named note", () => {
  const f = fixture();
  writeFileSync(join(f.notes, "a.1.md"), note("Legacy A", "See [[b.1]]."));
  writeFileSync(join(f.notes, "b.1.md"), note("Legacy B", "See [[a.1]]."));
  const op: WriteOp = { op: "move", from: "a.1", to: "a-1" }, preview = f.request(op);
  expect(preview.ok).toBe(true);
  expect(f.request(op, { confirm: true, fingerprint: preview.fingerprint }).applied).toBe(true);
  expect(readFileSync(join(f.notes, "b.1.md"), "utf8")).toContain("See [[a-1]].");
  expect(f.request({ op: "move", from: "b.1", to: "b.2" }).issues.some(issue => issue.code === "V04")).toBe(true);
});
test("move preserves explicit labels and leaves alias-only links untouched", () => {
  const f = fixture(); writeFileSync(join(f.notes, "reference.md"), note("Reference", "[[old]] [[old|Kept Label]] [[Prior Alias]]"));
  const op: WriteOp = { op: "move", from: "old", to: "renamed" }, preview = f.request(op);
  expect(f.request(op, { confirm: true, fingerprint: preview.fingerprint }).ok).toBe(true);
  expect(readFileSync(join(f.notes, "reference.md"), "utf8")).toContain("[[renamed]] [[renamed|Kept Label]] [[Prior Alias]]");
});
test("writer read allocation follows file size plus growth probe, and size drift still refuses", () => {
  const f = fixture();
  const allocation = Bun.spawnSync([process.execPath, "test/fixtures/writer-fault.ts", f.home, f.vault, "allocation", JSON.stringify(create())], { stdout: "pipe", stderr: "pipe" });
  expect(allocation.exitCode).toBe(0);
  const output = JSON.parse(allocation.stdout.toString()) as { result: { ok: boolean }; reads: { capacity: number; size: number }[] };
  expect(output.result.ok).toBe(true); expect(output.reads.length).toBeGreaterThanOrEqual(3);
  expect(output.reads.every(read => read.capacity === read.size + 1)).toBe(true);
  for (const mode of ["grow", "shrink"]) {
    const fresh = fixture();
    const result = Bun.spawnSync([process.execPath, "test/fixtures/writer-fault.ts", fresh.home, fresh.vault, mode, JSON.stringify({ op: "patch", path: "old", oldString: "Original text.", newString: "Changed text." })], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0); const receipt = JSON.parse(result.stdout.toString());
    expect(receipt.ok).toBe(false); expect(receipt.issues.some((issue: { code: string }) => issue.code === "V09")).toBe(true);
    expect(readFileSync(join(fresh.notes, "old.md"), "utf8")).toContain("Original text."); expect(existsSync(join(fresh.vault, MUTATION_LOCK))).toBe(false);
  }
});

test("delete preview and confirm cannot break metadata references hidden behind an unclosed body fence", () => {
  const f = fixture(), referrer = join(f.notes, "referrer.md"), beforeTarget = readFileSync(join(f.notes, "old.md"), "utf8");
  const source = note("Referrer", "```md\nUnclosed code fence.", { supersedes: "[[old]]" }); writeFileSync(referrer, source);
  const op: WriteOp = { op: "delete", path: "old" }, preview = f.request(op);
  expect(preview.ok).toBe(false); expect(preview.issues.some(issue => issue.code === "V03" && issue.path === "notes/referrer.md")).toBe(true);
  const confirm = f.request(op, { confirm: true, fingerprint: preview.fingerprint });
  expect(confirm.ok).toBe(false); expect(confirm.issues.some(issue => issue.code === "V03" && issue.severity === "error")).toBe(true);
  expect(readFileSync(join(f.notes, "old.md"), "utf8")).toBe(beforeTarget); expect(readFileSync(referrer, "utf8")).toBe(source);
});
test("move preview-confirm accepts legacy duplicate H1 while create still refuses a new duplicate", () => {
  const f = fixture(), legacy = note("Old Finding", "A distinct legacy note with the same H1."); writeFileSync(join(f.notes, "legacy.md"), legacy);
  const op: WriteOp = { op: "move", from: "old", to: "renamed" }, preview = f.request(op);
  expect(preview.ok).toBe(true); expect(preview.issues.some(issue => issue.code === "V08")).toBe(false);
  const confirmed = f.request(op, { confirm: true, fingerprint: preview.fingerprint }); expect(confirmed.ok).toBe(true);
  expect(existsSync(join(f.notes, "old.md"))).toBe(false); expect(existsSync(join(f.notes, "renamed.md"))).toBe(true); expect(readFileSync(join(f.notes, "legacy.md"), "utf8")).toBe(legacy);
  const creation = f.request({ op: "create", path: "third", frontmatter: { title: "Old Finding", description: "A supporting duplicate detection fixture.", type: "insight", domain: "research", topics: ["[[research]]"] } });
  expect(creation.ok).toBe(false); expect(creation.issues.some(issue => issue.code === "V08")).toBe(true);
});

test("report bounds allow 16 MiB, refuse excess and leave note limits unchanged", () => {
  const f = fixture(), maximum = 16 * 1024 * 1024;
  for (const prefix of ["reports", "ops"]) {
    const operation = { op: "report" as const, path: `${prefix}/limit.md`, text: "x".repeat(maximum) };
    expect(f.request(operation, { dryRun: true }).ok).toBe(true);
    const refused = f.request({ ...operation, text: operation.text + "x" }, { dryRun: true });
    expect(refused.ok).toBe(false);
    expect(refused.issues.some(issue => issue.code === "V09" && issue.message.includes("16 MiB"))).toBe(true);
    mkdirSync(join(f.vault, prefix), { recursive: true });
    writeFileSync(join(f.vault, operation.path), operation.text + "x");
    const existing = f.request({ ...operation, text: "Small replacement." }, { dryRun: true });
    expect(existing.ok).toBe(false);
    expect(existing.issues.some(issue => issue.code === "V09")).toBe(true);
  }
  const oversizedNote = f.request({ op: "check", path: "old", text: note("Old Finding", "x".repeat(256 * 1024)) });
  expect(oversizedNote.ok).toBe(false);
  expect(oversizedNote.issues.some(issue => issue.code === "V09" && issue.message.includes("256 KiB"))).toBe(true);
  writeFileSync(join(f.notes, "old.md"), "x".repeat(2 * 1024 * 1024 + 1));
  const oversizedRead = f.request({ op: "report", path: "ops/small.md", text: "Small report." }, { dryRun: true });
  expect(oversizedRead.ok).toBe(false);
  expect(oversizedRead.issues.some(issue => issue.code === "V09")).toBe(true);
}, 30_000);

test("rollback rereads a report above 2 MiB and restores its large original", () => {
  const f = fixture(), file = join(f.vault, "ops", "large.md");
  const original = "Synthetic original.\n".repeat(120000);
  expect(Buffer.byteLength(original)).toBeGreaterThan(2 * 1024 * 1024);
  expect(f.request({ op: "report", path: "ops/large.md", text: original }, { log: false }).ok).toBe(true);
  const child = Bun.spawnSync([process.execPath, "test/fixtures/report-rollback.ts", f.home], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.ok).toBe(false);
  expect(result.applied).toBe(false);
  expect(result.issues.some((issue: { code: string }) => issue.code === "IO")).toBe(true);
  expect(result.issues.some((issue: { code: string }) => issue.code === "ROLLBACK")).toBe(false);
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(existsSync(join(f.vault, MUTATION_LOCK))).toBe(false);
});

test("frontmatter refiles a clean note under another MOC in one validated write", () => {
  const f = fixture(), file = join(f.notes, "old.md");
  writeFileSync(join(f.notes, "other.md"), "---\ntype: moc\ndescription: Another synthetic directory.\n---\n# Other\n");
  const before = parseFrontmatter(readFileSync(file, "utf8"));
  const result = run(["frontmatter", "test", "old", "--set", JSON.stringify({ topics: ["[[other]]"] }), "--json"], f.env);
  const receipt = JSON.parse(result.text);
  expect(result.code).toBe(0);
  expect(receipt.applied).toBe(true);
  expect(receipt.changes).toHaveLength(1);
  expect(receipt.issues.some((issue: { code: string }) => issue.code === "V05")).toBe(false);
  const after = parseFrontmatter(readFileSync(file, "utf8"));
  expect(after.data.topics).toEqual(["[[other]]"]);
  expect(after.body).toBe(before.body.replace("- [[research]]", "- [[other]]"));
  expect(after.frontmatter).toContain("# preserved comment");
});

test("frontmatter refiling recognizes a clean lowercase Topics heading outside fences", () => {
  const f = fixture(), file = join(f.notes, "old.md");
  writeFileSync(join(f.notes, "other.md"), "---\ntype: moc\ndescription: Another synthetic directory.\n---\n# Other\n");
  writeFileSync(file, note("Old Finding", "```md\n## Topics\n- [[research]]\n```", {}).replace(/## Topics(?=\n\n- \[\[research\]\]\n$)/, "## topics ###"));
  const result = f.request({ op: "frontmatter", path: "old", set: { topics: ["[[other]]"] } });
  expect(result.ok).toBe(true);
  expect(result.issues.some(issue => issue.code === "V05")).toBe(false);
  const body = parseFrontmatter(readFileSync(file, "utf8")).body;
  expect(body).toContain("```md\n## Topics\n- [[research]]\n```");
  expect(body.endsWith("## topics ###\n\n- [[other]]\n")).toBe(true);
});

test("frontmatter refiling preserves fenced blocks and legacy H3/prose inside Topics byte for byte", () => {
  for (const suffix of [
    "\n```dataview\nLIST FROM \"synthetic\"\n- [[research]]\n```\n",
    "\n### Detail\nLegacy prose, keep its spacing.  \n\n~~~md\n- [[research]]\n~~~\n",
  ]) {
    const f = fixture(), file = join(f.notes, "old.md");
    writeFileSync(join(f.notes, "other.md"), "---\ntype: moc\ndescription: Another synthetic directory.\n---\n# Other\n");
    const original = note("Old Finding") + suffix;
    writeFileSync(file, original);
    const result = f.request({ op: "frontmatter", path: "old", set: { topics: ["[[other]]"] } });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    const before = parseFrontmatter(original), after = parseFrontmatter(readFileSync(file, "utf8"));
    expect(after.data.topics).toEqual(["[[other]]"]);
    expect(after.body).toBe(before.body.replace("- [[research]]", "- [[other]]"));
    expect(after.body.endsWith(suffix)).toBe(true);
    expect(result.issues.some(issue => issue.code === "V05" && issue.severity === "error")).toBe(false);
  }
});

test("frontmatter Topics refiling keeps CRLF and setting unchanged topics keeps the whole note unchanged", () => {
  const f = fixture(), file = join(f.notes, "old.md");
  writeFileSync(join(f.notes, "other.md"), "---\ntype: moc\ndescription: Another synthetic directory.\n---\n# Other\n");
  const original = (note("Old Finding").replace("- [[research]]", "* [[research]]   ") + "\n```dataview\nLIST\n```\n").replaceAll("\n", "\r\n");
  writeFileSync(file, original);
  const unchanged = f.request({ op: "frontmatter", path: "old", set: { topics: ["[[research]]"] } });
  expect(unchanged.ok).toBe(true);
  expect(unchanged.changes).toHaveLength(0);
  expect(readFileSync(file, "utf8")).toBe(original);
  const changed = f.request({ op: "frontmatter", path: "old", set: { topics: ["[[other]]"] } });
  expect(changed.ok).toBe(true);
  expect(changed.issues.some(issue => issue.code === "V05")).toBe(false);
  const after = readFileSync(file, "utf8");
  expect(after.replaceAll("\r\n", "")).not.toContain("\n");
  expect(parseFrontmatter(after).body).toBe(parseFrontmatter(original).body.replace("* [[research]]   ", "- [[other]]"));
});

test("frontmatter Topics refiling replaces only the leading list run and keeps later links byte for byte", () => {
  const f = fixture(), file = join(f.notes, "old.md");
  writeFileSync(join(f.notes, "other.md"), "---\ntype: moc\ndescription: Another synthetic directory.\n---\n# Other\n");
  writeFileSync(join(f.notes, "foo.md"), note("Foo Finding"));
  for (const tail of ["\n### Related\n- [[foo]]\n- [[research]]\n", "\nSee also:\n[[foo]]\n"]) {
    const original = note("Old Finding").replace(/\n?$/, "\n") + tail;
    writeFileSync(file, original);
    const result = f.request({ op: "frontmatter", path: "old", set: { topics: ["[[other]]"] } });
    expect(result.ok).toBe(true);
    const body = parseFrontmatter(readFileSync(file, "utf8")).body;
    expect(body).toBe(parseFrontmatter(original).body.replace("- [[research]]\n", "- [[other]]\n"));
    expect(body.endsWith(tail)).toBe(true);
  }
});

test("frontmatter inserts a missing Topics list after its heading without deleting legacy content", () => {
  const f = fixture(), file = join(f.notes, "old.md");
  const original = note("Old Finding").replace("- [[research]]\n", "### Detail\nLegacy prose.\n");
  writeFileSync(file, original);
  writeFileSync(join(f.notes, "other.md"), "---\ntype: moc\ndescription: Another synthetic directory.\n---\n# Other\n");
  const result = f.request({ op: "frontmatter", path: "old", set: { topics: ["[[other]]"] } });
  expect(result.ok).toBe(true);
  const after = parseFrontmatter(readFileSync(file, "utf8"));
  expect(after.body).toBe(parseFrontmatter(original).body.replace("## Topics\n", "## Topics\n- [[other]]\n"));
});
