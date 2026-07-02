// Timeline layout sync — poll until video metadata (duration) is ready.

import { isVideoMetadataReady } from "../youtube.js";

let timelineSyncTimer = null;

export function initTimelineSync({ player, videoStore, bus }) {
  let timelineSyncedKey = null;

  function trySyncLayout() {
    const videoId = videoStore.getVideoId();
    if (!videoId || !isVideoMetadataReady(player, videoId)) return false;

    const duration = player.getDuration();
    const key = `${videoId}:${duration}`;
    if (timelineSyncedKey === key) return true;

    timelineSyncedKey = key;
    bus.emit("timeline:ready", { videoId, duration });
    return true;
  }

  function scheduleTimelineSync(videoId) {
    if (timelineSyncTimer) clearInterval(timelineSyncTimer);
    const deadline = Date.now() + 15000;
    timelineSyncTimer = setInterval(() => {
      if (trySyncLayout() || Date.now() >= deadline) {
        clearInterval(timelineSyncTimer);
        timelineSyncTimer = null;
      }
    }, 100);
  }

  player.onStateChange(() => {
    trySyncLayout();
  });

  bus.on("video:loading", () => {
    timelineSyncedKey = null;
  });

  bus.on("video:loaded", ({ videoId }) => {
    timelineSyncedKey = null;
    if (!trySyncLayout()) scheduleTimelineSync(videoId);
  });

  return { trySyncLayout };
}
