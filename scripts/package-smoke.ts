import { mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { releaseRpc } from "./release-rpc.ts";
import { version } from "../package.json";
function requireOk(value:unknown,message:string):asserts value {if(!value)throw new Error("package smoke: "+message);}
function command(argv:string[],cwd:string,env:NodeJS.ProcessEnv):string {
  const result=Bun.spawnSync(argv,{cwd,env,stdout:"pipe",stderr:"pipe",timeout:120000});
  requireOk(result.exitCode===0,"command failed: "+argv.slice(0,2).join(" "));return result.stdout.toString().trim();
}
/** Pack the checkout, install in a fresh consumer, then use only that installed executable/provider. */
export async function runPackageSmoke(archive = process.env.VMEM_SMOKE_TARBALL):Promise<void>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"vmem-package-smoke-"))),repo=resolve(import.meta.dir,"..");
  const env={...process.env,PATH:dirname(process.execPath)+":"+process.env.PATH,VMEM_HOME:join(root,"home"),AMEM_HOME:join(root,"amem")};
  let rpc:ReturnType<typeof releaseRpc>|undefined;
  try {
    const tarball=archive ? resolve(archive) : join(root,"package.tgz"),consumer=join(root,"consumer"),vault=join(root,"vault"),notes=join(vault,"notes");
    mkdirSync(consumer);mkdirSync(notes,{recursive:true});
    if(!archive)command([process.execPath,"pm","pack","--ignore-scripts","--filename",tarball],repo,env);
    const entries=command(["tar","-tzf",tarball],repo,env).split("\n").filter(Boolean);
    requireOk(entries.every(name=>/^package\/(?:package\.json|LICENSE|README\.md|CHANGELOG\.md|bin\/vmem\.js|src\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.ts|src\/ui\/panel\.(?:js|css))$/.test(name)),"unexpected package contents");
    for(const required of ["package/package.json","package/bin/vmem.js","package/src/index.ts","package/src/ui/plugin.ts","package/src/ui/panel.js","package/src/ui/panel.css","package/CHANGELOG.md"])requireOk(entries.includes(required),"missing artifact "+required);
    writeFileSync(join(consumer,"package.json"),JSON.stringify({private:true,dependencies:{"@staix/vault-mem":"file:"+tarball}}));
    command([process.execPath,"install","--production","--ignore-scripts"],consumer,env);
    const installed=join(consumer,"node_modules","@staix","vault-mem"),bin=join(consumer,"node_modules",".bin","vmem");
    for(const name of entries){const relative=name.slice("package/".length);requireOk(readFileSync(join(installed,relative)).equals(readFileSync(join(repo,relative))),"installed content mismatch");}
    requireOk(command([bin,"--version"],consumer,env)===version,"version mismatch");
    const help=command([bin,"--help"],consumer,env);for(const name of ["graph build","promote-from-amem","setup"])requireOk(help.includes(name),"missing help command");
    writeFileSync(join(notes,"research.md"),'---\ntype: moc\ndescription: Synthetic installation fixture.\n---\n# Research\n');
    command([bin,"vaults","add","fixture",vault,"--kind","personal","--write","mcp"],consumer,env);
    const created=JSON.parse(command([bin,"new","fixture","installed-note","--type","insight","--domain","research","--topics","research","--description","Synthetic installed package evidence.","--title","Installed Finding","--json"],consumer,env));
    requireOk(created.ok && created.applied && created.logged,"non-TTY CLI mutation failed");
    const found=JSON.parse(command([bin,"search","fixture","Installed","--json"],consumer,env));requireOk(found.some((hit:{path:string})=>hit.path==="installed-note.md"),"installed CLI search failed");
    rpc=releaseRpc([bin,"mcp"],env);await rpc.initialize();
    const tools=await rpc.request("tools/list");requireOk(tools.tools.some((t:{name:string})=>t.name==="vmem_graph_neighbors"),"installed MCP analysis missing");
    const read=await rpc.request("tools/call",{name:"vmem_read",arguments:{vault:"fixture",path:"installed-note"}});
    const body=JSON.parse(read.content[0].text);requireOk(body.sha256 && body.frontmatter.type==="insight","installed MCP read failed");
    const preview=JSON.parse((await rpc.request("tools/call",{name:"vmem_move",arguments:{vault:"fixture",from:"installed-note",to:"installed-moved"}})).content[0].text);
    requireOk(preview.preview && preview.fingerprint,"installed MCP preview failed");
    writeFileSync(join(notes,"installed-note.md"),readFileSync(join(notes,"installed-note.md"),"utf8")+"\nExternal synthetic edit.\n");
    const stale=JSON.parse((await rpc.request("tools/call",{name:"vmem_move",arguments:{vault:"fixture",from:"installed-note",to:"installed-moved",confirm:true,fingerprint:preview.fingerprint}})).content[0].text);
    requireOk(stale.ok===false && stale.issues.some((i:{code:string})=>i.code==="V09"),"installed stale fingerprint accepted");
    requireOk(existsSync(join(notes,"installed-note.md")) && !existsSync(join(notes,"installed-moved.md")),"stale refusal changed file paths");
    requireOk(readFileSync(join(notes,"installed-note.md"),"utf8").endsWith("External synthetic edit.\n"),"stale refusal lost external edit");
    await rpc.close();rpc=undefined;console.log(`package smoke: ok (${entries.length} installed files, CLI/MCP/non-TTY/stale preview)`);
  }finally{await rpc?.stop();rmSync(root,{recursive:true,force:true});}
}
if(import.meta.main)await runPackageSmoke();
