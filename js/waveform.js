// ============================================================
// waveform.js — compute downsampled peaks from an AudioBuffer and
// draw a simple canvas preview.
// ============================================================

// Reduce a decoded AudioBuffer to N peak values (0..1) for cheap previews.
export function computePeaks(audioBuffer, buckets = 80) {
  const channel = audioBuffer.getChannelData(0);
  const size = channel.length;
  const block = Math.max(1, Math.floor(size / buckets));
  const peaks = new Array(buckets).fill(0);
  for (let i = 0; i < buckets; i++) {
    let max = 0;
    const start = i * block;
    const end = Math.min(start + block, size);
    for (let j = start; j < end; j++) {
      const v = Math.abs(channel[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  // Normalize so quiet recordings are still visible.
  const globalMax = Math.max(0.001, ...peaks);
  return peaks.map((p) => +(p / globalMax).toFixed(3));
}

// Decide whether a recorded take is essentially silence or steady background
// noise (no actual singing), so we can auto-discard it without prompting.
// Conservative on purpose: when in doubt, treat it as a real take and keep it.
export function isSilentOrNoise(audioBuffer) {
  const channel = audioBuffer.getChannelData(0);
  const size = channel.length;
  if (size === 0) return true;

  const sampleRate = audioBuffer.sampleRate || 48000;
  const frame = Math.max(1, Math.floor(sampleRate * 0.05)); // ~50 ms windows

  let truePeak = 0;
  const frameRms = [];
  for (let start = 0; start < size; start += frame) {
    const end = Math.min(start + frame, size);
    let sumSquares = 0;
    for (let j = start; j < end; j++) {
      const v = channel[j];
      const a = v < 0 ? -v : v;
      if (a > truePeak) truePeak = a;
      sumSquares += v * v;
    }
    frameRms.push(Math.sqrt(sumSquares / (end - start)));
  }

  // Dead silence / essentially nothing captured (~ -40 dBFS peak).
  if (truePeak < 0.01) return true;

  frameRms.sort((a, b) => a - b);
  const percentile = (p) =>
    frameRms[Math.min(frameRms.length - 1, Math.floor(p * frameRms.length))];
  const noiseFloor = percentile(0.1);
  const activeLevel = percentile(0.9);

  // Faint sound with little dynamic range above its own floor is room/mic
  // noise rather than voice: real singing rises well above the noise floor.
  const dynamicRange = activeLevel / Math.max(noiseFloor, 1e-4);
  if (activeLevel < 0.02 && dynamicRange < 2.5) return true;

  return false;
}

export function drawWaveform(canvas, peaks, color) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 40;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  if (!peaks || !peaks.length) return;
  const mid = cssH / 2;
  const barW = cssW / peaks.length;
  ctx.fillStyle = color || "#6c8cff";
  for (let i = 0; i < peaks.length; i++) {
    const h = Math.max(1, peaks[i] * (cssH - 4));
    const x = i * barW;
    ctx.fillRect(x, mid - h / 2, Math.max(1, barW - 1), h);
  }
}

// Draw peaks inside a segment of a full-width timeline canvas (0..1 fractions).
export function drawTimelineWaveform(canvas, peaks, { segmentLeft = 0, segmentWidth = 1, color } = {}) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 40;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  if (!peaks || !peaks.length || segmentWidth <= 0) return;

  const left = Math.max(0, segmentLeft) * cssW;
  const right = Math.min(1, segmentLeft + segmentWidth) * cssW;
  const segW = Math.max(2, right - left);
  if (segW <= 0) return;

  const mid = cssH / 2;
  const barW = segW / peaks.length;
  ctx.fillStyle = color || "#6c8cff";
  for (let i = 0; i < peaks.length; i++) {
    const h = Math.max(1, peaks[i] * (cssH - 4));
    const x = left + i * barW;
    ctx.fillRect(x, mid - h / 2, Math.max(1, barW - 0.5), h);
  }

  ctx.strokeStyle = color || "#6c8cff";
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.55;
  ctx.strokeRect(left + 0.5, 1.5, Math.max(1, segW - 1), cssH - 3);
  ctx.globalAlpha = 1;
}
