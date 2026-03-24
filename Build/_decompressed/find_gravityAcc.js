const fs = require('fs');
const path = 'Build/_decompressed/SnowRider3D-gd-1.data';
const buf = fs.readFileSync(path);
const needle = Buffer.from('gravityAcc','utf8');
let idx = 0;
let hits = [];
while (true) {
  const pos = buf.indexOf(needle, idx);
  if (pos === -1) break;
  hits.push(pos);
  idx = pos + 1;
  if (hits.length > 50) break;
}
console.log('hits', hits.length);
hits.forEach((p,i)=>console.log(i, p));
