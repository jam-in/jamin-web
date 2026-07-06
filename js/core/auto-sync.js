// Auto-sync orchestrator: GCC-PHAT offset estimation via speaker bleed.

import {
  AUTOSYNC_ANALYSIS_HZ,
  AUTOSYNC_CALIB_WINDOW_SEC,
  AUTOSYNC_ENERGY_SUSTAIN_MS,
  AUTOSYNC_ENERGY_THRESHOLD,
  AUTOSYNC_ENERGY_WAIT_MS,
  AUTOSYNC_MAX_LAG_SEC,
  AUTOSYNC_MERGE_SEC,
  AUTOSYNC_MIN_PEAK_MEDIAN,
  AUTOSYNC_MIN_PROMINENCE,
} from "../constants.js";
import { isUsingHeadphones } from "../audio-devices.js";
import { reportWarning } from "../errors.js";
import { showActionToast } from "../ui.js";
import { STATE } from "../youtube.js";

const LOG_PREFIX = "[Jam-in auto-sync]";
const WORKER_URL = new URL("../auto-sync-worker.js", import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    return new Promise((resolve) => {
      showActionToast(
        elements,
        "Tap to share this tab's audio (required for auto-sync)",
        async () => {
          try {
            await referenceCapture.ensureShare();
            console.log(LOG_PREFIX, "tab audio share granted via prompt");
            resolve(true);
          } catch (error) {
            reportWarning(LOG_PREFIX, "share denied via prompt", error);
            notify(error.message || "Tab audio share was denied.", "error");
            resolve(false);
          }
        },
        "warn"
      );
    });
  }

  function canMeasureBleed() {
    return referenceCapture.isAvailable()
      && !isUsingHeadphones()
      && referenceCapture.hasShare();
  }

  function logStart(role, pcm) {
    console.log(LOG_PREFIX, "start", {
      role,
      sampleRate: pcm?.sampleRate ?? AUTOSYNC_ANALYSIS_HZ,
      micSamples: pcm?.mic?.length ?? 0,
      refSamples: pcm?.ref?.length ?? 0,
    });
  }

  function logFinish(role, result, extra = {}) {
    const payload = {
      role,
      offsetSec: result.offsetSec,
      applied: result.applied,
      confidence: result.confidence,
      peaks: result.peaks,
      ...extra,
    };
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

  function analyzeInWorker(pcm, role) {
    return new Promise((resolve, reject) => {
      const w = getWorker();
      const onMessage = (event) => {
        if (event.data?.role !== role) return;
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
      }, [pcm.mic.buffer, pcm.ref.buffer]);
    });
  }

  async function applyTrackOffset(track, offsetSec, { source } = {}) {
    const absolute = Math.max(0, Math.round(offsetSec * 1000) / 1000);
    console.log(LOG_PREFIX, "track offset applied", {
      source,
      offsetSec: absolute,
    });
    await trackStore.setTrackOffset(track, absolute);
    bus.emit("tracks:changed", { tracks: [...trackStore.getTracks()] });
  }

  async function runAnalysis(pcm, role) {
    logStart(role, pcm);
    let result;
    try {
      result = await analyzeInWorker(pcm, role);
    } catch (error) {
      reportWarning(LOG_PREFIX, "analysis error", role, error);
      logFinish(role, {
        offsetSec: 0,
        applied: false,
        confidence: {},
        peaks: [],
      });
      return null;
    }

    logFinish(role, result);
    return result;
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

  /**
   * Measure speaker bleed and set the speakers default offset.
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
    console.log(LOG_PREFIX, "default-speakers calibration starting");

    let pcm = null;
    let capturing = false;
    try {
      await referenceCapture.startCapture(recorder.stream);
      capturing = true;

      const wasPlaying = player.getState() === STATE.PLAYING;
      if (!wasPlaying) player.play();

      await waitForEnergy(() => referenceCapture.refEnergy());

      const windowMs = AUTOSYNC_CALIB_WINDOW_SEC * 1000;
      const captureStart = Date.now();
      while (Date.now() - captureStart < windowMs) {
        if (player.getState() !== STATE.PLAYING) break;
        await sleep(100);
      }

      player.pause();
      pcm = await referenceCapture.stopCapture();
      capturing = false;
    } catch (error) {
      reportWarning(LOG_PREFIX, "default-speakers calibration failed", error);
      notify("Default sync calibration failed.", "error");
    } finally {
      if (capturing) {
        const leftover = await referenceCapture.stopCapture();
        if (!pcm) pcm = leftover;
      }
      setCalibrating(false);
      console.log(LOG_PREFIX, "default-speakers calibration finished");
    }

    if (!pcm || pcm.mic.length < AUTOSYNC_ANALYSIS_HZ || pcm.ref.length < AUTOSYNC_ANALYSIS_HZ) {
      reportWarning(LOG_PREFIX, "insufficient capture data", {
        micSamples: pcm?.mic?.length ?? 0,
        refSamples: pcm?.ref?.length ?? 0,
      });
      return;
    }

    const result = await runAnalysis(pcm, "default-speakers");
    if (result?.applied && result.offsetSec > 0) {
      settings.setDefaultOffsetSpeakers(result.offsetSec);
      notify(
        `Speakers default set to ${Math.round(result.offsetSec * 1000)} ms`,
        "success"
      );
    } else {
      reportWarning(LOG_PREFIX, "default-speakers not updated (low confidence)", result);
      notify("Could not measure speakers default — adjust manually.", "warn");
    }
  }

  /**
   * Per-take analysis after a confirmed take.
   * Uses measured offset when confident; otherwise the route-appropriate default.
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
      return null;
    }

    const result = await runAnalysis(pcm, "per-take");
    if (result?.applied && result.offsetSec > 0) {
      await applyTrackOffset(track, result.offsetSec, { source: "measured" });
    } else {
      const fallback = settings.getDefaultOffsetSpeakers();
      logFinish("per-take", {
        offsetSec: fallback,
        applied: true,
        confidence: result?.confidence ?? {},
        peaks: result?.peaks ?? [],
      }, { source: "speakers-default-low-confidence", measured: result?.offsetSec ?? 0 });
      await applyTrackOffset(track, fallback, { source: "speakers-default-low-confidence" });
    }
    return result;
  }

  async function beginTakeCapture(micStream) {
    if (!canMeasureBleed()) return null;
    try {
      await referenceCapture.startCapture(micStream);
      return () => referenceCapture.stopCapture();
    } catch (error) {
      reportWarning(LOG_PREFIX, "take capture start failed", error);
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
