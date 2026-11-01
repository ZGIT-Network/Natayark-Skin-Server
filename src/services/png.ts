import {PNG} from 'pngjs';
/** GD accepted trailing metadata after the terminal IEND chunk; keep that legacy behavior. */
export function parsePng(data:Buffer):PNG{
  for(let offset=8;offset+12<=data.length;){
    const length=data.readUInt32BE(offset),end=offset+12+length;
    if(end>data.length)break;
    if(data.toString('ascii',offset+4,offset+8)==='IEND')return PNG.sync.read(data.subarray(0,end));
    offset=end;
  }
  return PNG.sync.read(data);
}
