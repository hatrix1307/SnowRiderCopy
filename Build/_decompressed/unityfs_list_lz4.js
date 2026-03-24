const fs = require('fs');

function readNullTerminated(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  return { value: buf.subarray(off, end).toString('utf8'), next: end + 1 };
}

function readU64LE(buf, off) {
  const lo = buf.readUInt32LE(off);
  const hi = buf.readUInt32LE(off + 4);
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

    if (ip >= input.length) break; // done

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

    // Copy match; may overlap.
    for (let i = 0; i < matchLen; i++) {
      out[op + i] = out[matchPos + i];
    }
    op += matchLen;

    if (op === out.length) break;
  }

  if (op !== out.length) {
    // Some encoders leave trailing bytes; tolerate small underfill? No—Unity expects exact.
    throw new Error(`LZ4: output size mismatch ${op} != ${out.length}`);
  }

  return out;
}

function parseUnityFS(bundleBuf) {
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

  const fileSize = readU64LE(bundleBuf, off);
  off += 8;
  const compressedBlocksInfoSize = bundleBuf.readUInt32BE(off);
  off += 4;
  const uncompressedBlocksInfoSize = bundleBuf.readUInt32BE(off);
  off += 4;
  const flags = bundleBuf.readUInt32BE(off);
  off += 4;

  const blocksInfoAtEnd = (flags & 0x80) !== 0;
  let blocksInfoOff;
  if (blocksInfoAtEnd) {
    blocksInfoOff = Number(fileSize) - compressedBlocksInfoSize;
  } else {
    blocksInfoOff = off;
  }

  const blocksInfoComp = bundleBuf.subarray(blocksInfoOff, blocksInfoOff + compressedBlocksInfoSize);
  const compType = flags & 0x3f;
  let blocksInfo;
  if (compType === 0) blocksInfo = blocksInfoComp;
  else if (compType === 2 || compType === 3) blocksInfo = lz4Decompress(blocksInfoComp, uncompressedBlocksInfoSize);
  else throw new Error('unsupported blocks-info compression type: ' + compType);

  let boff = 0;
  boff += 16; // hash
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
    const offset64 = readU64LE(blocksInfo, boff);
    boff += 8;
    const size64 = readU64LE(blocksInfo, boff);
    boff += 8;
    const dflags = blocksInfo.readUInt32BE(boff);
    boff += 4;
    let end = boff;
    while (end < blocksInfo.length && blocksInfo[end] !== 0) end++;
    const path = blocksInfo.subarray(boff, end).toString('utf8');
    boff = end + 1;
    dirs.push({ offset: offset64, size: size64, flags: dflags, path });
  }

  return {
    signature,
    formatVersion,
    unityVersion: unityVersion.value,
    genVersion: genVersion.value,
    fileSize,
    compressedBlocksInfoSize,
    uncompressedBlocksInfoSize,
    flags,
    blocksInfoAtEnd,
    blocks,
    dirs,
    headerEnd: off,
    blocksInfoOff,
  };
}

const dataArchive = fs.readFileSync('Build/_decompressed/SnowRider3D-gd-1.data');
const entries = JSON.parse(fs.readFileSync('Build/_decompressed/data_entries.json', 'utf8'));
const e = entries.find((x) => x.path === 'data.unity3d');
const bundle = dataArchive.subarray(e.dataOffset, e.dataOffset + e.dataSize);

const info = parseUnityFS(bundle);
console.log('UnityFS', info.unityVersion, 'flags=0x' + info.flags.toString(16));
console.log('blockCount', info.blocks.length, 'dirCount', info.dirs.length);
info.dirs.forEach((d) => console.log(String(d.size).padStart(10), d.path));
fs.writeFileSync('Build/_decompressed/unityfs_dirs.json', JSON.stringify(info.dirs, null, 2));
console.log('wrote Build/_decompressed/unityfs_dirs.json');
