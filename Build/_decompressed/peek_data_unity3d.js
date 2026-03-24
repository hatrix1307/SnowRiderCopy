const fs = require('fs');
const buf = fs.readFileSync('Build/_decompressed/SnowRider3D-gd-1.data');
const entries = JSON.parse(fs.readFileSync('Build/_decompressed/data_entries.json','utf8'));
const e = entries.find(x=>x.path==='data.unity3d');
const sub = buf.subarray(e.dataOffset, e.dataOffset + Math.min(e.dataSize, 256));
function hex(b){return b.toString(16).padStart(2,'0');}
console.log('data.unity3d size', e.dataSize);
console.log(Array.from(sub).map(hex).join(' '));
console.log('ascii:', Array.from(sub).map(x=> (x>=0x20 && x<=0x7e)?String.fromCharCode(x):'.').join(''));
