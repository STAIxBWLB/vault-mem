export {};
const [home, id, reason, fingerprint] = process.argv.slice(2);
if (!home || !id || !reason || !fingerprint) throw new Error("fixture arguments required");
const { rejectProposal } = await import("../../src/proposal-provider.ts");
try { console.log(JSON.stringify(rejectProposal(home, { vault: "test", id, reason, fingerprint }, { channel: "mcp" }))); }
catch (error) { console.log(JSON.stringify({ rejected: false, error: error instanceof Error ? error.message : "operation failed" })); }
