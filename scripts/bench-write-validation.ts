import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { ValidationContext, WriteIssue } from "../src/write-types.ts";
import { createWriteValidator } from "../src/write-validation.ts";
import { stampContentChanges } from "../src/write-operations.ts";

const values = new Map<string, string>();
const baselineAdvice = "generate the pre-change module with git show <before-commit>:src/write-validation.ts > src/.bench-write-validation-before.ts, then pass --baseline-module src/.bench-write-validation-before.ts";
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]!, value = process.argv[i + 1];
  if (!["--baseline-module", "--baseline-ref", "--notes", "--repetitions"].includes(key) || value === undefined || values.has(key)) throw new Error(`benchmark: unknown/repeated option or missing value for ${key}; use --baseline-module PATH [--baseline-ref SHA] [--notes 2..10000] [--repetitions 1..25]`);
  values.set(key, value);
}
const baselineArgument = values.get("--baseline-module");
if (!baselineArgument) throw new Error(`benchmark: missing --baseline-module for the actual pre-change validation module; ${baselineAdvice}`);
const count = Number(values.get("--notes") ?? 5000), repetitions = Number(values.get("--repetitions") ?? 5);
if (!Number.isInteger(count) || count < 2 || count > 10000 || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 25) throw new Error("benchmark: invalid note count or repetition count; choose --notes 2..10000 and --repetitions 1..25");
const baselinePath = resolve(baselineArgument);
if (baselinePath === resolve(import.meta.dir, "../src/write-validation.ts")) throw new Error(`benchmark: current optimized validation is not a pre-change baseline; ${baselineAdvice}`);
type Baseline = { validateWrite?: (changes: import("../src/write-types.ts").PlannedChange[], context: ValidationContext) => WriteIssue[] };
let before: Baseline;
try { before = await import(pathToFileURL(baselinePath).href) as Baseline; }
catch (error) { throw new Error(`benchmark: baseline module could not load; ${baselineAdvice}`, { cause: error }); }
if (typeof before.validateWrite !== "function") throw new Error(`benchmark: baseline module does not export validateWrite; ${baselineAdvice}`);
const notes = new Map<string, string>([["notes/research.md", "---\ntype: moc\ndescription: Synthetic benchmark directory.\n---\n# Research\n"]]);
for (let i = 0; i < count - 1; i++) {
  const name = `note-${String(i).padStart(5, "0")}`, next = `note-${String((i + 1) % (count - 1)).padStart(5, "0")}`;
  const debt = i % 23 === 0 ? `\n\nLegacy [[missing-${i}]].` : "";
  notes.set(`notes/${name}.md`, `---\ntitle: Fixture ${i}\ndescription: Distinct synthetic benchmark evidence.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\nsource: mem:benchmark-${i}\n---\n# Fixture ${i}\n\nOriginal evidence for ${i}. See [[${next}]].${debt}\n\n## Topics\n\n- [[research]]\n`);
}
const vault = { id: "benchmark", path: "/synthetic/validation-benchmark", kind: "personal" as const, write: "mcp" as const, pii: "allow" as const };
const operation = { op: "patch" as const, path: "note-00000", oldString: "Original evidence for 0.", newString: "Edited evidence for 0." };
const context: ValidationContext = { vault, config: { vaults: [vault] }, notes, operation };
const original = notes.get("notes/note-00000.md")!;
const raw = [{ path: "notes/note-00000.md", before: original, after: original.replace(operation.oldString, operation.newString) }];
const stamped = stampContentChanges(operation, raw, "2026-01-02");
const oldPair = () => [before.validateWrite!(raw, context), before.validateWrite!(stamped, context)];
const newPair = () => { const validate = createWriteValidator(context); return [validate(raw), validate(stamped)]; };
const expected = JSON.stringify(oldPair());
if (JSON.stringify(newPair()) !== expected) throw new Error("benchmark: session results diverge from the exact baseline; fix validation parity before comparing timing");
const times = { before: [] as number[], session: [] as number[] };
function measure(kind: keyof typeof times, run: () => WriteIssue[][]): void {
  const start = performance.now(), result = run(); times[kind].push(performance.now() - start);
  if (JSON.stringify(result) !== expected) throw new Error(`benchmark: ${kind} results changed; resolve semantic parity before reporting measurements`);
}
for (let i = 0; i < repetitions; i++) {
  if (i % 2) { measure("session", newPair); measure("before", oldPair); }
  else { measure("before", oldPair); measure("session", newPair); }
}
const median = (list: number[]) => { const sorted = [...list].sort((a, b) => a - b), at = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[at]! : (sorted[at - 1]! + sorted[at]!) / 2; };
const milliseconds = (value: number) => Math.round(value * 1000) / 1000;
const oldMedian = median(times.before), newMedian = median(times.session);
console.log(JSON.stringify({ baselineModule: relative(process.cwd(), baselinePath), baselineRef: values.get("--baseline-ref") ?? null,
  notes: notes.size, inputBytes: [...notes.values()].reduce((sum, source) => sum + Buffer.byteLength(source), 0), repetitions,
  workload: "one raw plus one stamped validation; session construction included", semanticParity: true, issuesPerPass: JSON.parse(expected).map((issues: WriteIssue[]) => issues.length),
  beforeMedianMs: milliseconds(oldMedian), sessionMedianMs: milliseconds(newMedian), speedup: milliseconds(oldMedian / newMedian),
  beforeMs: times.before.map(milliseconds), sessionMs: times.session.map(milliseconds) }, null, 2));
