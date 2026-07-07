// Module worker: GCC-PHAT offset estimation off the main thread.

import { analyzeSyncMode } from "./core/gcc-phat.js";

// Partial PHAT whitening. rho=0.3 was the most run-to-run consistent estimator
// across ground-truth runs; windows are aggregated by median in the orchestrator.
const PROD_RHO = 0.3;

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
    id,
  } = event.data;

  try {
    const opts = { maxLagSec, mergeSec, minProminence, minPeakMedian };

    const result = analyzeSyncMode(mic, ref, sampleRate, opts, PROD_RHO);

    self.postMessage({
      ok: true,
      id,
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
      id,
      role,
      error: String(error?.message || error),
    });
  }
};
