// Recording session — mic capture driven purely by video playback.
// The video transport IS the record control: playing captures a take, and
// pausing (or ending) finalizes it and prompts to keep or discard. There is
// no separate record button — we are always potentially recording.

import { SEEK_DETECT_SEC } from "../constants.js";
import { reportError } from "../errors.js";
import { formatTime } from "../ui.js";
import { computePeaks } from "../waveform.js";
import { getEffectiveRawMic } from "../audio-devices.js";
import { STATE } from "../youtube.js";

export function createRecordingSession({
  player,
  recorder,
  engine,
  trackStore,
  videoStore,
  settings,
  elements,
  bus,
  notify,
}) {
  // A take is "active" while the mic is capturing the current play segment.
  let active = false;
  let keepTakePending = false;
  let finalizing = false;
  let recStartVideoTime = 0;
  let recStartedAt = 0;
  let lastVideoTime = null;
  let uiTimer = null;

  function emitState() {
    bus.emit("recording:state-changed", { active });
  }

  function elapsedSec() {
    return recStartedAt ? (Date.now() - recStartedAt) / 1000 : 0;
  }

  function stopUiLoop() {
    clearInterval(uiTimer);
    uiTimer = null;
  }

  function startUiLoop() {
    if (uiTimer) return;
    uiTimer = setInterval(() => tickUi(), 250);
  }

  function showIndicator() {
    elements.recIndicator.hidden = false;
    elements.recIndicator.innerHTML = `● REC <span id="recTimer">0:00</span>`;
    elements.recTimer = document.getElementById("recTimer");
  }

  function hideIndicator() {
    elements.recIndicator.hidden = true;
  }

  function confirmKeepTake() {
    return new Promise((resolve) => {
      keepTakePending = true;
      elements.keepTakeModal.hidden = false;

      const finish = (keep) => {
        keepTakePending = false;
        elements.keepTakeModal.hidden = true;
        elements.keepTakeYes.removeEventListener("click", onYes);
        elements.keepTakeNo.removeEventListener("click", onNo);
        document.removeEventListener("keydown", onKey);
        resolve(keep);
      };

      const onYes = () => finish(true);
      const onNo = () => finish(false);
      const onKey = (event) => {
        if (event.key === "Escape") finish(false);
      };

      elements.keepTakeYes.addEventListener("click", onYes);
      elements.keepTakeNo.addEventListener("click", onNo);
      document.addEventListener("keydown", onKey);
      elements.keepTakeYes.focus();
    });
  }

  // Begin capturing a take for the play segment that just started.
  async function startTake() {
    if (active || keepTakePending || finalizing) return;
    if (!videoStore.getVideoId()) return;

    settings.setRawMic(getEffectiveRawMic());
    if (getEffectiveRawMic()) recorder.resetMic();

    try {
      await recorder.ensureMic();
    } catch (error) {
      notify(error.message, "error");
      return;
    }

    // The mic request is async; if the user paused (or seeked) meanwhile, abort
    // so we don't start capturing over a stopped video.
    if (player.getState() !== STATE.PLAYING) return;

    recStartVideoTime = player.getCurrentTime();
    recStartedAt = Date.now();
    lastVideoTime = recStartVideoTime;

    try {
      await recorder.start();
    } catch (error) {
      reportError("startTake", error, null, notify);
      return;
    }
    active = true;

    showIndicator();
    startUiLoop();
    emitState();
  }

  // End the current take and ask whether to keep it. By the time we get here
  // the player is already paused (user pause), ended, or paused for a seek.
  async function finalizeTake() {
    if (!active || finalizing) return;
    finalizing = true;
    active = false;

    hideIndicator();
    engine.stop();
    stopUiLoop();
    lastVideoTime = null;
    emitState();

    let result;
    try {
      result = await recorder.stop();
    } catch (error) {
      reportError("finalizeTake", error, null, notify);
      finalizing = false;
      return;
    }

    const { blob, mimeType } = result;
    let duration = elapsedSec();
    let peaks = [];

    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const buffer = await audioContext.decodeAudioData((await blob.arrayBuffer()).slice(0));
      duration = buffer.duration;
      peaks = computePeaks(buffer);
      audioContext.close();
    } catch (error) {
      reportError("finalizeTake.decode", error, null, notify);
    }

    const keep = await confirmKeepTake();
    finalizing = false;
    if (!keep) {
      notify("Take discarded.");
      return;
    }

    const videoId = videoStore.getVideoId();
    const trackData = {
      videoId,
      name: `Take ${trackStore.getTracks().length + 1}`,
      startTime: recStartVideoTime,
      offset: 0,
      duration,
      mimeType,
      volume: 1,
      muted: false,
      peaks,
      createdAt: Date.now(),
      blob,
    };

    try {
      await trackStore.add(trackData);
      notify("Take saved.", "success");
    } catch (error) {
      reportError("finalizeTake.save", error, "Could not save this take.", notify);
    }
  }

  function tickUi() {
    if (!active) return;

    const currentTime = player.getCurrentTime();
    const playerState = player.getState();

    // A seek mid-take is a discontinuity: pause so the take is finalized, then
    // the next play starts a fresh take at the new position.
    if (lastVideoTime != null && playerState !== STATE.BUFFERING) {
      const jump = Math.abs(currentTime - lastVideoTime);
      if (jump > SEEK_DETECT_SEC) {
        player.pause();
        return;
      }
    }
    lastVideoTime = currentTime;

    if (elements.recTimer) {
      elements.recTimer.textContent = formatTime(elapsedSec());
    }
  }

  function onPlayerStateChange(state) {
    if (state === STATE.PLAYING) {
      if (keepTakePending || finalizing) return;
      engine.start();
      startTake();
    } else if (state === STATE.PAUSED) {
      engine.stop();
      finalizeTake();
    } else if (state === STATE.ENDED) {
      engine.stop();
      finalizeTake();
    } else if (state === STATE.BUFFERING) {
      engine.stop();
    }
  }

  return {
    onPlayerStateChange,
  };
}
