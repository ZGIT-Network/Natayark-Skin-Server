/** Restricted implementation of the SearchString grammar used by the original models. */
export type SearchEntity = 'users' | 'players' | 'reports';
type Column = { name: string; date?: boolean; boolean?: boolean; searchable?: boolean };
const definitions: Record<SearchEntity, Column[]> = {
  users: [
    {name:'uid'}, {name:'email',searchable:true}, {name:'nickname',searchable:true},
    ...['avatar','score','permission','ip'].map(name=>({name})),
    {name:'last_sign_at',date:true}, {name:'register_at',date:true},
    {name:'verified',boolean:true}, {name:'is_dark_mode',boolean:true},
  ],
  players: [
    ...['pid','uid','tid_skin','tid_cape'].map(name=>({name})),
    {name:'name',searchable:true}, {name:'last_modified',date:true,boolean:true},
  ],
  reports: [
    ...['id','tid','uploader','reporter','reason','status'].map(name=>({name})), {name:'report_at',date:true},
  ],
};
export class SearchError extends Error { statusCode=422; }
type Token = {type:'value'|'symbol'|'end';text:string;quoted?:boolean};
type Leaf = {kind:'leaf';key?:string;op?:string;values:string[];nullValue?:boolean};
type Node = Leaf | {kind:'and'|'or';nodes:Node[]} | {kind:'not';node:Node};
export type SearchQuery = {
  where:string;params:unknown[];orderBy:string;fields:string[]|null;
  limit:number|null;offset:number|null;
};
const error=(message:string):never=>{throw new SearchError(message);};
function tokenize(source:string):Token[]{
  if(source.length>4096)error('搜索表达式最多 4096 个字符');
  const tokens:Token[]=[];let at=0;
  while(at<source.length){
    if(/\s/.test(source[at])){at++;continue;}
    const char=source[at++];
    if(char==='"'||char==="'"){
      let text='',closed=false;
      while(at<source.length){const next=source[at++];if(next===char){closed=true;break;}if(next==='\\'&&(source[at]===char||source[at]==='\\'))text+=source[at++];else text+=next;}
      if(!closed)error('引号没有闭合');tokens.push({type:'value',text,quoted:true});
    }else if('():,=<>!'.includes(char)){
      let text=char;if('<>!'.includes(char)&&source[at]==='=')text+=source[at++];
      if(text==='!')error('请使用 not 或 != 表示否定');tokens.push({type:'symbol',text});
    }else{
      let text=char;while(at<source.length&&!/[\s():,=<>!"']/.test(source[at]))text+=source[at++];
      tokens.push({type:'value',text});
    }
    if(tokens.length>512)error('搜索条件过多');
  }
  return [...tokens,{type:'end',text:''}];
}

/** Calendar arithmetic is done in the site's timezone, independent of the host OS timezone. */
export function searchDateRange(value:string,now=new Date(),timezone='Asia/Shanghai'):[string,string]|null{
  const current=new Intl.DateTimeFormat('sv-SE',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(now).replace(',','');
  const clock=/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(current)!;
  let y=Number(clock[1]),m=Number(clock[2]),d=Number(clock[3]),h=0,min=0,s=0,micro='';
  let precision='day',matched=true;const text=value.trim().toLowerCase();let match:RegExpExecArray|null;
  const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const year=(raw:string)=>raw.length===2?(Number(raw)<70?2000:1900)+Number(raw):Number(raw);
  if((match=/^(\d{2}|\d{4})$/.exec(text))){y=year(match[1]);m=d=1;precision='year';}
  else if((match=/^(\d{4})[-/ ](\d{1,2})$/.exec(text))){y=+match[1];m=+match[2];d=1;precision='month';}
  else if((match=/^(\d{1,2})[-/ ](\d{2}|\d{4})$/.exec(text))){m=+match[1];y=year(match[2]);d=1;precision='month';}
  else if((match=/^(?:(\d{2}|\d{4})\s+([a-z]+)|([a-z]+)\s+(\d{2}|\d{4}))$/.exec(text))){
    y=year(match[1]||match[4]);m=months.indexOf((match[2]||match[3]).slice(0,3))+1;d=1;precision='month';
  }else if((match=/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](\d{1,2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?)?$/.exec(text))){
    y=+match[1];m=+match[2];d=+match[3];h=+(match[4]||0);min=+(match[5]||0);s=+(match[6]||0);micro=match[7]||'';
    precision=match[6]?'second':match[5]?'minute':match[4]?'hour':'day';
  }else if((match=/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text))){m=+match[1];d=+match[2];y=year(match[3]);}
  else if((match=/^(?:([a-z]+)\s+(\d{1,2}),?\s+(\d{4})|(\d{1,2})\s+([a-z]+)\s+(\d{4}))(?:\s+(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?\s*(am|pm)?)?$/.exec(text))){
    m=months.indexOf((match[1]||match[5]).slice(0,3))+1;d=+(match[2]||match[4]);y=+(match[3]||match[6]);
    h=+(match[7]||0);min=+(match[8]||0);s=+(match[9]||0);
    if(match[10]){if(h<1||h>12)return null;h=h%12+(match[10]==='pm'?12:0);}
    precision=match[9]?'second':match[8]?'minute':match[7]?'hour':'day';
  }else if(['today','yesterday','tomorrow','now'].includes(text)){
    if(text==='now'){h=+clock[4];min=+clock[5];s=+clock[6];precision='second';}
    else d+=text==='tomorrow'?1:text==='yesterday'?-1:0;
    const shifted=new Date(Date.UTC(y,m-1,d));y=shifted.getUTCFullYear();m=shifted.getUTCMonth()+1;d=shifted.getUTCDate();
  }else if((match=/^(?:(last|next|this)\s+(day|week|month|year)|([+-]?\d+)\s+(days?|weeks?|months?|years?)(?:\s+(ago))?)$/.exec(text))){
    const amount=match[1]?(match[1]==='last'?-1:match[1]==='next'?1:0):Number(match[3])*(match[5]?-1:1),unit=(match[2]||match[4]).replace(/s$/,'');
    if(!Number.isSafeInteger(amount)||Math.abs(amount)>10000)return null;
    let shifted:Date;
    if(unit==='month')shifted=new Date(Date.UTC(y,m-1+amount,d));else if(unit==='year')shifted=new Date(Date.UTC(y+amount,m-1,d));
    else if(unit==='week'&&match[1])shifted=new Date(Date.UTC(y,m-1,d-(new Date(Date.UTC(y,m-1,d)).getUTCDay()+6)%7+amount*7));
    else shifted=new Date(Date.UTC(y,m-1,d+amount*(unit==='week'?7:1)));
    y=shifted.getUTCFullYear();m=shifted.getUTCMonth()+1;d=shifted.getUTCDate();
    h=+clock[4];min=+clock[5];s=+clock[6];precision=s?'second':min?'minute':h?'hour':'day';
  }else matched=false;
  if(!matched||y<100||y>9999||m<1||m>12||d<1||d>31||h>23||min>59||s>59)return null;
  const start=new Date(Date.UTC(y,m-1,d,h,min,s));
  if(start.getUTCMonth()!==m-1||start.getUTCDate()!==d)return null;
  const format=(date:Date)=>date.toISOString().slice(0,19).replace('T',' ');
  if(precision==='second'){const exact=format(start)+(micro?'.'+micro.padEnd(6,'0'):'');return[exact,exact];}
  let end:Date;
  if(precision==='year')end=new Date(Date.UTC(y+1,0,1));else if(precision==='month')end=new Date(Date.UTC(y,m,1));
  else if(precision==='day')end=new Date(+start+86400000);else if(precision==='hour')end=new Date(+start+3600000);else end=new Date(+start+60000);
  return [format(start),format(new Date(+end-1000))];
}

export function compileSearch(entity:SearchEntity,source:string,options:{alias?:string;defaultOrder?:string;numericIds?:boolean;now?:Date;timezone?:string}={}):SearchQuery{
  const columns=definitions[entity],aliases=new Map(columns.map(column=>[column.name,column]));
  if(entity==='players'){aliases.set('skin',aliases.get('tid_skin')!);aliases.set('cape',aliases.get('tid_cape')!);}
  const qualifier=options.alias?(/^[a-z][a-z0-9_]*$/i.test(options.alias)?'`'+options.alias+'`.':error('无效的表别名')):'';
  const sqlColumn=(column:Column)=>qualifier+'`'+column.name+'`';
  const tokens=tokenize(source);let at=0,depth=0;
  const result:SearchQuery={where:'',params:[],orderBy:options.defaultOrder||sqlColumn(columns[0])+' DESC',fields:null,limit:null,offset:null};
  const peek=()=>tokens[at],take=()=>tokens[at++];
  const is=(word:string)=>peek().type!=='end'&&!peek().quoted&&peek().text.toLowerCase()===word;
  const scalar=()=>{const token=take();if(token.type!=='value'||!token.quoted&&['and','or','not','in'].includes(token.text.toLowerCase()))error('条件缺少有效的值');return token.text;};
  const directive=(leaf:Leaf,negated:boolean):boolean=>{
    if(!leaf.key||!['sort','fields','limit','from'].includes(leaf.key))return false;
    if(leaf.op!=='='&&leaf.op!=='in')error('排序、字段和分页指令只能使用冒号、等号或列表');
    if(leaf.key==='limit'||leaf.key==='from'){
      if(negated||leaf.op==='in'||leaf.values.length!==1||!/^\d+$/.test(leaf.values[0])||!Number.isSafeInteger(Number(leaf.values[0])))error('分页指令必须是非负整数');
      if(leaf.key==='limit')result.limit=Number(leaf.values[0]);else result.offset=Number(leaf.values[0]);return true;
    }
    if(leaf.key==='sort'){
      if(negated)error('排序不能使用 not');
      result.orderBy=leaf.values.map(value=>{const descending=value.startsWith('-'),key=descending?value.slice(1):value,column=aliases.get(key);if(!column)error('未知的排序字段：'+key);return sqlColumn(column!)+(descending?' DESC':' ASC');}).join(', ');
    }else{
      const names=leaf.values.map(key=>{const column=aliases.get(key);if(!column)error('未知的显示字段：'+key);return column!.name;});
      result.fields=columns.filter(column=>negated?!names.includes(column.name):names.includes(column.name)).map(column=>column.name);
      if(!result.fields.length)error('至少保留一个显示字段');
    }
    return true;
  };
  function terminal():Node{
    if(++depth>32)error('搜索条件嵌套最多 32 层');
    try{
      if(is('not')){take();return{kind:'not',node:terminal()};}
      if(is('(')){take();const expression=or();if(!is(')'))error('括号没有闭合');take();return expression;}
      const first=take();if(first.type!=='value'||!first.quoted&&['and','or','in'].includes(first.text.toLowerCase()))return error('搜索条件不完整');
      if(!first.quoted&&(peek().type==='symbol'&&[':', '=','!=','<','>','<=','>='].includes(peek().text)||is('in'))){
        const op=take().text.toLowerCase(),values:string[]=[];let nullValue=false;
        if(op==='in'){
          if(!is('('))error('in 后需要括号列表');take();values.push(scalar());while(is(',')){take();values.push(scalar());}if(!is(')'))error('列表括号没有闭合');take();
        }else{nullValue=peek().text==='NULL'&&!peek().quoted;values.push(scalar());while(is(',')){if(![':', '='].includes(op))error('比较条件不接受列表');take();values.push(scalar());}}
        return{kind:'leaf',key:first.text,op:op===':'?'=':op,values,nullValue};
      }
      return{kind:'leaf',values:[first.text],key:first.quoted?undefined:aliases.has(first.text)?first.text:undefined};
    }finally{depth--;}
  }
  function and():Node{const nodes=[terminal()];while(peek().type!=='end'&&!is(')')&&!is('or')){if(is('and'))take();nodes.push(terminal());}return nodes.length===1?nodes[0]:{kind:'and',nodes};}
  function or():Node{const nodes=[and()];while(is('or')){take();nodes.push(and());}return nodes.length===1?nodes[0]:{kind:'or',nodes};}
  const inverse:Record<string,string>={'=':'!=','!=':'=','>':'<=','>=':'<','<':'>=','<=':'>'};
  function compile(node:Node,negated=false):string{
    if(node.kind==='not')return compile(node.node,!negated);
    if(node.kind==='and'||node.kind==='or'){
      const operator=(node.kind==='and')!==negated?' AND ':' OR ',parts=node.nodes.map(child=>compile(child,negated)).filter(Boolean);
      return parts.length?'('+parts.join(operator)+')':'';
    }
    const leaf=node as Leaf;if(directive(leaf,negated))return '';
    const column=leaf.key?aliases.get(leaf.key):undefined;
    if(leaf.op&&!column)error('未知的搜索字段：'+leaf.key);
    if(!leaf.op){
      if(column?.date&&column.boolean)return sqlColumn(column)+(negated?' IS NULL':' IS NOT NULL');
      if(column?.boolean){result.params.push(negated?0:1);return sqlColumn(column)+' = ?';}
      const searchable=columns.filter(item=>item.searchable||(entity==='reports'&&item.name==='reason'));
      const parts=searchable.map(item=>{result.params.push('%'+leaf.values[0]+'%');return sqlColumn(item)+(negated?' NOT LIKE ?':' LIKE ?');});
      if(options.numericIds&&/^\d+$/.test(leaf.values[0]))for(const name of entity==='players'?['pid','uid']:[columns[0].name]){result.params.push(leaf.values[0]);parts.push(sqlColumn(aliases.get(name)!)+(negated?' != ?':' = ?'));}
      return parts.length?'('+parts.join(negated?' AND ':' OR ')+')':'1=1';
    }
    const field=sqlColumn(column!);
    if(leaf.op==='in'||leaf.values.length>1){result.params.push(...leaf.values);return field+(negated?' NOT IN (':' IN (')+leaf.values.map(()=>'?').join(',')+')';}
    const raw=leaf.values[0];let op=negated?inverse[leaf.op]||leaf.op:leaf.op;
    if(leaf.nullValue)return field+(op==='!='?' IS NOT NULL':' IS NULL');
    if(column!.date){
      const range=searchDateRange(raw,options.now,options.timezone);
      if(range){
        if(range[0]===range[1]){result.params.push(range[0]);return field+' '+op+' ?';}
        if(['<','>=','>','<='].includes(op)){result.params.push(['<','>='].includes(op)?range[0]:range[1]);return field+' '+op+' ?';}
        result.params.push(...range);return '('+field+(op==='!='?' < ? OR ':' >= ? AND ')+field+(op==='!='?' > ?':' <= ?')+')';
      }
    }
    result.params.push(raw);
    return field+' '+op+' ?';
  }
  if(peek().type==='end')return result;
  const tree=or();if(peek().type!=='end')error('存在多余的括号或条件');
  const expression=compile(tree);result.where=expression?'WHERE '+expression:'';return result;
}
