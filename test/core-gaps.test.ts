import {afterEach,expect,test} from "bun:test";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {addVault} from "../src/registry.ts";
import {applyWrite} from "../src/writer.ts";
import {parseFrontmatter} from "../src/frontmatter.ts";
import {analysisInput} from "../src/analysis-input.ts";
import {lintVault} from "../src/vault-lint.ts";
import {normalizeSource} from "../src/source.ts";
import {run} from "../src/cli.ts";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const note=(extra="",body="Body anchor.")=>`---\ntitle: Synthetic Finding\ntype: insight\ndomain: research\ndescription: Synthetic distinct evidence for core regression.\ntopics: ["[[research]]"]\n${extra}---\n# Synthetic Finding\n\n${body}\n\n## Topics\n\n- [[research]]\n`;
function fixture(registry=false){const root=realpathSync(mkdtempSync(join(tmpdir(),"vmem-gaps-")));roots.push(root);const home=join(root,"state"),vault=join(root,"vault"),notes=join(vault,"notes");mkdirSync(notes,{recursive:true});writeFileSync(join(notes,"research.md"),'---\ntype: moc\ndescription: Synthetic navigation.\n---\n# Research\n');writeFileSync(join(notes,"alpha.md"),note());writeFileSync(join(notes,"beta.md"),note('aliases: ["Beta Alias"]\n',"Second distinct body."));if(registry){writeFileSync(join(root,"project-registry.yaml"),"projects: []\n");writeFileSync(join(root,"workspace.config.yaml"),"fixture: true\n");}addVault(home,{id:"fixture",path:vault,kind:"personal",write:"mcp",...(registry?{registry:join(root,"project-registry.yaml")}: {})});return{root,home,vault,notes};}
test("untouched unknown keys and enum debt warn on body edits; added, changed or explicitly set debt errors",()=>{
 const f=fixture(),file=join(f.notes,"alpha.md");writeFileSync(file,note('custom_stage: old\nconfidence: speculative\n'));
 const edit=applyWrite(f.home,{vault:"fixture",operation:{op:"patch",path:"alpha",oldString:"Body anchor.",newString:"Changed body."}});
 expect(edit.ok).toBe(true);expect(edit.applied).toBe(true);expect(edit.issues.filter(i=>i.code==="V01"&&i.severity==="warning")).toHaveLength(2);
 for(const set of [{custom_stage:"new"},{confidence:"certain"},{custom_stage:"old"}]){const result=applyWrite(f.home,{vault:"fixture",operation:{op:"frontmatter",path:"alpha",set}});expect(result.ok).toBe(false);expect(result.issues.some(i=>i.code==="V01"&&i.severity==="error")).toBe(true);}
 const create=applyWrite(f.home,{vault:"fixture",operation:{op:"create",path:"new",frontmatter:{...parseFrontmatter(note()).data,custom_stage:"new"}}});expect(create.ok).toBe(false);
});
test("link dedupe ignores Topics and code, resolves body aliases and still adds a missing reverse side",()=>{
 const f=fixture(),alpha=join(f.notes,"alpha.md"),beta=join(f.notes,"beta.md");
 writeFileSync(alpha,note("","Body links ![[Beta Alias#anything|shown]] in a dated section.\n\n## Connections (2026-10-29)\n\n[[beta]]"));
 const before=readFileSync(alpha,"utf8"),linked=applyWrite(f.home,{vault:"fixture",operation:{op:"link",from:"alpha",to:"beta",relation:"supports"}});
 expect(linked.ok).toBe(true);expect(linked.changes.map(c=>c.path)).toEqual(["notes/beta.md"]);expect(readFileSync(alpha,"utf8")).toBe(before);expect(readFileSync(beta,"utf8")).toContain("[[alpha]]");
 const logBefore=readFileSync(join(f.vault,"log"),"utf8"),again=applyWrite(f.home,{vault:"fixture",operation:{op:"link",from:"alpha",to:"beta",relation:"supports"}});
 expect(again.ok).toBe(true);expect(again.unchanged).toBe(true);expect(again.applied).toBe(false);expect(again.changes).toHaveLength(0);expect(readFileSync(join(f.vault,"log"),"utf8")).toBe(logBefore);
 const topics=applyWrite(f.home,{vault:"fixture",operation:{op:"link",from:"beta",to:"research",relation:"context-for",bidirectional:false}});expect(topics.applied).toBe(true);
 writeFileSync(alpha,note("","```md\n[[beta]]\n```"));expect(applyWrite(f.home,{vault:"fixture",operation:{op:"link",from:"alpha",to:"beta",relation:"supports",bidirectional:false}}).applied).toBe(true);
});
test("frontmatter patch anchors refuse with a set_frontmatter hint and body patches still work",()=>{
 const f=fixture(),file=join(f.notes,"alpha.md"),before=readFileSync(file,"utf8");
 const refusal=applyWrite(f.home,{vault:"fixture",operation:{op:"patch",path:"alpha",oldString:"type: insight",newString:"type: decision"}});
 expect(refusal.ok).toBe(false);expect(refusal.issues.some(i=>i.message.includes("vmem_set_frontmatter"))).toBe(true);expect(readFileSync(file,"utf8")).toBe(before);
 expect(applyWrite(f.home,{vault:"fixture",operation:{op:"patch",path:"alpha",oldString:"Body anchor.",newString:"type: decision in body."}}).ok).toBe(true);
});
test("typed source list normalizes only explicit writes and writer/lint warn on missing workspace paths",()=>{
 const f=fixture(true);writeFileSync(join(f.root,"existing.md"),"Synthetic source file.\n");
 const source=["work/existing.md","work/missing.md","mem:synthetic-id","https://example.com/source"];
 const result=applyWrite(f.home,{vault:"fixture",operation:{op:"frontmatter",path:"alpha",set:{source}}});
 expect(result.ok).toBe(true);expect(result.issues.some(i=>i.code==="V11"&&i.message==="source path does not exist: missing.md")).toBe(true);
 expect(parseFrontmatter(readFileSync(join(f.notes,"alpha.md"),"utf8")).data.source).toEqual(["existing.md","missing.md","mem:synthetic-id","https://example.com/source"]);
 expect(lintVault(analysisInput(f.home,"fixture").snapshot).findings.L14).toContain("`notes/alpha.md`: source path does not exist: missing.md");
 const legacy=note('source: work/existing.md\n');writeFileSync(join(f.notes,"alpha.md"),legacy);
 expect(applyWrite(f.home,{vault:"fixture",operation:{op:"patch",path:"alpha",oldString:"Body anchor.",newString:"Unrelated edit."}}).ok).toBe(true);expect(readFileSync(join(f.notes,"alpha.md"),"utf8")).toContain("source: work/existing.md");
 const cli=run(["new","fixture","source-cli","--type","insight","--domain","research","--topics","research","--description","Synthetic source list creation.","--source",JSON.stringify(source),"--json"],{VMEM_HOME:f.home});expect(JSON.parse(cli.text).ok).toBe(true);
 for(const invalid of [[],[1],"../escape.md","/absolute.md","mem:","work/../escape.md"]){expect(()=>normalizeSource(invalid)).toThrow();}
 expect(existsSync(join(f.root,"missing.md"))).toBe(false);
});

test("rename retains schema debt and unrelated H1 edits do not create a new description violation",()=>{
 const f=fixture(),file=join(f.notes,"alpha.md");
 writeFileSync(file,note('custom_stage: old\nconfidence: speculative\n'));
 const preview=applyWrite(f.home,{vault:"fixture",operation:{op:"move",from:"alpha",to:"renamed"}});expect(preview.ok).toBe(true);
 const moved=applyWrite(f.home,{vault:"fixture",operation:{op:"move",from:"alpha",to:"renamed"},confirm:true,fingerprint:preview.fingerprint});expect(moved.ok).toBe(true);expect(moved.applied).toBe(true);expect(moved.issues.filter(i=>i.code==="V01"&&i.severity==="warning")).toHaveLength(2);
 writeFileSync(file,note().replace('description: Synthetic distinct evidence for core regression.','description: alpha'));
 const edit=applyWrite(f.home,{vault:"fixture",operation:{op:"patch",path:"alpha",oldString:"# Synthetic Finding",newString:"# Changed Heading"}});expect(edit.ok).toBe(true);expect(edit.issues.some(i=>i.code==="V01"&&i.severity==="warning")).toBe(true);
});
test("denied sources are refused or reported generically before missing-path warnings",()=>{
 const f=fixture(true),source=".maru/secrets/nonexistent.md";
 const result=applyWrite(f.home,{vault:"fixture",operation:{op:"frontmatter",path:"alpha",set:{source}}});expect(result.ok).toBe(false);expect(result.issues.some(i=>i.code==="V06")).toBe(true);expect(result.issues.every(i=>!i.message.includes(source))).toBe(true);expect(result.issues.some(i=>i.code==="V11")).toBe(false);
 writeFileSync(join(f.notes,"alpha.md"),note(`source: ${source}\n`));
 const findings=lintVault(analysisInput(f.home,"fixture").snapshot).findings.L14;expect(findings).toContain("`notes/alpha.md`: source is denied by the path policy");expect(findings.every(message=>!message.includes(source))).toBe(true);
});

test("count-only parser probe never writes its result inside the vault",async()=>{
 const {probeFrontmatter}=await import("../scripts/frontmatter-probe.ts"),f=fixture(),before=readFileSync(join(f.notes,"alpha.md"),"utf8");
 expect(()=>probeFrontmatter(f.vault,join(f.notes,"probe.json"))).toThrow("outside the vault");expect(existsSync(join(f.notes,"probe.json"))).toBe(false);
 const report=probeFrontmatter(f.vault,join(f.root,"private-probe.json"));expect(report.ok).toBe(true);expect(report.notes).toBe(3);expect(report.contentIncluded).toBe(false);expect(readFileSync(join(f.notes,"alpha.md"),"utf8")).toBe(before);
});

test("decoded metadata escapes cannot bypass secret or denied PII checks on unrelated edits",()=>{
 const f=fixture(),file=join(f.notes,"alpha.md"),slash=String.fromCharCode(92);
 const hidden=note().replace("title: Synthetic Finding",`title: "${slash}u0067hp_${"A".repeat(30)}"`);
 writeFileSync(file,hidden);
 const secret=applyWrite(f.home,{vault:"fixture",operation:{op:"patch",path:"alpha",oldString:"Body anchor.",newString:"Edited body."}});expect(secret.ok).toBe(false);expect(secret.issues.some(i=>i.code==="V06")).toBe(true);expect(secret.issues.every(i=>!i.message.includes("ghp_"))).toBe(true);expect(readFileSync(file,"utf8")).toBe(hidden);
 writeFileSync(file,note(`"${slash}u0070assword": syntheticvalue\n`));
 const contextual=applyWrite(f.home,{vault:"fixture",operation:{op:"patch",path:"alpha",oldString:"Body anchor.",newString:"Edited body."}});expect(contextual.ok).toBe(false);expect(contextual.issues.some(i=>i.code==="V06")).toBe(true);
 const config=JSON.parse(readFileSync(join(f.home,"vmem.config.json"),"utf8"));config.vaults[0].pii="deny";writeFileSync(join(f.home,"vmem.config.json"),JSON.stringify(config));
 writeFileSync(file,note().replace("title: Synthetic Finding",`title: "fixture${slash}u0040example.com"`));
 const pii=applyWrite(f.home,{vault:"fixture",operation:{op:"patch",path:"alpha",oldString:"Body anchor.",newString:"Edited body."}});expect(pii.ok).toBe(false);expect(pii.issues.some(i=>i.code==="V07")).toBe(true);
});
