import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultIndex, MAX_READ_BYTES } from "../src/vault-index.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const late = "## Late Section\n\n한글 café, a synthetic section.\n\n### Detail\nNested text remains in the selected H2.\n\n";
function fixture(extra = "") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-sections-"))); roots.push(root);
  const home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true }); mkdirSync(home);
  const spec = { id: "fixture", path: vault, kind: "personal" as const, write: "mcp" as const };
  const source = "---\ntitle: Synthetic Canon\ntype: moc\ndescription: Synthetic long-note navigation fixture.\n---\n# Synthetic Canon\n\n## Early\n\n" + "Synthetic filler.\n".repeat(4500) + "\n```md\n## Hidden Fence\n```\n\n" + late + "## Last\n\nThe final synthetic section.\n" + extra;
  writeFileSync(join(notes, "canon.md"), source);
  writeFileSync(join(home, "vmem.config.json"), JSON.stringify({ vaults: [spec] }));
  return { root, home, vault, notes, spec, source };
}
test("derived section read reaches beyond 64KiB, retains nested headings and never rescans the note file", () => {
  const f = fixture(), index = new VaultIndex(f.home, f.spec);
  try {
    index.scan(); expect(Buffer.byteLength(f.source)).toBeGreaterThan(MAX_READ_BYTES);
    const prefix = index.show("canon", 32);
    expect(prefix.truncated).toBe(true); expect(prefix.headings).toEqual(["Early", "Late Section", "Last"]);
    expect(prefix.headings).not.toContain("Hidden Fence");
    writeFileSync(join(f.notes, "canon.md"), "External synthetic change after indexing.\n");
    const selected = index.show("canon", 65536, "Late Section");
    expect(selected.content).toBe(late); expect(selected.section).toBe("Late Section"); expect(selected.truncated).toBe(false);
    expect(selected.hash).toBe(prefix.hash); expect(selected.headings).toBeUndefined();
    const tiny = index.show("canon", 24, "Late Section");
    expect(tiny.truncated).toBe(true); expect(Buffer.byteLength(tiny.content)).toBeLessThanOrEqual(24); expect(tiny.content).not.toContain("�");
    expect(tiny.headings).toEqual(["Early", "Late Section", "Last"]);
    expect(() => index.show("canon", 65536, "late section")).toThrow("unknown");
    expect(() => index.show("canon", 65536, "missing")).toThrow("unknown");
    expect(() => index.show("canon", 65536, "bad\nname")).toThrow("section");
  } finally { index.close(); }
});
test("derived section names are exact, ambiguous names refuse and metadata remains bounded", () => {
  const f = fixture("\n## Duplicate\nfirst\n## Duplicate\nsecond\n## Closing ###\nclosed\n# New Chapter\noutside\n"), index = new VaultIndex(f.home, f.spec);
  try {
    index.scan(); expect(() => index.show("canon", 65536, "Duplicate")).toThrow("ambiguous");
    expect(index.show("canon", 65536, "Closing").content).toBe("## Closing ###\nclosed\n");
  } finally { index.close(); }
  const many = fixture(Array.from({ length: 100 }, (_, i) => `\n## Name ${i}\nBody\n`).join("")), capped = new VaultIndex(many.home, many.spec);
  try {
    capped.scan(); const result = capped.show("canon", 1);
    expect(result.headings?.length).toBeLessThanOrEqual(64); expect(result.headingsTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.headings))).toBeLessThanOrEqual(8192);
    expect(capped.show("canon", 100, "Name 99").content).toBe("## Name 99\nBody\n");
  } finally { capped.close(); }
});
test("CLI and MCP expose exact section reads and headings without treating sections as complete notes", async () => {
  const { run } = await import("../src/cli.ts"), { createVaultMcp } = await import("../src/mcp-vault.ts");
  const f = fixture(), result = JSON.parse(run(["show", "fixture", "canon", "--section", "Late Section", "--json"], { VMEM_HOME: f.home }).text);
  expect(result.content).toBe(late); expect(result.truncated).toBe(false);
  const server = createVaultMcp(f.home), read = server.handlers.vmem_read!;
  const section = await read({ vault: "fixture", path: "canon", section: "Late Section" }) as { body: string; frontmatter: unknown; section: string };
  expect(section.body).toBe(late); expect(section.frontmatter).toBeNull(); expect(section.section).toBe("Late Section");
  const prefix = await read({ vault: "fixture", path: "canon", maxBytes: 32 }) as { headings: string[]; truncated: boolean };
  expect(prefix.truncated).toBe(true); expect(prefix.headings).toEqual(["Early", "Late Section", "Last"]);
  const short = fixture(); writeFileSync(join(short.notes, "canon.md"), "---\ntitle: Small\ntype: moc\ndescription: Synthetic small read fixture.\n---\n# Small\n");
  const small = await createVaultMcp(short.home).handlers.vmem_read!({ path: "canon" }) as { body: string; frontmatter: { title: string }; section?: string };
  expect(small.frontmatter.title).toBe("Small"); expect(small.body).toBe("# Small\n"); expect(small.section).toBeUndefined();
});
test("MCP create source schema permits a bounded string list and rejects empty or nonstring lists", async () => {
  const { vaultTools } = await import("../src/mcp-vault.ts"), { validArguments } = await import("../src/mcp.ts");
  const schema = vaultTools(["fixture"]).find(tool => tool.name === "vmem_create")!.inputSchema;
  const args = { vault: "fixture", stem: "new-note", type: "insight", domain: "research", description: "Synthetic new note." };
  expect(validArguments({ ...args, source: ["work/project/source.md", "https://example.test/source"] }, schema)).toBe(true);
  expect(validArguments({ ...args, source: [] }, schema)).toBe(false);
  expect(validArguments({ ...args, source: ["valid.md", 42] }, schema)).toBe(false);
  expect(validArguments({ ...args, source: Array(33).fill("valid.md") }, schema)).toBe(false);
});
test("derived byte paging reconstructs one oversized Unicode H2 and the whole-note tail", () => {
  const f = fixture(), section = "## One Large H2\n\n" + "한글 café 👋 synthetic.\n".repeat(7000) + "\n";
  const source = "---\ntitle: Paged Canon\ntype: moc\ndescription: Synthetic Unicode paging fixture.\n---\n# Paged Canon\n\n" + section + "## After\nFinal section.\n";
  writeFileSync(join(f.notes, "canon.md"), source);
  const index = new VaultIndex(f.home, f.spec);
  try {
    index.scan(); expect(Buffer.byteLength(section)).toBeGreaterThan(MAX_READ_BYTES);
    let offset = 0, reconstructed = "", hash: string | undefined;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = index.show("canon", MAX_READ_BYTES, "One Large H2", offset);
      expect(page.offset).toBe(offset); expect(page.section).toBe("One Large H2"); expect(page.content).not.toContain("�");
      if (hash === undefined) hash = page.hash; else expect(page.hash).toBe(hash);
      reconstructed += page.content;
      if (!page.truncated) { expect(page.nextOffset).toBeUndefined(); break; }
      expect(page.nextOffset!).toBeGreaterThan(offset);
      expect(page.nextOffset).toBe(offset + Buffer.byteLength(page.content));
      offset = page.nextOffset!;
    }
    expect(reconstructed).toBe(section);
    const full = index.show("canon", MAX_READ_BYTES), rest = index.show("canon", MAX_READ_BYTES, undefined, full.nextOffset);
    expect(full.nextOffset).toBe(Buffer.byteLength(full.content));
    expect(rest.offset).toBe(full.nextOffset); expect(rest.content).toBe(Buffer.from(source).subarray(full.nextOffset!, full.nextOffset! + Buffer.byteLength(rest.content)).toString("utf8"));
    const finalOffset = Buffer.byteLength(source) - Buffer.byteLength("Final section.\n");
    const tail = index.show("canon", 100, undefined, finalOffset);
    expect(tail.content).toBe("Final section.\n"); expect(tail.truncated).toBe(false);
    const midCharacter = Buffer.byteLength("## One Large H2\n\n") + 1;
    expect(() => index.show("canon", 100, "One Large H2", midCharacter)).toThrow("UTF-8");
    expect(() => index.show("canon", 1, "One Large H2", midCharacter - 1)).toThrow("cannot fit");
    for (const bad of [-1, 1.5, NaN, 2097153]) expect(() => index.show("canon", 100, undefined, bad)).toThrow("offset");
    expect(() => index.show("canon", 100, "One Large H2", Buffer.byteLength(section) + 1)).toThrow("exceeds");
    expect(index.show("canon", 100, "One Large H2", Buffer.byteLength(section)).content).toBe("");
  } finally { index.close(); }
});
test("CLI and MCP byte offsets return raw pages even when the final page is complete", async () => {
  const { run } = await import("../src/cli.ts"), { createVaultMcp } = await import("../src/mcp-vault.ts");
  const f = fixture(), offset = Buffer.byteLength(f.source) - Buffer.byteLength("The final synthetic section.\n");
  const result = JSON.parse(run(["show", "fixture", "canon", "--offset", String(offset), "--max-bytes", "64", "--json"], { VMEM_HOME: f.home }).text);
  expect(result.content).toBe("The final synthetic section.\n"); expect(result.offset).toBe(offset); expect(result.truncated).toBe(false);
  const server = createVaultMcp(f.home);
  const finalPage = await server.handlers.vmem_read!({ path: "canon", offset, maxBytes: 64 }) as { frontmatter: unknown; body: string; offset: number; truncated: boolean };
  expect(finalPage.frontmatter).toBeNull(); expect(finalPage.body).toBe(result.content); expect(finalPage.offset).toBe(offset); expect(finalPage.truncated).toBe(false);
  const start = await server.handlers.vmem_read!({ path: "canon", offset: 0, maxBytes: 32 }) as { frontmatter: unknown; body: string; offset: number; nextOffset: number };
  expect(start.frontmatter).toBeNull(); expect(start.body).toBe(f.source.slice(0, 32)); expect(start.offset).toBe(0); expect(start.nextOffset).toBe(32);
  const fromSection = await server.handlers.vmem_read!({ path: "canon", section: "Late Section", offset: Buffer.byteLength("## Late Section\n\n"), maxBytes: 1024 }) as { frontmatter: unknown; body: string; section: string };
  expect(fromSection.frontmatter).toBeNull(); expect(fromSection.body).toBe(late.slice("## Late Section\n\n".length)); expect(fromSection.section).toBe("Late Section");
  expect(() => run(["show", "fixture", "canon", "--offset", "-1"], { VMEM_HOME: f.home })).toThrow("offset");
});
