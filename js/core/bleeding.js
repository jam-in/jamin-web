// Bleeding playback policy — wet (original) vs dry (bleed removed).

import { BLEEDING_MODE } from "../constants.js";
import { reportWarning } from "../errors.js";

/** @typedef {import("../constants.js").BLEEDING_MODE[keyof typeof BLEEDING_MODE]} BleedingMode */

/**
 * Global menu "Bleeding" maps at the UI boundary to:
 *   Yes       → wet       — original recording with speaker bleed
 *   No        → dry       — bleed-removed version when available
 *   Per track → per-track — each track's Dry checkbox
 */
function isTrackDry(track) {
  if (track.dry != null) return !!track.dry;
  // Legacy: `bleeding: false` meant prefer dry.
  return track.bleeding === false;
}

export function shouldPlayWet(track, mode) {
  switch (mode) {
    case BLEEDING_MODE.WET:
      return true;
    case BLEEDING_MODE.DRY:
      return false;
    case BLEEDING_MODE.PER_TRACK:
      return !isTrackDry(track);
    default:
      reportWarning("bleeding.unknownMode", mode);
      return !isTrackDry(track);
  }
}

export function resolvePlaybackBlob(track, mode) {
  if (shouldPlayWet(track, mode) || !track.dryBlob) {
    return track.blob;
  }
  return track.dryBlob;
}

export function resolvePlaybackPeaks(track, mode) {
  if (shouldPlayWet(track, mode) || !track.dryPeaks?.length) {
    return track.peaks;
  }
  return track.dryPeaks;
}
