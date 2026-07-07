// Tab-audio reference capture via getDisplayMedia, aligned with the mic stream.

import { AUTOSYNC_ANALYSIS_HZ, AUTOSYNC_WINDOW_SEC } from "./constants.js";
import { reportWarning } from "./errors.js";

const WORKLET_URL = new URL("./worklets/capture-processor.js", import.meta.url);

export function createReferenceCapture() {
  let shareStream = null;
  let audioTrack = null;
  let ctx = null;
  let workletLoaded = false;
  let workletNode = null;
  let micSource = null;
  let refSource = null;
  let merger = null;
  let capturing = false;

  // Latest reference RMS from the worklet.
  let refEnergyRms = 0;

  function isAvailable() {
    return !!(navigator.mediaDevices?.getDisplayMedia
      && window.AudioWorklet
      && window.isSecureContext);
  }

  async function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === "suspended") await ctx.resume();
    if (!ctx.audioWorklet) {
      throw new Error("AudioWorklet is not supported in this browser.");
    }
    if (!workletLoaded) {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      workletLoaded = true;
    }
    return ctx;
  }

  /**
   * Request tab-audio share. Must be called from a user gesture.
   * Keeps the audio track; stops the video track immediately.
   */
  async function ensureShare() {
    if (audioTrack && audioTrack.readyState === "live") return shareStream;

    if (!isAvailable()) {
      throw new Error("Tab audio capture is not available in this browser.");
    }

    shareStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      preferCurrentTab: true,
      selfBrowserSurface: "include",
    });

    // Drop the video track — we only need audio.
    for (const track of shareStream.getVideoTracks()) track.stop();

    const audioTracks = shareStream.getAudioTracks();
    if (!audioTracks.length) {
      shareStream.getTracks().forEach((t) => t.stop());
      shareStream = null;
      throw new Error(
        "No audio track in the share. Pick this tab and enable 'Share tab audio'."
      );
    }

    audioTrack = audioTracks[0];
    audioTrack.addEventListener("ended", () => {
      audioTrack = null;
      shareStream = null;
    });

    return shareStream;
  }

  function hasShare() {
    return !!(audioTrack && audioTrack.readyState === "live");
  }

  /** Recent reference RMS (0..1 range, updated ~20 Hz during capture). */
  function refEnergy() {
    return refEnergyRms;
  }

  /**
   * Start aligned mic+ref capture. Returns a stop function.
   * stop() resolves with { mic, ref, sampleRate } Float32Arrays.
   * `windowSec` sizes the rolling ring buffer (each snapshot returns the
   * most recent `windowSec` seconds of audio).
   */
  async function startCapture(micStream, { windowSec = AUTOSYNC_WINDOW_SEC } = {}) {
    if (capturing) await stopCapture();
    if (!hasShare()) {
      throw new Error("Tab audio share is not active.");
    }

    const audioCtx = await ensureCtx();
    refEnergyRms = 0;

    const refStream = new MediaStream([audioTrack]);
    micSource = audioCtx.createMediaStreamSource(micStream);
    refSource = audioCtx.createMediaStreamSource(refStream);
    merger = audioCtx.createChannelMerger(2);
    micSource.connect(merger, 0, 0);
    refSource.connect(merger, 0, 1);

    const maxSamples = AUTOSYNC_ANALYSIS_HZ * windowSec;
    workletNode = new AudioWorkletNode(audioCtx, "capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
      processorOptions: {
        targetHz: AUTOSYNC_ANALYSIS_HZ,
        maxSamples,
      },
    });

    workletNode.port.onmessage = (event) => {
      if (event.data?.type === "energy") {
        refEnergyRms = event.data.rms;
      }
    };

    merger.connect(workletNode);
    capturing = true;

    return stopCapture;
  }

  function snapshotWindow() {
    return new Promise((resolve, reject) => {
      if (!capturing || !workletNode) {
        resolve(null);
        return;
      }

      const node = workletNode;
      let settled = false;
      let timeoutId = null;
      const onMessage = (event) => {
        if (event.data?.type !== "snapshot") return;
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        node.port.removeEventListener("message", onMessage);
        resolve({
          mic: new Float32Array(event.data.mic),
          ref: new Float32Array(event.data.ref),
          sampleRate: AUTOSYNC_ANALYSIS_HZ,
        });
      };

      node.port.addEventListener("message", onMessage);
      node.port.postMessage({ type: "snapshot" });

      timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        node.port.removeEventListener("message", onMessage);
        reportWarning("referenceCapture.snapshotTimeout", "Worklet snapshot timed out");
        reject(new Error("Worklet snapshot timed out"));
      }, 2000);
    });
  }

  function stopCapture() {
    return new Promise((resolve) => {
      if (!capturing || !workletNode) {
        resolve(null);
        return;
      }

      // Ask the worklet to flush; read buffers from its closure via a
      // one-shot message after disconnecting (buffers live in the processor).
      // We pull data by sending a flush command through a dedicated port message.
      const node = workletNode;

      const finish = () => {
        try { micSource?.disconnect(); } catch { /* */ }
        try { refSource?.disconnect(); } catch { /* */ }
        try { merger?.disconnect(); } catch { /* */ }
        try { node?.disconnect(); } catch { /* */ }
        micSource = null;
        refSource = null;
        merger = null;
        workletNode = null;
        capturing = false;

        resolve(null);
      };

      // The worklet accumulates in its own buffers; we need to retrieve them.
      // Post a flush request and wait for the response.
      const onMessage = (event) => {
        if (event.data?.type !== "flush") return;
        node.port.removeEventListener("message", onMessage);
        try { micSource?.disconnect(); } catch { /* */ }
        try { refSource?.disconnect(); } catch { /* */ }
        try { merger?.disconnect(); } catch { /* */ }
        try { node?.disconnect(); } catch { /* */ }
        micSource = null;
        refSource = null;
        merger = null;
        workletNode = null;
        capturing = false;

        resolve({
          mic: new Float32Array(event.data.mic),
          ref: new Float32Array(event.data.ref),
          sampleRate: AUTOSYNC_ANALYSIS_HZ,
        });
      };

      node.port.addEventListener("message", onMessage);
      node.port.postMessage({ type: "flush" });

      // Fallback if worklet doesn't respond (shouldn't happen).
      setTimeout(() => {
        if (capturing) {
          reportWarning("referenceCapture.flushTimeout", "Worklet flush timed out");
          finish();
        }
      }, 2000);
    });
  }

  function releaseShare() {
    if (shareStream) {
      shareStream.getTracks().forEach((t) => t.stop());
    }
    shareStream = null;
    audioTrack = null;
  }

  return {
    isAvailable,
    ensureShare,
    hasShare,
    refEnergy,
    startCapture,
    snapshotWindow,
    stopCapture,
    releaseShare,
  };
}
