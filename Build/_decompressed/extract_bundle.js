const fs = require('fs');
const path = require('path');

function readNullTerminated(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  return { value: buf.subarray(off, end).toString('utf8'), next: end + 1 };
}

function readU64BE(buf, off) {
  const hi = buf.readUInt32BE(off);
  const lo = buf.readUInt32BE(off + 4);
  return (BigInt(hi) << 32n) | BigInt(lo);
}

function lz4Decompress(input, outputSize) {
  const out = Buffer.allocUnsafe(outputSize);
  let ip = 0;
  let op = 0;

  const readU16LE = () => {
    if (ip + 2 > input.length) throw new Error('LZ4: unexpected EOF reading offset');
    const v = input[ip] | (input[ip + 1] << 8);
    ip += 2;
    return v;
  };

  while (ip < input.length) {
    const token = input[ip++];
    let litLen = token >>> 4;
    let matchLen = token & 0x0f;

    if (litLen === 15) {
      let b;
      do {
        if (ip >= input.length) throw new Error('LZ4: unexpected EOF reading literal length');
        b = input[ip++];
        litLen += b;
      } while (b === 255);
    }

    if (ip + litLen > input.length) throw new Error('LZ4: literal out of range');
    if (op + litLen > out.length) throw new Error('LZ4: output overflow (literals)');
    input.copy(out, op, ip, ip + litLen);
    ip += litLen;
    op += litLen;

    if (ip >= input.length) break;

    const offset = readU16LE();
    if (offset === 0) throw new Error('LZ4: zero offset');

    if (matchLen === 15) {
      let b;
      do {
        if (ip >= input.length) throw new Error('LZ4: unexpected EOF reading match length');
        b = input[ip++];
        matchLen += b;
      } while (b === 255);
    }
    matchLen += 4;

    const matchPos = op - offset;
    if (matchPos < 0) throw new Error('LZ4: invalid match position');
    if (op + matchLen > out.length) throw new Error('LZ4: output overflow (match)');

    for (let i = 0; i < matchLen; i++) out[op + i] = out[matchPos + i];
    op += matchLen;
    if (op === out.length) break;
  }

  if (op !== out.length) throw new Error(`LZ4: output size mismatch ${op} != ${out.length}`);
  return out;
}

function parseUnityFSHeader(bundleBuf) {
  let off = 0;
  const sigEnd = bundleBuf.indexOf(0);
  const signature = bundleBuf.subarray(0, sigEnd).toString('utf8');
  off = sigEnd + 1;
  if (signature !== 'UnityFS') throw new Error('not UnityFS: ' + signature);

  const formatVersion = bundleBuf.readUInt32BE(off);
  off += 4;
  const unityVersion = readNullTerminated(bundleBuf, off);
  off = unityVersion.next;
  const genVersion = readNullTerminated(bundleBuf, off);
  off = genVersion.next;

  const fileSize = readU64BE(bundleBuf, off);
  off += 8;
  const compressedBlocksInfoSize = bundleBuf.readUInt32BE(off);
  off += 4;
  const uncompressedBlocksInfoSize = bundleBuf.readUInt32BE(off);
  off += 4;
  const flags = bundleBuf.readUInt32BE(off);
  off += 4;

  const blocksInfoAtEnd = (flags & 0x80) !== 0;
  const blocksInfoOff = blocksInfoAtEnd ? Number(fileSize) - compressedBlocksInfoSize : off;
  const blocksInfoComp = bundleBuf.subarray(blocksInfoOff, blocksInfoOff + compressedBlocksInfoSize);

  const compType = flags & 0x3f;
  let blocksInfo;
  if (compType === 0) blocksInfo = blocksInfoComp;
  else if (compType === 2 || compType === 3) blocksInfo = lz4Decompress(blocksInfoComp, uncompressedBlocksInfoSize);
  else throw new Error('unsupported blocks-info compression type: ' + compType);

  let boff = 0;
  boff += 16;
  const blockCount = blocksInfo.readInt32BE(boff);
  boff += 4;
  const blocks = [];
  for (let i = 0; i < blockCount; i++) {
    const uncompressedSize = blocksInfo.readUInt32BE(boff);
    boff += 4;
    const compressedSize = blocksInfo.readUInt32BE(boff);
    boff += 4;
    const bflags = blocksInfo.readUInt16BE(boff);
    boff += 2;
    blocks.push({ uncompressedSize, compressedSize, flags: bflags });
  }
  const dirCount = blocksInfo.readInt32BE(boff);
  boff += 4;
  const dirs = [];
  for (let i = 0; i < dirCount; i++) {
    const offset64 = readU64BE(blocksInfo, boff);
    boff += 8;
    const size64 = readU64BE(blocksInfo, boff);
    boff += 8;
    const dflags = blocksInfo.readUInt32BE(boff);
    boff += 4;
    let end = boff;
    while (end < blocksInfo.length && blocksInfo[end] !== 0) end++;
    const p = blocksInfo.subarray(boff, end).toString('utf8');
    boff = end + 1;
    dirs.push({ offset: Number(offset64), size: Number(size64), flags: dflags, path: p });
  }

  const headerEnd = blocksInfoAtEnd ? off : (blocksInfoOff + compressedBlocksInfoSize);
  // Per UnityFS spec: blocks data begins after the (possibly embedded) blocks info section.
  const dataOff = headerEnd;

  return {
    unityVersion: unityVersion.value,
    genVersion: genVersion.value,
    fileSize: Number(fileSize),
    flags,
    blocks,
    dirs,
    dataOff,
  };
}

function buildUncompressedData(bundleBuf, header) {
  let off = header.dataOff;
  const parts = [];
  let total = 0;
  for (const block of header.blocks) {
    const comp = bundleBuf.subarray(off, off + block.compressedSize);
    off += block.compressedSize;
    const ctype = block.flags & 0x3f;
    let un;
    if (ctype === 0) {
      un = comp;
      if (un.length !== block.uncompressedSize) {
        throw new Error('block size mismatch for uncompressed block');
      }
    } else if (ctype === 2 || ctype === 3) {
      un = lz4Decompress(comp, block.uncompressedSize);
    } else {
      throw new Error('unsupported block compression: ' + ctype);
    }
    parts.push(un);
    total += un.length;
  }
  return Buffer.concat(parts, total);
}

const dataArchive = fs.readFileSync('Build/_decompressed/SnowRider3D-gd-1.data');
const entries = JSON.parse(fs.readFileSync('Build/_decompressed/data_entries.json', 'utf8'));
const e = entries.find((x) => x.path === 'data.unity3d');
const bundle = dataArchive.subarray(e.dataOffset, e.dataOffset + e.dataSize);

const header = parseUnityFSHeader(bundle);
console.log('parsed bundle, unityVersion', header.unityVersion, 'blocks', header.blocks.length, 'dirs', header.dirs.length);

const outDir = 'Build/_decompressed/bundle_extracted';
fs.mkdirSync(outDir, { recursive: true });

const uncompressed = buildUncompressedData(bundle, header);
console.log('uncompressed data bytes', uncompressed.length);

for (const d of header.dirs) {
  const fileBytes = uncompressed.subarray(d.offset, d.offset + d.size);
  const outPath = path.join(outDir, d.path.replaceAll('..','__'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, fileBytes);
  console.log('wrote', outPath, fileBytes.length);
}
