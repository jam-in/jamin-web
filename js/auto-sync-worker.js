// Module worker: GCC-PHAT offset estimation off the main thread.

import { analyzeSync } from "./core/gcc-phat.js";

self.onmessage = (event) => {
  const {
    mic,
    ref,
    sampleRate,
    maxLagSec,
    mergeSec,
    minProminence,
    minPeakMedian,
    role,
  } = event.data;

  try {
    const result = analyzeSync(mic, ref, sampleRate, {
      maxLagSec,
      mergeSec,
      minProminence,
      minPeakMedian,
    });

    self.postMessage({
      ok: true,
      role,
      offsetSec: result.offsetSec,
      measuredOffsetSec: result.measuredOffsetSec ?? result.offsetSec,
      confidence: result.confidence,
      peaks: result.peaks,
      applied: result.applied,
      diagnostics: {
        micSamples: mic.length,
        refSamples: ref.length,
        sampleRate,
      },
    });
  } catch (error) {
    self.postMessage({
      ok: false,
      role,
      error: String(error?.message || error),
    });
  }
};
