const fs = require('fs');

function readNullTerminated(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  return { value: buf.subarray(off, end).toString('utf8'), next: end + 1 };
}

function readU64LE(buf, off) {
  const lo = buf.readUInt32LE(off);
  const hi = buf.readUInt32LE(off + 4);
  return BigInt(hi) << 32n | BigInt(lo);
}

function align(off, a) {
  const r = off % a;
  return r === 0 ? off : off + (a - r);
}

function decompressBlock(data, flags) {
  const compressionType = flags & 0x3f;
  if (compressionType === 0) return data; // none
  if (compressionType === 2 || compressionType === 3) {
    // LZ4 or LZ4HC. Node doesn't have LZ4 built-in.
    throw new Error('LZ4 compressed blocks-info not supported in this script.');
  }
  if (compressionType === 1) {
    // LZMA - also not built-in.
    throw new Error('LZMA compressed blocks-info not supported in this script.');
  }
  throw new Error('unknown compression type ' + compressionType);
}

function parseUnityFS(bundleBuf) {
  let off = 0;
  const sigEnd = bundleBuf.indexOf(0);
  const signature = bundleBuf.subarray(0, sigEnd).toString('utf8');
  off = sigEnd + 1;
  if (signature !== 'UnityFS') throw new Error('not UnityFS: ' + signature);

  const formatVersion = bundleBuf.readUInt32BE(off); off += 4;
  const unityVersion = readNullTerminated(bundleBuf, off); off = unityVersion.next;
  const genVersion = readNullTerminated(bundleBuf, off); off = genVersion.next;

  const fileSize = readU64LE(bundleBuf, off); off += 8;
  const compressedBlocksInfoSize = bundleBuf.readUInt32BE(off); off += 4;
  const uncompressedBlocksInfoSize = bundleBuf.readUInt32BE(off); off += 4;
  const flags = bundleBuf.readUInt32BE(off); off += 4;

  const blocksInfoAtEnd = (flags & 0x80) !== 0;

  let blocksInfoOff;
  if (blocksInfoAtEnd) {
    blocksInfoOff = Number(fileSize) - compressedBlocksInfoSize;
  } else {
    blocksInfoOff = off;
  }

  const blocksInfoComp = bundleBuf.subarray(blocksInfoOff, blocksInfoOff + compressedBlocksInfoSize);
  // blocks-info compression is stored in flags bits 0..5 (compression type)
  // In UnityFS, blocks-info itself uses compression type = flags & 0x3f
  const blocksInfo = decompressBlock(blocksInfoComp, flags);

  // If no compression, blocksInfo is the raw bytes; else we'd need lz4/lzma.
  let boff = 0;
  const uncompressedDataHash = blocksInfo.subarray(boff, boff + 16); boff += 16;
  const blockCount = blocksInfo.readInt32BE(boff); boff += 4;
  const blocks = [];
  for (let i = 0; i < blockCount; i++) {
    const uncompressedSize = blocksInfo.readUInt32BE(boff); boff += 4;
    const compressedSize = blocksInfo.readUInt32BE(boff); boff += 4;
    const bflags = blocksInfo.readUInt16BE(boff); boff += 2;
    blocks.push({ uncompressedSize, compressedSize, flags: bflags });
  }
  const dirCount = blocksInfo.readInt32BE(boff); boff += 4;
  const dirs = [];
  for (let i = 0; i < dirCount; i++) {
    const offset64 = readU64LE(blocksInfo, boff); boff += 8;
    const size64 = readU64LE(blocksInfo, boff); boff += 8;
    const dflags = blocksInfo.readUInt32BE(boff); boff += 4;
    // read null-terminated path
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
  };
}

const dataArchive = fs.readFileSync('Build/_decompressed/SnowRider3D-gd-1.data');
const entries = JSON.parse(fs.readFileSync('Build/_decompressed/data_entries.json','utf8'));
const e = entries.find(x=>x.path==='data.unity3d');
const bundle = dataArchive.subarray(e.dataOffset, e.dataOffset + e.dataSize);

try {
  const info = parseUnityFS(bundle);
  console.log('UnityFS', info.unityVersion, 'flags=0x'+info.flags.toString(16), 'blocksInfoAtEnd', info.blocksInfoAtEnd);
  console.log('blockCount', info.blocks.length, 'dirCount', info.dirs.length);
  info.dirs.slice(0,200).forEach(d=>console.log(String(d.size).padStart(10), d.path));
} catch (err) {
  console.error(String(err && err.stack || err));
  process.exitCode = 1;
}
