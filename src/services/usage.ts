import { queryOne } from '../db.js';
import { getOptionInt } from './option.js';
import { singlePlayerLimitEnabled,playerLimit } from './player.js';

export type UsageLimit = { used: number; limit: number | null; remaining: number | null };
export type AccountUsage = { players: UsageLimit; storage: UsageLimit; privateStorageRemaining: number | null; singlePlayer: boolean; playerLimit: number|null };

/** Credit-based capacity, matching the original dashboard rather than a fixed disk quota. */
export function calculateUsage(input: {score: number; players: number; storage: number; playerCost: number; storageCost: number; privateStorageCost: number; singlePlayer: boolean; playerLimit?:number|null}): AccountUsage {
  const credit = Math.max(0, input.score);
  const remaining = (cost: number) => cost > 0 ? Math.floor(credit / cost) : null;
  const cap=input.singlePlayer?1:input.playerLimit??null;
  const paid=remaining(input.playerCost),budgetLimit=paid===null?null:input.players+paid;
  const limit=input.singlePlayer?1:cap===null?budgetLimit:budgetLimit===null?cap:Math.min(cap,budgetLimit);
  const playerRemaining=limit===null?null:Math.max(0,limit-input.players);
  const storageRemaining = remaining(input.storageCost);
  return {
    players: {used: input.players, limit, remaining: playerRemaining},
    storage: {used: input.storage, limit: storageRemaining === null ? null : input.storage + storageRemaining, remaining: storageRemaining},
    privateStorageRemaining: remaining(input.privateStorageCost), singlePlayer: input.singlePlayer,playerLimit:cap,
  };
}

export async function accountUsage(uid: number): Promise<AccountUsage> {
  const [usage, playerCost, storageCost, privateStorageCost, singlePlayer, cap] = await Promise.all([
    queryOne<{score:number; players:number; storage:number}>('SELECT score,(SELECT COUNT(*) FROM players WHERE uid=?) AS players,(SELECT COALESCE(SUM(size),0) FROM textures WHERE uploader=?) AS storage FROM users WHERE uid=?',[uid,uid,uid]),
    getOptionInt('score_per_player',100), getOptionInt('score_per_storage',3), getOptionInt('private_score_per_storage',25), singlePlayerLimitEnabled(),playerLimit(),
  ]);
  return calculateUsage({score:Number(usage?.score??0),players:Number(usage?.players??0),storage:Number(usage?.storage??0),playerCost,storageCost,privateStorageCost,singlePlayer,playerLimit:cap});
}
