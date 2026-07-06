// Default sync offset UI — separate speakers / headphones defaults.

import { DEFAULT_SYNC_OFFSET_SEC } from "./constants.js";

const NUDGE_SEC = 0.01;

function formatOffsetMs(seconds) {
  const ms = Math.round(seconds * 1000);
  return `+${ms} ms`;
}

export function initDefaultOffsets({ elements, settings, bus, autoSync }) {
  renderAll(elements, settings);

  bus?.on("settings:defaults-changed", () => renderAll(elements, settings));

  elements.speakersOffsetEarlier?.addEventListener("click", (event) => {
    event.stopPropagation();
    settings.nudgeDefaultOffsetSpeakers(NUDGE_SEC);
  });
  elements.speakersOffsetLater?.addEventListener("click", (event) => {
    event.stopPropagation();
    settings.nudgeDefaultOffsetSpeakers(-NUDGE_SEC);
  });
  elements.speakersOffsetReadout?.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    settings.setDefaultOffsetSpeakers(DEFAULT_SYNC_OFFSET_SEC);
  });
  elements.speakersOffsetReadout?.addEventListener("click", (e) => e.stopPropagation());

  elements.headphonesOffsetEarlier?.addEventListener("click", (event) => {
    event.stopPropagation();
    settings.nudgeDefaultOffsetHeadphones(NUDGE_SEC);
  });
  elements.headphonesOffsetLater?.addEventListener("click", (event) => {
    event.stopPropagation();
    settings.nudgeDefaultOffsetHeadphones(-NUDGE_SEC);
  });
  elements.headphonesOffsetReadout?.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    settings.setDefaultOffsetHeadphones(DEFAULT_SYNC_OFFSET_SEC);
  });
  elements.headphonesOffsetReadout?.addEventListener("click", (e) => e.stopPropagation());

  elements.speakersAutoBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    autoSync?.runSpeakersDefaultCalibration();
  });
}

function renderAll(elements, settings) {
  if (elements.speakersOffsetReadout) {
    elements.speakersOffsetReadout.textContent = formatOffsetMs(
      settings.getDefaultOffsetSpeakers()
    );
  }
  if (elements.headphonesOffsetReadout) {
    elements.headphonesOffsetReadout.textContent = formatOffsetMs(
      settings.getDefaultOffsetHeadphones()
    );
  }
}

// Back-compat alias used by main.js
export const initLatencyOffset = initDefaultOffsets;
