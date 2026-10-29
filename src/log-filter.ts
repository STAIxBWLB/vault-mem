/** A bounded, non-backtracking grep subset: alternatives, anchors, classes and atom * + ?. */
interface Atom { test: (char: string) => boolean; optional: boolean; repeat: boolean }
interface Branch { atoms: Atom[]; start: boolean; end: boolean }
export function compileLogFilter(pattern: string): (line: string) => boolean {
  if (typeof pattern !== "string" || pattern.length > 256) throw new Error("grep pattern exceeds 256 characters");
  const chars = [...pattern], branches: Branch[] = [];
  let current: Branch = { atoms: [], start: false, end: false };
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    if (char === "|") { branches.push(current); current = { atoms: [], start: false, end: false }; continue; }
    if (char === "^" && current.atoms.length === 0 && !current.start && !current.end) { current.start = true; continue; }
    if (char === "$" && (i === chars.length - 1 || chars[i + 1] === "|")) { current.end = true; continue; }
    if (current.end || "^$()*+?{}]".includes(char)) throw new Error("unsupported grep syntax");
    let expression: string | undefined, literal: string | undefined;
    if (char === "\\") {
      const escaped = chars[++i];
      if (!escaped) throw new Error("incomplete grep escape");
      if (/^[dDsSwW]$/.test(escaped)) expression = `\\${escaped}`;
      else if ("\\.^$|?*+()[]{}-".includes(escaped)) literal = escaped;
      else throw new Error("unsupported grep escape");
    } else if (char === "[") {
      let value = "[", closed = false;
      while (++i < chars.length) {
        const item = chars[i]!; value += item;
        if (item === "\\") {
          const escaped = chars[++i];
          if (!escaped || (!/^[dDsSwW]$/.test(escaped) && !"\\[]^-".includes(escaped))) throw new Error("unsupported class escape");
          value += escaped;
        } else if (item === "]") { closed = true; break; }
      }
      if (!closed) throw new Error("unterminated grep class");
      expression = value;
    } else if (char === ".") expression = ".";
    else literal = char;
    const matcher = expression === undefined ? undefined : new RegExp(`^(?:${expression})$`, "u");
    const atom: Atom = { test: matcher ? value => matcher.test(value) : value => value === literal, optional: false, repeat: false };
    const quantifier = chars[i + 1];
    if (quantifier && "*+?".includes(quantifier)) {
      i++; atom.optional = quantifier !== "+"; atom.repeat = quantifier !== "?";
    }
    current.atoms.push(atom);
  }
  branches.push(current);
  return (line: string) => {
    const text = [...line];
    for (const branch of branches) {
      const atoms = branch.atoms;
      let active = new Uint8Array(atoms.length + 1), next = new Uint8Array(atoms.length + 1);
      for (let position = 0; position <= text.length; position++) {
        if (!branch.start || position === 0) active[0] = 1;
        // Epsilon transitions only move forward; a single pass computes closure.
        for (let i = 0; i < atoms.length; i++) if (active[i] && atoms[i]!.optional) active[i + 1] = 1;
        if (active[atoms.length] && (!branch.end || position === text.length)) return true;
        if (position === text.length) break;
        next.fill(0);
        for (let i = 0; i < atoms.length; i++) if (active[i] && atoms[i]!.test(text[position]!)) {
          next[i + 1] = 1;
          if (atoms[i]!.repeat) next[i] = 1;
        }
        const previous = active; active = next; next = previous;
      }
    }
    return false;
  };
}
