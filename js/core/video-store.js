// Video session: load orchestration, metadata capture, current video + jam session.

import * as db from "../db.js";
import { BLOCKED_VIDEO_IDS, DEFAULT_VIDEO_ID, STORAGE_KEYS } from "../constants.js";
import { resolveSessionId } from "./session-id.js";
import { reportError, reportWarning } from "../errors.js";
import { describeYouTubeError, setPlayerOverlay } from "../video.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function readLastSession() {
  const raw = localStorage.getItem(STORAGE_KEYS.lastSession);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.videoId) {
        return {
          videoId: parsed.videoId,
          sessionId: resolveSessionId(parsed.sessionId),
        };
      }
    } catch {
      localStorage.removeItem(STORAGE_KEYS.lastSession);
    }
  }

  const legacyVideo = localStorage.getItem(STORAGE_KEYS.lastVideo);
  if (legacyVideo) {
    return { videoId: legacyVideo, sessionId: resolveSessionId(null) };
  }
  return null;
}

function persistLastSession(videoId, sessionId) {
  localStorage.setItem(
    STORAGE_KEYS.lastSession,
    JSON.stringify({ videoId, sessionId })
  );
  localStorage.removeItem(STORAGE_KEYS.lastVideo);
}

export function createVideoStore({ player, trackStore, sessionStore, elements, bus, notify }) {
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

    getSessionId() {
      return sessionStore.getSessionId();
    },

    getSession() {
      return sessionStore.getSession();
    },

    async getVideoTitle() {
      const videoId = currentVideoId;
      if (!videoId) return "";

      const data = player.getVideoData?.();
      if (data?.video_id === videoId && data.title) return data.title;

      const meta = await db.getVideoMeta(videoId);
      return meta?.title || "";
    },

    async load(videoId, { sessionId = null, createSession = false, persist = true } = {}) {
      bus.emit("video:loading", { videoId });
      setPlayerOverlay(elements, "Loading player…");

      try {
        let session;
        if (createSession) {
          session = await sessionStore.create(videoId);
        } else {
          session = await sessionStore.ensure(sessionId, videoId);
        }

        await player.load(videoId);
        setPlayerOverlay(elements, null);
        currentVideoId = videoId;
        if (persist) persistLastSession(videoId, session.sessionId);

        await trackStore.loadForSession(videoId, session.sessionId);
        bus.emit("video:loaded", { videoId, sessionId: session.sessionId });
        captureMeta(videoId);
        return true;
      } catch (error) {
        const code = String(error.message || "").split(":")[1];
        const message = describeYouTubeError(code);
        reportError("loadVideo", error, message, notify);
        setPlayerOverlay(elements, message);
        const saved = readLastSession();
        if (persist && saved?.videoId === videoId) {
          localStorage.removeItem(STORAGE_KEYS.lastSession);
        }
        bus.emit("video:error", { videoId, message });
        return false;
      }
    },

    async loadInitial(deeplinkVideoId = null, deeplinkSessionId = null) {
      const saved = readLastSession();
      if (saved?.videoId && BLOCKED_VIDEO_IDS.has(saved.videoId)) {
        localStorage.removeItem(STORAGE_KEYS.lastSession);
      }

      const deeplinkVideo =
        deeplinkVideoId && !BLOCKED_VIDEO_IDS.has(deeplinkVideoId)
          ? deeplinkVideoId
          : null;

      if (deeplinkVideo) {
        const loaded = await this.load(deeplinkVideo, {
          sessionId: deeplinkSessionId,
        });
        return loaded;
      }

      const lastSession = readLastSession();
      const candidates = [
        lastSession?.videoId && !BLOCKED_VIDEO_IDS.has(lastSession.videoId)
          ? { videoId: lastSession.videoId, sessionId: lastSession.sessionId }
          : null,
        { videoId: DEFAULT_VIDEO_ID, sessionId: resolveSessionId(null) },
      ].filter(Boolean);

      for (const candidate of candidates) {
        const loaded = await this.load(candidate.videoId, {
          sessionId: candidate.sessionId,
        });
        if (loaded) {
          if (
            candidate.videoId === DEFAULT_VIDEO_ID
            && lastSession?.videoId !== DEFAULT_VIDEO_ID
          ) {
            notify("Demo video loaded. Search or paste a karaoke URL — many channels block embedding.");
          }
          return true;
        }
      }
      return false;
    },

    captureMeta,
  };
}
