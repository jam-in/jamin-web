// App-wide constants and persisted storage keys.

export const SEARCH_KEYWORD = "karaoke";

// YouTube IFrame API demo — reliably embeds on localhost.
export const DEFAULT_VIDEO_ID = "M7lc1UVf-VE";

// Karaoke IDs often block embedding; skip if cached from earlier versions.
export const BLOCKED_VIDEO_IDS = new Set([
  "B3O1OlTWXSA",
  "HY4lQ7vH4K4",
  "PD6ippYQ434",
]);

export const STORAGE_KEYS = {
  lastVideo: "jamin:lastVideo",
  latencyOffset: "jamin:latencyOffset",
  rawMicOverride: "jamin:rawMicOverride",
  nudge: "jamin:nudge",
};

// Sensible starting point for wired output; Bluetooth needs more.
export const DEFAULT_LATENCY_OFFSET_SEC = 0.2;

// Jump larger than normal playback between UI polls → treat as a seek.
export const SEEK_DETECT_SEC = 0.6;
