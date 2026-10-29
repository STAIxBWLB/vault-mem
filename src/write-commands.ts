import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { canonicalPath, isDenied } from "./platform.ts";
import { loadRegistry } from "./registry.ts";
import { basename } from "node:path";
import { applyWrite, MAX_WRITE_BYTES } from "./writer.ts";
import { notePath } from "./write-operations.ts";
import type { WriteOp, WriteRequest } from "./write-types.ts";
const COMMANDS = new Set(["new", "patch", "append", "frontmatter", "link", "supersede", "move", "delete", "tidy", "report", "check"]);
export function isWriteCommand(command: string): boolean { return COMMANDS.has(command); }
function object(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${label}: invalid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected object`);
  return value as Record<string, unknown>;
}
function input(file: string, home: string): string {
  if (file !== "-" && isDenied(canonicalPath(file), loadRegistry(home).denyPaths)) throw new Error("V06: input path denied");
  const fd = file === "-" ? 0 : openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (file !== "-" && (!stat.isFile() || stat.size > MAX_WRITE_BYTES)) throw new Error("input: expected regular file <=256 KiB");
    const buffer = Buffer.alloc(MAX_WRITE_BYTES + 1); let size = 0;
    while (size < buffer.length) { const count = readSync(fd, buffer, size, buffer.length - size, null); if (!count) break; size += count; }
    if (size > MAX_WRITE_BYTES) throw new Error("input: exceeds 256 KiB");
    const bytes = buffer.subarray(0, size), text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) throw new Error("input: invalid UTF-8");
    return text;
  } finally { if (file !== "-") closeSync(fd); }
}
export function runWriteCommand(command: string, args: string[], home: string): { text: string; code: number } {
  const valueOptions: Record<string, string[]> = {
    new: ["--type", "--domain", "--topics", "--description", "--title", "--source", "--confidence", "--status", "--extra", "--body"],
    patch: ["--old", "--new", "--expected-sha"], append: ["--section", "--markdown", "--expected-sha"],
    frontmatter: ["--set", "--unset", "--expected-sha"], link: ["--relation", "--context"],
    move: ["--fingerprint"], delete: ["--fingerprint"], tidy: ["--fingerprint"], report: ["--body"], check: ["--path"], supersede: [],
  };
  const values = valueOptions[command];
  if (!values) throw new Error("unknown writer command");
  const twoStep = ["move", "delete", "tidy"].includes(command);
  const booleans = ["--json", "--dry-run", ...(twoStep ? ["--confirm"] : []), ...(command === "link" ? ["--one-way"] : []), ...(command === "tidy" ? ["--connections"] : [])];
  const flags: Record<string, string | boolean> = {}, positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (Object.hasOwn(flags, arg) || (!values.includes(arg) && !booleans.includes(arg))) throw new Error(`${command}: unknown or repeated option`);
    if (booleans.includes(arg)) flags[arg] = true;
    else {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg}: value required`);
      flags[arg] = value;
    }
  }
  const required = (name: string): string => { if (typeof flags[name] !== "string") throw new Error(`${name}: required`); return flags[name] as string; };
  const optional = (name: string): string | undefined => typeof flags[name] === "string" ? flags[name] as string : undefined;
  const count = ["move", "link", "supersede"].includes(command) ? 3 : command === "tidy" ? 1 : 2;
  if (positional.length !== count) throw new Error(`${command}: requires vault id${count > 1 ? " and target(s)" : ""}`);
  const vault = positional[0]!, target = positional[1]!;
  let operation: WriteOp;
  switch (command) {
    case "new": {
      const frontmatter = optional("--extra") ? object(required("--extra"), "extra") : {};
      for (const key of ["type", "domain", "description", "title", "source", "confidence", "status"]) if (optional(`--${key}`) !== undefined) frontmatter[key] = optional(`--${key}`);
      if (optional("--topics") !== undefined) frontmatter.topics = required("--topics").split(",").filter(Boolean).map(value => value.startsWith("[[") ? value : `[[${value}]]`);
      operation = { op: "create", path: target, frontmatter, ...(optional("--body") ? { body: input(required("--body"), home) } : {}) }; break;
    }
    case "patch": operation = { op: "patch", path: target, oldString: required("--old"), newString: required("--new"), expectedSha: optional("--expected-sha") }; break;
    case "append": operation = { op: "append", path: target, section: required("--section"), markdown: required("--markdown"), expectedSha: optional("--expected-sha") }; break;
    case "frontmatter": operation = { op: "frontmatter", path: target, set: optional("--set") ? object(required("--set"), "set") : {}, unset: optional("--unset")?.split(","), expectedSha: optional("--expected-sha") }; break;
    case "link": operation = { op: "link", from: target, to: positional[2]!, relation: required("--relation") as Extract<WriteOp, { op: "link" }>["relation"], context: optional("--context"), bidirectional: !flags["--one-way"] }; break;
    case "supersede": operation = { op: "supersede", old: target, next: positional[2]! }; break;
    case "move": operation = { op: "move", from: target, to: positional[2]! }; break;
    case "delete": operation = { op: "delete", path: target }; break;
    case "tidy": operation = { op: "tidy" }; break;
    case "report": operation = { op: "report", path: target, text: input(required("--body"), home) }; break;
    case "check": operation = { op: "check", path: notePath(optional("--path") ?? (target === "-" ? "checked-note" : basename(target))), text: input(target, home) }; break;
    default: throw new Error("unknown writer command");
  }
  const request: WriteRequest = { vault, operation, channel: "cli", dryRun: flags["--dry-run"] === true, confirm: flags["--confirm"] === true, fingerprint: optional("--fingerprint") };
  const result = applyWrite(home, request);
  return { text: JSON.stringify(result, null, flags["--json"] ? undefined : 2), code: result.ok ? 0 : 1 };
}
