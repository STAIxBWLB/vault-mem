#!/usr/bin/env -S bun --smol
const version = /^(\d+)\.(\d+)\.(\d+)/.exec(process.versions.bun ?? "");
if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && (Number(version[2]) < 4 || (Number(version[2]) === 4 && Number(version[3]) < 2)))) {
  console.error("vmem: Bun >=1.4.2 is required. Install Bun: https://bun.sh");
  process.exit(1);
}
const { main, mainAsync, runMcp } = await import("../src/cli.ts");
if (process.argv.length === 3 && process.argv[2] === "mcp") {
  try { await runMcp(); }
  catch (error) { console.error(`vmem mcp: ${error instanceof Error ? error.message : "failed"}`); process.exitCode = 1; }
} else if (process.argv[2] === "promote-from-amem" || process.argv[2] === "skills") process.exitCode = await mainAsync(process.argv.slice(2));
else process.exitCode = main(process.argv.slice(2));
