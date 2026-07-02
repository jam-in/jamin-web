// Headphone detection + raw-mic mode.

import { STORAGE_KEYS } from "./constants.js";
import { reportWarning } from "./errors.js";

const HEADPHONE_HINTS = [
  "headphone", "headset", "airpod", "earbud", "earphone",
  "bluetooth", "wireless", "buds", "wh-", "sony", "bose",
];

let headphonesDetected = null;
let rawMicOverride = "auto";

export function initAudioDevices({ elements, settings }) {
  rawMicOverride = localStorage.getItem(STORAGE_KEYS.rawMicOverride) || "auto";
  if (elements.advRawMic) {
    elements.advRawMic.value = rawMicOverride;
  }

  refreshHeadphoneDetection();
  applyRawMic(settings);

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      refreshHeadphoneDetection();
      applyRawMic(settings);
    });
  }
}

export function setRawMicOverride(settings, value) {
  rawMicOverride = value === "on" || value === "off" ? value : "auto";
  localStorage.setItem(STORAGE_KEYS.rawMicOverride, rawMicOverride);
  applyRawMic(settings);
}

export function getRawMicOverride() {
  return rawMicOverride;
}

export function getEffectiveRawMic() {
  if (rawMicOverride === "on") return true;
  if (rawMicOverride === "off") return false;
  return headphonesDetected === true;
}

export function applyRawMic(settings) {
  settings.setRawMic(getEffectiveRawMic());
}

async function refreshHeadphoneDetection() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    headphonesDetected = null;
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((device) => device.kind === "audiooutput");
    if (!outputs.length) {
      headphonesDetected = null;
      return;
    }

    const builtInOnly = outputs.every((device) => {
      const label = (device.label || "").toLowerCase();
      return !label || label.includes("default") || label.includes("built-in")
        || label.includes("speaker") || label.includes("internal");
    });

    if (!builtInOnly) {
      headphonesDetected = true;
      return;
    }

    const hinted = outputs.some((device) => {
      const label = (device.label || "").toLowerCase();
      return HEADPHONE_HINTS.some((hint) => label.includes(hint));
    });
    headphonesDetected = hinted ? true : false;
  } catch (error) {
    reportWarning("detectHeadphones", error);
    headphonesDetected = null;
  }
}
