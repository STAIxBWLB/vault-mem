import { parseAnalysisYaml, scalarText, yamlTruthy, AnalysisYamlUnsupported } from "./analysis-yaml.ts";
import type { AnalysisSnapshot, LintCode, LintReport } from "./analysis-types.ts";
const TYPES = ["decision", "insight", "method", "moc", "observation", "person", "project", "reference"];
const CONFIDENCE = ["experimental", "likely", "proven"], STATUS = ["active", "archived", "superseded"];
const FIELDS = ["topics", "project", "projects", "superseded_by", "supersedes"];
const CANONICAL = new Set("INGEST ROUTE EXTRACT CONNECT DIGEST LEARN LINT TASK GRAPH SYNC RETHINK SOURCE".split(" "));
const LEGACY = new Set("CREATE UPDATE MIGRATE REFACTOR MERGE MOVE RELOCATE RENAME DRAFT REVIEW RESEARCH REF CLEANUP CLOSE DONE SUPERSEDED DUPLICATE SKIP EDIT CORRECT".split(" "));
const CODE_TITLES: Record<LintCode, string> = {
  L01: "L01 — dead wiki-link", L02: "L02 — 필수 frontmatter / 허용값", L03: "L03 — orphan",
  L09: "L09 — 로그 포맷", L10: "L10 — project 값", L11: "L11 — graph report staleness", L12: "L12 — island community", L13: "L13 — filename", L14: "L14 — source paths",
};
const truth = yamlTruthy;
/** Python scalar formatting matters to per-code diagnostic parity. */
function py(x: unknown): string {
  const scalar = scalarText(x); if (scalar !== undefined) return scalar;
  if (x === undefined || x === null) return "None";
  if (x === true) return "True";
  if (x === false) return "False";
  if (Array.isArray(x)) return `[${x.map(v => typeof v === "string" ? `'${v}'` : py(v)).join(", ")}]`;
  if (typeof x === "object") return `{${Object.entries(x).map(([k,v]) => `'${k}': ${typeof v === "string" ? `'${v}'` : py(v)}`).join(", ")}}`;
  return String(x);
}
export function legacyDocument(source: string): { fm: Record<string, unknown> | null; body: string } {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(source);
  let fm: Record<string, unknown> | null = null;
  if (match) {
    try {
      const value: unknown = parseAnalysisYaml(match[1]!);
      fm = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch (error) { if (error instanceof AnalysisYamlUnsupported) throw error; /* Keep parse failures visible to L02. */ }
  }
  return { fm, body: match ? source.slice(match[0].length) : source };
}
function links(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap(v => typeof v === "string" ? [...v.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map(m => m[1]!.trim()) : []);
}
const stem = (s: string) => s.trim().replace(/\.md$/, "").split("/").at(-1)!;
function graphChecks(snapshot: AnalysisSnapshot): { l11: string[]; l12: string[]; info: string } {
  const l11: string[] = [], l12: string[] = [], names = Object.keys(snapshot.reports).filter(s => /^graph-report-.*\.md$/.test(s)).sort();
  const latest = names.at(-1);
  if (!latest) l11.push("graph report 없음 — `/vault-graph build` 필요");
  else {
    const match = /graph-report-(\d{2})(\d{2})(\d{2})\.md$/.exec(latest);
    let age: number | null = null;
    if (match) {
      const year = Number(match[1]) <= 68 ? 2000 + Number(match[1]) : 1900 + Number(match[1]);
      const date = `${year}-${match[2]}-${match[3]}`, time = Date.parse(date + "T00:00:00Z");
      if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== date) throw new Error("analysis: invalid graph report date");
      age = Math.round((Date.parse(snapshot.today + "T00:00:00Z") - time) / 86400000);
    }
    if (age === null || age > 7) l11.push(`\`${latest}\`: ${py(age)}일 경과 (> 7) — \`/vault-graph build\` 재실행 권장`);
  }
  const source = snapshot.reports["vault-graph.json"];
  if (!source) return { l11, l12, info: "vault-graph.json 없음 — L12 생략" };
  const graph = JSON.parse(source) as { nodes?: { id: string; community?: number | string | null }[]; links?: {source:string;target:string}[]; edges?: {source:string;target:string}[] };
  if (!graph || !Array.isArray(graph.nodes ?? []) || !Array.isArray(graph.links ?? graph.edges ?? [])) throw new Error("analysis: invalid graph artifact");
  const communities = new Map<string | number, string[]>(), member = new Map<string, string | number>(), cross = new Set<string | number>();
  for (const node of graph.nodes ?? []) if (node.community !== undefined && node.community !== null) {
    member.set(node.id, node.community);
    const members = communities.get(node.community) ?? []; members.push(node.id); communities.set(node.community, members);
  }
  const edges = graph.links?.length ? graph.links : graph.edges ?? [];
  for (const edge of edges) { const a = member.get(edge.source), b = member.get(edge.target); if (a !== undefined && b !== undefined && a !== b) { cross.add(a); cross.add(b); } }
  const singles: string[] = [];
  for (const [id, members] of communities) {
    if (members.length === 1) singles.push(members[0]!);
    else if (!cross.has(id)) l12.push(`island community (${members.length} notes): ${members.sort().slice(0,10).map(s => `\`${s}\``).join(", ")}${members.length > 10 ? ` +${members.length - 10} more` : ""} — \`/vault-connect\` 필요`);
  }
  singles.sort();
  return { l11, l12, info: `nodes ${graph.nodes?.length ?? 0} / edges ${edges.length} / communities ${communities.size}; singleton ${singles.length}개${singles.length ? ": " + singles.slice(0,10).map(s => `\`${s}\``).join(", ") : ""}` };
}
export function lintVault(snapshot: AnalysisSnapshot, only?: string): LintReport {
  const findings: Record<LintCode,string[]> = {L01:[],L02:[],L03:[],L09:[],L10:[],L11:[],L12:[],L13:[],L14:[]};
  const notes = [...snapshot.notes].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(n => ({...n,...legacyDocument(n.source),stem: n.path.replace(/^notes\//, "").slice(0,-3)}));
  const stems = new Set(notes.map(n => n.stem)), inlinks = new Map(notes.map(n => [n.stem,0]));
  let superseded = 0;
  for (const note of notes) {
    const rel = `notes/${note.stem}.md`, prefix = `\`${rel}\`: `, fm = note.fm;
    for(const message of snapshot.sourceWarnings?.[note.path] ?? [])findings.L14.push(prefix+message);
    const allLinks: [string,string][] = links(note.body).map(t => ["body",t]);
    if (fm) for (const field of FIELDS) for (const t of links(fm[field])) allLinks.push([field,t]);
    for (const [field,t] of allLinks) {
      const target = stem(t);
      if (stems.has(target)) { if (target !== note.stem) inlinks.set(target,inlinks.get(target)!+1); }
      else findings.L01.push(prefix + `\`[[${t}]]\` (${field}) → 대상 노트 없음`);
    }
    if (fm === null) { findings.L02.push(prefix + "frontmatter 없음/파싱 실패"); continue; }
    if (fm.status === "superseded") superseded++;
    if (!TYPES.includes(String(fm.type))) findings.L02.push(prefix + `\`type: ${py(fm.type)}\` 허용값 아님 (${TYPES.join(" | ")})`);
    if (fm.type === "moc") { if (!truth(fm.description)) findings.L02.push(prefix + "`type: moc` 노트는 `description` 필수"); }
    else if (!truth(fm.topics)) findings.L02.push(prefix + "`topics` 없음/빈 배열");
    for (const [key,allowed] of [["confidence",CONFIDENCE],["status",STATUS]] as const) if (fm[key] !== undefined && fm[key] !== null && !allowed.includes(py(fm[key]))) findings.L02.push(prefix + `\`${key}: ${py(fm[key])}\` 허용값 아님 (${allowed.join(" | ")})${key === "status" ? " (status는 노트 생애주기이지 사업 진행 상태가 아님 — 작업 상태는 본문에)" : ""}`);
    const project = fm.project;
    if (typeof project === "string" && project.trim()) {
      const targets = links(project);
      if (targets.length) { for (const t of targets) if (!stems.has(stem(t))) findings.L10.push(prefix + `\`project: [[${t}]]\` dead wiki-link`); }
      else if (snapshot.registryIds !== null && !snapshot.registryIds.includes(project.trim())) findings.L10.push(prefix + `\`project: ${project}\` registry id 아님`);
    }
  }
  for (const note of notes) {
    if (note.stem !== "index" && note.fm !== null && !truth(note.fm.topics) && inlinks.get(note.stem) === 0) findings.L03.push(`\`notes/${note.stem}.md\`: in-link 0, topics 0`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(note.stem)) findings.L13.push(`\`notes/${note.stem}.md\`: expected lowercase ASCII kebab-case filename`);
  }
  let legacy = 0, last = "", data = 0;
  if (snapshot.log === null) findings.L09.push(`\`${snapshot.logPath}\` 없음`);
  else for (const [index,line] of snapshot.log.split(/\r\n|\n|\r/).entries()) {
    if (!line.trim() || line.startsWith("#")) continue;
    data++;
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) findings.L09.push(`\`log:${index+1}\`: 구조 위반 (\`YYYY-MM-DD HH:MM  TYPE  ...\` 아님): \`${[...line].slice(0,60).join("")}\``);
    else if (LEGACY.has(m[3]!)) { legacy++; if (m[1]! > last) last = m[1]!; }
    else if (!CANONICAL.has(m[3]!)) findings.L09.push(`\`log:${index+1}\`: TYPE \`${m[3]}\` 미등록 (정규 12종·정규화표 모두 없음)`);
  }
  if (data > 20000) findings.L09.push(`log ${data} 라인 > 20000 — 수동 아카이브 권장`);
  const graph = graphChecks(snapshot); findings.L11 = graph.l11; findings.L12 = graph.l12;
  if (only) for (const code of ["L01","L02","L03","L10","L13","L14"] as const) findings[code] = findings[code].filter(s => s.startsWith(`\`${only}\``));
  const errors = findings.L01.length + findings.L02.length + findings.L13.length;
  const warnings = findings.L03.length + findings.L09.length + findings.L10.length + findings.L11.length + findings.L12.length + findings.L14.length;
  const summary = `SUMMARY errors=${errors} warnings=${warnings}`;
  const extra: Partial<Record<LintCode,string>> = {
    L02: `정보: \`status: superseded\` ${superseded}건${superseded === 0 ? " — supersede 프로토콜 미가동" : ""}`,
    L03: "hub MOC `notes/index.md`는 설계상 예외",
    L09: snapshot.log === null ? "정보: log 없음" : `정보: ${legacy ? `legacy TYPE ${legacy}건 (정규화표 등재), 최종 사용 ${last}, 신규 발생 없음` : "legacy TYPE 0건"}`,
    L10: snapshot.registryIds === null ? "registry 미지정 — plain id 검사 생략" : "", L12: graph.info,
  };
  const lines = [`<!-- lint.py ${snapshot.today} notes=${notes.length} errors=${errors} warnings=${warnings} -->`,""];
  for (const code of Object.keys(findings) as LintCode[]) {
    const sev = ["L01","L02","L13"].includes(code) ? "error" : "warn";
    lines.push(`## ${CODE_TITLES[code]} (${sev}, ${findings[code].length}건)`,"",...(findings[code].length ? findings[code].map(s => `- ${s}`) : ["위반 없음"]));
    if (extra[code]) lines.push("",extra[code]!);
    lines.push("");
  }
  return { findings, errors, warnings, markdown: lines.join("\n"), summary };
}
