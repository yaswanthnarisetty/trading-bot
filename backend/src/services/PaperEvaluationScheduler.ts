/** One owner and at most one pending wakeup per account. Completion-based cadence:
 * no overlap, catch-up queue, automatic restart, or financial work in timer code. */
export class PaperEvaluationScheduler {
  private owners = new Map<string,{sessionId:string; active:boolean; timer?:ReturnType<typeof setTimeout>}>();
  constructor(private readonly run:(sessionId:string)=>Promise<unknown>, private readonly report:(sessionId:string)=>void = ()=>{}) {}
  start(accountId:string,sessionId:string,intervalMs:number) {
    if (!Number.isInteger(intervalMs)||intervalMs<300000||intervalMs>3600000) throw new Error("INVALID_CADENCE");
    const previous=this.owners.get(accountId);
    if(previous?.active&&previous.sessionId===sessionId)return;
    if(previous){previous.active=false;if(previous.timer)clearTimeout(previous.timer);}
    const owner:{sessionId:string;active:boolean;timer?:ReturnType<typeof setTimeout>}={sessionId,active:true};
    this.owners.set(accountId,owner);
    const tick=async()=>{
      if(!owner.active||this.owners.get(accountId)!==owner)return;
      try{await this.run(sessionId);}catch{this.report(sessionId);}
      if(owner.active&&this.owners.get(accountId)===owner){owner.timer=setTimeout(tick,intervalMs);owner.timer.unref?.();}
    };
    void tick();
  }
  stop(sessionId:string){for(const [key,owner]of this.owners)if(owner.sessionId===sessionId){owner.active=false;if(owner.timer)clearTimeout(owner.timer);this.owners.delete(key);}}
}
