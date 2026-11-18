import { mock } from "bun:test";
import * as fs from "node:fs";
const [home] = process.argv.slice(2);
if (!home) throw new Error("fixture home required");
const original = { ...fs };
mock.module("node:fs", () => ({ ...original,
  linkSync: (...args: Parameters<typeof fs.linkSync>) => {
    if (String(args[1]).endsWith("/binding.json")) throw Object.assign(new Error("synthetic full storage"), { code: "ENOSPC" });
    return original.linkSync(...args);
  },
}));
const { submitProposal } = await import("../../src/proposal-provider.ts");
const operation = { op: "create", path: "proposed", frontmatter: { type: "insight", domain: "research", description: "Synthetic finding.", topics: ["[[research]]"] }, body: "# Proposed\n\nSynthetic body.\n\n## Topics\n\n- [[research]]\n" };
console.log(JSON.stringify(submitProposal(home, { vault: "test", operation }, { channel: "mcp" })));
