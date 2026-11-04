import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { VaultSpec } from "./config.ts";
import { isDenied } from "./platform.ts";
import { MAX_NOTE_BYTES, MAX_READ_BYTES, MAX_RESULTS, readPage } from "./vault-index.ts";

/** Vault paths readable outside notes/: these directories and root files. Reads never lock, index or write. */
export const FILE_ROOTS = ["ops/", "reports/", "self/", "templates/", "AGENTS.md", "README.md"] as const;
const DIRS = new Set(["ops", "reports", "self", "templates"]), FILES = new Set(["AGENTS.md", "README.md"]);
const ROOTS = "ops/, reports/, self/, templates/, AGENTS.md or README.md";
function fail(message: string, code = "V04"): never { throw Object.assign(new Error(message), { code }); }

/** Checks `path` against the allowed roots and returns its location; every component must be a plain directory or file. */
function locate(vault: VaultSpec, denyPaths: string[], path: string, kind: "file" | "dir"): string {
  const parts = path.split("/");
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || parts.some(part => !part || part === "." || part === ".."))
    fail(`path: absolute, empty, . or .. segments are refused; pass a vault-relative path under ${ROOTS}`);
  if (parts.some(part => part.startsWith("."))) fail(`path: dot paths such as .git are not readable through vmem; read a path under ${ROOTS}`);
  if (parts[0] === "notes") fail("path: notes/ is read with vmem_read or vmem_read_many and listed with vmem_list");
  if (parts[0] === "log") fail("path: the vault log is read with vmem_log_tail");
  if (!(DIRS.has(parts[0]!) || (kind === "file" && parts.length === 1 && FILES.has(parts[0]!))))
    fail(`path: outside the readable roots; use a path under ${ROOTS}`);
  const root = realpathSync(vault.path);
  if (root !== vault.path) fail(`vault ${vault.id}: registered path changed; re-register it with vmem vaults add and restart the MCP server`);
  if (isDenied(join(root, path), denyPaths)) fail("path: denied by the built-in secret rules or registry denyPaths; nothing read", "V06");
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(`path: not found; list the parent directory with vmem_list_files`); throw error; }
    // ponytail: every link is refused, not only links leaving the vault; matches the writer's plain-path rule.
    if (stat.isSymbolicLink()) fail("path: symlinked components are refused because a link can leave the vault; read the link target's own vault path");
    const last = i === parts.length - 1, wantDir = !last || kind === "dir";
    if (wantDir ? !stat.isDirectory() : !stat.isFile()) fail(wantDir ? "path: not a directory; list its parent with vmem_list_files" : "path: not a regular file; list it with vmem_list_files");
  }
  return current;
}

/** Bounded UTF-8 read with vmem_read's limits and paging: maxBytes 1..64 KiB, files up to 2 MiB, byte offsets on character boundaries. */
export function readVaultFile(vault: VaultSpec, denyPaths: string[], path: string, maxBytes = 16384, offset?: number) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) fail(`max-bytes: expected integer 1..${MAX_READ_BYTES}`);
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_NOTE_BYTES)) fail(`offset: expected integer 0..${MAX_NOTE_BYTES}`);
  const fd = openSync(locate(vault, denyPaths, path, "file"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) fail("path: not a regular file; list it with vmem_list_files");
    if (before.size > MAX_NOTE_BYTES) fail(`file: exceeds the ${MAX_NOTE_BYTES}-byte read bound; read it outside vmem or split it`, "V09");
    const buffer = Buffer.alloc(before.size + 1); let size = 0;
    while (size < buffer.length) { const count = readSync(fd, buffer, size, buffer.length - size, null); if (!count) break; size += count; }
    const after = fstatSync(fd);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail("file: changed during read; retry once it is stable", "V09");
    bytes = buffer.subarray(0, size);
  } finally { closeSync(fd); }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) fail("file: not valid UTF-8 text; vmem_read_file reads text files only", "V01");
  const start = offset ?? 0, page = readPage(bytes.subarray(start, start + maxBytes + 4), maxBytes, start, bytes.length);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), truncated: page.truncated, body: page.content,
    ...(offset !== undefined ? { offset } : {}), ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}) };
}

/** One directory level under an allowed root, sorted by name; dot, linked, special and denied entries are left out. */
export function listVaultFiles(vault: VaultSpec, denyPaths: string[], dir: string) {
  const clean = dir.replace(/\/$/, ""), location = locate(vault, denyPaths, clean, "dir");
  // ponytail: readdirSync loads the whole directory before the 500-entry cut; stream with opendir if vault dirs grow huge.
  const entries = readdirSync(location, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith(".") && (entry.isFile() || entry.isDirectory()) && !isDenied(join(location, entry.name), denyPaths))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { dir: clean, truncated: entries.length > MAX_RESULTS, entries: entries.slice(0, MAX_RESULTS).map(entry => entry.isDirectory()
    ? { name: entry.name, path: `${clean}/${entry.name}`, type: "dir" as const }
    : { name: entry.name, path: `${clean}/${entry.name}`, type: "file" as const, bytes: lstatSync(join(location, entry.name)).size }) };
}
