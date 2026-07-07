// Auto-sync orchestrator: GCC-PHAT offset estimation via speaker bleed.

import {
  AUTOSYNC_ANALYSIS_HZ,
  AUTOSYNC_BUTTON_MAX_SEC,
  AUTOSYNC_BUTTON_WINDOW_SEC,
  AUTOSYNC_ENERGY_SUSTAIN_MS,
  AUTOSYNC_ENERGY_THRESHOLD,
  AUTOSYNC_ENERGY_WAIT_MS,
  AUTOSYNC_MAX_LAG_SEC,
  AUTOSYNC_MERGE_SEC,
  AUTOSYNC_MIN_PEAK_MEDIAN,
  AUTOSYNC_MIN_PROMINENCE,
  AUTOSYNC_REF_LATENCY_SEC,
  AUTOSYNC_WINDOW_SEC,
} from "../constants.js";
import { isUsingHeadphones } from "../audio-devices.js";
import { reportWarning } from "../errors.js";
import { hideTabShareOverlay, showTabShareOverlay, showToast } from "../ui.js";
import { STATE } from "../youtube.js";

const LOG_PREFIX = "[Jam-in auto-sync]";
const WORKER_URL = new URL("../auto-sync-worker.js", import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatOffsetMs(offsetSec) {
  return `${Math.round((offsetSec || 0) * 1000)} ms`;
}

/** Best-peak lag for logs — never substitute the fallback default. */
function measuredOffsetSec(result) {
  if (result?.measuredOffsetSec > 0) return result.measuredOffsetSec;
  if (result?.offsetSec > 0) return result.offsetSec;
  const peakLag = result?.peaks?.[0]?.lagSec;
  return peakLag > 0 ? peakLag : 0;
}

function confidenceScore(result) {
  const measured = measuredOffsetSec(result);
  if (measured <= 0) return 0;
  const { prominence = 0, peakMedianRatio = 0 } = result.confidence || {};
  return prominence * peakMedianRatio;
}

export function createAutoSync({
  referenceCapture,
  settings,
  trackStore,
  player,
  recorder,
  elements,
  bus,
  notify,
}) {
  let worker = null;
  let calibrating = false;
  let sharePromptPromise = null;
  let rollingBest = null;
  let rollingTimer = null;
  let windowSeq = 1;
  let takeStartMs = 0;
  let workerReqId = 0;
  let rollingOffsets = [];
  // Optional per-window callback (button/calibration mode) for live updates.
  let onWindowUpdate = null;
  const pendingAnalyses = new Set();

  const MIN_MEDIAN_WINDOWS = 3;
  // Peaks below this are near-DC spurious hits, not a real acoustic delay.
  const MIN_PLAUSIBLE_OFFSET_SEC = 0.05;

  function validOffsets() {
    return rollingOffsets.filter((v) => v >= MIN_PLAUSIBLE_OFFSET_SEC);
  }

  // Median of per-window measured peaks (robust to the jumpy outliers that
  // any single window produces). Constant reference-latency correction is
  // added at apply time, not here.
  function medianOffsetSec() {
    const vals = validOffsets().sort((a, b) => a - b);
    if (!vals.length) return 0;
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  }

  // Best current estimate: robust median + constant reference-capture latency.
  function correctedOffsetSec() {
    const median = medianOffsetSec();
    return median > 0 ? median + AUTOSYNC_REF_LATENCY_SEC : 0;
  }

  function getWorker() {
    if (!worker) {
      worker = new Worker(WORKER_URL, { type: "module" });
    }
    return worker;
  }

  function needsTabShare() {
    return referenceCapture.isAvailable()
      && !isUsingHeadphones()
      && !referenceCapture.hasShare();
  }

  async function ensureShareFromGesture() {
    if (!referenceCapture.isAvailable() || isUsingHeadphones()) return true;
    if (referenceCapture.hasShare()) return true;
    try {
      await referenceCapture.ensureShare();
      console.log(LOG_PREFIX, "tab audio share granted");
      return true;
    } catch (error) {
      reportWarning(LOG_PREFIX, "share denied", error);
      notify(error.message || "Tab audio share was denied.", "error");
      return false;
    }
  }

  function requestTabSharePrompt() {
    if (sharePromptPromise) return sharePromptPromise;

    sharePromptPromise = new Promise((resolve) => {
      showTabShareOverlay(elements, async () => {
        try {
          await referenceCapture.ensureShare();
          console.log(LOG_PREFIX, "tab audio share granted via player overlay");
          resolve(true);
        } catch (error) {
          reportWarning(LOG_PREFIX, "share denied via player overlay", error);
          notify(error.message || "Tab audio share was denied.", "error");
          resolve(false);
        } finally {
          hideTabShareOverlay(elements);
          sharePromptPromise = null;
        }
      });
      showToast(elements, "Tap the video to enable tab audio for auto-sync", "warn");
    });

    return sharePromptPromise;
  }

  function canMeasureBleed() {
    return referenceCapture.isAvailable()
      && !isUsingHeadphones()
      && referenceCapture.hasShare();
  }

  function logFinish(role, result, extra = {}) {
    const measured = measuredOffsetSec(result);
    const { appliedOffsetSec: extraApplied, ...restExtra } = extra;
    const appliedOffset = extraApplied ?? (result.applied ? measured : null);
    const payload = {
      role,
      measuredOffsetSec: measured,
      applied: result.applied,
      confidence: result.confidence,
      peaks: result.peaks,
      ...restExtra,
    };
    if (appliedOffset != null) payload.appliedOffsetSec = appliedOffset;

    if (result.applied) {
      console.log(LOG_PREFIX, "finish", payload);
    } else {
      console.log(LOG_PREFIX, "finish (low confidence)", payload);
      reportWarning(LOG_PREFIX, "low confidence", payload);
    }
  }

  function logEnergyWaiting(elapsedMs, rms) {
    console.log(LOG_PREFIX, "waiting for source energy", {
      elapsedMs: Math.round(elapsedMs),
      refRms: +rms.toFixed(5),
      threshold: AUTOSYNC_ENERGY_THRESHOLD,
    });
  }

  function logEnergyReached(elapsedMs, rms) {
    console.log(LOG_PREFIX, "high energy reached", {
      elapsedMs: Math.round(elapsedMs),
      refRms: +rms.toFixed(5),
      threshold: AUTOSYNC_ENERGY_THRESHOLD,
    });
  }

  function logWindowResult(seq, result, isBest) {
    console.log(LOG_PREFIX, `window ${seq} result`, {
      window: seq,
      elapsedMs: takeStartMs ? Math.round(Date.now() - takeStartMs) : 0,
      measuredOffsetSec: measuredOffsetSec(result),
      applied: result.applied,
      confidence: result.confidence,
      peaks: result.peaks,
      confidenceScore: confidenceScore(result),
      isBest,
      bestWindow: rollingBest?.windowSeq ?? null,
    });
  }

  function resetRollingState() {
    rollingBest = null;
    windowSeq = 1;
    takeStartMs = Date.now();
    rollingOffsets = [];
    onWindowUpdate = null;
    pendingAnalyses.clear();
  }

  function clearRollingTimer() {
    if (rollingTimer) {
      clearInterval(rollingTimer);
      rollingTimer = null;
    }
  }

  function updateRollingBest(seq, result) {
    const score = confidenceScore(result);
    const isBest = !rollingBest || score > rollingBest.score;
    if (isBest && score > 0) {
      rollingBest = { windowSeq: seq, result, score };
    }
    return isBest;
  }

  function analyzeInWorker(pcm, role, id, opts = {}) {
    return new Promise((resolve, reject) => {
      const w = getWorker();
      const onMessage = (event) => {
        if (event.data?.id !== id) return;
        w.removeEventListener("message", onMessage);
        if (!event.data.ok) {
          reject(new Error(event.data.error || "Worker analysis failed"));
          return;
        }
        resolve(event.data);
      };
      w.addEventListener("message", onMessage);
      w.postMessage({
        mic: pcm.mic,
        ref: pcm.ref,
        sampleRate: pcm.sampleRate,
        maxLagSec: AUTOSYNC_MAX_LAG_SEC,
        mergeSec: AUTOSYNC_MERGE_SEC,
        minProminence: AUTOSYNC_MIN_PROMINENCE,
        minPeakMedian: AUTOSYNC_MIN_PEAK_MEDIAN,
        role,
        id,
        ...opts,
      }, [pcm.mic.buffer, pcm.ref.buffer]);
    });
  }

  async function applyTrackOffset(track, offsetSec, { source, measuredOffsetSec: measured } = {}) {
    const absolute = Math.max(0, Math.round(offsetSec * 1000) / 1000);
    console.log(LOG_PREFIX, "track offset applied", {
      source,
      appliedOffsetSec: absolute,
      ...(measured > 0 && measured !== absolute ? { measuredOffsetSec: measured } : {}),
    });
    await trackStore.setTrackOffset(track, absolute);
    bus.emit("tracks:changed", { tracks: [...trackStore.getTracks()] });
  }

  async function waitForEnergy(getRms) {
    const start = Date.now();
    let highSince = null;
    let lastLog = 0;

    while (Date.now() - start < AUTOSYNC_ENERGY_WAIT_MS) {
      const rms = getRms();
      const elapsed = Date.now() - start;

      if (Date.now() - lastLog > 500) {
        logEnergyWaiting(elapsed, rms);
        lastLog = Date.now();
      }

      if (rms >= AUTOSYNC_ENERGY_THRESHOLD) {
        if (!highSince) highSince = Date.now();
        if (Date.now() - highSince >= AUTOSYNC_ENERGY_SUSTAIN_MS) {
          logEnergyReached(elapsed, rms);
          return true;
        }
      } else {
        highSince = null;
      }

      await sleep(50);
    }

    reportWarning(LOG_PREFIX, "energy wait timed out", {
      waitedMs: AUTOSYNC_ENERGY_WAIT_MS,
      threshold: AUTOSYNC_ENERGY_THRESHOLD,
    });
    return false;
  }

  function setCalibrating(active) {
    calibrating = active;
    bus.emit("autosync:calibrating", { active });
  }

  async function analyzeWindow(pcm, seq) {
    if (!pcm || pcm.mic.length < AUTOSYNC_ANALYSIS_HZ || pcm.ref.length < AUTOSYNC_ANALYSIS_HZ) {
      console.log(LOG_PREFIX, `window ${seq} result (insufficient data)`, {
        window: seq,
        micSamples: pcm?.mic?.length ?? 0,
        refSamples: pcm?.ref?.length ?? 0,
      });
      return null;
    }

    const id = ++workerReqId;
    const role = `per-take-window-${seq}`;
    let result;
    try {
      result = await analyzeInWorker(pcm, role, id);
    } catch (error) {
      reportWarning(LOG_PREFIX, `window ${seq} analysis error`, error);
      return null;
    }

    const measured = measuredOffsetSec(result);
    if (measured > 0) rollingOffsets.push(measured);
    const isBest = updateRollingBest(seq, result);
    logWindowResult(seq, result, isBest);

    if (onWindowUpdate) {
      const corrected = correctedOffsetSec();
      if (corrected > 0) {
        onWindowUpdate({ corrected, isBest, validWindows: validOffsets().length });
      }
    }
    return result;
  }

  function dispatchWindowAnalysis(pcm, seq) {
    const promise = analyzeWindow(pcm, seq);
    pendingAnalyses.add(promise);
    promise.finally(() => pendingAnalyses.delete(promise));
    return promise;
  }

  async function onWindowTick() {
    const seq = windowSeq;
    try {
      const snap = await referenceCapture.snapshotWindow();
      if (snap) dispatchWindowAnalysis(snap, seq);
    } catch (error) {
      reportWarning(LOG_PREFIX, `window ${seq} snapshot failed`, error);
    }
    windowSeq += 1;
  }

  async function analyzeFinalWindow() {
    const seq = windowSeq;
    try {
      const snap = await referenceCapture.snapshotWindow();
      if (snap) await dispatchWindowAnalysis(snap, seq);
    } catch (error) {
      reportWarning(LOG_PREFIX, `window ${seq} final snapshot failed`, error);
    }
  }

  /**
   * Measure speaker bleed and set the speakers default offset.
   * Uses the same rolling-window algorithm as per-take sync, but with shorter
   * (6 s) windows and LIVE updates: the default offset is refined after every
   * window instead of only at the end. Runs until the user pauses playback
   * (finalizing the partial in-progress window) or a safety cap is reached.
   * Must be called from a user gesture (for ensureShare).
   */
  async function runSpeakersDefaultCalibration() {
    if (calibrating) return;
    if (!referenceCapture.isAvailable()) {
      notify("Auto-sync needs Chrome/Edge desktop with tab audio sharing.", "warn");
      return;
    }
    if (isUsingHeadphones()) {
      notify("Speaker default calibration needs speakers (no headphones).", "warn");
      return;
    }

    try {
      await referenceCapture.ensureShare();
    } catch (error) {
      notify(error.message || "Tab audio share was denied.", "error");
      return;
    }

    try {
      await recorder.ensureMic();
    } catch (error) {
      notify(error.message, "error");
      return;
    }

    setCalibrating(true);
    console.log(LOG_PREFIX, "rolling default-speakers calibration starting");

    let capturing = false;
    try {
      await referenceCapture.startCapture(recorder.stream, {
        windowSec: AUTOSYNC_BUTTON_WINDOW_SEC,
      });
      capturing = true;
      resetRollingState();
      // Live-update the speakers default as each window refines the estimate.
      onWindowUpdate = ({ corrected }) => {
        settings.setDefaultOffsetSpeakers(corrected);
      };

      const wasPlaying = player.getState() === STATE.PLAYING;
      if (!wasPlaying) player.play();

      await waitForEnergy(() => referenceCapture.refEnergy());

      rollingTimer = setInterval(() => {
        onWindowTick().catch((error) => {
          reportWarning(LOG_PREFIX, "calibration window tick failed", error);
        });
      }, AUTOSYNC_BUTTON_WINDOW_SEC * 1000);

      // Keep refining until the user pauses playback (or the safety cap hits).
      const startedAt = Date.now();
      while (
        player.getState() === STATE.PLAYING
        && calibrating
        && Date.now() - startedAt < AUTOSYNC_BUTTON_MAX_SEC * 1000
      ) {
        await sleep(150);
      }

      clearRollingTimer();
      // Finalize with whatever the current (possibly partial) window holds.
      await analyzeFinalWindow();
      await Promise.all([...pendingAnalyses]);
      await referenceCapture.stopCapture();
      capturing = false;
    } catch (error) {
      reportWarning(LOG_PREFIX, "default-speakers calibration failed", error);
      notify("Default sync calibration failed.", "error");
    } finally {
      clearRollingTimer();
      onWindowUpdate = null;
      if (capturing) await referenceCapture.stopCapture();
      if (player.getState() === STATE.PLAYING) player.pause();
      setCalibrating(false);
      console.log(LOG_PREFIX, "default-speakers calibration finished");
    }

    const corrected = correctedOffsetSec();
    const windows = validOffsets().length;
    if (windows >= 1 && corrected > 0) {
      settings.setDefaultOffsetSpeakers(corrected);
      notify(
        `Speakers default set to ${formatOffsetMs(corrected)} (${windows} window${windows > 1 ? "s" : ""})`,
        "success"
      );
    } else {
      const fallback = settings.getDefaultOffsetSpeakers();
      reportWarning(LOG_PREFIX, "default-speakers not updated (no measurement)", {
        windows,
        appliedOffsetSec: fallback,
      });
      notify(
        `Could not measure speakers default — kept ${formatOffsetMs(fallback)}`,
        "warn"
      );
    }
    resetRollingState();
  }

  /**
   * Per-take analysis after a confirmed take.
   * Uses the highest-confidence rolling window when confident; otherwise the route default.
   */
  async function analyzeTake(track, pcm) {
    if (isUsingHeadphones()) {
      const fallback = settings.getDefaultOffsetHeadphones();
      logFinish("per-take", {
        offsetSec: fallback,
        applied: true,
        confidence: { source: "headphones-default" },
        peaks: [],
      }, { source: "headphones-default" });
      await applyTrackOffset(track, fallback, { source: "headphones-default" });
      resetRollingState();
      return null;
    }

    if (!canMeasureBleed() || !pcm) {
      const fallback = settings.getDefaultOffsetSpeakers();
      logFinish("per-take", {
        offsetSec: fallback,
        applied: true,
        confidence: { source: "speakers-default-no-measurement" },
        peaks: [],
      }, { source: "speakers-default-fallback" });
      await applyTrackOffset(track, fallback, { source: "speakers-default-fallback" });
      resetRollingState();
      return null;
    }

    const bestResult = rollingBest?.result ?? null;
    const median = medianOffsetSec();
    const validWindows = rollingOffsets.filter((v) => v >= MIN_PLAUSIBLE_OFFSET_SEC).length;
    const useMedian = validWindows >= MIN_MEDIAN_WINDOWS && median > 0;
    // Reliable estimator = median of rho=0.3 per-window peaks + constant
    // reference-capture latency (raw bleed correlation undershoots the true
    // take offset because the tab-audio reference arrives late).
    const rawMeasured = useMedian ? median : measuredOffsetSec(bestResult);
    const measured = rawMeasured > 0 ? rawMeasured + AUTOSYNC_REF_LATENCY_SEC : 0;
    const confident = useMedian || bestResult?.applied;

    if (confident && measured > 0) {
      console.log(LOG_PREFIX, "per-take offset", {
        source: useMedian ? "median+latency" : "best-window+latency",
        windows: validWindows,
        medianOffsetSec: median,
        refLatencySec: AUTOSYNC_REF_LATENCY_SEC,
        bestWindow: rollingBest?.windowSeq ?? null,
        measuredOffsetSec: measured,
      });
      await applyTrackOffset(track, measured, { source: "measured", measuredOffsetSec: measured });
      const result = bestResult;
      resetRollingState();
      return result;
    }

    const fallback = settings.getDefaultOffsetSpeakers();
    logFinish("per-take", bestResult ?? {
      offsetSec: fallback,
      applied: false,
      confidence: {},
      peaks: [],
    }, {
      source: "speakers-default-low-confidence",
      bestWindow: rollingBest?.windowSeq ?? null,
      measuredOffsetSec: measured,
    });
    await applyTrackOffset(track, fallback, {
      source: "speakers-default-low-confidence",
      measuredOffsetSec: measured,
    });
    resetRollingState();
    return bestResult;
  }

  async function beginTakeCapture(micStream) {
    if (!canMeasureBleed()) return null;
    try {
      await referenceCapture.startCapture(micStream, { windowSec: AUTOSYNC_WINDOW_SEC });
      resetRollingState();
      rollingTimer = setInterval(() => {
        onWindowTick().catch((error) => {
          reportWarning(LOG_PREFIX, "window tick failed", error);
        });
      }, AUTOSYNC_WINDOW_SEC * 1000);

      return async () => {
        clearRollingTimer();
        await analyzeFinalWindow();
        await Promise.all([...pendingAnalyses]);
        return referenceCapture.stopCapture();
      };
    } catch (error) {
      reportWarning(LOG_PREFIX, "take capture start failed", error);
      clearRollingTimer();
      resetRollingState();
      return null;
    }
  }

  async function ensureShareBeforePlay({ fromGesture = false } = {}) {
    if (!needsTabShare()) return true;
    if (fromGesture) return ensureShareFromGesture();
    return requestTabSharePrompt();
  }

  function isCalibrating() {
    return calibrating;
  }

  return {
    runSpeakersDefaultCalibration,
    // Back-compat alias
    runCalibration: runSpeakersDefaultCalibration,
    analyzeTake,
    beginTakeCapture,
    ensureShareBeforePlay,
    ensureShareFromGesture,
    needsTabShare,
    canAutoSync: canMeasureBleed,
    isCalibrating,
  };
}
