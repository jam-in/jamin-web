// App-wide constants and persisted storage keys.

// Offline shell cache — bump when sw.js SHELL list or assets change.
export const JAMIN_VERSION = "v46";

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
  lastSession: "jamin:lastSession",
  // Legacy single offset — migrated to defaultOffsetSpeakers on load.
  latencyOffset: "jamin:latencyOffset",
  defaultOffsetSpeakers: "jamin:defaultOffsetSpeakers",
  defaultOffsetHeadphones: "jamin:defaultOffsetHeadphones",
  bleedingMode: "jamin:bleedingMode",
  nudge: "jamin:nudge",
};

/** Playback bleeding policy (persisted in localStorage). */
export const BLEEDING_MODE = {
  WET: "wet",
  DRY: "dry",
  PER_TRACK: "per-track",
};

export const BLEEDING_MODES = Object.values(BLEEDING_MODE);
export const DEFAULT_BLEEDING_MODE = BLEEDING_MODE.PER_TRACK;

const LEGACY_BLEEDING_MODE = {
  yes: BLEEDING_MODE.WET,
  no: BLEEDING_MODE.DRY,
  "no (dry)": BLEEDING_MODE.DRY,
};

/** Map stored / legacy menu values to a canonical bleeding mode. */
export function normalizeBleedingMode(raw) {
  if (BLEEDING_MODES.includes(raw)) return raw;
  if (raw && LEGACY_BLEEDING_MODE[raw]) return LEGACY_BLEEDING_MODE[raw];
  return DEFAULT_BLEEDING_MODE;
}

// Default sync offset when auto-sync has low confidence (seconds).
export const DEFAULT_SYNC_OFFSET_SEC = 0;

// Jump larger than normal playback between UI polls → treat as a seek.
export const SEEK_DETECT_SEC = 0.6;

// Auto-sync (GCC-PHAT speaker bleed)
export const AUTOSYNC_MAX_LAG_SEC = 1.0;
export const AUTOSYNC_MERGE_SEC = 0.04;
export const AUTOSYNC_ANALYSIS_HZ = 16000;
// Hardened thresholds — low confidence falls back to the default offset.
export const AUTOSYNC_MIN_PROMINENCE = 2.2;
export const AUTOSYNC_MIN_PEAK_MEDIAN = 5.0;
export const AUTOSYNC_ENERGY_THRESHOLD = 0.008;
export const AUTOSYNC_ENERGY_WAIT_MS = 15000;
export const AUTOSYNC_ENERGY_SUSTAIN_MS = 200;
export const AUTOSYNC_CALIB_WINDOW_SEC = 7;
