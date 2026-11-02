import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateUsage} from '../src/services/usage.js';

const base={score:2000,players:1,storage:75,playerCost:100,storageCost:1,privateStorageCost:25,singlePlayer:false};
test('usage matches credit-based legacy capacity and counts existing uploads',()=>{
  const result=calculateUsage(base);
  assert.deepEqual(result.players,{used:1,limit:21,remaining:20});
  assert.deepEqual(result.storage,{used:75,limit:2075,remaining:2000});
  assert.equal(result.privateStorageRemaining,80);
});
test('single-player limits take precedence over balance without hiding legacy excess',()=>{
  assert.deepEqual(calculateUsage({...base,singlePlayer:true}).players,{used:1,limit:1,remaining:0});
  assert.deepEqual(calculateUsage({...base,singlePlayer:true,players:0}).players,{used:0,limit:1,remaining:1});
  assert.deepEqual(calculateUsage({...base,singlePlayer:true,players:2}).players,{used:2,limit:1,remaining:0});
  assert.deepEqual(calculateUsage({...base,singlePlayer:true,players:0,score:0}).players,{used:0,limit:1,remaining:1});
});
test('fixed player caps combine with the available credit and apply even when creation is free',()=>{
  assert.deepEqual(calculateUsage({...base,playerLimit:3}).players,{used:1,limit:3,remaining:2});
  assert.deepEqual(calculateUsage({...base,playerLimit:3,score:0}).players,{used:1,limit:1,remaining:0});
  assert.deepEqual(calculateUsage({...base,playerLimit:3,playerCost:0}).players,{used:1,limit:3,remaining:2});
  assert.deepEqual(calculateUsage({...base,playerLimit:1,players:2}).players,{used:2,limit:1,remaining:0});
});
test('free rates are unlimited and a negative balance offers no additional paid capacity',()=>{
  const free=calculateUsage({...base,playerCost:0,storageCost:0,privateStorageCost:0});
  assert.equal(free.players.limit,null);assert.equal(free.storage.limit,null);assert.equal(free.privateStorageRemaining,null);
  const debt=calculateUsage({...base,score:-5});
  assert.deepEqual(debt.players,{used:1,limit:1,remaining:0});
  assert.deepEqual(debt.storage,{used:75,limit:75,remaining:0});
});
