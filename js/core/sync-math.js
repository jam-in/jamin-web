// Shared sync formula — must match playback engine scheduling.
// Per-track offset is absolute (full latency compensation for that take).

export function effectiveStartTime(track) {
  return track.startTime - Math.max(0, track.offset || 0);
}
