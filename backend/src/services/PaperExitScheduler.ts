/** Thin bounded dispatcher. Slow positions occupy one slot, never block every position. */
export class PaperExitScheduler {
 private timer:ReturnType<typeof setTimeout>|undefined;private running=false;private scanning=false;private cursorAfter:string|undefined;
 private readonly active=new Set<string>();
 constructor(private readonly list:()=>Promise<readonly {positionId:string}[]>,private readonly evaluate:(id:string)=>Promise<unknown>,
  private readonly onError:()=>void,readonly intervalMs=5000,readonly concurrency=4){
  if(!Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>60000||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>8)throw new Error('INVALID_EXIT_CADENCE');
 }
 start(){if(this.running)return;this.running=true;void this.tick();}
 isRunning(){return this.running;}
 stop(){this.running=false;if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
 async tick(){if(this.scanning)return;this.scanning=true;
  try{const rows=[...(await this.list())].sort((a,b)=>a.positionId<b.positionId?-1:a.positionId>b.positionId?1:0);
   const next=this.cursorAfter===undefined?0:rows.findIndex(row=>row.positionId>this.cursorAfter!);
   const start=next<0?0:next;
   for(let i=0;i<rows.length&&this.active.size<this.concurrency;i++){
    const row=rows[(start+i)%rows.length];this.cursorAfter=row.positionId;
    if(this.active.has(row.positionId))continue;
    this.active.add(row.positionId);
    void Promise.resolve().then(()=>this.evaluate(row.positionId)).catch(()=>this.onError()).finally(()=>this.active.delete(row.positionId));
   }
  }catch{this.onError();}finally{this.scanning=false;if(this.running)this.timer=setTimeout(()=>{void this.tick();},this.intervalMs);}
 }
}
