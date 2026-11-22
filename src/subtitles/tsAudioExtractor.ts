/**
 * MPEG-TS AAC Audio Demuxer & 16 kHz Mono WAV Encoder
 * Extracts clean elementary AAC audio directly from HLS .ts segments in memory
 * so AI transcription services (Gemini, Groq Whisper, OpenAI Whisper) receive
 * pure speech audio instead of multiplexed H.264/HEVC video containers.
 */

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
const AUDIO_STREAM_TYPES = new Set([0x0f, 0x11, 0x03, 0x04]);

/**
 * Checks whether a buffer begins with valid 188-byte MPEG-TS packet sync framing
 * within the first 376 bytes.
 */
export function isMpegTs(bytes: Uint8Array): boolean {
  return findTsSyncOffset(bytes) >= 0;
}

function findTsSyncOffset(bytes: Uint8Array): number {
  if (!bytes || bytes.length < TS_PACKET_SIZE + 1) return -1;
  const maxScan = Math.min(376, bytes.length - TS_PACKET_SIZE);
  for (let off = 0; off < maxScan; off++) {
    if (bytes[off] === TS_SYNC_BYTE && bytes[off + TS_PACKET_SIZE] === TS_SYNC_BYTE) {
      if (off + TS_PACKET_SIZE * 2 >= bytes.length || bytes[off + TS_PACKET_SIZE * 2] === TS_SYNC_BYTE) {
        return off;
      }
    }
  }
  return -1;
}

function trimToAdtsSync(data: Uint8Array): Uint8Array {
  // Scan leading bytes for ADTS syncword 0xFF 0xF? in case a segment starts mid-frame
  const scanLimit = Math.min(data.length - 1, 64);
  for (let i = 0; i < scanLimit; i++) {
    if (data[i] === 0xff && (data[i + 1] & 0xf0) === 0xf0) {
      return i === 0 ? data : data.subarray(i);
    }
  }
  return data;
}

/**
 * Demuxes elementary audio bytes (ADTS AAC / MP3) out of an MPEG-TS byte buffer.
 * Parses PAT/PMT tables to find the audio PID and falls back to PES audio stream_ids (0xC0..0xDF).
 */
export function extractAacFromTs(tsBytes: Uint8Array): Uint8Array {
  const startOffset = findTsSyncOffset(tsBytes);
  if (startOffset < 0) return new Uint8Array(0);

  const pmtPids = new Set<number>();
  const audioPids = new Set<number>();
  const fallbackAudioPids = new Set<number>();
  const seenPesStart = new Set<number>();
  const pidChunks = new Map<number, Uint8Array[]>();

  let pos = startOffset;
  while (pos + TS_PACKET_SIZE <= tsBytes.length) {
    if (tsBytes[pos] !== TS_SYNC_BYTE) {
      let resync = pos + 1;
      let found = -1;
      const limit = Math.min(tsBytes.length - TS_PACKET_SIZE, pos + TS_PACKET_SIZE * 2);
      while (resync < limit) {
        if (tsBytes[resync] === TS_SYNC_BYTE && tsBytes[resync + TS_PACKET_SIZE] === TS_SYNC_BYTE) {
          found = resync;
          break;
        }
        resync++;
      }
      if (found < 0) break;
      pos = found;
      continue;
    }

    const payloadUnitStart = (tsBytes[pos + 1] & 0x40) !== 0;
    const pid = ((tsBytes[pos + 1] & 0x1f) << 8) | tsBytes[pos + 2];
    const afc = (tsBytes[pos + 3] >>> 4) & 0x03;

    let payloadOffset = pos + 4;
    if (afc === 0 || afc === 2) {
      pos += TS_PACKET_SIZE;
      continue;
    }
    if (afc === 3) {
      const adaptLen = tsBytes[payloadOffset];
      payloadOffset += 1 + adaptLen;
    }

    const packetEnd = pos + TS_PACKET_SIZE;
    if (payloadOffset >= packetEnd) {
      pos += TS_PACKET_SIZE;
      continue;
    }

    const payload = tsBytes.subarray(payloadOffset, packetEnd);

    if (pid === 0x0000) {
      // Program Association Table (PAT)
      let sec = 0;
      if (payloadUnitStart && payload.length > 0) {
        sec = 1 + payload[0];
      }
      if (sec + 8 <= payload.length && payload[sec] === 0x00) {
        const secLen = ((payload[sec + 1] & 0x0f) << 8) | payload[sec + 2];
        const secEnd = Math.min(payload.length, sec + 3 + secLen - 4);
        for (let p = sec + 8; p + 4 <= secEnd; p += 4) {
          const progNum = (payload[p] << 8) | payload[p + 1];
          const pmtPid = ((payload[p + 2] & 0x1f) << 8) | payload[p + 3];
          if (progNum !== 0 && pmtPid > 0) {
            pmtPids.add(pmtPid);
          }
        }
      }
    } else if (pmtPids.has(pid)) {
      // Program Map Table (PMT)
      let sec = 0;
      if (payloadUnitStart && payload.length > 0) {
        sec = 1 + payload[0];
      }
      if (sec + 12 <= payload.length && payload[sec] === 0x02) {
        const secLen = ((payload[sec + 1] & 0x0f) << 8) | payload[sec + 2];
        const secEnd = Math.min(payload.length, sec + 3 + secLen - 4);
        const progInfoLen = ((payload[sec + 10] & 0x0f) << 8) | payload[sec + 11];
        let e = sec + 12 + progInfoLen;
        while (e + 5 <= secEnd) {
          const streamType = payload[e];
          const elemPid = ((payload[e + 1] & 0x1f) << 8) | payload[e + 2];
          const esInfoLen = ((payload[e + 3] & 0x0f) << 8) | payload[e + 4];
          if (AUDIO_STREAM_TYPES.has(streamType)) {
            audioPids.add(elemPid);
          }
          e += 5 + esInfoLen;
        }
      }
    } else if (pid !== 0x1fff) {
      let chunks = pidChunks.get(pid);
      if (payloadUnitStart) {
        if (payload.length >= 9 && payload[0] === 0x00 && payload[1] === 0x00 && payload[2] === 0x01) {
          const streamId = payload[3];
          if (streamId >= 0xc0 && streamId <= 0xdf) {
            fallbackAudioPids.add(pid);
          }
          const pesHeaderLen = payload[8];
          const esStart = 9 + pesHeaderLen;
          seenPesStart.add(pid);
          if (esStart < payload.length) {
            if (!chunks) {
              chunks = [];
              pidChunks.set(pid, chunks);
            }
            chunks.push(payload.subarray(esStart));
          }
        }
      } else if (seenPesStart.has(pid)) {
        if (!chunks) {
          chunks = [];
          pidChunks.set(pid, chunks);
        }
        chunks.push(payload);
      }
    }

    pos += TS_PACKET_SIZE;
  }

  let selectedChunks: Uint8Array[] | undefined;
  for (const pid of audioPids) {
    const c = pidChunks.get(pid);
    if (c && c.length > 0) {
      selectedChunks = c;
      break;
    }
  }
  if (!selectedChunks) {
    for (const pid of fallbackAudioPids) {
      const c = pidChunks.get(pid);
      if (c && c.length > 0) {
        selectedChunks = c;
        break;
      }
    }
  }
  if (!selectedChunks) return new Uint8Array(0);

  let totalLen = 0;
  for (const c of selectedChunks) totalLen += c.length;
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of selectedChunks) {
    combined.set(c, offset);
    offset += c.length;
  }

  return trimToAdtsSync(combined);
}

/**
 * Downsamples mono PCM samples to 16 kHz and writes a standard 44-byte RIFF/WAVE header.
 */
export function encodeSamplesToWav16k(samples: Float32Array, sourceSampleRate: number): Blob {
  const targetRate = 16000;
  const safeSrcRate = Number.isFinite(sourceSampleRate) && sourceSampleRate > 0 ? sourceSampleRate : targetRate;

  let resampled: Float32Array;
  if (samples.length === 0) {
    resampled = new Float32Array(0);
  } else if (safeSrcRate === targetRate) {
    resampled = samples;
  } else {
    const ratio = safeSrcRate / targetRate;
    const outLen = Math.max(1, Math.floor(samples.length / ratio));
    resampled = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcPos = i * ratio;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(samples.length - 1, i0 + 1);
      const frac = srcPos - i0;
      resampled[i] = samples[i0] + (samples[i1] - samples[i0]) * frac;
    }
  }

  const dataByteLen = resampled.length * 2;
  const buf = new ArrayBuffer(44 + dataByteLen);
  const view = new DataView(buf);

  const writeStr = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(off + i, str.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataByteLen, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true); // Byte rate = sampleRate * 1ch * 2bytes
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataByteLen, true);

  let writeOff = 44;
  for (let i = 0; i < resampled.length; i++) {
    const clamped = Math.max(-1, Math.min(1, resampled[i]));
    view.setInt16(writeOff, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    writeOff += 2;
  }

  return new Blob([buf], { type: "audio/wav" });
}

/**
 * Decodes ADTS AAC / audio bytes using WebAudio and downsamples to a 16 kHz mono WAV Blob.
 * Returns null if WebAudio is unavailable or decoding fails.
 */
export async function decodeAacToWav16k(aacBytes: Uint8Array): Promise<Blob | null> {
  if (!aacBytes || aacBytes.length === 0) return null;
  const AudioCtx =
    (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ||
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;

  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioCtx();
    const copyBuf = aacBytes.slice().buffer;
    const audioBuf = await ctx.decodeAudioData(copyBuf);
    const numCh = audioBuf.numberOfChannels;
    const len = audioBuf.length;
    if (len === 0 || numCh === 0) return null;

    const mono = new Float32Array(len);
    if (numCh === 1) {
      mono.set(audioBuf.getChannelData(0));
    } else {
      for (let ch = 0; ch < numCh; ch++) {
        const chData = audioBuf.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          mono[i] += chData[i];
        }
      }
      for (let i = 0; i < len; i++) {
        mono[i] /= numCh;
      }
    }
    return encodeSamplesToWav16k(mono, audioBuf.sampleRate);
  } catch {
    return null;
  } finally {
    try {
      await ctx?.close();
    } catch {
      // ignore close errors
    }
  }
}
