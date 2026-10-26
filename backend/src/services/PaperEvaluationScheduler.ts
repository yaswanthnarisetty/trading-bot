/** Give Kite's completed bar time to reach REST/stream before starting the AI cycle.
 * At 45 seconds, the previous bar is past the existing 30-second grace and
 * cannot authorize an entry if the new bar has not arrived. */
export function nextEvaluationWake(nowMs: number, intervalMs: number): number {
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(intervalMs) || intervalMs < 300_000 || intervalMs > 3_600_000)
    throw new Error("INVALID_CADENCE");
  return (Math.floor(nowMs / intervalMs) + 1) * intervalMs + 45_000;
}

/** Preparation begins before the decision target so broker reconciliation can
 * finish ahead of the fresh-bar evaluation. */
export function nextPreparationWake(nowMs: number, intervalMs: number, leadMs: number) {
  if (!Number.isSafeInteger(leadMs) || leadMs < 0 || leadMs > 240_000)
    throw new Error("INVALID_CADENCE");
  const targetAtMs = nextEvaluationWake(nowMs, intervalMs);
  return { targetAtMs, delayMs: Math.max(0, targetAtMs - leadMs - nowMs) };
}

/** One owner and at most one pending wakeup per account. Slow cycles skip missed
 * bars rather than overlapping or replaying financial work. */
export class PaperEvaluationScheduler {
  private owners = new Map<string,{sessionId:string; active:boolean; timer?:ReturnType<typeof setTimeout>}>();
  constructor(private readonly run:(sessionId:string,targetAtMs:number)=>Promise<unknown>, private readonly report:(sessionId:string)=>void = ()=>{},
    private readonly clock:()=>number = Date.now, private readonly preparationLeadMs = 0) {
    if (!Number.isSafeInteger(preparationLeadMs) || preparationLeadMs < 0 || preparationLeadMs > 240_000)
      throw new Error("INVALID_CADENCE");
  }
  start(accountId:string,sessionId:string,intervalMs:number) {
    if (!Number.isInteger(intervalMs)||intervalMs<300000||intervalMs>3600000) throw new Error("INVALID_CADENCE");
    const previous=this.owners.get(accountId);
    if(previous?.active&&previous.sessionId===sessionId)return;
    if(previous){previous.active=false;if(previous.timer)clearTimeout(previous.timer);}
    const owner:{sessionId:string;active:boolean;timer?:ReturnType<typeof setTimeout>}={sessionId,active:true};
    this.owners.set(accountId,owner);
    const schedule=(attemptedTargetAtMs:number)=>{
      const now=this.clock();
      const next=nextPreparationWake(now,intervalMs,this.preparationLeadMs);
      // An early readiness failure must not retry the same upcoming bar in a
      // zero-delay loop. Every attempted target gets at most one preparation.
      const targetAtMs=Math.max(next.targetAtMs,attemptedTargetAtMs+intervalMs);
      owner.timer=setTimeout(()=>void tick(targetAtMs),Math.max(0,targetAtMs-this.preparationLeadMs-now));
      owner.timer.unref?.();
    };
    const tick=async(targetAtMs:number)=>{
      if(!owner.active||this.owners.get(accountId)!==owner)return;
      try{await this.run(sessionId,targetAtMs);}catch{this.report(sessionId);}
      if(owner.active&&this.owners.get(accountId)===owner)schedule(targetAtMs);
    };
    const firstTarget = nextEvaluationWake(this.clock(), intervalMs);
    // A just-started session can be more than one receipt lifetime away from
    // its first bar. Preparing immediately would leave an expired receipt at
    // evaluation, so start at the configured lead boundary in that case.
    if (this.preparationLeadMs === 0 || firstTarget - this.clock() <= this.preparationLeadMs)
      void tick(firstTarget);
    else schedule(firstTarget - intervalMs);
  }
  stop(sessionId:string){for(const [key,owner]of this.owners)if(owner.sessionId===sessionId){owner.active=false;if(owner.timer)clearTimeout(owner.timer);this.owners.delete(key);}}
}
