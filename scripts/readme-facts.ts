// Usage: bun scripts/readme-facts.ts [--write]
// Renders README blocks between <!-- facts:NAME --> and <!-- /facts:NAME --> from the package's own sources.
// Without --write it exits 1 when a block differs from what it would write.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VMEM_TOOL_NAMES } from "../src/mcp-vault.ts";
import { INDEX_SCHEMA, LINK_RESOLUTION } from "../src/vault-index.ts";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const code = (values: readonly string[]) => values.map(value => `\`${value}\``).join(", ");
const block = (body: string) => `\n\n${body}\n\n`;

export function facts(): Record<string, string> {
  const pkg = JSON.parse(read("package.json")) as { engines: { bun: string }; dependencies: Record<string, string> };
  const amem = pkg.dependencies["@staix/agent-mem"];
  if (!amem) throw new Error("package.json has no @staix/agent-mem dependency; restore the exact pin before rendering README facts");
  const types = /const TYPES = new Set\(\[([^\]]+)\]\)/.exec(read("src/write-validation.ts"))?.[1];
  if (!types) throw new Error("note types not found: src/write-validation.ts must define const TYPES = new Set([...]); update scripts/readme-facts.ts if it moved");
  const exports = [...read("src/index.ts").matchAll(/^export \{([^}]+)\} from "\.\/([^"]+)\.ts";$/gm)]
    .map(match => `- \`src/${match[2]}.ts\`: ${code(match[1]!.split(",").map(name => name.trim()))}`);
  if (!exports.length) throw new Error("no value exports found in src/index.ts; update scripts/readme-facts.ts if the export syntax changed");
  return {
    "bun-floor": `Bun ${pkg.engines.bun}`,
    "amem-pin": `\`@staix/agent-mem@${amem}\``,
    "amem-version": amem,
    "index-links": String(LINK_RESOLUTION),
    "index-schema": String(INDEX_SCHEMA),
    "note-types": code([...types.matchAll(/"([^"]+)"/g)].map(match => match[1]!)),
    "mcp-tools": block(`\`vmem mcp\` lists ${VMEM_TOOL_NAMES.length} tools: ${code(VMEM_TOOL_NAMES)}.`),
    "exports": block(exports.join("\n")),
  };
}

export function render(text: string, values: Record<string, string>): { text: string; problems: string[] } {
  const problems: string[] = [], seen = new Set<string>();
  const out = text.replace(/<!-- facts:([a-z-]+) -->([\s\S]*?)<!-- \/facts:\1 -->/g, (whole, name: string, current: string) => {
    const want = values[name];
    if (want === undefined) { problems.push(`facts:${name} is not a known fact (known: ${Object.keys(values).join(", ")})`); return whole; }
    seen.add(name);
    if (current !== want) problems.push(`facts:${name} differs: README has ${JSON.stringify(current.trim().slice(0, 80))}, source gives ${JSON.stringify(want.trim().slice(0, 80))}`);
    return `<!-- facts:${name} -->${want}<!-- /facts:${name} -->`;
  });
  const opened = text.match(/<!-- facts:/g)?.length ?? 0, closed = text.match(/<!-- \/facts:/g)?.length ?? 0;
  const matched = text.match(/<!-- facts:([a-z-]+) -->[\s\S]*?<!-- \/facts:\1 -->/g)?.length ?? 0;
  if (opened !== matched || closed !== matched) problems.push(`unbalanced facts markers: ${opened} opening, ${closed} closing, ${matched} matched pairs`);
  for (const name of Object.keys(values)) if (!seen.has(name)) problems.push(`facts:${name} has no block in README.md`);
  return { text: out, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--write")) throw new Error("Unknown argument. Use bun scripts/readme-facts.ts [--write].");
  const before = read("README.md");
  const { text, problems } = render(before, facts());
  const structural = problems.filter(problem => !problem.includes(" differs: "));
  if (args.includes("--write") && !structural.length) {
    if (text !== before) writeFileSync(join(root, "README.md"), text);
    console.log(`readme-facts: ${text === before ? "unchanged" : "README.md rewritten"}`);
  } else if (problems.length) {
    for (const problem of problems) console.error(`readme-facts: ${problem}`);
    console.error(structural.length ? "readme-facts: fix the markers in README.md, then rerun." : "readme-facts: run bun scripts/readme-facts.ts --write and commit README.md.");
    process.exit(1);
  } else console.log("readme-facts: ok");
}
