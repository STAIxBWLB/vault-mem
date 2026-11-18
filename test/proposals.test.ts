import { expect, test } from "bun:test";
import { checkProposalRpcSize, MAX_PROPOSAL_RPC_BYTES, parseProposalOperation, proposalRpcBytes } from "../src/proposals.ts";

test("proposal operations admit only one normalized note and bounded exact edits", () => {
  expect(parseProposalOperation({ op: "create", path: "synthetic", frontmatter: { type: "insight" }, body: "한글" })).toEqual({ op: "create", path: "notes/synthetic.md", frontmatter: { type: "insight" }, body: "한글" });
  const patch = { op: "patch" as const, path: "notes/synthetic.md", expectedSha: "a".repeat(64), edits: [{ oldString: "before", newString: "after" }] };
  expect(parseProposalOperation(patch)).toEqual(patch);
  expect(() => parseProposalOperation({ ...patch, expectedSha: "bad" })).toThrow("base SHA");
  expect(() => parseProposalOperation({ ...patch, edits: Array(33).fill(patch.edits[0]) })).toThrow("1..32");
  expect(() => parseProposalOperation({ ...patch, path: "../other" })).toThrow();
  expect(() => parseProposalOperation({ ...patch, arbitrary: true })).toThrow();
  expect(() => parseProposalOperation({ op: "delete", path: "synthetic" })).toThrow("unsupported operation");
  expect(() => parseProposalOperation({ op: "create", path: "synthetic", frontmatter: {}, body: "가".repeat(12000) })).toThrow("32 KiB");
});

test("request bound counts actual JSON escaping and UTF-8 envelope bytes", () => {
  const request = { jsonrpc: "2.0", id: 1, method: "vmem_proposal_submit", params: { body: '한글 " \\'.repeat(100) } };
  expect(proposalRpcBytes(request)).toBe(Buffer.byteLength(JSON.stringify(request), "utf8") + 1);
  expect(proposalRpcBytes(request)).toBeGreaterThan(Buffer.byteLength(request.params.body, "utf8"));
  expect(() => checkProposalRpcSize({ ...request, params: { body: '"'.repeat(MAX_PROPOSAL_RPC_BYTES / 2) } })).toThrow("48 KiB");
});
