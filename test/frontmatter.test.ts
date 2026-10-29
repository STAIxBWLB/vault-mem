import { describe, expect, test } from "bun:test";
import { emitFrontmatter, parseFrontmatter } from "../src/frontmatter.ts";

describe("lossless frontmatter", () => {
  test("retains comments, scalar styles, sequences, mappings, BOM and CRLF byte-identically", () => {
    const source = "﻿---\r\n# synthetic corpus\r\ntitle: 'A ''quoted'' title' # title comment\r\ndescription: >-\r\n  folded first\r\n  folded second\r\nliteral: |+\r\n  first\r\n  second\r\n\r\naliases:\r\n  - Alpha\r\n  - 'Beta'\r\nmetadata:\r\n  owner: Synthetic\r\n  count: 2\r\ninline: [one, 'two']\r\n---\r\n# Connections\r\n[[Alpha]]\r\n";
    const document = parseFrontmatter(source);
    expect(document.data.title).toBe("A 'quoted' title");
    expect(document.data.description).toBe("folded first folded second");
    expect(document.data.aliases).toEqual(["Alpha", "Beta"]);
    expect(document.data.metadata).toEqual({ owner: "Synthetic", count: 2 });
    expect(document.body).toBe("# Connections\r\n[[Alpha]]\r\n");
    expect(Buffer.from(emitFrontmatter(document))).toEqual(Buffer.from(source));
    expect(emitFrontmatter(document, { title: document.data.title, aliases: ["Alpha", "Beta"] })).toBe(source);
  });

  test("only changed keys canonicalize, preserving adjacent standalone comments and body", () => {
    const source = "---\ntitle: 'Old' # inline\n# describes the next field\ndescription: >-\n  retained folded\n  description\n\naliases: ['Synthetic']\n# trailing comment\n---\nBody\n";
    const changed = emitFrontmatter(parseFrontmatter(source), { title: "New", domain: "testing" });
    expect(changed).toBe('---\n"title": "New"\n# describes the next field\ndescription: >-\n  retained folded\n  description\n\naliases: [\'Synthetic\']\n# trailing comment\n"domain": "testing"\n---\nBody\n');
    expect(parseFrontmatter(changed).data).toEqual({ title: "New", description: "retained folded description", aliases: ["Synthetic"], domain: "testing" });
    const deleted = emitFrontmatter(parseFrontmatter(source), { title: undefined });
    expect(deleted).toContain("---\n# describes the next field\n");
    expect(parseFrontmatter(deleted).data.title).toBeUndefined();
  });

  test("changed sequences and one-level maps use valid canonical YAML without changing neighbors", () => {
    const source = "---\nkeep: 'same'\naliases:\n  - Before\nmeta:\n  owner: Before\nlast: |\n  unchanged\n---\nbody";
    const output = emitFrontmatter(parseFrontmatter(source), { aliases: ["After", "Other"], meta: { owner: "After", active: true } });
    expect(output).toContain("keep: 'same'\n");
    expect(output).toContain("last: |\n  unchanged\n");
    expect(parseFrontmatter(output).data).toEqual({ keep: "same", aliases: ["After", "Other"], meta: { owner: "After", active: true }, last: "unchanged\n" });
  });

  test("quoted multiline values and flow collections do not produce false top-level keys", () => {
    const source = '---\ntitle: "line\n fake: content"\naliases: [\n "Alias",\n "Other"\n ]\nkeep: yes\n---\nbody';
    const output = emitFrontmatter(parseFrontmatter(source), { title: "Replacement" });
    expect(output).toContain('"title": "Replacement"\naliases: [\n "Alias",\n "Other"\n ]\nkeep: yes\n');
    expect(parseFrontmatter(output).data.title).toBe("Replacement");
  });

  test("plain notes, empty frontmatter, closing delimiter at EOF and quoted keys", () => {
    for (const source of ["", "# Synthetic\n---\nbody", "---\n# empty\n---", "---\r\ntitle: x\r\n---"]) expect(emitFrontmatter(parseFrontmatter(source))).toBe(source);
    expect(emitFrontmatter(parseFrontmatter("﻿Body"), { title: "New" })).toBe('﻿---\n"title": "New"\n---\nBody');
    const quoted = parseFrontmatter('---\n"complex:key": \'old\'\n---\nbody');
    expect(parseFrontmatter(emitFrontmatter(quoted, { "complex:key": "new" })).data["complex:key"]).toBe("new");
  });

  test("flow mappings round-trip untouched and reject additions, replacements and deletions", () => {
    for (const yaml of ["{a: 1}\n", "{\n  a: 1,\n  b: [one, two]\n}\n", "# flow mapping\n{}\n"]) {
      const source = `---\n${yaml}---\nBody`;
      const document = parseFrontmatter(source);
      expect(emitFrontmatter(document)).toBe(source);
      expect(() => emitFrontmatter(document, { added: "value" })).toThrow("editing requires a block mapping");
      if (Object.hasOwn(document.data, "a")) {
        expect(emitFrontmatter(document, { a: 1 })).toBe(source);
        expect(() => emitFrontmatter(document, { a: 2 })).toThrow("editing requires a block mapping");
        expect(() => emitFrontmatter(document, { a: undefined })).toThrow("editing requires a block mapping");
      }
    }
    const source = '---\n"complex:key": \'before\'\n\'single key\': [one, two]\n---\nBody';
    const output = emitFrontmatter(parseFrontmatter(source), { "complex:key": "after", "single key": ["three"], added: true });
    expect(parseFrontmatter(output).data).toEqual({ "complex:key": "after", "single key": ["three"], added: true });
  });

  test("malformed and ambiguous YAML rejects without echoing note contents", () => {
    for (const source of ["---\ntitle: private", "---\ntitle: [private\n---\n", "---\n- private\n---\n", "---\ntitle: first\ntitle: second\n---\n"]) {
      expect(() => parseFrontmatter(source)).toThrow("frontmatter:");
    }
    expect(() => emitFrontmatter(parseFrontmatter("Body"), { title: Number.NaN })).toThrow("JSON-compatible");
  });
});
