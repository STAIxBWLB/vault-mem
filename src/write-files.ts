/** Shared path-based publication and descriptor-owned cleanup. These checks narrow races;
 * Node fs cannot make identity checks and namespace mutations one atomic operation. */
import { fstatSync, linkSync, lstatSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";

export class PublicationDrift extends Error {
  constructor(readonly file: string, readonly published = false, readonly targetExists = false) {
    super(`publication path identity or containment changed; ${published
      ? "this step was published; stop concurrent writers, inspect the registered root, target and listed retained backups, restore the original plain parent directories, and recover the recorded write before another mutation"
      : "this step was not published; stop concurrent writers, inspect the registered root and target, restore the original plain parent directories, and review any earlier applied changes before another mutation"}`);
  }
}
export interface PublicationPath { root: string; file: string; parents: { path: string; identity: string }[] }
export type PublicationOperation = { kind: "rename" | "link"; temp: string } | { kind: "unlink" };
const identity = (s: { dev: bigint; ino: bigint }) => `${s.dev}:${s.ino}`;
const within = (root: string, file: string) => { const p = relative(root, file); return p === "" || !isAbsolute(p) && p !== ".." && !p.startsWith(`..${sep}`); };

export function capturePublicationPath(root: string, file: string): PublicationPath {
  if (!within(root, file)) throw new PublicationDrift(file);
  const parents: PublicationPath["parents"] = [];
  for (let parent = dirname(file); ; parent = dirname(parent)) {
    const stat = lstatSync(parent, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !within(root, realpathSync(parent))) throw new PublicationDrift(file);
    parents.push({ path: parent, identity: identity(stat) });
    if (parent === root) break;
    if (dirname(parent) === parent) throw new PublicationDrift(file);
  }
  return { root, file, parents };
}
function checkPublicationPath(path: PublicationPath, deleted: boolean, published = false): void {
  try {
    for (const parent of path.parents) {
      const stat = lstatSync(parent.path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== parent.identity || !within(path.root, realpathSync(parent.path))) throw new PublicationDrift(path.file, published);
    }
    try {
      const stat = lstatSync(path.file);
      if (!stat.isFile() || stat.isSymbolicLink() || !within(path.root, realpathSync(path.file))) throw new PublicationDrift(path.file, published, true);
    } catch (error) { if (!deleted || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } catch (error) {
    if (error instanceof PublicationDrift) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PublicationDrift(path.file, published);
    // A permissions, storage or descriptor failure is not proof that the namespace changed.
    throw error;
  }
}
export function publishFile(path: PublicationPath, operation: PublicationOperation, published: () => void): void {
  // The target may be absent for create; existing-content guards remain the writer's responsibility.
  checkPublicationPath(path, true);
  if (operation.kind === "rename") renameSync(operation.temp, path.file);
  else if (operation.kind === "link") linkSync(operation.temp, path.file);
  else unlinkSync(path.file);
  // Record persisted state before the post-publication guard can fail.
  published();
  checkPublicationPath(path, operation.kind === "unlink", true);
}

/** Caller keeps fd open throughout this call and closes it independently, including on failure. */
export function cleanupOwnedFile(file: string, fd: number): void {
  const owned = fstatSync(fd, { bigint: true }), named = lstatSync(file, { bigint: true });
  if (!owned.isFile() || !named.isFile() || named.isSymbolicLink() || identity(owned) !== identity(named)) {
    throw new Error("owned file identity changed; replacement retained; inspect the temporary or lock path before manual recovery");
  }
  unlinkSync(file);
}
