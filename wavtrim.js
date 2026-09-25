// Dependency-free WAV trimming: drop the first N seconds of PCM data.
// Walks the RIFF chunks rather than assuming a fixed 44-byte header, since
// files can carry LIST/fact/etc. chunks before "data".

function trimWav(buf, seconds) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }

  let fmt = null;
  let dataStart = -1;
  let dataLen = 0;
  const preData = []; // chunks before "data" (fmt, LIST, ...) kept verbatim

  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const bodyStart = pos + 8;

    if (id === "data") {
      // Streamed/piped WAVs may write 0 or 0xFFFFFFFF as the size; fall back to "rest of file".
      if (size === 0 || size === 0xffffffff || bodyStart + size > buf.length) {
        size = buf.length - bodyStart;
      }
      dataStart = bodyStart;
      dataLen = size;
      break;
    }

    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(bodyStart),
        channels: buf.readUInt16LE(bodyStart + 2),
        sampleRate: buf.readUInt32LE(bodyStart + 4),
        blockAlign: buf.readUInt16LE(bodyStart + 12),
        bitsPerSample: buf.readUInt16LE(bodyStart + 14),
      };
    }

    preData.push(buf.subarray(pos, bodyStart + size + (size & 1))); // chunks are word-aligned
    pos = bodyStart + size + (size & 1);
  }

  if (!fmt) throw new Error("WAV has no fmt chunk");
  if (dataStart === -1) throw new Error("WAV has no data chunk");
  if (!fmt.blockAlign || !fmt.sampleRate) throw new Error("WAV fmt chunk is invalid");

  // Whole frames only, so channels never get shifted out of alignment.
  const skipFrames = Math.round(seconds * fmt.sampleRate);
  const skipBytes = skipFrames * fmt.blockAlign;

  if (skipBytes >= dataLen) {
    throw new Error(`Audio is shorter than ${seconds}s; nothing would be left`);
  }

  const newData = buf.subarray(dataStart + skipBytes, dataStart + dataLen);
  const pad = newData.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0);

  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.write("WAVE", 8, "ascii");

  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "ascii");
  dataHeader.writeUInt32LE(newData.length, 4);

  const body = Buffer.concat([...preData, dataHeader, newData, pad]);
  header.writeUInt32LE(4 + body.length, 4); // RIFF size = "WAVE" + everything after
  return {
    buffer: Buffer.concat([header, body]),
    info: { ...fmt, skippedFrames: skipFrames, remainingSeconds: newData.length / fmt.blockAlign / fmt.sampleRate },
  };
}

module.exports = { trimWav };
