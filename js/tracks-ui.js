// Timeline track UI: positioned waveforms, segment bounds, hover controls.

import { reportError } from "./errors.js";
import { effectiveStartTime } from "./core/sync-math.js";
import { BLEEDING_MODE } from "./constants.js";
import { resolvePlaybackPeaks } from "./core/bleeding.js";
import { drawTimelineWaveform } from "./waveform.js";
import { confirmDeleteTake, formatTime, getAccentColor, getRecordColor, makeIconButton } from "./ui.js";

const LONG_PRESS_MS = 450;
const NUDGE_SEC = 0.01;
const CONTROLS_GAP_PX = 4;

let activeTrackRow = null;
let volOpenRow = null;

export function createTrackListController({ trackStore, settings, videoStore, player, elements, bus, notify }) {
  function getTimelineMetrics() {
    return {
      videoDuration: player.getDuration() || 0,
    };
  }

  function getTrackSegment(track, metrics) {
    const { videoDuration } = metrics;
    if (videoDuration <= 0) {
      return { segmentLeft: 0, segmentWidth: 0 };
    }
    const effStart = effectiveStartTime(track);
    return {
      segmentLeft: effStart / videoDuration,
      segmentWidth: (track.duration || 0) / videoDuration,
    };
  }

  function updateRuler() {
    const duration = player.getDuration() || 0;
    if (elements.timelineRulerStart) {
      elements.timelineRulerStart.textContent = formatTime(0);
    }
    if (elements.timelineRulerEnd) {
      elements.timelineRulerEnd.textContent = formatTime(duration);
    }
  }

  function layoutTrackRow(row) {
    if (!row._segmentEl || !row._controlsEl || !row._getSegment) return;
    const segment = row._getSegment();
    const { segmentLeft, segmentWidth } = segment;
    const rowW = row.clientWidth;
    if (rowW <= 0) return;

    row._segmentEl.style.left = `${segmentLeft * 100}%`;
    row._segmentEl.style.width = `${Math.max(0, segmentWidth) * 100}%`;

    const controlsW = row._controlsEl.offsetWidth || 210;
    const segEnd = segmentLeft + segmentWidth;
    const spaceRight = (1 - segEnd) * rowW;
    const spaceLeft = segmentLeft * rowW;
    const need = controlsW + CONTROLS_GAP_PX;

    row._controlsEl.classList.remove("align-left", "align-right", "align-inside");
    if (spaceRight >= need || spaceRight >= spaceLeft) {
      row._controlsEl.classList.add("align-right");
      row._controlsEl.style.left = `${segEnd * 100}%`;
    } else if (spaceLeft >= need) {
      row._controlsEl.classList.add("align-left");
      row._controlsEl.style.left = `${segmentLeft * 100}%`;
    } else {
      row._controlsEl.classList.add("align-inside");
      const insideLeft = Math.max(0, Math.min(1 - controlsW / rowW, segEnd - controlsW / rowW));
      row._controlsEl.style.left = `${insideLeft * 100}%`;
    }
  }

  function layoutAllTrackRows() {
    elements.trackList.querySelectorAll(".timeline-track").forEach(layoutTrackRow);
  }

  // ---- Live recording waveform ----------------------------------------
  // While a take records we draw its waveform in real time on a temporary row.
  // It stays if the take is kept (replaced by the saved row) and vanishes if
  // it's discarded.
  let live = null; // { row, canvas, startTime, peaks }

  function beginLive(startTime) {
    endLive(false); // clear any stale live row first
    const row = document.createElement("div");
    row.className = "timeline-track is-live";

    const canvas = document.createElement("canvas");
    canvas.className = "timeline-wave";
    row.append(canvas);

    elements.trackList.prepend(row);
    elements.emptyHint.hidden = true;
    live = { row, canvas, startTime, peaks: [] };
    drawLive();
  }

  function pushLiveSample(peak) {
    if (!live) return;
    live.peaks.push(peak);
    drawLive();
  }

  function drawLive() {
    if (!live) return;
    const duration = player.getDuration() || 0;
    if (duration <= 0 || !Number.isFinite(live.startTime)) return;
    const frontier = player.getCurrentTime();
    const segmentLeft = live.startTime / duration;
    const segmentWidth = Math.max(0, (frontier - live.startTime) / duration);

    // Raw mic peaks are small; normalize against the running max so the live
    // waveform is as visible as the saved (normalized) one.
    let max = 0.001;
    for (let i = 0; i < live.peaks.length; i++) {
      if (live.peaks[i] > max) max = live.peaks[i];
    }
    const normalized = live.peaks.map((p) => p / max);

    drawTimelineWaveform(live.canvas, normalized, {
      segmentLeft,
      segmentWidth,
      color: getRecordColor(),
    });
  }

  function endLive(kept) {
    if (!live) return;
    // When kept, leave the row in place; the tracks:changed re-render replaces
    // it with the saved take. When not kept, remove it now.
    if (!kept) {
      if (live.row.parentNode) live.row.remove();
      elements.emptyHint.hidden = trackStore.getTracks().length > 0;
    }
    live = null;
  }

  function renderTracks() {
    const tracks = trackStore.getTracks();
    elements.trackList.innerHTML = "";
    live = null; // innerHTML reset drops any live row
    const hasTracks = tracks.length > 0;
    elements.emptyHint.hidden = hasTracks;

    updateRuler();

    const sorted = [...tracks].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    for (const track of sorted) {
      elements.trackList.append(
        buildTrackElement({
          track,
          trackStore,
          settings,
          getTimelineMetrics,
          getTrackSegment,
          layoutTrackRow,
          elements,
          notify,
        })
      );
    }

    requestAnimationFrame(() => {
      layoutAllTrackRows();
      bus.emit("playhead:refresh");
    });
  }

  function getDisplayPeaks(track) {
    return resolvePlaybackPeaks(track, settings.getBleedingMode());
  }

  function redrawWaveforms() {
    const metrics = getTimelineMetrics();
    const color = getAccentColor();
    const tracks = trackStore.getTracks();
    elements.trackList.querySelectorAll("canvas.timeline-wave").forEach((canvas) => {
      const track = tracks.find((t) => t.id === canvas.dataset.trackId);
      if (!track) return;
      const segment = getTrackSegment(track, metrics);
      canvas._segment = segment;
      canvas._peaks = getDisplayPeaks(track);
      drawTimelineWaveform(canvas, canvas._peaks, { ...segment, color });
    });
    updateRuler();
    layoutAllTrackRows();
    drawLive();
    bus.emit("playhead:refresh");
  }

  bus.on("tracks:changed", () => renderTracks());
  bus.on("video:loaded", () => renderTracks());
  bus.on("settings:defaults-changed", () => redrawWaveforms());
  bus.on("settings:bleeding-changed", () => {
    redrawWaveforms();
    const perTrack = settings.getBleedingMode() === BLEEDING_MODE.PER_TRACK;
    elements.trackList.querySelectorAll(".timeline-bleeding input").forEach((chk) => {
      chk.disabled = !perTrack;
      chk.closest(".timeline-bleeding")?.classList.toggle("is-disabled", !perTrack);
    });
  });
  bus.on("timeline:ready", () => {
    redrawWaveforms();
    layoutAllTrackRows();
  });

  bus.on("recording:take-started", (event) => beginLive(event.detail.startTime));
  bus.on("recording:live-sample", (event) => pushLiveSample(event.detail.peak));
  bus.on("recording:take-ended", (event) => endLive(event.detail.kept));

  return { renderTracks, redrawWaveforms, layoutAllTrackRows };
}

function buildTrackElement({ track, trackStore, settings, getTimelineMetrics, getTrackSegment, layoutTrackRow, elements, notify }) {
  const row = document.createElement("div");
  row.className = "timeline-track";
  row.dataset.trackId = track.id;

  const canvas = document.createElement("canvas");
  canvas.className = "timeline-wave";
  canvas.dataset.trackId = track.id;
  canvas._peaks = resolvePlaybackPeaks(track, settings.getBleedingMode());

  const segmentEl = document.createElement("div");
  segmentEl.className = "timeline-segment";
  segmentEl.setAttribute("aria-hidden", "true");

  const controls = document.createElement("div");
  controls.className = "timeline-controls";

  const sync = document.createElement("div");
  sync.className = "timeline-sync";

  const syncMs = document.createElement("span");
  syncMs.className = "track-sync-ms";
  syncMs.title = "Double-click to reset nudge to 0 ms";

  const renderSyncMs = () => {
    const ms = Math.round((track.offset || 0) * 1000);
    syncMs.textContent = `${ms >= 0 ? "+" : ""}${ms} ms`;
  };

  const refreshSegment = () => {
    const metrics = getTimelineMetrics();
    const segment = getTrackSegment(track, metrics);
    canvas._segment = segment;
    canvas._peaks = resolvePlaybackPeaks(track, settings.getBleedingMode());
    drawTimelineWaveform(canvas, canvas._peaks, { ...segment, color: getAccentColor() });
    layoutTrackRow(row);
  };

  const earlierBtn = makeIconButton("◀", "Nudge 10 ms earlier", () => {
    nudgeTrack(trackStore, track, -NUDGE_SEC, renderSyncMs, refreshSegment, notify);
  });
  const laterBtn = makeIconButton("▶", "Nudge 10 ms later", () => {
    nudgeTrack(trackStore, track, NUDGE_SEC, renderSyncMs, refreshSegment, notify);
  });
  renderSyncMs();
  sync.append(earlierBtn, syncMs, laterBtn);

  syncMs.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    resetTrackOffset(trackStore, track, renderSyncMs, refreshSegment, notify);
  });

  const dryWrap = document.createElement("label");
  dryWrap.className = "timeline-bleeding";
  const dryChk = document.createElement("input");
  dryChk.type = "checkbox";
  dryChk.checked = track.dry === true || (track.dry == null && track.bleeding === false);
  dryChk.title = "Play bleed-removed (dry) version";
  dryChk.setAttribute("aria-label", "Dry");
  const syncDryChk = () => {
    const perTrack = settings.getBleedingMode() === BLEEDING_MODE.PER_TRACK;
    dryChk.disabled = !perTrack;
    dryWrap.classList.toggle("is-disabled", !perTrack);
  };
  syncDryChk();
  dryChk.addEventListener("change", () => {
    trackStore.setTrackDry(track, dryChk.checked).catch((error) => {
      reportError("setTrackDry", error, null, notify);
    });
  });

  const dryText = document.createElement("span");
  dryText.className = "timeline-bleeding-label";
  dryText.textContent = "Dry";
  dryWrap.append(dryChk, dryText);

  const volWrap = document.createElement("div");
  volWrap.className = "timeline-vol";

  const volBtn = makeIconButton(
    track.muted ? "🔇" : "🔊",
    "Click to mute; hold for volume",
    () => {}
  );
  if (track.muted) volBtn.classList.add("muted");

  const volPopover = document.createElement("div");
  volPopover.className = "vol-popover";
  const volSlider = document.createElement("input");
  volSlider.type = "range";
  volSlider.min = "0";
  volSlider.max = "1";
  volSlider.step = "0.01";
  volSlider.value = String(track.volume ?? 1);
  volSlider.title = "Volume in mix";
  volSlider.setAttribute("aria-label", "Track volume");
  volSlider.addEventListener("input", () => {
    track.volume = parseFloat(volSlider.value);
    trackStore.setTrackVolume(track, track.volume, { persist: false });
  });
  volSlider.addEventListener("change", () => {
    trackStore.setTrackVolume(track, track.volume).catch((error) => {
      reportError("updateTrack", error, null, notify);
    });
  });
  volWrap.append(volBtn, volPopover);
  wireVolumeButton(trackStore, track, row, volBtn, notify);

  const soloWrap = document.createElement("div");
  soloWrap.className = "timeline-solo";
  const soloBtn = makeIconButton("S", "Solo — hear only this take", () => {
    toggleSolo(trackStore, elements, track);
  });
  if (trackStore.getSoloId() === track.id) soloBtn.classList.add("active");
  soloWrap.append(soloBtn);

  const delWrap = document.createElement("div");
  delWrap.className = "timeline-del";
  const deleteBtn = makeIconButton("🗑", "Delete take", () => {
    deleteTrack(trackStore, elements, track, notify);
  });
  deleteBtn.classList.add("danger");
  delWrap.append(deleteBtn);

  controls.append(sync, dryWrap, volWrap, soloWrap, delWrap);
  controls.addEventListener("click", (event) => event.stopPropagation());

  row._segmentEl = segmentEl;
  row._controlsEl = controls;
  row._getSegment = () => getTrackSegment(track, getTimelineMetrics());

  row.append(canvas, segmentEl, controls);
  wireRowActivation(row, controls, () => layoutTrackRow(row));

  requestAnimationFrame(refreshSegment);

  return row;
}

function wireRowActivation(row, controls, onActivate) {
  row.addEventListener("pointerdown", (event) => {
    if (controls.contains(event.target)) return;
    setActiveTrackRow(row);
    onActivate?.();
  });

  controls.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    setActiveTrackRow(row);
    onActivate?.();
  });

  row.addEventListener("mouseenter", () => onActivate?.());
}

function setActiveTrackRow(row) {
  if (activeTrackRow && activeTrackRow !== row) {
    activeTrackRow.classList.remove("is-active");
  }
  activeTrackRow = row;
  row.classList.add("is-active");
}

function closeVolPopover() {
  if (volOpenRow) {
    volOpenRow.classList.remove("vol-open");
    volOpenRow = null;
  }
}

document.addEventListener("pointerdown", (event) => {
  if (activeTrackRow && !activeTrackRow.contains(event.target)) {
    activeTrackRow.classList.remove("is-active");
    activeTrackRow = null;
  }
  if (volOpenRow && !volOpenRow.contains(event.target)) {
    closeVolPopover();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeVolPopover();
});

function wireVolumeButton(trackStore, track, row, volBtn, notify) {
  let pressTimer = null;
  let longPressFired = false;

  const clearPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };

  volBtn.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    longPressFired = false;
    clearPress();
    pressTimer = setTimeout(() => {
      longPressFired = true;
      closeVolPopover();
      row.classList.add("vol-open");
      volOpenRow = row;
    }, LONG_PRESS_MS);
  });

  volBtn.addEventListener("pointerup", () => {
    clearPress();
    if (!longPressFired) toggleMute(trackStore, track, volBtn, notify);
  });

  volBtn.addEventListener("pointercancel", clearPress);
}

function nudgeTrack(trackStore, track, deltaSeconds, renderSyncMs, refreshSegment, notify) {
  const next = (track.offset || 0) + deltaSeconds;
  trackStore.setTrackOffset(track, next).then(() => {
    renderSyncMs();
    refreshSegment();
  }).catch((error) => {
    reportError("nudgeTrack", error, null, notify);
  });
}

function resetTrackOffset(trackStore, track, renderSyncMs, refreshSegment, notify) {
  if ((track.offset || 0) === 0) return;
  trackStore.setTrackOffset(track, 0).then(() => {
    renderSyncMs();
    refreshSegment();
  }).catch((error) => {
    reportError("resetTrackOffset", error, null, notify);
  });
}

function toggleMute(trackStore, track, button, notify) {
  trackStore.setTrackMuted(track, !track.muted).then(() => {
    button.textContent = track.muted ? "🔇" : "🔊";
    button.classList.toggle("muted", track.muted);
  }).catch((error) => {
    reportError("toggleMute", error, null, notify);
  });
}

function toggleSolo(trackStore, elements, track) {
  const next = trackStore.getSoloId() === track.id ? null : track.id;
  trackStore.setSolo(next);
  elements.trackList.querySelectorAll(".timeline-track").forEach((trackRow) => {
    const btn = trackRow.querySelector(".timeline-solo .icon-btn");
    if (!btn) return;
    btn.classList.toggle("active", trackRow.dataset.trackId === String(next));
  });
}

async function deleteTrack(trackStore, elements, track, notify) {
  const ok = await confirmDeleteTake(elements);
  if (!ok) return;
  try {
    await trackStore.remove(track.id);
    notify("Take deleted.");
  } catch (error) {
    reportError("deleteTrack", error, "Could not delete this take.", notify);
  }
}
