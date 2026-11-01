import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {compileSearch,searchDateRange,SearchError} from '../src/services/search.js';
const reference=JSON.parse(fs.readFileSync('tests/fixtures/search-reference.json','utf8'));

test('search dates preserve the original PHP calendar precision and relative clock',()=>{
  for(const item of reference.dates)assert.deepEqual(searchDateRange(item.value,new Date(reference.now),reference.timezone),item.range,item.value);
  assert.equal(searchDateRange('2020-02-30'),null);assert.equal(searchDateRange('2020-13'),null);
  assert.deepEqual(searchDateRange('today',new Date('2026-11-01T23:30:00Z'),'Asia/Shanghai'),['2026-11-02 00:00:00','2026-11-02 23:59:59']);
});
test('search conditions use bound values and whitelisted fields, with correct negation and directives',()=>{
  const search=compileSearch('users','not (verified or score<100) (email:"a@example.test" or nickname:"Alpha User") sort:-score,uid fields:uid,nickname');
  assert.deepEqual(search.params,[0,'100','a@example.test','Alpha User']);assert.match(search.where,/AND/);assert.equal(search.orderBy,'`score` DESC, `uid` ASC');assert.deepEqual(search.fields,['uid','nickname']);
  const injection=compileSearch('users','nickname:"\' OR 1=1 --"');assert.equal(injection.where,'WHERE `nickname` = ?');assert.deepEqual(injection.params,["' OR 1=1 --"]);
  assert.deepEqual(compileSearch('players','skin:1 not cape:0').params,['1','0']);
  assert.equal(compileSearch('users','email:"NULL"').where,'WHERE `email` = ?');assert.equal(compileSearch('users','not email:NULL').where,'WHERE `email` IS NOT NULL');
  assert.match(compileSearch('users','not register_at:2020').where,/< \? OR.*> \?/);
  assert.equal(compileSearch('users','not fields:email,ip limit:1 from:10').limit,1);
});
test('invalid search never silently returns the full database and has bounded complexity',()=>{
  for(const source of ['password:secret','sort:password','fields:remember_token','uid in ()','(verified','verified or','not','score>1,2','nickname:"unfinished','limit:-1','from:1.5','sort:uid;DROP','fields:unknown', '('.repeat(33)+'verified'+')'.repeat(33),'a'.repeat(4097)])assert.throws(()=>compileSearch('users',source),SearchError,source);
});
