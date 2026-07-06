// Post-process takes: subtract tab reference bleed using the track sync offset.

import { AUTOSYNC_ANALYSIS_HZ } from "../constants.js";
import { computePeaks } from "../waveform.js";
import { reportWarning } from "../errors.js";
import {
  encodeWavBlob,
  estimateBleedGain,
  refBlobToPcm,
  refPcmToBlob,
  resampleLinear,
  subtractBleed,
} from "./bleeding-math.js";

const LOG_PREFIX = "[Jam-in bleeding]";

async function decodeMicChannel(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buffer = await ctx.decodeAudioData((await blob.arrayBuffer()).slice(0));
  ctx.close();
  return {
    samples: buffer.getChannelData(0).slice(),
    sampleRate: buffer.sampleRate,
  };
}

/**
 * Remove speaker bleed from a mic take using aligned reference PCM and offset.
 * @returns {{ dryBlob, dryPeaks, refBlob, refSampleRate } | null}
 */
export async function processBleedRemoval({
  micBlob,
  refPcm,
  refSampleRate,
  offsetSec,
}) {
  if (!micBlob || !refPcm?.length || offsetSec <= 0) return null;

  try {
    const { samples: mic, sampleRate: micRate } = await decodeMicChannel(micBlob);
    const refAtMicRate = resampleLinear(refPcm, refSampleRate, micRate);
    const lagSamples = Math.round(offsetSec * micRate);
    const alpha = estimateBleedGain(mic, refAtMicRate, lagSamples);
    const dry = subtractBleed(mic, refAtMicRate, lagSamples, alpha);

    console.log(LOG_PREFIX, "processed", {
      offsetSec,
      lagSamples,
      alpha: +alpha.toFixed(4),
      micRate,
      refSampleRate,
    });

    const dryBlob = encodeWavBlob(dry, micRate);
    const dryCtx = new (window.AudioContext || window.webkitAudioContext)();
    const dryBuffer = await dryCtx.decodeAudioData((await dryBlob.arrayBuffer()).slice(0));
    const dryPeaks = computePeaks(dryBuffer);
    dryCtx.close();

    return {
      dryBlob,
      dryPeaks,
      refBlob: refPcmToBlob(refPcm),
      refSampleRate,
    };
  } catch (error) {
    reportWarning(LOG_PREFIX, "process failed", error);
    return null;
  }
}

export function createBleedingProcessor({ trackStore, settings }) {
  async function processTrackFromPcm(track, pcm) {
    if (!pcm?.ref?.length || !track.blob) return null;

    const result = await processBleedRemoval({
      micBlob: track.blob,
      refPcm: pcm.ref,
      refSampleRate: pcm.sampleRate || AUTOSYNC_ANALYSIS_HZ,
      offsetSec: track.offset || 0,
    });
    if (!result) return null;

    await trackStore.setBleedingData(track, result);
    return result;
  }

  async function reprocessTrack(track) {
    if (!track.refBlob || !track.blob) return null;
    const refPcm = await refBlobToPcm(track.refBlob);
    return processBleedRemoval({
      micBlob: track.blob,
      refPcm,
      refSampleRate: track.refSampleRate || AUTOSYNC_ANALYSIS_HZ,
      offsetSec: track.offset || 0,
    }).then((result) => {
      if (!result) return null;
      return trackStore.setBleedingData(track, result);
    });
  }

  return {
    processTrackFromPcm,
    reprocessTrack,
  };
}
