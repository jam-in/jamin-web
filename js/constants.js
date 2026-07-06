// App-wide constants and persisted storage keys.



// Offline shell cache — bump when sw.js SHELL list or assets change.

export const JAMIN_VERSION = "v42";



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

  latencyOffset: "jamin:latencyOffset",

  nudge: "jamin:nudge",

};



// Sensible starting point for wired output; Bluetooth needs more.

export const DEFAULT_LATENCY_OFFSET_SEC = 0.2;



// Jump larger than normal playback between UI polls → treat as a seek.

export const SEEK_DETECT_SEC = 0.6;



// Auto-sync (GCC-PHAT speaker bleed)

export const AUTOSYNC_MAX_LAG_SEC = 1.0;

export const AUTOSYNC_MERGE_SEC = 0.04;

export const AUTOSYNC_ANALYSIS_HZ = 16000;

export const AUTOSYNC_MIN_PROMINENCE = 1.4;

export const AUTOSYNC_MIN_PEAK_MEDIAN = 3.0;

export const AUTOSYNC_ENERGY_THRESHOLD = 0.008;

export const AUTOSYNC_ENERGY_WAIT_MS = 15000;

export const AUTOSYNC_ENERGY_SUSTAIN_MS = 200;

export const AUTOSYNC_CALIB_WINDOW_SEC = 7;

