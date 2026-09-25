// Dependency-free FLAC trimming: drop whole frames from the start.
//
// FLAC frames are independent (no bit reservoir like MP3), so the remaining
// audio is bit-identical to the original. Cuts land on frame boundaries, so
// the cut is accurate to about half a block (~±46 ms at 4096 samples/44.1 kHz).
//
// What must be rewritten after dropping frames:
//   * STREAMINFO: total sample count is updated; the audio MD5 can't be
//     recomputed without decoding, so it is set to zeros (= "unknown", which
//     the spec allows and decoders skip).
//   * Every frame header: frame/sample numbers restart from 0, so each
//     header is re-encoded and both its CRC-8 and the frame's CRC-16 are
//     recomputed. Without this, libFLAC refuses the file.
// SEEKTABLE blocks would point at removed frames, so they are dropped.

const CRC8 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
}
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 8;
  for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
  CRC16[i] = c;
}
function crc8(buf, start, end) {
  let c = 0;
  for (let i = start; i < end; i++) c = CRC8[c ^ buf[i]];
  return c;
}
function crc16(buf, start, end) {
  let c = 0;
  for (let i = start; i < end; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ buf[i]];
  return c;
}

const BLOCK_SIZES = { 1: 192, 2: 576, 3: 1152, 4: 2304, 5: 4608, 8: 256, 9: 512, 10: 1024, 11: 2048, 12: 4096, 13: 8192, 14: 16384, 15: 32768 };

// Decode FLAC's UTF-8-style variable-length number (up to 36 bits).
function readCodedNumber(buf, pos) {
  const b = buf[pos];
  if (b < 0x80) return { value: b, length: 1 };
  let n = 0;
  while (b & (0x80 >> n)) n++;
  if (n < 2 || n > 7) return null;
  let v = b & (0xff >> (n + 1));
  for (let i = 1; i < n; i++) {
    if (pos + i >= buf.length || (buf[pos + i] & 0xc0) !== 0x80) return null;
    v = v * 64 + (buf[pos + i] & 0x3f); // multiply, not shift: values can exceed 32 bits
  }
  return { value: v, length: n };
}

function writeCodedNumber(value) {
  if (value < 0x80) return Buffer.from([value]);
  let n = 2;
  while (value >= Math.pow(2, 6 * (n - 1) + (7 - n))) n++;
  const out = Buffer.alloc(n);
  let v = value;
  for (let i = n - 1; i >= 1; i--) {
    out[i] = 0x80 | (v % 64);
    v = Math.floor(v / 64);
  }
  out[0] = ((0xff << (8 - n)) & 0xff) | v;
  return out;
}

// Parse a frame header at pos. Returns null unless the sync code, fields and CRC-8 all check out.
function parseFrameHeader(buf, pos) {
  if (pos + 6 > buf.length || buf[pos] !== 0xff || (buf[pos + 1] & 0xfe) !== 0xf8) return null;
  const variable = buf[pos + 1] & 1;
  const bsCode = buf[pos + 2] >> 4;
  const srCode = buf[pos + 2] & 15;
  if (bsCode === 0 || srCode === 15) return null;
  const num = readCodedNumber(buf, pos + 4);
  if (!num) return null;
  let q = pos + 4 + num.length;
  const extStart = q;
  let blockSize;
  if (bsCode === 6) { blockSize = buf[q] + 1; q += 1; }
  else if (bsCode === 7) { blockSize = buf.readUInt16BE(q) + 1; q += 2; }
  else blockSize = BLOCK_SIZES[bsCode];
  if (blockSize === undefined) return null;
  if (srCode === 12) q += 1;
  else if (srCode === 13 || srCode === 14) q += 2;
  if (q >= buf.length || crc8(buf, pos, q) !== buf[q]) return null;
  return { off: pos, variable, blockSize, number: num.value, numLength: num.length, extStart, extEnd: q, headerEnd: q + 1 };
}

// Locate every frame. A boundary is only accepted if the next header is valid,
// its number is the expected successor, and the CRC-16 of the frame before it checks out.
function scanFrames(buf, start) {
  const frames = [];
  let cur = parseFrameHeader(buf, start);
  if (!cur) throw new Error("No valid FLAC frame found after metadata");
  for (;;) {
    let found = null;
    for (let q = cur.headerEnd + 1; q < buf.length - 1; q++) {
      if (buf[q] !== 0xff || (buf[q + 1] & 0xfe) !== 0xf8) continue;
      const nh = parseFrameHeader(buf, q);
      if (!nh) continue;
      const expected = cur.number + (cur.variable ? cur.blockSize : 1);
      if (nh.number !== expected) continue;
      if (crc16(buf, cur.off, q - 2) !== buf.readUInt16BE(q - 2)) continue;
      found = nh;
      break;
    }
    if (!found) {
      // No valid next frame: either this is the true last frame, or the data is damaged.
      if (crc16(buf, cur.off, buf.length - 2) !== buf.readUInt16BE(buf.length - 2)) {
        const at = frames.length;
        throw new Error(
          `FLAC data is corrupt or truncated near frame ${at} (~${Math.round(cur.off / 1024)} KiB in); ` +
            `could not find a frame that passes its CRC`
        );
      }
      cur.size = buf.length - cur.off;
      frames.push(cur);
      return frames;
    }
    cur.size = found.off - cur.off;
    frames.push(cur);
    cur = found;
  }
}

function trimFlac(buf, seconds) {
  if (buf.length < 42 || buf.toString("latin1", 0, 4) !== "fLaC") throw new Error("Not a FLAC file");

  // Walk metadata blocks.
  const blocks = [];
  let pos = 4;
  for (;;) {
    if (pos + 4 > buf.length) throw new Error("Truncated FLAC metadata");
    const isLast = buf[pos] >> 7;
    const type = buf[pos] & 0x7f;
    const len = buf.readUIntBE(pos + 1, 3);
    blocks.push({ type, data: buf.subarray(pos + 4, pos + 4 + len) });
    pos += 4 + len;
    if (isLast) break;
  }
  if (blocks[0].type !== 0 || blocks[0].data.length !== 34) throw new Error("FLAC has no valid STREAMINFO");
  const si = Buffer.from(blocks[0].data);
  const packed = si.readBigUInt64BE(10);
  const sampleRate = Number(packed >> 44n);
  if (!sampleRate) throw new Error("STREAMINFO has no sample rate");

  const frames = scanFrames(buf, pos);
  const variable = frames[0].variable === 1;

  // Pick the frame boundary nearest the requested cut point.
  const target = Math.round(seconds * sampleRate);
  let skip = 0;
  let skipped = 0;
  while (skip < frames.length && skipped + frames[skip].blockSize / 2 <= target) {
    skipped += frames[skip].blockSize;
    skip++;
  }
  if (skip >= frames.length) throw new Error(`Audio is shorter than ${seconds}s; nothing would be left`);

  const kept = frames.slice(skip);
  let keptSamples = 0;
  for (const f of kept) keptSamples += f.blockSize;

  // Re-encode each kept frame with numbering restarted from 0.
  const out = [];
  let sampleNo = 0;
  kept.forEach((f, i) => {
    const num = variable ? sampleNo : i;
    const head = Buffer.concat([
      buf.subarray(f.off, f.off + 4),
      writeCodedNumber(num),
      buf.subarray(f.extStart, f.extEnd),
    ]);
    const hdr = Buffer.concat([head, Buffer.from([crc8(head, 0, head.length)])]);
    const body = buf.subarray(f.headerEnd, f.off + f.size - 2);
    const frame = Buffer.concat([hdr, body, Buffer.alloc(2)]);
    frame.writeUInt16BE(crc16(frame, 0, frame.length - 2), frame.length - 2);
    out.push(frame);
    sampleNo += f.blockSize;
  });

  // Patch STREAMINFO: total samples (low 36 bits of that 8-byte field) and MD5 -> zeros.
  const mask = (1n << 36n) - 1n;
  si.writeBigUInt64BE((packed & ~mask) | BigInt(keptSamples), 10);
  si.fill(0, 18, 34);

  // Rebuild metadata, dropping SEEKTABLE (type 3): its offsets no longer match.
  const keep = [{ type: 0, data: si }, ...blocks.slice(1).filter((b) => b.type !== 3)];
  const meta = [Buffer.from("fLaC", "latin1")];
  keep.forEach((b, i) => {
    const h = Buffer.alloc(4);
    h[0] = (i === keep.length - 1 ? 0x80 : 0) | b.type;
    h.writeUIntBE(b.data.length, 1, 3);
    meta.push(h, b.data);
  });

  const cutSamples = frames.slice(0, skip).reduce((a, f) => a + f.blockSize, 0);
  return {
    buffer: Buffer.concat([...meta, ...out]),
    info: {
      sampleRate,
      skippedFrames: skip,
      cutSeconds: cutSamples / sampleRate,
      remainingSeconds: keptSamples / sampleRate,
      variableBlocksize: variable,
    },
  };
}

module.exports = { trimFlac };
