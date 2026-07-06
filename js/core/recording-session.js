// Recording session — mic capture driven purely by video playback.
// The video transport IS the record control: playing captures a take, and
// pausing (or ending) finalizes it and prompts to keep or discard. There is
// no separate record button — we are always potentially recording.

import { SEEK_DETECT_SEC } from "../constants.js";
import { reportError, reportWarning } from "../errors.js";
import { formatTime } from "../ui.js";
import { computePeaks, isSilentOrNoise } from "../waveform.js";

import { applyRawMic, refreshHeadphoneDetection } from "../audio-devices.js";
import { STATE } from "../youtube.js";

export function createRecordingSession({
  player,
  recorder,
  engine,
  trackStore,
  videoStore,
  settings,
  autoSync,
  elements,
  bus,
  notify,
}) {
  let active = false;
  let keepTakePending = false;
  let finalizing = false;
  let calibrating = false;
  let recStartVideoTime = 0;
  let recStartedAt = 0;
  let lastVideoTime = null;
  let uiTimer = null;
  let stopSyncCapture = null;

  let liveCtx = null;
  let liveAnalyser = null;
  let liveSource = null;
  let liveData = null;
  let liveTimer = null;

  let sharePromptInFlight = false;

  bus.on("autosync:calibrating", (event) => {
    calibrating = !!event.detail?.active;
  });

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
      liveSource.connect(liveAnalyser);
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

  async function endSyncCapture() {
    if (!stopSyncCapture) return null;
    const stop = stopSyncCapture;
    stopSyncCapture = null;
    try {
      return await stop();
    } catch (error) {
      reportWarning("recording.syncCapture", error);
      return null;
    }
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

  async function startTake() {
    if (active || keepTakePending || finalizing || calibrating) return;
    if (!videoStore.getVideoId()) return;

    applyRawMic(settings);
    recorder.resetMic();

    try {
      await recorder.ensureMic();
      await refreshHeadphoneDetection();
    } catch (error) {
      notify(error.message, "error");
      return;
    }

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

    if (autoSync && recorder.stream) {
      stopSyncCapture = await autoSync.beginTakeCapture(recorder.stream);
    }

    showIndicator();
    startUiLoop();
    bus.emit("recording:take-started", { startTime: recStartVideoTime });
    startLiveSampling();
    emitState();
  }

  async function finalizeTake() {
    if (!active || finalizing) return;
    finalizing = true;
    active = false;

    const pcm = await endSyncCapture();

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
    const sessionId = videoStore.getSessionId();
    const trackData = {
      videoId,
      sessionId,
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
      const track = await trackStore.add(trackData);
      notify("Take saved.", "success");

      if (autoSync && pcm) {
        autoSync.analyzeTake(track, pcm).catch((error) => {
          reportWarning("recording.autoSync", error);
        });
      }
    } catch (error) {
      reportError("finalizeTake.save", error, "Could not save this take.", notify);
    }
  }

  async function discardTake() {
    if (!active) return;
    active = false;
    await endSyncCapture();
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

  async function handleSeekDuringTake() {
    reportWarning("recording.seek", "Discarded in-progress take because the video was seeked.");
    notify("Recording discarded — you seeked mid-take.", "warn");
    await discardTake();
    if (player.getState() === STATE.PLAYING && !calibrating) {
      engine.start();
      startTake();
    }
  }

  function tickUi() {
    if (!active) return;
    if (player.getState() !== STATE.PLAYING) return;

    const currentTime = player.getCurrentTime();

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

  async function onPlaying() {
    if (keepTakePending || finalizing) return;
    if (calibrating) return;

    if (autoSync?.needsTabShare() && !sharePromptInFlight) {
      sharePromptInFlight = true;
      player.pause();
      const ok = await autoSync.ensureShareBeforePlay({ fromGesture: false });
      sharePromptInFlight = false;
      if (!ok) return;
      player.play();
      return;
    }

    engine.start();
    startTake();
  }

  function onPlayerStateChange(state) {
    if (state === STATE.PLAYING) {
      onPlaying();
    } else if (state === STATE.PAUSED) {
      if (calibrating) return;
      engine.stop();
      finalizeTake();
    } else if (state === STATE.ENDED) {
      if (calibrating) return;
      engine.stop();
      finalizeTake();
    } else if (state === STATE.BUFFERING) {
      if (!calibrating) engine.stop();
    }
  }

  return {
    onPlayerStateChange,
  };
}
