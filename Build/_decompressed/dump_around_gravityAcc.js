const fs = require('fs');
const buf = fs.readFileSync('Build/_decompressed/SnowRider3D-gd-1.data');
const off = 4374133;
const start = Math.max(0, off - 256);
const end = Math.min(buf.length, off + 256);
const slice = buf.subarray(start, end);
function hex(b){return b.toString(16).padStart(2,'0');}
let out='';
for (let i=0;i<slice.length;i+=16){
  const chunk = slice.subarray(i,i+16);
  out += (start+i).toString(16).padStart(8,'0')+': ';
  out += Array.from(chunk).map(hex).join(' ');
  out += '  ';
  out += Array.from(chunk).map(x=> (x>=0x20 && x<=0x7e)?String.fromCharCode(x):'.').join('');
  out += '\n';
}
console.log(out);
