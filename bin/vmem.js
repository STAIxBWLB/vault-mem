#!/usr/bin/env -S bun --smol
const version = /^(\d+)\.(\d+)\.(\d+)/.exec(process.versions.bun ?? "");
if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && (Number(version[2]) < 4 || (Number(version[2]) === 4 && Number(version[3]) < 2)))) {
  console.error("vmem: Bun >=1.4.2 is required. Install Bun: https://bun.sh");
  process.exit(1);
}
const { main, mainAsync, runMcp } = await import("../src/cli.ts");
const { resolveColor, takeColorFlag } = await import("../src/text-output.ts");
const argv = process.argv.slice(2);
// `--color=` may stand anywhere, so the dispatch looks at the words without it; main/mainAsync take it off again.
let words;
try { const taken = takeColorFlag(argv); resolveColor(taken.color, { isTTY: false }); words = taken.args; }
catch (error) { console.error(`vmem: ${error instanceof Error ? error.message : "invalid --color"}`); process.exit(1); }
if (words.length === 1 && words[0] === "mcp") {
  try { await runMcp(); }
  catch (error) { console.error(`vmem mcp: ${error instanceof Error ? error.message : "failed"}`); process.exitCode = 1; }
} else if (words[0] === "promote-from-amem" || words[0] === "skills") process.exitCode = await mainAsync(argv);
else process.exitCode = main(argv);
