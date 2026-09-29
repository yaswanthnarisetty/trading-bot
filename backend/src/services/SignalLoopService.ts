import type { AssetKey } from "../config/assets";
/** Retired automatic financial path. Historical helpers remain available to legacy
 * read APIs; session routes use PaperEntryOrchestrator exclusively. */
export async function start(_sessionId:string,_asset:AssetKey):Promise<void>{throw new Error("LEGACY_SIGNAL_LOOP_DISABLED");}
export async function _runTick(_sessionId:string,_asset:AssetKey):Promise<void>{throw new Error("LEGACY_SIGNAL_LOOP_DISABLED");}
export function stop():void{}
export function isRunning():boolean{return false;}
