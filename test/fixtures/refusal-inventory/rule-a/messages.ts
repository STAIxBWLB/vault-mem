// Synthetic refusal messages for rule A; never imported.
export function messages(kind: string): never {
  if (kind === "bare") throw new Error("widget: refused");
  if (kind === "next") throw new Error("widget: refused; retry with a smaller widget");
  if (kind === "rules") throw new Error("V01, V09: widget rules violated");
  if (kind === "rules-retry") throw new Error("V01: widget rule violated; retry with vmem check <vault> <file>");
  // refusal: human-authority
  if (kind === "marked") throw new Error("widget: needs the owner");
  if (kind === "known") throw new Error("widget: listed in the baseline");
  throw new Error(`widget: ${kind}`);
}
