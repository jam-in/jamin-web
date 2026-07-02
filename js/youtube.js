// ============================================================
// youtube.js — load the IFrame API, parse URLs, wrap the player.
// ============================================================

let apiPromise = null;

// Load the YouTube IFrame API exactly once. The API signals readiness by
// calling the global window.onYouTubeIframeAPIReady, so we hook into that.
function loadYouTubeAPI() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === "function") prev();
      resolve(window.YT);
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return apiPromise;
}

// Accepts full URLs (watch, youtu.be, shorts, embed) or a bare 11-char ID.
export function parseVideoId(input) {
  if (!input) return null;
  const raw = input.trim();
  if (/^[\w-]{11}$/.test(raw)) return raw;

  try {
    const url = new URL(raw.includes("://") ? raw : "https://" + raw);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.slice(1, 12);
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      if (url.searchParams.get("v")) {
        const id = url.searchParams.get("v");
        return /^[\w-]{11}$/.test(id) ? id : null;
      }
      const m = url.pathname.match(/\/(embed|shorts|v)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch {
    /* fall through */
  }
  return null;
}

// Thin wrapper around YT.Player with promise-based readiness.
export class Player {
  constructor(elementId) {
    this.elementId = elementId;
    this.yt = null;
    this.videoId = null;
    this._stateListeners = [];
  }

  onStateChange(cb) {
    this._stateListeners.push(cb);
  }

  async load(videoId) {
    await loadYouTubeAPI();
    this.videoId = videoId;

    if (this.yt) {
      this.yt.loadVideoById(videoId);
      await waitForDuration(this, videoId);
      return;
    }

    // origin + enablejsapi are required for the IFrame API (especially on
    // localhost). origin must match the page URL exactly, including port.
    const origin = location.origin && location.origin !== "null"
      ? location.origin
      : `${location.protocol}//${location.host}`;

    await new Promise((resolve, reject) => {
      this.yt = new YT.Player(this.elementId, {
        videoId,
        playerVars: {
          enablejsapi: 1,
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
          origin,
        },
        events: {
          onReady: () => resolve(),
          onError: (e) => reject(new Error("yt-error:" + e.data)),
          onStateChange: (e) => {
            for (const cb of this._stateListeners) cb(e.data);
          },
        },
      });
    });
  }

  play() { this.yt && this.yt.playVideo && this.yt.playVideo(); }
  pause() { this.yt && this.yt.pauseVideo && this.yt.pauseVideo(); }
  seekTo(sec) { this.yt && this.yt.seekTo && this.yt.seekTo(sec, true); }
  getCurrentTime() { return this.yt && this.yt.getCurrentTime ? this.yt.getCurrentTime() : 0; }
  getDuration() { return this.yt && this.yt.getDuration ? this.yt.getDuration() : 0; }
  getState() { return this.yt && this.yt.getPlayerState ? this.yt.getPlayerState() : -1; }
  // { video_id, title, author } — populated once the video metadata loads.
  getVideoData() { return this.yt && this.yt.getVideoData ? this.yt.getVideoData() : null; }
}

export function isVideoMetadataReady(player, videoId) {
  const duration = player.getDuration();
  if (duration <= 0) return false;
  const dataId = player.getVideoData()?.video_id;
  return dataId === videoId;
}

// cueVideoById returns before metadata is ready; poll until the new video is known.
async function waitForDuration(player, videoId, maxMs = 15000) {
  if (isVideoMetadataReady(player, videoId)) return;

  await new Promise((resolve) => {
    const deadline = Date.now() + maxMs;
    let timer = null;

    const done = () => {
      if (timer) clearInterval(timer);
      const idx = player._stateListeners.indexOf(onState);
      if (idx >= 0) player._stateListeners.splice(idx, 1);
      resolve();
    };

    const tryResolve = () => {
      if (isVideoMetadataReady(player, videoId) || Date.now() >= deadline) done();
    };

    const onState = () => tryResolve();
    player._stateListeners.push(onState);
    timer = setInterval(tryResolve, 50);
    tryResolve();
  });
}

// Re-export the player-state enum values we care about (avoids depending on
// YT being defined at import time).
export const STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
};
