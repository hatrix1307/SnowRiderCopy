const fs = require('fs');

const filePath = process.argv[2];
const minLen = Number(process.argv[3] || 4);
const data = fs.readFileSync(filePath);

let current = [];
function flush(){
  if(current.length >= minLen){
    const s = Buffer.from(current).toString('utf8');
    // Filter out super-noisy strings (mostly punctuation)
    const alpha = s.replace(/[^A-Za-z]/g,'').length;
    if(alpha >= Math.max(3, Math.floor(s.length * 0.25))) {
      console.log(s);
    }
  }
  current = [];
}

for (let i=0;i<data.length;i++){
  const b = data[i];
  if (b >= 0x20 && b <= 0x7E) current.push(b);
  else flush();
}
flush();
