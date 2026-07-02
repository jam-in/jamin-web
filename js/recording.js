// Recording session wiring — the video transport drives recording, so we just
// forward player state changes; there is no record button anymore.

export function initRecording({ player, recordingSession }) {
  player.onStateChange((state) => recordingSession.onPlayerStateChange(state));
}
