import { mock } from "bun:test";
const [home, source, state] = process.argv.slice(2);
if (!home || !source || !state) throw new Error("synthetic promotion receipt needs home/source/state");
const result = { ok: false, applied: state === "applied", issues: [{ code: "SYNTHETIC", severity: "error", message: "synthetic post-publication or pre-write failure; inspect the receipt before retrying" }] };
mock.module("../../src/org-promote.ts", () => ({ promoteToOrg: () => result }));
mock.module("../../src/promote.ts", () => ({ promoteFromAmem: async () => result }));
const { createVaultMcp } = await import("../../src/mcp-vault.ts");
const mcp = createVaultMcp(home, process.env);
const reply = source === "org"
  ? await mcp.handlers.vmem_promote!({ path: "alpha", to: "team", confirm: true, fingerprint: "f".repeat(64) })
  : await mcp.handlers.vmem_promote_from_amem!({ id: "a".repeat(32), project: "synthetic", confirm: true, fingerprint: "f".repeat(64) });
console.log(JSON.stringify(reply));
