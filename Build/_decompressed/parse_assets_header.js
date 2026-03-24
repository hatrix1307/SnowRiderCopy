const fs = require('fs');
const buf = fs.readFileSync('Build/_decompressed/bundle_extracted/sharedassets0.assets');

function readCString(off){
  let end=off;
  while(end<buf.length && buf[end]!==0) end++;
  return {str: buf.subarray(off,end).toString('utf8'), next: end+1};
}

// header values are big endian for first part, then endian flag tells rest endianness.
const metadataSize = buf.readUInt32BE(0);
const fileSize = buf.readUInt32BE(4);
const version = buf.readUInt32BE(8);
const dataOffset = buf.readUInt32BE(12);
const endian = buf[16];
const reserved = buf.subarray(17,20);
let off=20;
const unityVer = readCString(off); off = unityVer.next;
const targetPlatform = endian===0 ? buf.readUInt32LE(off) : buf.readUInt32BE(off); off+=4;
const enableTypeTree = buf[off] !== 0; off += 1;

console.log({metadataSize,fileSize,actualSize:buf.length,version,dataOffset,endian,targetPlatform,enableTypeTree,unityVersion:unityVer.str});
console.log('headerEndGuess', off);
