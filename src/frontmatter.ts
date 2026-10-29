import { isDeepStrictEqual } from "node:util";

interface FieldSpan { key: string; start: number; end: number }
export interface FrontmatterDocument {
  readonly source: string;
  readonly body: string;
  readonly data: Record<string, unknown>;
  /** Original delimiters and YAML, including their original line endings. */
  readonly frontmatter: string | null;
}
interface ParsedDocument extends FrontmatterDocument {
  start: number;
  end: number;
  newline: string;
  fields: FieldSpan[];
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Locate a block mapping's top-level keys without mistaking quoted/flow content for keys. */
function fieldSpans(yaml: string): FieldSpan[] {
  const fields: FieldSpan[] = [];
  let offset = 0, quote = "", flow = 0;
  let blockIndent: number | null = null;
  for (const line of yaml.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (blockIndent !== null) {
      const indent = line.match(/^[ \t]*/)![0].length;
      if (!line.trim() || indent > blockIndent) { offset += line.length; continue; }
      blockIndent = null;
    }
    if (!quote && !flow && /^[^ \t\r\n#{\[]/.test(line)) {
      let keyQuote = "", colon = -1;
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (keyQuote) {
          if (c === "\\" && keyQuote === '"') { i++; continue; }
          if (c === keyQuote) {
            if (c === "'" && line[i + 1] === "'") { i++; continue; }
            keyQuote = "";
          }
        } else if ((c === '"' || c === "'") && i === 0) keyQuote = c;
        else if (c === ":" && /[ \t\r\n]/.test(line[i + 1] ?? "\n")) { colon = i; break; }
      }
      if (colon >= 0) {
        const parsed: unknown = Bun.YAML.parse(`${line.slice(0, colon)}: null`);
        if (!mapping(parsed) || Object.keys(parsed).length !== 1) throw new Error("frontmatter: expected string mapping key");
        const key = Object.keys(parsed)[0]!;
        if (fields.some(field => field.key === key)) throw new Error("frontmatter: duplicate key");
        fields.push({ key, start: offset, end: yaml.length });
      }
    }
    let nodeStart = !quote && flow === 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (quote) {
        if (c === "\\" && quote === '"') { i++; continue; }
        if (c === quote) {
          if (c === "'" && line[i + 1] === "'") { i++; continue; }
          quote = "";
        }
        continue;
      }
      if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) break;
      if ((c === '"' || c === "'") && nodeStart) { quote = c; nodeStart = false; }
      else if (nodeStart && (c === "[" || c === "{")) { flow++; nodeStart = true; }
      else if (flow > 0 && (c === "]" || c === "}")) { flow--; nodeStart = false; }
      else if ((c === ":" && /\s/.test(line[i + 1] ?? "\n")) || (flow > 0 && c === ",") || (nodeStart && c === "-")) nodeStart = true;
      else if (!/\s/.test(c)) nodeStart = false;
    }
    if (!quote && !flow && /(?:^|:[ \t]+|-[ \t]+)[|>](?:[+-][1-9]?|[1-9][+-]?)?[ \t]*(?:#[^\r\n]*)?\r?\n?$/.test(line)) blockIndent = line.match(/^[ \t]*/)![0].length;
    offset += line.length;
  }
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    const next = fields[i + 1]?.start ?? yaml.length;
    // Standalone comments/blank lines between fields belong to the untouched document.
    const raw = yaml.slice(field.start, next);
    let end = next;
    const lines = raw.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    for (let j = lines.length - 1; j > 0; j--) {
      if (!/^[ \t]*(?:#[^\r\n]*)?\r?\n?$/.test(lines[j]!)) break;
      end -= lines[j]!.length;
    }
    field.end = end;
  }
  return fields;
}

/** Parse semantics with Bun's YAML parser while retaining every source byte for emission. */
export function parseFrontmatter(source: string): FrontmatterDocument {
  const opening = source.match(/^(?:﻿)?---[ \t]*\r?\n/);
  if (!opening) return { source, body: source, data: {}, frontmatter: null };
  const start = opening[0].length;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = start;
  const match = closing.exec(source);
  if (!match) throw new Error("frontmatter: missing closing delimiter");
  const yaml = source.slice(start, match.index);
  let value: unknown;
  try { value = Bun.YAML.parse(yaml); }
  catch { throw new Error("frontmatter: invalid YAML"); }
  if (value === null || value === undefined) value = {};
  if (!mapping(value)) throw new Error("frontmatter: expected mapping");
  const end = match.index + match[0].length;
  const document: ParsedDocument = {
    source, body: source.slice(end), data: value, frontmatter: source.slice(0, end),
    start, end: match.index, newline: opening[0].endsWith("\r\n") ? "\r\n" : "\n", fields: fieldSpans(yaml),
  };
  return document;
}

function canonical(key: string, value: unknown, newline: string): string {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); }
  catch { throw new Error("frontmatter: changed values must be JSON-compatible"); }
  if (encoded === undefined || !isDeepStrictEqual(JSON.parse(encoded), value)) throw new Error("frontmatter: changed values must be JSON-compatible");
  return `${JSON.stringify(key)}: ${encoded}${newline}`;
}

/** Emit the entire note. Undefined deletes a key; omitted or semantically equal keys retain their bytes. */
export function emitFrontmatter(document: FrontmatterDocument, changes: Record<string, unknown> = {}): string {
  const parsed = parseFrontmatter(document.source) as ParsedDocument;
  const changed = Object.entries(changes).filter(([key, value]) => !isDeepStrictEqual(parsed.data[key], value));
  if (!changed.length) return document.source;
  const newline = parsed.frontmatter === null ? "\n" : parsed.newline;
  if (parsed.frontmatter === null) {
    const yaml = changed.filter(([, value]) => value !== undefined).map(([key, value]) => canonical(key, value, newline)).join("");
    if (!yaml) return document.source;
    const bom = document.source.startsWith("﻿") ? "﻿" : "";
    return `${bom}---${newline}${yaml}---${newline}${document.source.slice(bom.length)}`;
  }
  let yaml = document.source.slice(parsed.start, parsed.end);
  const hasYamlContent = yaml.split(/\r?\n/).some(line => line.trim() && !line.trimStart().startsWith("#"));
  if ((hasYamlContent && !parsed.fields.length) || Object.keys(parsed.data).some(key => !parsed.fields.some(field => field.key === key))) {
    throw new Error("frontmatter: editing requires a block mapping");
  }
  const replacements: { start: number; end: number; value: string }[] = [];
  let additions = "";
  for (const [key, value] of changed) {
    const field = parsed.fields.find(item => item.key === key);
    const output = value === undefined ? "" : canonical(key, value, newline);
    if (field) replacements.push({ start: field.start, end: field.end, value: output });
    else {
      if (Object.hasOwn(parsed.data, key)) throw new Error("frontmatter: editing requires a block mapping");
      additions += output;
    }
  }
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) yaml = yaml.slice(0, replacement.start) + replacement.value + yaml.slice(replacement.end);
  return document.source.slice(0, parsed.start) + yaml + additions + document.source.slice(parsed.end);
}
