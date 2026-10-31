const home = process.argv[2];
if (!home) throw new Error("fixture home required");
const { VaultIndex } = await import("../../src/vault-index.ts");
const scan = VaultIndex.prototype.scan;
let injected = false;
VaultIndex.prototype.scan = function(...args) {
  if (!injected) { injected = true; throw new Error("injected index refresh failure"); }
  return scan.apply(this, args);
};
const { applyWrite } = await import("../../src/writer.ts");
console.log(JSON.stringify(applyWrite(home, {
  vault: "test",
  operation: { op: "report", path: "ops/large.md", text: "Synthetic replacement.\n".repeat(110000) },
  log: false,
})));
