import { terminalText } from "@staix/cli-output";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { run } from "../src/cli.ts";
import { VaultIndex } from "../src/vault-index.ts";
import { readLog } from "../src/vault-log.ts";
import { analysisInput } from "../src/analysis-input.ts";
import { lintDetails, lintVault } from "../src/vault-lint.ts";
import { buildGraph, graphNeighbors } from "../src/vault-graph.ts";
import { analysisCorpus } from "./fixtures/analysis-corpus.ts";
import { PLAIN } from "../src/text-output.ts";
import { analysisWriteText, linksText, lintText, logAppendText, logReadText, neighborsText, rebuildText, searchText, showText } from "../src/read-output.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-read-output-"))); roots.push(root);
  const home = join(root, "home"), vault = join(root, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true }); mkdirSync(join(vault, "reports"));
  writeFileSync(join(vault, "notes", "alpha.md"), "---\ntitle: Alpha Lanterns\ntype: method\ntopics: [x]\n---\n# Alpha\n\nLanterns light the synthetic path. See [[beta]] and [[missing]].\n\n## First\n\nMore lanterns.\n\n## Second\n\nEnd.\n");
  writeFileSync(join(vault, "notes", "beta.md"), "---\ntitle: Beta\ntype: method\ntopics: [x]\n---\n# Beta\n\nLanterns again, [[alpha#First]].\n");
  writeFileSync(join(vault, "log"), "2026-11-01 10:00  LEARN  -  synthetic  — first\n2026-11-02 10:00  CONNECT  -  synthetic  — second\n");
  const spec = { id: "demo", path: vault, kind: "personal" as const, write: "cli" as const };
  addVault(home, spec);
  return { home, vault, spec, env: { VMEM_HOME: home } };
}

test("#114 search: one hit per row with its snippet beneath, a count line and the command for more", () => {
  const hits = [
    { path: "alpha.md", title: "Alpha Lanterns", description: "", type: "method", domain: "", score: -1, snippet: "Lanterns \u001b[31mlight\u001b[0m the path" },
    { path: "beta.md", title: "Beta", description: "", type: "method", domain: "", score: -0.5, snippet: "" },
  ];
  const output = searchText(hits, PLAIN, { vault: "demo", query: "lanterns", limit: 2, type: "method" });
  expect(output).toContain("alpha.md: Alpha Lanterns");
  expect(output).toContain("Lanterns light the path");
  expect(output).toContain("vmem search demo lanterns --type method --limit 4");
  expect(searchText([], PLAIN, { vault: "demo", query: "none", limit: 50 })).toContain("Results:  0");
  const wrapped = searchText([{ ...hits[0]!, title: "A title long enough to wrap into another table row", snippet: "first snippet" }, { ...hits[1]!, snippet: "second snippet" }], PLAIN, { vault: "demo", query: "x", limit: 10 });
  expect(wrapped.indexOf("first snippet")).toBeLessThan(wrapped.indexOf("beta.md"));
  expect(wrapped.indexOf("beta.md")).toBeLessThan(wrapped.indexOf("second snippet"));
});

test("#114 show: title line, fields, the body as is without escapes, and for a truncated read the next-page command and headings", () => {
  const full = { path: "alpha.md", hash: "37b9ad6179010000", content: "# Alpha\n\x1b]0;title\x07Body \x1b[1mbold\x1b[0m\r\n", truncated: false };
  expect(showText(full, PLAIN, { vault: "demo", target: "alpha" })).toContain("# Alpha\nBody bold");
  const cut = { path: "alpha.md", hash: "37b9ad6179010000", content: "---\ntitle: A", truncated: true, section: "First", offset: 0, nextOffset: 12, headings: ["First", "Second"], headingsTruncated: true };
  const shown = showText(cut, PLAIN, { vault: "demo", target: "alpha", maxBytes: 12 });
  expect(shown).toContain("---\ntitle: A");
  expect(shown).toContain("vmem show demo alpha --section First --max-bytes 12 --offset 12");
  expect(shown).toContain("▸ H2 headings");
  expect(shown).toContain("-  First");
  expect(terminalText("a\u001b[2Kb\u009b31mc\u001bcd\u0008e\tf")).toBe("abcde\tf");
});

test("#114 links, log, rebuild and neighbours render tables, counts and next commands", () => {
  const link = (target: string, resolved: string | null, reason: "missing-note" | null, heading: string | null = null) => ({ target, label: null, heading, block: null, embed: false, line: 3, source: "alpha.md", resolved, reason });
  const links = linksText([link("beta", "beta.md", null, "First"), link("missing", null, "missing-note")], PLAIN, { vault: "demo", target: "alpha", limit: 2 });
  expect(links).toContain("beta#First: beta.md");
  expect(links).toContain("missing: missing-note");
  expect(links).toContain("vmem links demo alpha --limit 4");
  // A hinted dead link keeps one RESOLVED cell, and the hint inherits the reason's tone.
  const hinted = [{ ...link("missing", null, "missing-note"), suggested: { path: "lantern.md", title: "Synthetic Lantern Notes", score: 3.76 } }];
  expect(linksText(hinted, PLAIN, { vault: "demo", target: "alpha", limit: 2 })).toContain("lantern.md (3.760)");
  expect(linksText(hinted, { color: true }, { vault: "demo", target: "alpha", limit: 2 })).not.toBe(linksText(hinted, PLAIN, { vault: "demo", target: "alpha", limit: 2 }));
  expect(linksText([link("missing", null, "missing-note")], PLAIN, { vault: "demo", target: "alpha", limit: 2 })).not.toContain("suggested");
  const read = { ok: true, lines: ["2026-11-02 10:00  CONNECT  -  synthetic  — second"], dataLines: 2, warnings: ["incomplete final log line omitted"], issues: [] };
  const log = logReadText(read, PLAIN, { command: "grep", vault: "demo", pattern: "sec ond", limit: 1 });
  expect(log).toContain("incomplete final log line omitted");
  expect(log).toContain("vmem log grep demo 'sec ond' --limit 2");
  expect(logAppendText({ ok: true, appended: true, synced: true, bytesWritten: 53, issues: [] }, PLAIN, { vault: "demo", type: "LEARN" })).toContain("appended LEARN to the demo log");
  expect(logAppendText({ ok: false, appended: false, synced: false, bytesWritten: 0, issues: [{ code: "L09", severity: "error", message: "bad" }] }, PLAIN, { vault: "demo", type: "LEARN" })).toContain("L09: bad");
  expect(rebuildText({ vault: "demo", notes: 2, changed: 1, removed: 0 }, PLAIN)).toContain("Changed:  1");
  const node = (id: string) => ({ id, label: id.toUpperCase(), type: "method", domain: "", source_file: `notes/${id}.md`, community: 0, degree: 1 });
  const edge = (source: string, target: string) => ({ source, target, relation: "wiki_link" as const, confidence_tag: "EXTRACTED" as const, confidence: 1 as const });
  const neighbors = neighborsText({ start: "a", hops: 2, nodes: [node("a"), node("c"), node("b")], edges: [edge("b", "c"), edge("a", "b")], truncated: true }, PLAIN, { vault: "demo", limit: 3 });
  expect(neighbors).toContain("wiki_link");
  expect(neighbors).toContain("vmem graph neighbors demo a --hops 2 --limit 6");
});

test("#114 lint keeps every finding and info line as LEVEL/CHECK/FINDING rows and closes with the summary verdict", () => {
  const details = lintDetails(analysisCorpus()), text = lintText(details, PLAIN, { vault: "demo" }), lines = text.split("\n");
  expect(details.report).toEqual(lintVault(analysisCorpus()));
  expect(lines[0]).toBe(" vmem lint");
  expect(text).toContain("▸ Findings");
  for (const finding of Object.values(details.report.findings).flat()) expect(text).toContain(finding.replaceAll("`", ""));
  for (const info of Object.values(details.info).filter(Boolean)) expect(text).toContain(info!.replaceAll("`", ""));
  expect(text).not.toContain(details.report.summary);
  expect(lines.at(-1)).toContain("12 failed");
  const written = analysisWriteText({ ok: true, applied: false, summary: { nodes: 2, edges: 1, communities: 1 }, paths: ["reports/vault-graph.json"], receipts: [] }, PLAIN, { kind: "graph", dryRun: true });
  expect(written).toContain("reports/vault-graph.json");
  expect(written).toContain("nodes:");
});

test("#114 AC1: default output is text and --json prints exactly the previous compact JSON", () => {
  const f = fixture(), json = (args: string[]) => run([...args, "--json"], f.env).text;
  const index = new VaultIndex(f.home, f.spec);
  let expected: { search: string; show: string; links: string };
  try {
    index.scan();
    const listed = index.links("alpha");
    expect(listed.map(link => [link.target, link.resolved])).toContainEqual(["missing", null]);
    // A dead link gains only the hint field; its null here says the title search found nothing for "missing".
    expected = { search: JSON.stringify(index.search("lanterns")), show: JSON.stringify(index.show("alpha", 40)), links: JSON.stringify(listed.map(link => link.resolved ? link : { ...link, suggested: null })) };
  } finally { index.close(); }
  expect(json(["search", "demo", "lanterns"])).toBe(expected.search);
  expect(json(["show", "demo", "alpha", "--max-bytes", "40"])).toBe(expected.show);
  expect(json(["links", "demo", "alpha"])).toBe(expected.links);
  expect(JSON.parse(json(["links", "demo", "alpha"])).at(-1)).toMatchObject({ target: "missing", resolved: null, suggested: null });
  expect(json(["rebuild", "demo"])).toBe(JSON.stringify({ vault: "demo", notes: 2, changed: 2, removed: 0 }));
  expect(json(["log", "tail", "demo"])).toBe(JSON.stringify(readLog(f.home, { vault: "demo" })));
  const snapshot = analysisInput(f.home, "demo").snapshot;
  expect(json(["lint", "demo"])).toBe(JSON.stringify(lintVault(snapshot)));
  expect(json(["graph", "neighbors", "demo", "alpha"])).toBe(JSON.stringify(graphNeighbors(buildGraph(snapshot), "alpha", 1, 50)));
  expect(JSON.parse(json(["graph", "build", "demo", "--dry-run"]))).toMatchObject({ ok: true, applied: false });
  for (const args of [["search", "demo", "lanterns"], ["show", "demo", "alpha", "--max-bytes", "40"], ["links", "demo", "alpha"], ["rebuild", "demo"], ["log", "tail", "demo"], ["lint", "demo"], ["graph", "neighbors", "demo", "alpha"], ["graph", "build", "demo", "--dry-run"]]) {
    const text = run(args, f.env).text;
    expect(() => JSON.parse(text)).toThrow();
    expect(text).not.toContain("\u001b");
  }
  expect(run(["show", "demo", "alpha", "--max-bytes", "40"], f.env).text).toContain("vmem show demo alpha --max-bytes 40 --offset 40");
  expect(run(["search", "demo", "lanterns", "--color=always"], f.env).text).toContain("\u001b[");
});
