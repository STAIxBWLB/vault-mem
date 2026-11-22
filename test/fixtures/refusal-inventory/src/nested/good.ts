// Synthetic refusal messages that name existing commands, options and tools; never imported.
export function good(id: string): never {
  if (id === "a") throw new Error(`spec ${id}: refused; see vmem spec grep --help, then vmem specs remove <id> [--confirm]`);
  throw new Error("refused; " + "run vmem help assertions purge or call vmem_assertions_purge");
}
