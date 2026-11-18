export {};
const [home, id, fingerprint] = process.argv.slice(2);
if (!home || !id || !fingerprint) throw new Error("fixture arguments required");
const { applyProposal } = await import("../../src/proposal-provider.ts");
try { console.log(JSON.stringify(applyProposal(home, { vault: "test", id, fingerprint }, { channel: "mcp" }))); }
catch (error) { console.log(JSON.stringify({ applied: false, error: error instanceof Error ? error.message : "operation failed" })); }
