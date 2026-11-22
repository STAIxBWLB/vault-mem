#!/usr/bin/env -S bun --smol
const version = /^(\d+)\.(\d+)\.(\d+)/.exec(process.versions.bun ?? "");
if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && (Number(version[2]) < 4 || (Number(version[2]) === 4 && Number(version[3]) < 4)))) {
  console.error("vmem: Bun >=1.4.4 is required. Install Bun: https://bun.sh");
  process.exit(1);
}
let cli;
try { cli = await import("../src/cli.ts"); }
catch (error) {
  if (error instanceof Error && error.code === "VMEM_HOST_API_INCOMPATIBLE") console.error(`vmem: ${error.message}`);
  else console.error(error);
  process.exit(1);
}
const { main, mainAsync, reportError, runMcp } = cli;
const { textOptions, takeColorFlag } = await import("../src/text-output.ts");
const argv = process.argv.slice(2);
// `--color=` may stand anywhere, so the dispatch looks at the words without it; main/mainAsync take it off again.
let words;
try { const taken = takeColorFlag(argv); textOptions(taken.color, process.env); words = taken.args; }
catch (error) { process.exit(reportError(error, argv)); }
if (words.length === 1 && words[0] === "mcp") {
  try { await runMcp(); }
  catch (error) { console.error(`vmem mcp: ${error instanceof Error ? error.message : "failed"}`); process.exitCode = 1; }
} else if (words[0] === "promote-from-amem" || words[0] === "skills") process.exitCode = await mainAsync(argv);
else process.exitCode = main(argv);
