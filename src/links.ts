export interface Link {
  target: string;
  label: string | null;
  heading: string | null;
  block: string | null;
  embed: boolean;
  /** One-based line in the body, excluding frontmatter delimiters and YAML. */
  line: number;
}
export interface LinkNote { path: string; title: string; aliases: string[]; body: string }
export interface ResolvedLink extends Link {
  source: string;
  resolved: string | null;
  reason: "missing-note" | "ambiguous-note" | "missing-heading" | "missing-block" | null;
}
export function normalizeTarget(value: string): string { return value.normalize("NFC").toLowerCase(); }
/** Preserve line positions while hiding fenced code, including unclosed fences. */
export function proseLines(body: string): string[] {
  let fence: { char: string; size: number } | undefined;
  return body.split(/\r?\n/).map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1]![0] === fence.char && match[1]!.length >= fence.size && !match[2]!.trim()) fence = undefined;
      return "";
    }
    if (match && !(match[1]![0] === "`" && match[2]!.includes("`"))) {
      fence = { char: match[1]![0]!, size: match[1]!.length };
      return "";
    }
    return line;
  });
}
function escapedAt(text: string, offset: number): boolean {
  let slashes = 0;
  for (let i = offset - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}
/** Mask matched inline code spans across lines, retaining offsets and line numbers. */
function maskInlineCode(body: string): string {
  const runs = [...body.matchAll(/`+/g)];
  const next = new Map<number, number>(), closing = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const size = runs[i]![0].length, match = next.get(size);
    if (match !== undefined) closing.set(i, match);
    next.set(size, i);
  }
  const parts: string[] = [];
  let offset = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!, start = run.index!;
    // Backslashes escape opening delimiters, but have no escape meaning inside code.
    if (escapedAt(body, start)) continue;
    const endIndex = closing.get(i);
    if (endIndex === undefined) continue; // Unmatched backticks remain literal Markdown.
    const end = runs[endIndex]!.index! + runs[endIndex]![0].length;
    parts.push(body.slice(offset, start), body.slice(start, end).replace(/[^\r\n]/g, " "));
    offset = end;
    i = endIndex;
  }
  parts.push(body.slice(offset));
  return parts.join("");
}
export function extractLinks(body: string): Link[] {
  const links: Link[] = [];
  for (const [index, line] of maskInlineCode(proseLines(body).join("\n")).split("\n").entries()) {
    for (const match of line.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
      if (escapedAt(line, match.index!)) continue;
      const [address, ...labels] = match[2]!.split("|");
      const hash = address!.indexOf("#");
      const target = (hash < 0 ? address! : address!.slice(0, hash)).trim();
      const anchor = hash < 0 ? null : address!.slice(hash + 1).trim();
      links.push({ target, label: labels.length ? labels.join("|") : null,
        heading: anchor && !anchor.startsWith("^") ? anchor : null,
        block: anchor?.startsWith("^") ? anchor.slice(1) : null, embed: match[1] === "!", line: index + 1 });
    }
  }
  return links;
}
function noteKey(value: string): string {
  return normalizeTarget(value.replace(/^\.\//, "").replace(/^notes\//i, "").replace(/\.md$/i, ""));
}
function anchorIndex(body: string): { headings: Set<string>; blocks: Set<string> } {
  const lines = proseLines(body), headings = new Set<string>(), blocks = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, atx = /^ {0,3}#{1,6}([ \t]+.*|)$/.exec(line);
    if (atx) headings.add(normalizeTarget(atx[1]!.replace(/[ \t]+#+[ \t]*$/, "").trim()));
    if (i > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(line) && lines[i - 1]!.trim()) headings.add(normalizeTarget(lines[i - 1]!.trim()));
    const block = /(?:^|\s)\^([\w-]+)\s*$/.exec(line);
    if (block) blocks.add(normalizeTarget(block[1]!));
  }
  return { headings, blocks };
}
export function resolveLinks(notes: LinkNote[]): ResolvedLink[] {
  const names = new Map<string, Set<LinkNote>>();
  const anchors = new Map<LinkNote, ReturnType<typeof anchorIndex>>();
  for (const note of notes) {
    anchors.set(note, anchorIndex(note.body));
    for (const name of [note.path, ...note.aliases]) {
      const key = noteKey(name), candidates = names.get(key) ?? new Set<LinkNote>();
      candidates.add(note); names.set(key, candidates);
    }
  }
  const result: ResolvedLink[] = [];
  for (const note of notes) for (const link of extractLinks(note.body)) {
    const candidates = link.target ? [...(names.get(noteKey(link.target)) ?? [])] : [note];
    const target = candidates.length === 1 ? candidates[0]! : undefined;
    let reason: ResolvedLink["reason"] = candidates.length > 1 ? "ambiguous-note" : target ? null : "missing-note";
    if (target && link.heading && !anchors.get(target)!.headings.has(normalizeTarget(link.heading))) reason = "missing-heading";
    if (target && link.block && !anchors.get(target)!.blocks.has(normalizeTarget(link.block))) reason = "missing-block";
    result.push({ ...link, source: note.path, resolved: reason ? null : target!.path, reason });
  }
  return result;
}
