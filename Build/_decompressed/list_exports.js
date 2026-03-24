const fs = require('fs');
(async () => {
  const wasm = fs.readFileSync('Build/_decompressed/SnowRider3D-gd-1.wasm');
  const mod = await WebAssembly.compile(wasm);
  const exports = WebAssembly.Module.exports(mod).map(e=>e.name);
  console.log('export_count', exports.length);
  exports.slice(0,200).forEach(n=>console.log(n));
})();
