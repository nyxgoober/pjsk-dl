// Dependency-free MP3 trimming: drop whole frames from the start.
//
// Scope: MPEG-1 Layer III (what these files use). Cuts land on frame
// boundaries (1152 samples ~ 26 ms). A leading Xing/Info frame is rebuilt so
// players report the right duration.
//
// Caveat: MP3 frames borrow data from earlier frames (the "bit reservoir"),
// so the first ~3 frames (~78 ms) after a cut can decode as silence/partial.
// Everything after that is bit-identical to the original.

const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SAMPLE_RATES = [44100, 48000, 32000];
const SAMPLES_PER_FRAME = 1152;

function id3v2Length(buf) {
  if (buf.length >= 10 && buf.toString("latin1", 0, 3) === "ID3") {
    const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
    return 10 + size + (buf[5] & 0x10 ? 10 : 0); // +10 if footer present
  }
  return 0;
}

function parseHeader(buf, pos) {
  if (pos + 4 > buf.length || buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) return null;
  const version = (buf[pos + 1] >> 3) & 3;
  const layer = (buf[pos + 1] >> 1) & 3;
  if (version !== 3 || layer !== 1) return null; // MPEG-1 Layer III only
  const brIdx = (buf[pos + 2] >> 4) & 0xf;
  const srIdx = (buf[pos + 2] >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const bitrate = BITRATES[brIdx] * 1000;
  const sampleRate = SAMPLE_RATES[srIdx];
  const padding = (buf[pos + 2] >> 1) & 1;
  const mono = ((buf[pos + 3] >> 6) & 3) === 3;
  return {
    size: Math.floor((144 * bitrate) / sampleRate) + padding,
    bitrate,
    sampleRate,
    mono,
    sideInfo: mono ? 17 : 32,
    hasCrc: (buf[pos + 1] & 1) === 0,
  };
}

// Walk frames, requiring the next header to also be valid so stray 0xFF bytes
// inside audio data aren't mistaken for frames.
function scanFrames(buf, start) {
  const frames = [];
  let pos = start;
  while (pos < buf.length) {
    const h = parseHeader(buf, pos);
    if (h && pos + h.size <= buf.length && (pos + h.size === buf.length || parseHeader(buf, pos + h.size))) {
      frames.push({ off: pos, ...h });
      pos += h.size;
    } else {
      pos++;
    }
  }
  return frames;
}

// A Xing/Info frame is a non-audio frame: its tag sits right after the side info.
function findInfoTag(buf, frame) {
  const at = frame.off + 4 + (frame.hasCrc ? 2 : 0) + frame.sideInfo;
  const tag = buf.toString("latin1", at, at + 4);
  return tag === "Xing" || tag === "Info" ? at : -1;
}

function trimMp3(buf, seconds) {
  const audioStart = id3v2Length(buf);
  const frames = scanFrames(buf, audioStart);
  if (frames.length === 0) throw new Error("No MPEG-1 Layer III frames found");

  const infoAt = findInfoTag(buf, frames[0]);
  const hasInfo = infoAt !== -1;
  const audio = hasInfo ? frames.slice(1) : frames;
  if (audio.length === 0) throw new Error("File has no audio frames");

  const sampleRate = audio[0].sampleRate;
  const skip = Math.round((seconds * sampleRate) / SAMPLES_PER_FRAME);
  if (skip >= audio.length) throw new Error(`Audio is shorter than ${seconds}s; nothing would be left`);

  const kept = audio.slice(skip);
  const audioBytes = buf.subarray(kept[0].off, kept[kept.length - 1].off + kept[kept.length - 1].size);
  const id3 = buf.subarray(0, audioStart);

  let infoFrame = Buffer.alloc(0);
  if (hasInfo) {
    // Copy the original Info frame, then patch frames / bytes / TOC.
    const f0 = frames[0];
    infoFrame = Buffer.from(buf.subarray(f0.off, f0.off + f0.size));
    const t = infoAt - f0.off;
    const flags = infoFrame.readUInt32BE(t + 4);
    let p = t + 8;
    if (flags & 1) { infoFrame.writeUInt32BE(kept.length, p); p += 4; }
    if (flags & 2) { infoFrame.writeUInt32BE(infoFrame.length + audioBytes.length, p); p += 4; }
    if (flags & 4) {
      // TOC: 100 entries, position of each 1% of the duration as 0-255 of total bytes.
      const total = infoFrame.length + audioBytes.length;
      for (let i = 0; i < 100; i++) {
        const frameIdx = Math.min(kept.length - 1, Math.floor((i / 100) * kept.length));
        const bytePos = infoFrame.length + (kept[frameIdx].off - kept[0].off);
        infoFrame[p + i] = Math.min(255, Math.floor((bytePos / total) * 256));
      }
      p += 100;
    }
    // Quality field (flags & 8) and encoder delay/padding are left as-is.
  }

  return {
    buffer: Buffer.concat([id3, infoFrame, audioBytes]),
    info: {
      sampleRate,
      skippedFrames: skip,
      cutSeconds: (skip * SAMPLES_PER_FRAME) / sampleRate,
      remainingSeconds: (kept.length * SAMPLES_PER_FRAME) / sampleRate,
      rebuiltInfoHeader: hasInfo,
    },
  };
}

module.exports = { trimMp3 };
