export {};
const [home, raw] = process.argv.slice(2);
if (!home || !raw) throw new Error("fixture arguments required");
const { submitProposal } = await import("../../src/proposal-provider.ts");
try { console.log(JSON.stringify(submitProposal(home, { vault: "test", operation: JSON.parse(raw) }, { channel: "mcp" }))); }
catch (error) { console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "operation failed" })); }
