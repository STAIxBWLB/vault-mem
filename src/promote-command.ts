import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "./registry.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { MAX_WRITE_BYTES } from "./writer.ts";
import { listPromotionCandidates, promoteFromAmem, type PromoteRequest } from "./promote.ts";

const VALUES = ["--project", "--limit", "--stem", "--type", "--domain", "--topics", "--description", "--title", "--body", "--link-to", "--log-project", "--fingerprint"];
const BOOLEANS = ["--all-projects", "--edit", "--confirm", "--json"];
function readBody(file: string, home: string): string {
  if (file !== "-" && isDenied(canonicalPath(file), loadRegistry(home).denyPaths)) throw new Error("V06: body path denied");
  const fd = file === "-" ? 0 : openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (file !== "-" && (!fstatSync(fd).isFile() || fstatSync(fd).size > MAX_WRITE_BYTES)) throw new Error("body: expected regular file <=256 KiB");
    const buffer = Buffer.alloc(MAX_WRITE_BYTES + 1); let size = 0;
    while (size < buffer.length) { const n = readSync(fd, buffer, size, buffer.length - size, null); if (!n) break; size += n; }
    if (size > MAX_WRITE_BYTES) throw new Error("body: exceeds 256 KiB");
    const bytes = buffer.subarray(0, size), text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) throw new Error("body: invalid UTF-8");
    return text;
  } finally { if (file !== "-") closeSync(fd); }
}
/** Optional editor branch: the only place that looks at whether stdin is a terminal. */
function editBody(draft: string, env: NodeJS.ProcessEnv, stdinIsTTY: boolean): string | undefined {
  const editor = env.VISUAL?.trim() || env.EDITOR?.trim();
  if (!stdinIsTTY || !editor) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "vmem-promote-")), file = join(dir, "note.md");
  try {
    writeFileSync(file, draft, { mode: 0o600 });
    const result = spawnSync(editor, [file], { stdio: "inherit", shell: false });
    if (result.status !== 0) throw new Error("editor exited with an error; nothing promoted");
    return readFileSync(file, "utf8");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
/** `vmem promote-from-amem <vault> [<mem-id>] ...`: lists candidates, previews, or confirms one promotion. */
export async function runPromoteCommand(args: string[], home: string, env: NodeJS.ProcessEnv, io: { stdinIsTTY?: boolean } = {}): Promise<{ text: string; code: number }> {
  const flags: Record<string, string | boolean> = {}, positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (Object.hasOwn(flags, arg) || (!VALUES.includes(arg) && !BOOLEANS.includes(arg))) throw new Error(`promote-from-amem: unknown or repeated option ${arg}`);
    if (BOOLEANS.includes(arg)) { flags[arg] = true; continue; }
    const value = args[++i];
    if (value === undefined || (value.startsWith("--") && value !== "-")) throw new Error(`${arg}: value required`);
    flags[arg] = value;
  }
  const value = (name: string) => typeof flags[name] === "string" ? flags[name] as string : undefined;
  const format = (result: unknown) => JSON.stringify(result, null, flags["--json"] ? undefined : 2);
  if (positional.length < 1 || positional.length > 2) throw new Error("promote-from-amem: requires vault id and optional mem id");
  const [vault, rawId] = positional as [string, string | undefined];
  if (!loadRegistry(home).vaults.some(v => v.id === vault)) throw new Error("promote-from-amem: unknown vault id");
  if (rawId === undefined) {
    if (flags["--all-projects"] && value("--project")) throw new Error("choose either --all-projects or --project");
    const limit = value("--limit") === undefined ? undefined : /^[0-9]+$/.test(value("--limit")!) ? Number(value("--limit")) : NaN;
    const list = await listPromotionCandidates({ env, allProjects: flags["--all-projects"] === true, ...(value("--project") ? { project: value("--project") } : {}), ...(limit !== undefined ? { limit } : {}), piiPatterns: loadRegistry(home).piiPatterns });
    return { text: format(list), code: 0 };
  }
  if (flags["--all-projects"]) throw new Error("--all-projects lists candidates only");
  const request: PromoteRequest = { vault, id: rawId.replace(/^mem:/, ""), channel: "cli", confirm: flags["--confirm"] === true };
  for (const [flag, key] of [["--stem", "stem"], ["--type", "type"], ["--domain", "domain"], ["--description", "description"], ["--title", "title"], ["--link-to", "linkTo"], ["--log-project", "logProject"], ["--fingerprint", "fingerprint"]] as const) {
    if (value(flag) !== undefined) (request as unknown as Record<string, unknown>)[key] = value(flag);
  }
  if (value("--topics") !== undefined) request.topics = value("--topics")!.split(",").map(t => t.trim()).filter(Boolean);
  if (value("--body") !== undefined) request.body = readBody(value("--body")!, home);
  const options = { env, ...(value("--project") ? { project: value("--project") } : {}) };
  // The editor runs on the preview only; confirm always uses exactly what the preview showed.
  if (flags["--edit"] && request.body === undefined && !request.confirm) {
    const draft = await promoteFromAmem(home, request, options);
    const edited = draft.text !== undefined ? editBody(draft.text, env, io.stdinIsTTY === true) : undefined;
    if (edited !== undefined) request.body = edited;
  }
  const result = await promoteFromAmem(home, request, options);
  const edited = flags["--edit"] && request.body !== undefined && value("--body") === undefined;
  return { text: format(edited ? { ...result, hint: "edited text is only previewed: save it and confirm with --body <file> and this fingerprint" } : result), code: result.ok ? 0 : 1 };
}
