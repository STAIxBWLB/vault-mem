/** Internal proposal payload contracts. Durable storage and public commands are not available yet. */
import { notePath } from "./write-operations.ts";
import type { PatchEdit, WriteOp } from "./write-types.ts";

export const MAX_PROPOSAL_RECORD_BYTES = 32 * 1024;
export const MAX_PROPOSAL_RPC_BYTES = 48 * 1024;
export const MAX_PROPOSAL_EDITS = 32;
export type ProposalOperation = Extract<WriteOp, { op: "create" | "patch" }>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function jsonBytes(value: unknown): number {
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { throw new Error("proposal: input is not JSON serializable"); }
  if (text === undefined) throw new Error("proposal: input is not JSON serializable");
  return Buffer.byteLength(text, "utf8");
}
/** Measures the complete JSON-RPC frame, including escaping, envelope, and its terminating newline. */
export function proposalRpcBytes(request: unknown): number { return jsonBytes(request) + 1; }
export function checkProposalRpcSize(request: unknown): void {
  if (proposalRpcBytes(request) > MAX_PROPOSAL_RPC_BYTES) throw new Error("proposal: encoded JSON-RPC request exceeds 48 KiB; shorten the proposal");
}
/** Only create and exact-replacement patch operations are admissible, with one canonical flat note target. */
export function parseProposalOperation(value: unknown): ProposalOperation {
  if (!object(value) || typeof value.path !== "string") throw new Error("proposal: expected one create or patch operation and note target");
  if (jsonBytes(value) > MAX_PROPOSAL_RECORD_BYTES) throw new Error("proposal: operation exceeds the 32 KiB record limit; shorten the payload");
  const path = notePath(value.path);
  if (value.op === "create") {
    if (!exactKeys(value, ["op", "path", "frontmatter", "body"]) || !object(value.frontmatter) || (value.body !== undefined && typeof value.body !== "string"))
      throw new Error("proposal: create requires frontmatter and an optional text body; remove unsupported fields");
    return { op: "create", path, frontmatter: value.frontmatter, ...(typeof value.body === "string" ? { body: value.body } : {}) };
  }
  if (value.op === "patch") {
    if (!exactKeys(value, ["op", "path", "edits", "expectedSha"]) || typeof value.expectedSha !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedSha) || !Array.isArray(value.edits) || value.edits.length < 1 || value.edits.length > MAX_PROPOSAL_EDITS)
      throw new Error("proposal: patch requires a base SHA and 1..32 exact edits; correct the patch");
    const edits: PatchEdit[] = value.edits.map(edit => {
      if (!object(edit) || !exactKeys(edit, ["oldString", "newString"]) || typeof edit.oldString !== "string" || !edit.oldString || typeof edit.newString !== "string")
        throw new Error("proposal: each edit needs nonempty oldString and a text newString; correct the patch");
      return { oldString: edit.oldString, newString: edit.newString };
    });
    return { op: "patch", path, edits, expectedSha: value.expectedSha };
  }
  throw new Error("proposal: unsupported operation; choose create or patch");
}
