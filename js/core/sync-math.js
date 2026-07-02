// Shared sync formula — must match playback engine scheduling.

export function effectiveStartTime(track, globalOffset) {
  return track.startTime - globalOffset - (track.offset || 0);
}
