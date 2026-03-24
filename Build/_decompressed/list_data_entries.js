const fs = require('fs');
const buf = fs.readFileSync('Build/_decompressed/SnowRider3D-gd-1.data');
function readU32LE(off){return buf.readUInt32LE(off);} 
const magic = Buffer.from('UnityWebData1.0\0','utf8');
if (!buf.subarray(0, magic.length).equals(magic)) throw new Error('bad magic');
let off = magic.length;
const headerSize = readU32LE(off); off += 4;
const entries = [];
while (off < headerSize) {
  const dataOffset = readU32LE(off); off += 4;
  const dataSize = readU32LE(off); off += 4;
  const pathLen = readU32LE(off); off += 4;
  const p = buf.subarray(off, off + pathLen).toString('utf8'); off += pathLen;
  entries.push({ path: p, dataOffset, dataSize });
}
console.log('entries', entries.length);
entries
  .sort((a,b)=>b.dataSize-a.dataSize)
  .slice(0,50)
  .forEach(e=>console.log(String(e.dataSize).padStart(10), e.path));
// also dump all paths
fs.writeFileSync('Build/_decompressed/data_entries.json', JSON.stringify(entries, null, 2));
console.log('wrote Build/_decompressed/data_entries.json');
