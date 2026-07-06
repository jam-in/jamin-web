// Device-wide prefs: default sync offsets (speakers / headphones), raw mic.

import { DEFAULT_SYNC_OFFSET_SEC, STORAGE_KEYS } from "../constants.js";
import { isUsingHeadphones } from "../audio-devices.js";

const MIN_DEFAULT_OFFSET_SEC = 0;
const MAX_DEFAULT_OFFSET_SEC = 1.0;

function clampDefault(seconds) {
  return Math.max(MIN_DEFAULT_OFFSET_SEC, Math.min(MAX_DEFAULT_OFFSET_SEC, seconds));
}

function readDefault(key) {
  const saved = parseFloat(localStorage.getItem(key));
  return Number.isFinite(saved) ? saved : DEFAULT_SYNC_OFFSET_SEC;
}

function migrateLegacyOffset() {
  const legacy = localStorage.getItem(STORAGE_KEYS.latencyOffset);
  if (legacy == null) return;
  if (localStorage.getItem(STORAGE_KEYS.defaultOffsetSpeakers) == null) {
    const parsed = parseFloat(legacy);
    if (Number.isFinite(parsed)) {
      localStorage.setItem(STORAGE_KEYS.defaultOffsetSpeakers, String(parsed));
    }
  }
  localStorage.removeItem(STORAGE_KEYS.latencyOffset);
}

export function createSettingsStore({ engine, recorder, bus }) {
  migrateLegacyOffset();

  let defaultOffsetSpeakers = readDefault(STORAGE_KEYS.defaultOffsetSpeakers);
  let defaultOffsetHeadphones = readDefault(STORAGE_KEYS.defaultOffsetHeadphones);
  let rawMicEnabled = false;
  let searchSequence = 0;

  // Playback uses per-track offsets only; engine default is unused.
  engine.setDefaultOffset(0);

  function emitDefaultsChanged() {
    bus.emit("settings:defaults-changed", {
      defaultOffsetSpeakers,
      defaultOffsetHeadphones,
    });
  }

  return {
    getDefaultOffsetSpeakers() {
      return defaultOffsetSpeakers;
    },

    getDefaultOffsetHeadphones() {
      return defaultOffsetHeadphones;
    },

    /** Default for the current output route (fallback when auto-sync is uncertain). */
    getActiveDefaultOffset() {
      return isUsingHeadphones()
        ? defaultOffsetHeadphones
        : defaultOffsetSpeakers;
    },

    setDefaultOffsetSpeakers(seconds, { persist = true } = {}) {
      defaultOffsetSpeakers = clampDefault(seconds);
      if (persist) {
        localStorage.setItem(
          STORAGE_KEYS.defaultOffsetSpeakers,
          String(defaultOffsetSpeakers)
        );
      }
      emitDefaultsChanged();
    },

    setDefaultOffsetHeadphones(seconds, { persist = true } = {}) {
      defaultOffsetHeadphones = clampDefault(seconds);
      if (persist) {
        localStorage.setItem(
          STORAGE_KEYS.defaultOffsetHeadphones,
          String(defaultOffsetHeadphones)
        );
      }
      emitDefaultsChanged();
    },

    nudgeDefaultOffsetSpeakers(deltaSeconds) {
      const next = Math.round((defaultOffsetSpeakers + deltaSeconds) * 1000) / 1000;
      this.setDefaultOffsetSpeakers(next);
    },

    nudgeDefaultOffsetHeadphones(deltaSeconds) {
      const next = Math.round((defaultOffsetHeadphones + deltaSeconds) * 1000) / 1000;
      this.setDefaultOffsetHeadphones(next);
    },

    getRawMicEnabled() {
      return rawMicEnabled;
    },

    setRawMic(raw) {
      rawMicEnabled = !!raw;
      recorder.setRawMic(rawMicEnabled);
    },

    nextSearchSequence() {
      searchSequence += 1;
      return searchSequence;
    },

    getSearchSequence() {
      return searchSequence;
    },

    isStaleSearchSequence(sequence) {
      return sequence !== searchSequence;
    },
  };
}
