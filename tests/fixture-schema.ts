import fs from 'node:fs';
const statements=fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8').replace(/\/\*[\s\S]*?\*\//g,'').split(';').map(value=>value.trim()).filter(Boolean);
/** Empty fixture tables come from the distributable schema, never a developer's original database. */
export function fixtureSchema(table:string):string{
  if(!/^[a-z_]+$/.test(table))throw new Error('Invalid fixture table');
  const statement=statements.find(sql=>sql.startsWith('CREATE TABLE `'+table+'`'));
  if(!statement)throw new Error('Missing fixture schema: '+table);
  return statement;
}
