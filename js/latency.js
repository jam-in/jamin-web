// Latency / sync offset — device-wide compensation for capture delay.

import { DEFAULT_LATENCY_OFFSET_SEC } from "./constants.js";

const NUDGE_SEC = 0.01;

export function initLatencyOffset({ elements, settings }) {
  renderOffsetReadout(elements, settings);

  elements.offsetEarlier?.addEventListener("click", (event) => {
    event.stopPropagation();
    settings.nudgeLatencyOffset(NUDGE_SEC);
    renderOffsetReadout(elements, settings);
  });
  elements.offsetLater?.addEventListener("click", (event) => {
    event.stopPropagation();
    settings.nudgeLatencyOffset(-NUDGE_SEC);
    renderOffsetReadout(elements, settings);
  });
  elements.offsetReadout?.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    settings.setLatencyOffset(DEFAULT_LATENCY_OFFSET_SEC);
    renderOffsetReadout(elements, settings);
  });
  elements.offsetReadout?.addEventListener("click", (event) => event.stopPropagation());
}

function renderOffsetReadout(elements, settings) {
  if (!elements.offsetReadout) return;
  const offset = settings.getLatencyOffset();
  const milliseconds = Math.round(offset * 1000);
  elements.offsetReadout.textContent = `${milliseconds >= 0 ? "+" : ""}${milliseconds} ms`;
}
