import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {config} from '../src/config.js';
import {pool} from '../src/db.js';
import {compileSearch} from '../src/services/search.js';

test('advanced search returns the same rows as the original PHP-generated MySQL queries',{skip:!config.db.tablePrefix.startsWith('dev_')},async()=>{
  const connection=await pool.getConnection(),prefix='test_search_'+crypto.randomBytes(4).toString('hex')+'_',created:string[]=[];
  const fixture=JSON.parse(fs.readFileSync('tests/fixtures/search-reference.json','utf8'));
  try{
    for(const table of ['users','players']){await connection.query('CREATE TEMPORARY TABLE `'+prefix+table+'` LIKE `'+config.db.tablePrefix+table+'`');created.push(prefix+table);}
    const rows=[
      [1,'alpha@example.test','Alpha User',250,0,1,'2020-12-31 16:30:20'],
      [2,'beta@example.test','Beta',100,-1,0,'2019-01-01 12:00:00'],
      [3,'admin@example.test','Administrator',2000,1,1,'2026-11-01 15:26:37'],
      [4,'other@example.test','Other User',0,0,0,'2020-01-31 17:00:00'],
      [5,'next@example.test','Next User',201,0,1,'2026-11-02 08:00:00'],
    ];
    for(const [uid,email,nickname,score,permission,verified,date]of rows)await connection.query('INSERT INTO `'+prefix+'users` (uid,email,nickname,password,score,permission,verified,register_at,last_sign_at,ip,avatar,is_dark_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[uid,email,nickname,'',score,permission,verified,date,date,'192.0.2.'+uid,0,0]);
    for(let id=1;id<=3;id++)await connection.query('INSERT INTO `'+prefix+'players` (pid,uid,name,tid_skin,tid_cape,last_modified) VALUES (?,?,?,?,?,?)',[id,id,id===1?'Alpha Player':'Player'+id,id===1?1:0,id===2?2:0,'2020-12-31 17:00:00']);
    let comparisons=0;
    for(const item of fixture.queries){
      const table=item.entity,search=compileSearch(table,item.expression,{alias:table,now:new Date(fixture.now),timezone:fixture.timezone});
      const tableSql='`'+prefix+table+'` AS `'+table+'`',originalSql=item.sql.replace('from `'+table+'`','from '+tableSql);
      const projection=search.fields?search.fields.map(field=>'`'+table+'`.`'+field+'`').join(','):'*';
      const tail=(search.limit===null?'':` LIMIT ${search.limit}`)+(search.offset===null?'':search.limit===null?` LIMIT 18446744073709551615 OFFSET ${search.offset}`:` OFFSET ${search.offset}`);
      const migratedSql=`SELECT ${projection} FROM ${tableSql} ${search.where}`+(item.sql.includes(' order by ')?' ORDER BY '+search.orderBy:'')+tail;
      const [expected]:any=await connection.query(originalSql,item.bindings),[actual]:any=await connection.query(migratedSql,search.params);
      assert.deepEqual(actual,expected,item.expression);comparisons++;
    }
    assert.equal(comparisons,27);
  }finally{
    for(const table of created){assert.match(table,/^test_search_[a-f0-9]{8}_(users|players)$/);await connection.query('DROP TEMPORARY TABLE `'+table+'`');}
    connection.release();await pool.end();
  }
});
