/** Small sequential stdio client used only by readiness checks, never shipped at runtime. */
export function releaseRpc(argv: string[], env: NodeJS.ProcessEnv, shutdownMs = 5000) {
  const child = Bun.spawn(argv,{env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  const pending = new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  let next=0;
  const read = (async()=>{
    const decoder=new TextDecoder(),reader=child.stdout.getReader();let buffer="";
    try {
      for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});
        if(buffer.length>1024*1024)throw new Error("smoke: oversized protocol output");
        for(;;){const end=buffer.indexOf("\n");if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
          const response=JSON.parse(line),entry=pending.get(response.id);if(!entry)throw new Error("smoke: unexpected protocol response");
          pending.delete(response.id);clearTimeout(entry.timer);if(response.error)entry.reject(new Error("smoke: protocol request refused"));else entry.resolve(response.result);
        }
      }
      if(buffer.trim() || pending.size)throw new Error("smoke: incomplete protocol stream");
    }catch(error){for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(error instanceof Error?error:new Error("smoke: stream failure"));}pending.clear();throw error;}
  })();
  // Retain rejection for close(), without an unhandled rejection while a request propagates it.
  void read.catch(()=>{});
  const notify=(method:string,params:unknown={})=>{child.stdin.write(JSON.stringify({jsonrpc:"2.0",method,params})+"\n");child.stdin.flush();};
  const bounded=async<T>(promise:Promise<T>,ms:number,label:string):Promise<T>=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("smoke: MCP "+label+" timeout")),ms);})]);}
    finally{if(timer)clearTimeout(timer);}
  };
  const stop=async()=>{
    for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error("smoke: stopped"));}pending.clear();
    child.kill();
    try{await bounded(child.exited,shutdownMs,"termination");}
    catch{child.kill("SIGKILL");await bounded(child.exited,shutdownMs,"forced termination");}
  };
  const request=(method:string,params:unknown={}):Promise<any>=>new Promise((resolve,reject)=>{
    const id=++next,timer=setTimeout(()=>{pending.delete(id);child.kill();reject(new Error("smoke: MCP timeout"));},60000);
    pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");child.stdin.flush();
  });
  return {child,request,notify,async initialize(){await request("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"vmem-readiness",version:"1"}});notify("notifications/initialized");},
    async close(){
      try{child.stdin.end();const status=await bounded(child.exited,shutdownMs,"shutdown");await bounded(read,shutdownMs,"stdout close");const stderr=await bounded(new Response(child.stderr).text(),shutdownMs,"stderr close");if(status!==0 || stderr.trim())throw new Error("smoke: MCP process failed");}
      catch(error){await stop();throw error;}
    },
    stop,
  };
}
