// Device-wide prefs: latency offset, raw mic, search sequence guard.

import { DEFAULT_LATENCY_OFFSET_SEC, STORAGE_KEYS } from "../constants.js";

const MIN_OFFSET_SEC = -0.3;
const MAX_OFFSET_SEC = 0.8;

function clampOffset(seconds) {
  return Math.max(MIN_OFFSET_SEC, Math.min(MAX_OFFSET_SEC, seconds));
}

export function createSettingsStore({ engine, recorder, bus }) {
  const saved = parseFloat(localStorage.getItem(STORAGE_KEYS.latencyOffset));
  let latencyOffset = Number.isFinite(saved) ? saved : DEFAULT_LATENCY_OFFSET_SEC;
  let rawMicEnabled = false;
  let searchSequence = 0;

  engine.setGlobalOffset(latencyOffset);

  return {
    getLatencyOffset() {
      return latencyOffset;
    },

    setLatencyOffset(seconds, { persist = true } = {}) {
      latencyOffset = clampOffset(seconds);
      engine.setGlobalOffset(latencyOffset);
      if (persist) {
        localStorage.setItem(STORAGE_KEYS.latencyOffset, String(latencyOffset));
      }
      bus.emit("settings:latency-changed", { latencyOffset });
    },

    nudgeLatencyOffset(deltaSeconds) {
      const next = Math.round((latencyOffset + deltaSeconds) * 1000) / 1000;
      this.setLatencyOffset(next);
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
