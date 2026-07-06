// GCC-PHAT cross-correlation and positive-lag peak picking for auto-sync.

import { fft, nextPow2, padReal, realToComplex } from "./fft.js";

/**
 * GCC-PHAT cross-correlation via FFT.
 * Returns the full circular correlation (length = fftSize).
 */
export function crossCorrPhat(a, b) {
  const len = Math.max(a.length, b.length);
  const fftSize = nextPow2(len << 1);
  const half = fftSize >> 1;

  const fa = realToComplex(padReal(a, fftSize));
  const fb = realToComplex(padReal(b, fftSize));
  fft(fa);
  fft(fb);

  // PHAT weighting: X * conj(Y) / |X * conj(Y)|
  for (let i = 0; i < half; i++) {
    const ai = i << 1;
    const ar = fa[ai];
    const ai_ = fa[ai + 1];
    const br = fb[ai];
    const bi = -fb[ai + 1]; // conjugate

    const cr = ar * br - ai_ * bi;
    const ci = ar * bi + ai_ * br;
    const mag = Math.sqrt(cr * cr + ci * ci) || 1e-12;

    fa[ai] = cr / mag;
    fa[ai + 1] = ci / mag;
  }

  fft(fa, true);

  // Extract real part of circular correlation.
  const corr = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) corr[i] = fa[i << 1];
  return corr;
}

/**
 * Find local maxima of |values| in an array segment.
 */
function findLocalPeaks(values, start, end) {
  const peaks = [];
  for (let i = start + 1; i < end - 1; i++) {
    const a = Math.abs(values[i]);
    const left = Math.abs(values[i - 1]);
    const right = Math.abs(values[i + 1]);
    if (a > left && a >= right) {
      peaks.push({ index: i, strength: a });
    }
  }
  return peaks;
}

/**
 * Merge peaks closer than mergeSamples into a weighted average.
 */
function mergePeaks(peaks, mergeSamples, sampleRate) {
  if (!peaks.length) return [];
  const sorted = [...peaks].sort((a, b) => b.strength - a.strength);
  const merged = [];

  for (const peak of sorted) {
    let absorbed = false;
    for (const group of merged) {
      const lagDiff = Math.abs(peak.index - group.index);
      if (lagDiff <= mergeSamples) {
        const total = group.strength + peak.strength;
        group.index = Math.round(
          (group.index * group.strength + peak.index * peak.strength) / total
        );
        group.strength = Math.max(group.strength, peak.strength);
        group.lagSec = group.index / sampleRate;
        absorbed = true;
        break;
      }
    }
    if (!absorbed) {
      merged.push({
        index: peak.index,
        strength: peak.strength,
        lagSec: peak.index / sampleRate,
      });
    }
  }

  return merged.sort((a, b) => b.strength - a.strength);
}

/**
 * Pick the best positive lag from a GCC-PHAT correlation vector.
 * Mic can only lag the reference — search (0, maxLagSec].
 *
 * @returns {{ offsetSec: number, confidence: object, peaks: object[], applied: boolean }}
 *   offsetSec — best peak lag (always); applied — whether confidence passed to use it
 */
export function pickOffset(corr, sampleRate, {
  maxLagSec = 1.0,
  mergeSec = 0.04,
  minProminence = 1.4,
  minPeakMedian = 3.0,
} = {}) {
  const maxLagSamples = Math.min(
    Math.floor(maxLagSec * sampleRate),
    corr.length - 1
  );
  const mergeSamples = Math.max(1, Math.round(mergeSec * sampleRate));

  // Positive lags only: index 1 .. maxLagSamples
  const searchStart = 1;
  const searchEnd = maxLagSamples + 1;

  const rawPeaks = findLocalPeaks(corr, searchStart - 1, searchEnd + 1);
  const peaks = mergePeaks(rawPeaks, mergeSamples, sampleRate);

  // Median of absolute correlation in the search window.
  const window = corr.subarray(searchStart, searchEnd);
  const absSorted = Float32Array.from(window, Math.abs).sort();
  const median = absSorted[Math.floor(absSorted.length / 2)] || 1e-12;

  const confidence = {
    peakCount: peaks.length,
    mainStrength: 0,
    nextStrength: 0,
    prominence: 0,
    peakMedianRatio: 0,
    median,
  };

  if (!peaks.length) {
    return { offsetSec: 0, confidence, peaks: [], applied: false };
  }

  const main = peaks[0];
  const next = peaks[1] || { strength: 0 };
  confidence.mainStrength = main.strength;
  confidence.nextStrength = next.strength;
  confidence.prominence = next.strength > 0
    ? main.strength / next.strength
    : main.strength / median;
  confidence.peakMedianRatio = main.strength / median;

  const confident = confidence.prominence >= minProminence
    && confidence.peakMedianRatio >= minPeakMedian;

  const measuredOffsetSec = Math.round((main.index / sampleRate) * 1000) / 1000;

  return {
    measuredOffsetSec,
    offsetSec: measuredOffsetSec,
    confidence,
    peaks: peaks.map((p) => ({
      lagSec: Math.round(p.lagSec * 1000) / 1000,
      strength: +p.strength.toFixed(4),
    })),
    applied: confident,
  };
}

/**
 * Full GCC-PHAT analysis: correlate mic vs reference, pick offset.
 */
export function analyzeSync(mic, ref, sampleRate, options = {}) {
  const corr = crossCorrPhat(mic, ref);
  return pickOffset(corr, sampleRate, options);
}
