// Recording session — mic capture driven purely by video playback.
// The video transport IS the record control: playing captures a take, and
// pausing (or ending) finalizes it and prompts to keep or discard. There is
// no separate record button — we are always potentially recording.

import { SEEK_DETECT_SEC } from "../constants.js";
import { reportError, reportWarning } from "../errors.js";
import { formatTime } from "../ui.js";
import { computePeaks, isSilentOrNoise } from "../waveform.js";
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

  // Live waveform sampling (Web Audio analyser tapping the mic stream).
  let liveCtx = null;
  let liveAnalyser = null;
  let liveSource = null;
  let liveData = null;
  let liveTimer = null;

  function emitState() {
    bus.emit("recording:state-changed", { active });
  }

  function startLiveSampling() {
    const stream = recorder.stream;
    if (!stream) return;
    try {
      if (!liveCtx) liveCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (liveCtx.state === "suspended") liveCtx.resume();
      liveSource = liveCtx.createMediaStreamSource(stream);
      liveAnalyser = liveCtx.createAnalyser();
      liveAnalyser.fftSize = 1024;
      liveSource.connect(liveAnalyser); // analyser only — never to destination
      liveData = new Float32Array(liveAnalyser.fftSize);
      liveTimer = setInterval(sampleLive, 60);
    } catch (error) {
      reportWarning("recording.liveSampler", error);
    }
  }

  function sampleLive() {
    if (!liveAnalyser) return;
    liveAnalyser.getFloatTimeDomainData(liveData);
    let peak = 0;
    for (let i = 0; i < liveData.length; i++) {
      const a = Math.abs(liveData[i]);
      if (a > peak) peak = a;
    }
    bus.emit("recording:live-sample", { peak });
  }

  function stopLiveSampling() {
    if (liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
    if (liveSource) {
      try { liveSource.disconnect(); } catch { /* already gone */ }
      liveSource = null;
    }
    liveAnalyser = null;
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
    bus.emit("recording:take-started", { startTime: recStartVideoTime });
    startLiveSampling();
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
    stopLiveSampling();
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
    let silent = false;

    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const buffer = await audioContext.decodeAudioData((await blob.arrayBuffer()).slice(0));
      duration = buffer.duration;
      peaks = computePeaks(buffer);
      silent = isSilentOrNoise(buffer);
      audioContext.close();
    } catch (error) {
      reportError("finalizeTake.decode", error, null, notify);
    }

    // Don't bother the user with a keep/discard prompt for an empty take.
    if (silent) {
      finalizing = false;
      bus.emit("recording:take-ended", { kept: false });
      notify("Nothing to keep — that take was silent.");
      return;
    }

    const keep = await confirmKeepTake();
    finalizing = false;
    if (!keep) {
      bus.emit("recording:take-ended", { kept: false });
      notify("Take discarded.");
      return;
    }

    bus.emit("recording:take-ended", { kept: true });

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

  // Drop the in-progress take without prompting (used when a seek makes the
  // recording meaningless). Stops the recorder and resets state.
  async function discardTake() {
    if (!active) return;
    active = false;
    hideIndicator();
    engine.stop();
    stopUiLoop();
    stopLiveSampling();
    lastVideoTime = null;
    bus.emit("recording:take-ended", { kept: false });
    emitState();
    try {
      await recorder.stop();
    } catch (error) {
      reportError("discardTake", error, null, notify);
    }
  }

  // Seeking (YT scrubber or the green playhead) breaks continuity, so the take
  // is thrown away rather than kept. Warn, but don't block the user.
  async function handleSeekDuringTake() {
    reportWarning("recording.seek", "Discarded in-progress take because the video was seeked.");
    notify("Recording discarded — you seeked mid-take.", "warn");
    await discardTake();
    // Honour "always record on play": if playback keeps going past the seek,
    // start a fresh take from the new position.
    if (player.getState() === STATE.PLAYING) {
      engine.start();
      startTake();
    }
  }

  function tickUi() {
    if (!active) return;

    // Only track position while actually playing. During buffering (e.g. right
    // after a seek) getCurrentTime already reports the new target, so updating
    // lastVideoTime here would mask the seek and let the old take run on.
    if (player.getState() !== STATE.PLAYING) return;

    const currentTime = player.getCurrentTime();

    // A seek mid-take is a discontinuity: discard this take (and start a fresh
    // one from the new position while playback continues).
    if (lastVideoTime != null) {
      const jump = Math.abs(currentTime - lastVideoTime);
      if (jump > SEEK_DETECT_SEC) {
        handleSeekDuringTake();
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
