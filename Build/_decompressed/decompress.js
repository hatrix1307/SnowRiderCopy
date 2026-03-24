const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function gunzip(inPath, outPath){
  const input = fs.readFileSync(inPath);
  const output = zlib.gunzipSync(input);
  fs.writeFileSync(outPath, output);
  console.log('gunzip', path.basename(inPath), '->', path.basename(outPath), 'bytes', output.length);
}

gunzip('Build/SnowRider3D-gd-1.data.unityweb', 'Build/_decompressed/SnowRider3D-gd-1.data');
gunzip('Build/SnowRider3D-gd-1.wasm.code.unityweb', 'Build/_decompressed/SnowRider3D-gd-1.wasm');
gunzip('Build/SnowRider3D-gd-1.wasm.framework.unityweb', 'Build/_decompressed/SnowRider3D-gd-1.wasm.framework');
