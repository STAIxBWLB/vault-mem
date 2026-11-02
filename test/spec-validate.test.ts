import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { specGit } from "../src/spec-git.ts";
import { discoverSpecs, SpecIndex, type SpecDocument, type SpecSnapshot } from "../src/spec-source.ts";
import { buildSpecGraph } from "../src/spec-graph.ts";
import { validateSpecs, introducedSpecErrors, validateSpecRepo } from "../src/spec-validate.ts";
import { MAX_NOTE_BYTES } from "../src/vault-index.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const FIXTURES = resolve(import.meta.dir, "fixtures/spec-graph");
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-spec-validate-"))); roots.push(root);
  const repo = join(root, "repo"), home = join(root, "unused-home"); mkdirSync(repo);
  const git = (args: string[]) => specGit(repo, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args]);
  git(["-c", "init.templateDir=", "init", "--quiet"]);
  const write = (path: string, source: string | Buffer) => { const file = join(repo, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); };
  const commit = () => { git(["add", "."]); git(["commit", "--quiet", "-m", "Synthetic fixture"]); return git(["rev-parse", "HEAD"]).stdout.toString().trim(); };
  const source = { id: "repo", path: repo, write: "none", pii: "deny" } as const;
  return { root, repo, home, git, write, commit, source };
}
function document(id: string, fields: Record<string, unknown> = {}, body = "Synthetic body."): SpecDocument {
  return { id, path: `${id}/SPEC.md`, hash: "synthetic", source: "Synthetic input.", frontmatter: { id, type: id === "root" ? "goal" : "module", title: `Synthetic ${id}`, ...(id === "root" ? {} : { parent: "root" }), ...fields }, body };
}
const snapshot = (specs: SpecDocument[]): SpecSnapshot => ({ root: "/synthetic", commonDir: "/synthetic/.git", specs, diagnostics: [] });
const text = (data: Record<string, unknown>, body = "Synthetic body.") => `---\n${Object.entries(data).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n# Synthetic design\n\n${body}\n`;
function tree(root: string): unknown {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const file = join(root, entry.name);
    return [entry.name, entry.isSymbolicLink() ? { link: readlinkSync(file) } : entry.isDirectory() ? tree(file) : readFileSync(file).toString("base64")];
  });
}

test("schema contract fixture covers every listed error and warning class without source/config writes", () => {
  const expected = JSON.parse(readFileSync(join(FIXTURES, "expected.json"), "utf8")) as Record<string, { errors: string[]; warnings: string[] }>;
  for (const [name, classes] of Object.entries(expected)) {
    const f = fixture(); cpSync(join(FIXTURES, name), f.repo, { recursive: true }); f.commit();
    const before = tree(f.root), result = validateSpecRepo(f.repo, { env: { ...process.env, VMEM_HOME: f.home } });
    expect([...new Set(result.report.items.filter(item => item.severity === "error").map(item => item.code))].sort(), name).toEqual([...classes.errors].sort());
    expect([...new Set(result.report.items.filter(item => item.severity === "warning").map(item => item.code))].sort(), name).toEqual([...classes.warnings].sort());
    expect(result.code, name).toBe(classes.errors.length ? 1 : 0);
    expect(result.report.ok, name).toBe(!classes.errors.length);
    expect(result.report.truncated, name).toBe(false);
    expect(tree(f.root), name).toEqual(before);
    expect(existsSync(f.home), name).toBe(false);
    expect(result).not.toHaveProperty("snapshot");
  }
});

test("discovery candidate boundary preserves missing fields and ignores title-only or malformed ordinary Markdown", () => {
  const f = fixture();
  f.write("SPEC.md", "# No frontmatter\n");
  f.write("id-only.md", text({ id: "partial", title: "Synthetic partial" }));
  f.write("type-only.md", text({ type: "goal", title: "Synthetic type-only" }));
  f.write("README.md", "---\n# Horizontal rule opens prose\nNo closing YAML delimiter.\n");
  f.write("title.md", text({ title: "Ordinary title-only document" }, "[[unknown]]"));
  f.write("broken.md", "---\nid: [broken\n---\n");
  f.write("bad/SPEC.md", "---\nid: [broken\n---\n");
  const input = discoverSpecs(f.source), report = validateSpecs(input, { git: false });
  expect(input.specs).toEqual([]);
  expect(input.candidates?.map(candidate => candidate.path)).toEqual(["SPEC.md", "id-only.md", "type-only.md"]);
  expect(input.diagnostics.filter(item => item.code === "invalid_frontmatter").map(item => item.path)).toEqual(["bad/SPEC.md"]);
  expect(report.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "missing_id", path: "SPEC.md" }),
    expect.objectContaining({ code: "missing_type", path: "SPEC.md" }),
    expect.objectContaining({ code: "missing_title", path: "SPEC.md" }),
    expect.objectContaining({ code: "missing_type", path: "id-only.md" }),
    expect.objectContaining({ code: "missing_id", path: "type-only.md" }),
  ]));
  expect(report.items.some(item => ["README.md", "title.md", "broken.md"].includes(item.path))).toBe(false);
});

test("metadata wiki labels/headings resolve to ids and wrong list shapes stay visible to validation", () => {
  const root = document("root"), child = document("child", { parent: "[[root|Root]]", references: ["[[root#Heading]]"], "depends-on": ["[[root#Heading|Root]]"], implements: ["root"] });
  const input = snapshot([root, child]), graph = buildSpecGraph(input);
  expect(graph.unresolved).toEqual([]);
  expect(graph.edges.filter(edge => edge.source === "child")).toHaveLength(4);
  expect(validateSpecs(input, { git: false }).errors).toBe(0);
  expect(validateSpecs(snapshot([document("root", { paths: "src/**" })]), { git: false }).items).toContainEqual(expect.objectContaining({ code: "wrong_shape", field: "paths" }));
  for (const field of ["depends-on", "references", "implements"]) {
    const malformed = document("child", { [field]: "[[root|Root]]" });
    expect(validateSpecs(snapshot([root, malformed]), { git: false }).items).toContainEqual(expect.objectContaining({ code: "wrong_shape", field }));
    expect(buildSpecGraph(snapshot([root, malformed])).diagnostics).toContainEqual(expect.objectContaining({ code: "wrong_shape", field }));
    expect(malformed.frontmatter[field]).toBe("[[root|Root]]");
  }
});

test("rank levels may be skipped, parent cycles are errors, and all supersession rules are reported", () => {
  expect(validateSpecs(snapshot([document("root"), document("child", { type: "submodule" })]), { git: false }).errors).toBe(0);
  const cycle = validateSpecs(snapshot([document("root"), document("a", { parent: "b" }), document("b", { type: "submodule", parent: "a" })]), { git: false });
  expect(cycle.items.filter(item => item.code === "parent_cycle").map(item => item.id)).toEqual(["a", "b"]);
  const wrong = document("child", { status: "active", "superseded-by": "child" });
  const result = validateSpecs(snapshot([document("root"), wrong]), { git: false });
  expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ code: "superseded_self" }), expect.objectContaining({ code: "superseded_status" })]));
  for (const status of ["done", "stale"]) expect(validateSpecs(snapshot([document("root", { status })]), { git: false }).items).toContainEqual(expect.objectContaining({ code: "unknown_status" }));
});

test("introduced errors compare complete identities, preserve existing errors and detect new targets/cycles/ranks", () => {
  const current = snapshot([document("root"), document("child", { references: ["missing"] })]);
  const bodyOnly = snapshot([document("root"), document("child", { references: ["missing"] }, "Unrelated prose change.")]);
  expect(introducedSpecErrors(current, bodyOnly, { git: false })).toEqual([]);
  const target = snapshot([document("root"), document("child", { references: ["other-missing"] })]);
  expect(introducedSpecErrors(current, target, { git: false })).toContainEqual(expect.objectContaining({ code: "dangling_link", target: "other-missing" }));
  const clean = snapshot([document("root"), document("a"), document("b", { type: "submodule", parent: "a" })]);
  const cyclic = snapshot([document("root"), document("a", { parent: "b" }), document("b", { type: "submodule", parent: "a" })]);
  expect(introducedSpecErrors(clean, cyclic, { git: false }).map(item => item.code)).toEqual(expect.arrayContaining(["parent_cycle", "type_rank"]));
  const many = Array.from({ length: 600 }, (_, i) => document(`node-${i}`, { references: ["missing"] }));
  const smallReport = validateSpecs(snapshot([document("root"), ...many]), { git: false, limit: 1 });
  expect(smallReport.errors).toBe(600); expect(smallReport.items).toHaveLength(1); expect(smallReport.truncated).toBe(true);
  expect(introducedSpecErrors(snapshot([document("root"), ...many]), snapshot([document("root"), ...many, document("z-new", { references: ["new-target"] })]), { git: false, limit: 1 })[0]).toMatchObject({ id: "z-new", code: "dangling_link" });
});

test("validation report bounds optional long ids without inventing a new id restriction", () => {
  const id = "long-" + "x".repeat(20000), item = document(id, { type: "future-type", parent: "root" }); item.path = "long/SPEC.md";
  const report = validateSpecs(snapshot([document("root"), item]), { git: false });
  expect(report.errors).toBe(1); expect(report.items[0]?.code).toBe("unknown_type");
  expect(report.items[0]).not.toHaveProperty("id"); expect(report.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(128 * 1024);
  expect(introducedSpecErrors(snapshot([document("root")]), snapshot([document("root"), item]), { git: false })).toHaveLength(1);
});

test("non-candidate size/encoding failures are diagnostics while candidates keep blocking errors", () => {
  const f = fixture(); f.write("SPEC.md", text({ id: "root", type: "goal", title: "Synthetic root" }));
  f.write("README.md", "# Ordinary documentation\n" + "x".repeat(MAX_NOTE_BYTES));
  f.write("binary.md", Buffer.from([255]));
  const input = discoverSpecs(f.source);
  expect(input.specs.map(item => item.id)).toEqual(["root"]);
  expect(input.diagnostics.filter(item => item.code === "skipped_path").map(item => item.path)).toEqual(["README.md", "binary.md"]);
  expect(validateSpecs(input, { git: false }).ok).toBe(true);
  f.write("candidate.md", text({ id: "large", type: "module", title: "Synthetic candidate" }, "x".repeat(MAX_NOTE_BYTES)));
  expect(() => discoverSpecs(f.source)).toThrow("candidate.md: Markdown exceeds");
  rmSync(join(f.repo, "candidate.md"));
  f.write("encoded-candidate.md", Buffer.concat([Buffer.from(text({ id: "encoded", type: "module", title: "Synthetic encoded" })), Buffer.from([255])]));
  expect(() => discoverSpecs(f.source)).toThrow("encoded-candidate.md: Markdown is not valid UTF-8");
});

test("hostile pathspec environment cannot alter discovery or misclassify uppercase README.MD", () => {
  const f = fixture();
  f.write("nested/SPEC.md", text({ id: "nested", type: "goal", title: "Synthetic nested" }));
  f.write("README.MD", text({ id: "upper", type: "goal", title: "Synthetic uppercase" }));
  const expected = discoverSpecs(f.source).specs.map(item => item.id);
  for (const key of ["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) expect(discoverSpecs(f.source, { env: { ...process.env, [key]: "1" } }).specs.map(item => item.id)).toEqual(expected);
});

test("registry-free requireFresh fails only stale scopes, and no registry/home is read or written", () => {
  const f = fixture(); f.write("src/a.ts", "Synthetic first source.\n"); const stamp = f.commit();
  f.write("SPEC.md", text({ id: "root", type: "goal", title: "Synthetic root", status: "active", paths: ["src/**"], "verified-against": stamp }));
  const env = { ...process.env, VMEM_HOME: f.home }, before = tree(f.root);
  expect(validateSpecRepo(f.repo, { env }).code).toBe(0);
  expect(validateSpecRepo(f.repo, { env, requireFresh: true }).code).toBe(0);
  expect(tree(f.root)).toEqual(before); expect(existsSync(f.home)).toBe(false);
  f.write("src/a.ts", "Synthetic changed source.\n");
  expect(validateSpecRepo(f.repo, { env }).code).toBe(0);
  const strict = validateSpecRepo(f.repo, { env, requireFresh: true });
  expect(strict.code).toBe(1); expect(strict.report.items).toContainEqual(expect.objectContaining({ code: "stale", severity: "error" }));
});

test("adapter Git inspection holds no IMMEDIATE lock and a peer scanner can finish during discovery", () => {
  const f = fixture(); f.write("SPEC.md", text({ id: "root", type: "goal", title: "Synthetic root" }));
  const baseline = new SpecIndex(f.home, f.source); baseline.scan(); const file = baseline.file; baseline.close();
  const peer = `const { SpecIndex } = await import("./src/spec-source.ts"); const index = new SpecIndex(${JSON.stringify(f.home)}, ${JSON.stringify(f.source)}); try { index.scan(); } finally { index.close(); }`;
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { mock } from "bun:test";
    import { Database } from "bun:sqlite";
    const observer = new Database(${JSON.stringify(file)}); observer.run("PRAGMA busy_timeout=1");
    const cp = await import("node:child_process"), spawn = cp.spawnSync;
    let calls = 0, busy = 0, peerExit = null;
    mock.module("node:child_process", () => ({ ...cp, spawnSync: (...args) => {
      let unlocked = false;
      try { observer.run("BEGIN IMMEDIATE"); observer.run("ROLLBACK"); unlocked = true; } catch { busy++; }
      calls++;
      if (unlocked && peerExit === null && args[1].includes("ls-files")) peerExit = Bun.spawnSync([process.execPath, "-e", ${JSON.stringify(peer)}], { stdout: "pipe", stderr: "pipe" }).exitCode;
      return spawn(...args);
    } }));
    const { SpecIndex } = await import("./src/spec-source.ts");
    const index = new SpecIndex(${JSON.stringify(f.home)}, ${JSON.stringify(f.source)});
    try { index.scan(); console.log(JSON.stringify({ calls, busy, peerExit })); } finally { index.close(); observer.close(); }
  `], { stdout: "pipe", stderr: "pipe", timeout: 12000 });
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.calls).toBeGreaterThan(4); expect(result.busy).toBe(0); expect(result.peerExit).toBe(0);
}, 15000);

test("duplicate and missing id repairs do not turn retained field errors into introduced errors", () => {
  const root = document("root"), a = document("shared", { type: "future-type" }), b = document("shared"); a.path = "a.md"; b.path = "b.md";
  const current = snapshot([root, a]); current.candidates = [root, a, b];
  const fixed = document("fixed"); fixed.path = "b.md";
  expect(introducedSpecErrors(current, snapshot([root, a, fixed]), { git: false })).toEqual([]);
  const partial = document("partial"); delete partial.frontmatter.id; delete partial.frontmatter.title;
  const missing = snapshot([root]); missing.candidates = [root, partial];
  const repaired = document("partial"); delete repaired.frontmatter.title;
  expect(introducedSpecErrors(missing, snapshot([root, repaired]), { git: false })).toEqual([]);
  const moved = { ...a, path: "moved/SPEC.md" };
  expect(introducedSpecErrors(snapshot([root, a]), snapshot([root, moved]), { git: false })).toEqual([]);
});

test("oversized frontmatter is not silently mistaken for non-candidate Markdown", () => {
  const f = fixture();
  f.write("candidate.md", '---\nid: large\ntype: module\ntitle: Synthetic large header\nextra: "' + "x".repeat(MAX_NOTE_BYTES) + '"\n---\n# Synthetic body\n');
  expect(() => discoverSpecs(f.source)).toThrow("candidate.md: frontmatter exceeds the bounded candidate probe");
  expect(() => validateSpecRepo(f.repo)).toThrow("bounded candidate probe");
});

test("a failed final binding check invalidates the instance view before another read", () => {
  const f = fixture(); f.write("SPEC.md", text({ id: "root", type: "goal", title: "Synthetic root" }, "Initialquasar."));
  const replacement = text({ id: "root", type: "goal", title: "Synthetic root" }, "Updatedquasar.");
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { mock } from "bun:test";
    import { writeFileSync } from "node:fs";
    const cp = await import("node:child_process"), spawn = cp.spawnSync; let lists = 0, pending = false;
    mock.module("node:child_process", () => ({ ...cp, spawnSync: (...args) => {
      if (pending) { pending = false; return { status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: Object.assign(new Error("synthetic final timeout"), { code: "ETIMEDOUT" }) }; }
      const result = spawn(...args);
      if (args[1].includes("ls-files") && ++lists === 2) pending = true;
      return result;
    } }));
    const { SpecIndex } = await import("./src/spec-source.ts");
    const index = new SpecIndex(${JSON.stringify(f.home)}, ${JSON.stringify(f.source)});
    try {
      index.scan(); const old = index.snapshot().specs[0].source;
      writeFileSync(${JSON.stringify(join(f.repo, "SPEC.md"))}, ${JSON.stringify(replacement)});
      let failed = false; try { index.scan(); } catch { failed = true; }
      const current = index.snapshot();
      console.log(JSON.stringify({ failed, oldPreserved: old.includes("Initialquasar"), updated: current.specs[0].source.includes("Updatedquasar"), hits: index.search("Updatedquasar").length, lists }));
    } finally { index.close(); }
  `], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({ failed: true, oldPreserved: true, updated: true, hits: 1, lists: 3 });
});

test("one old error owner cannot be inherited by a moved spec and a new spec reusing its path", () => {
  const root = document("root"), original = document("one", { references: ["missing"] }); original.path = "a.md";
  const moved = { ...original, path: "b.md" }, added = document("new", { references: ["missing"] }); added.path = "a.md";
  const errors = introducedSpecErrors(snapshot([root, original]), snapshot([root, moved, added]), { git: false });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: "dangling_link", id: "new", path: "a.md", target: "missing" });
});

test("candidate keys keep an encoding error when another frontmatter value is invalid UTF-8", () => {
  const f = fixture();
  f.write("candidate.md", Buffer.concat([Buffer.from("---\nid: candidate\ntype: module\ntitle: Synthetic candidate\nnote: '"), Buffer.from([255]), Buffer.from("'\n---\n# Synthetic body\n")]));
  expect(() => discoverSpecs(f.source)).toThrow("candidate.md: Markdown is not valid UTF-8");
  expect(() => validateSpecRepo(f.repo)).toThrow("not valid UTF-8");
});

test("covers token claims warn across scalar/list forms without adding unspecified optional-metadata errors", () => {
  const result = validateSpecs(snapshot([document("root", { covers: "REQ-1", tags: "legacy-tag" }), document("child", { covers: ["REQ-1"] })]), { git: false });
  expect(result.errors).toBe(0);
  expect(result.items.filter(item => item.code === "duplicate_covers")).toHaveLength(2);
});

test("errors in a different repository namespace cannot excuse prospective errors", () => {
  const specs = [document("root"), document("child", { references: ["missing"] })];
  const current = snapshot(specs), other = { ...snapshot(specs), root: "/other", commonDir: "/other/.git" };
  expect(introducedSpecErrors(current, other, { git: false })).toContainEqual(expect.objectContaining({ code: "dangling_link", id: "child" }));
});

test("ambiguous duplicate file records fail closed instead of sharing an error owner", () => {
  const a = document("one"), b = document("two", { references: ["missing"] }); b.path = a.path;
  expect(() => introducedSpecErrors(snapshot([document("root"), a]), snapshot([document("root"), a, b]), { git: false })).toThrow("duplicate candidate paths");
});

test("a bounded report shows blocking errors before earlier-path warnings", () => {
  const report = validateSpecs(snapshot([document("root"), document("a-warning", { parent: undefined }), document("z-error", { references: ["missing"] })]), { git: false, limit: 1 });
  expect(report).toMatchObject({ errors: 1, warnings: 1, truncated: true });
  expect(report.items[0]).toMatchObject({ severity: "error", id: "z-error", code: "dangling_link" });
});
