export interface Link {
  target: string;
  label: string | null;
  heading: string | null;
  block: string | null;
  embed: boolean;
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
export function extractLinks(body: string): Link[] {
  const links: Link[] = [];
  for (const [index, raw] of proseLines(body).entries()) {
    // Inline code is not a link either. Matched runs must use equal delimiters.
    const line = raw.replace(/(`+)[\s\S]*?\1(?!`)/g, "");
    for (const match of line.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
      const preceding = line.slice(0, match.index);
      if ((/\\+$/.exec(preceding)?.[0].length ?? 0) % 2) continue;
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
function headings(body: string): Set<string> {
  const lines = proseLines(body), result = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, atx = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) result.add(normalizeTarget(atx[1]!.trim()));
    if (i > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(line) && lines[i - 1]!.trim()) result.add(normalizeTarget(lines[i - 1]!.trim()));
  }
  return result;
}
export function resolveLinks(notes: LinkNote[]): ResolvedLink[] {
  const names = new Map<string, Set<LinkNote>>();
  for (const note of notes) {
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
    if (target && link.heading && !headings(target.body).has(normalizeTarget(link.heading))) reason = "missing-heading";
    if (target && link.block && !proseLines(target.body).some(line => normalizeTarget(/(?:^|\s)\^([\w-]+)\s*$/.exec(line)?.[1] ?? "") === normalizeTarget(link.block!))) reason = "missing-block";
    result.push({ ...link, source: note.path, resolved: reason ? null : target!.path, reason });
  }
  return result;
}
