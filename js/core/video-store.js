// Video session: load orchestration, metadata capture, current video id.

import * as db from "../db.js";
import { BLOCKED_VIDEO_IDS, DEFAULT_VIDEO_ID, STORAGE_KEYS } from "../constants.js";
import { reportError, reportWarning } from "../errors.js";
import { describeYouTubeError, setPlayerOverlay } from "../video.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createVideoStore({ player, trackStore, elements, bus, notify }) {
  let currentVideoId = null;

  async function captureMeta(videoId) {
    let title = "";
    let author = "";

    if (currentVideoId === videoId) {
      for (let attempt = 0; attempt < 15; attempt++) {
        if (currentVideoId !== videoId) return;
        const data = player.getVideoData?.();
        if (data?.title) {
          title = data.title;
          author = data.author || "";
          break;
        }
        await sleep(200);
      }
    }

    if (!title) {
      try {
        const response = await fetch(
          `https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`
        );
        if (response.ok) {
          const json = await response.json();
          title = json.title || "";
          author = json.author_name || "";
        }
      } catch (error) {
        reportWarning("captureVideoMeta", "oEmbed fallback failed", error);
      }
    }

    try {
      await db.putVideoMeta({ videoId, title, author, updatedAt: Date.now() });
      bus.emit("video:meta-updated", { videoId });
    } catch (error) {
      reportError("captureVideoMeta", error, null, notify);
    }
  }

  return {
    getVideoId() {
      return currentVideoId;
    },

    async load(videoId, { persist = true } = {}) {
      bus.emit("video:loading", { videoId });
      setPlayerOverlay(elements, "Loading player…");

      try {
        await player.load(videoId);
        setPlayerOverlay(elements, null);
        currentVideoId = videoId;
        if (persist) localStorage.setItem(STORAGE_KEYS.lastVideo, videoId);

        await trackStore.loadForVideo(videoId);
        bus.emit("video:loaded", { videoId });
        captureMeta(videoId);
        return true;
      } catch (error) {
        const code = String(error.message || "").split(":")[1];
        const message = describeYouTubeError(code);
        reportError("loadVideo", error, message, notify);
        setPlayerOverlay(elements, message);
        if (persist && localStorage.getItem(STORAGE_KEYS.lastVideo) === videoId) {
          localStorage.removeItem(STORAGE_KEYS.lastVideo);
        }
        bus.emit("video:error", { videoId, message });
        return false;
      }
    },

    async loadInitial() {
      const saved = localStorage.getItem(STORAGE_KEYS.lastVideo);
      if (saved && BLOCKED_VIDEO_IDS.has(saved)) {
        localStorage.removeItem(STORAGE_KEYS.lastVideo);
      }

      const candidates = [
        saved && !BLOCKED_VIDEO_IDS.has(saved) ? saved : null,
        DEFAULT_VIDEO_ID,
      ].filter(Boolean);

      for (const videoId of candidates) {
        const loaded = await this.load(videoId);
        if (loaded) {
          if (videoId === DEFAULT_VIDEO_ID && saved !== DEFAULT_VIDEO_ID) {
            notify("Demo video loaded. Search or paste a karaoke URL — many channels block embedding.");
          }
          return;
        }
      }
    },

    captureMeta,
  };
}
