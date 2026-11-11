import { mock } from "bun:test";
import type { WriteReceipt } from "../../src/write-types.ts";
const [home, source, state] = process.argv.slice(2);
if (!home || !source || !state) throw new Error("synthetic promotion receipt needs home/source/state");
const writer = await import("../../src/writer.ts");
const originalApply = writer.applyWrite;
let injected = false;
mock.module("../../src/writer.ts", () => ({ ...writer, applyWrite: (...args: Parameters<typeof originalApply>): WriteReceipt => {
  const request = args[1];
  if (request.dryRun || injected) return originalApply(...args);
  const issue = { code: "SYNTHETIC", severity: "error" as const, message: "synthetic cleanup failure; inspect the applied receipt before recovery" };
  injected = true;
  if (state === "refused") return { ok: false, applied: false, issues: [issue], changes: [], indexUpdated: false };
  const result = originalApply(...args);
  if (!result.applied) throw new Error(`synthetic promotion did not publish: ${JSON.stringify(result.issues)}`);
  return { ...result, ok: false, issues: [...result.issues, issue] };
} }));
// Keep real promotion planning, preview fingerprints, publication and adapters. Only the external memory source is synthetic.
mock.module("../../src/amem/seam.ts", () => ({ preloadAmem: async () => {}, openAmem: async () => ({
  project: "synthetic", entry: async () => ({ id: "a".repeat(32), project: "synthetic", kind: "decision", title: "Synthetic Amem Promotion", text: "Synthetic durable method with stable identity.", about: [], at: "2026-11-11T00:00:00Z" }),
  linkedPath: () => undefined, recordLink: async (_id: string, path: string) => path, close() {},
}) }));
const { createVaultMcp } = await import("../../src/mcp-vault.ts");
const mcp = createVaultMcp(home, process.env);
const tool = source === "org" ? "vmem_promote" : "vmem_promote_from_amem";
const args = source === "org" ? { path: "alpha", to: "team" } : { id: "a".repeat(32), project: "synthetic", domain: "research", topics: ["research"], stem: "amem-promotion" };
const preview = await mcp.handlers[tool]!({ ...args }) as Record<string, unknown>;
if (preview.ok !== true || typeof preview.fingerprint !== "string") throw new Error(`synthetic promotion preview failed: ${JSON.stringify(preview)}`);
const reply = await mcp.handlers[tool]!({ ...args, confirm: true, fingerprint: preview.fingerprint }) as Record<string, unknown>;
const { PLAIN } = await import("../../src/text-output.ts");
const { renderPromote, renderOrgPromote } = await import("../../src/write-output.ts");
const text = source === "org"
  ? renderOrgPromote(reply as unknown as Parameters<typeof renderOrgPromote>[0], PLAIN, { argv: ["promote"], positional: ["promote", "alpha", "team"] })
  : renderPromote(reply as unknown as Parameters<typeof renderPromote>[0], PLAIN, { argv: ["promote-from-amem"], positional: ["promote-from-amem", "a".repeat(32)] });
console.log(JSON.stringify({ reply, text, injected }));
