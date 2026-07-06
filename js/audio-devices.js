// Headphone detection — used to gate auto-sync (speaker bleed mode only).
// Conservative: assume speakers unless the default output is clearly headphones.
// Windows often lists unplugged "Headphones (…)" endpoints; we ignore those.

import { reportWarning } from "./errors.js";

const LOG_PREFIX = "[Jam-in audio]";

// Only match when the default route is clearly headphones.
const HEADPHONE_LABEL = /headphone|headset|earbud|airpod|earphone|in-ear/i;
const SPEAKER_LABEL = /speaker|built-in|internal|loudspeaker|display|hdmi|monitor|realtek/i;

let headphonesDetected = false;

export function initAudioDevices({ settings }) {
  refreshHeadphoneDetection();
  applyRawMic(settings);

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      refreshHeadphoneDetection();
    });
  }
}

/** Always use raw mic (no AEC/NS) for bleed detection. */
export function applyRawMic(settings) {
  settings.setRawMic(true);
}

/** True only when the default audio output is confidently headphones. */
export function isUsingHeadphones() {
  return headphonesDetected === true;
}

function classifyDefaultOutput(label) {
  const text = (label || "").trim();
  if (!text) return "unknown";

  const hasHeadphone = HEADPHONE_LABEL.test(text);
  const hasSpeaker = SPEAKER_LABEL.test(text);

  // "Speakers (Realtek)" → speakers; "Headphones (Realtek)" → headphones.
  if (hasHeadphone && !hasSpeaker) return "headphones";
  if (hasSpeaker && !hasHeadphone) return "speakers";
  if (hasHeadphone) return "headphones";
  return "unknown";
}

export async function refreshHeadphoneDetection() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    headphonesDetected = false;
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((device) => device.kind === "audiooutput");
    if (!outputs.length) {
      headphonesDetected = false;
      return;
    }

    const defaultOut = outputs.find((d) => d.deviceId === "default")
      || outputs.find((d) => /^default/i.test(d.label || ""))
      || outputs[0];

    const classification = classifyDefaultOutput(defaultOut?.label);
  // Unknown labels (before permission) → assume speakers so auto-sync stays available.
    headphonesDetected = classification === "headphones";

    console.log(LOG_PREFIX, "output detection", {
      label: defaultOut?.label || "(empty)",
      deviceId: defaultOut?.deviceId,
      classification,
      headphonesDetected,
      outputCount: outputs.length,
    });
  } catch (error) {
    reportWarning("detectHeadphones", error);
    headphonesDetected = false;
  }
}
