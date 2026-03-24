const fs = require('fs');
(async () => {
  const wasm = fs.readFileSync('Build/_decompressed/SnowRider3D-gd-1.wasm');
  const mod = await WebAssembly.compile(wasm);
  const exports = WebAssembly.Module.exports(mod).map(e=>e.name);
  const needles = process.argv.slice(2);
  for (const needle of needles) {
    console.log('---', needle, '---');
    exports.filter(n=>n.toLowerCase().includes(needle.toLowerCase())).slice(0,200).forEach(n=>console.log(n));
  }
})();
