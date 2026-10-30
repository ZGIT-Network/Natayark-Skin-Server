import fs from 'node:fs';
const file='src/services/render.ts';
let source=fs.readFileSync(file,'utf8');
source=source.split('\n').map(line=>{
  if(!/boxFace\(members\.(torso|rightArm|leftArm|rightLeg|leftLeg),/.test(line))return line;
  if(line.includes("'top'")) line=line.replace(/, (?:8|20) \* r, (?:8|20) \* r, 0, 4 \* r, P,/, ', 0, 0, 0, 4 * r, P,');
  if(line.includes("'bottom'")) line=line.replace(/, (?:20|32) \* r, (?:20|32) \* r, 0, 4 \* r, P,/, ', 12 * r, 12 * r, 0, 4 * r, P,');
  line=line.replace("members.rightArm, 'right', -4 * r, -4 * r", "members.rightArm, 'right', 0, 0")
    .replace("members.rightArm, 'left', 0, 0", "members.rightArm, 'left', armI, armI")
    .replace("members.leftArm, 'right', 8 * r, 8 * r", "members.leftArm, 'right', 0, 0")
    .replace("members.leftArm, 'left', 12 * r, 12 * r", "members.leftArm, 'left', armI, armI")
    .replace("members.leftLeg, 'right', 4 * r, 4 * r", "members.leftLeg, 'right', 0, 0")
    .replace("members.leftLeg, 'left', 8 * r, 8 * r", "members.leftLeg, 'left', 4 * r, 4 * r");
  return line;
}).join('\n');
fs.writeFileSync(file,source);
