// Reference bleed subtraction — aligned using our measured sync offset (not browser AEC).

/** Linear resample mono Float32Array to a new sample rate. */
export function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples.slice();
  const outLen = Math.max(1, Math.round(samples.length * toRate / fromRate));
  const out = new Float32Array(outLen);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[idx] ?? 0;
    const b = samples[Math.min(idx + 1, samples.length - 1)] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Estimate bleed gain: mic[t] ≈ voice[t] + alpha * ref[t - lag].
 * Least-squares alpha on samples where reference has energy.
 */
export function estimateBleedGain(mic, ref, lagSamples) {
  let num = 0;
  let den = 0;
  const start = Math.max(0, lagSamples);
  for (let t = start; t < mic.length; t++) {
    const r = ref[t - lagSamples];
    num += mic[t] * r;
    den += r * r;
  }
  if (den < 1e-12) return 0;
  return Math.max(0, Math.min(1.5, num / den));
}

/** Subtract scaled, lag-aligned reference from the mic signal. */
export function subtractBleed(mic, ref, lagSamples, alpha) {
  const out = new Float32Array(mic.length);
  const lag = Math.max(0, lagSamples);
  for (let t = 0; t < mic.length; t++) {
    const bleed = t >= lag ? alpha * ref[t - lag] : 0;
    out[t] = mic[t] - bleed;
  }
  return out;
}

/** Encode mono float32 PCM (-1..1) as a 16-bit WAV Blob. */
export function encodeWavBlob(samples, sampleRate) {
  const numSamples = samples.length;
  const dataBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const v = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, v, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export function refPcmToBlob(refPcm) {
  return new Blob([refPcm.buffer], { type: "application/octet-stream" });
}

export async function refBlobToPcm(refBlob) {
  const buf = await refBlob.arrayBuffer();
  return new Float32Array(buf);
}
