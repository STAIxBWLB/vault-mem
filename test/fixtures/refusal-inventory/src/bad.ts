// Synthetic refusal messages for the refusal inventory test; never imported.
class UsageError extends Error {}
class Refusal extends Error { constructor(readonly issues: { message: string }[]) { super(""); } }
export function bad(kind: string): never {
  if (kind === "command") throw new UsageError("frob: refused; run vmem frobnicate <vault> to retry");
  if (kind === "flag") throw new Error(`search: refused; use vmem search ${kind} --no-such-flag`);
  if (kind === "tool") throw new Refusal([{ message: "write refused; call vmem_no_such_tool instead" }]);
  throw new Error("fine: reinstall a complete vmem package, or use vmem status --json and vmem_status");
}
