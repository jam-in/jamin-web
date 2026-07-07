// UI helpers: toast, theme, playerOverlay, formatting.

let toastTimer = null;
let tabShareOverlayActive = false;
let tabShareClickHandler = null;

export function isTabShareOverlayActive() {
  return tabShareOverlayActive;
}

export function bindElements() {
  return {
    ...[
      "searchForm",
      "searchInput",
      "searchResults",
      "logoBtn",
      "mainMenu",
      "advancedUiChk",
      "speakersOffsetEarlier",
      "speakersOffsetReadout",
      "speakersOffsetLater",
      "speakersAutoBtn",
      "headphonesOffsetEarlier",
      "headphonesOffsetReadout",
      "headphonesOffsetLater",
      "bleedingMode",
      "aboutBtn",
      "aboutModal",
      "aboutClose",
      "aboutVersion",
      "recIndicator",
      "recTimer",
      "timelinePanel",
      "timelineRulerStart",
      "timelineRulerEnd",
      "trackList",
      "playhead",
      "emptyHint",
      "historyPanel",
      "historyList",
      "historyEmpty",
      "shareLinkBtn",
      "playerOverlay",
      "playerOverlayMsg",
      "toast",
      "keepTakeModal",
      "keepTakeYes",
      "keepTakeNo",
      "deleteTakeModal",
      "deleteTakeYes",
      "deleteTakeNo"
    ].reduce((acc, key) => {
      acc[key] = document.getElementById(key);
      return acc;
    }, {}),
  };
}

export function showToast(elements, message, kind = "") {
  elements.toast.textContent = message;
  elements.toast.className = "toast" + (kind ? " " + kind : "");
  elements.toast.hidden = false;
  elements.toast.onclick = null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (elements.toast.hidden = true), 4200);
}

/** Persistent toast with a single tap action (e.g. reload after SW update). */
export function showActionToast(elements, message, onAction, kind = "") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = "toast actionable" + (kind ? " " + kind : "");
  elements.toast.hidden = false;
  elements.toast.onclick = () => {
    elements.toast.onclick = null;
    onAction();
  };
}

export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]
  ));
}

export function getAccentColor() {
  return getComputedStyle(document.documentElement)
    .getPropertyValue("--accent")
    .trim() || "#6c8cff";
}

// Distinct color for the live (currently-recording) waveform so it stands out
// from saved takes. Uses the recording red used elsewhere in the UI.
export function getRecordColor() {
  return getComputedStyle(document.documentElement)
    .getPropertyValue("--record")
    .trim() || "#ff3b46";
}

export function setPlayerOverlay(elements, message) {
  if (tabShareOverlayActive) return;
  if (!message) {
    elements.playerOverlay.hidden = true;
    return;
  }
  elements.playerOverlayMsg.textContent = message;
  elements.playerOverlay.hidden = false;
}

/**
 * Full-screen overlay on the YouTube player — tap runs onAccept inside a user gesture
 * (required for getDisplayMedia when play was started from the iframe).
 */
export function showTabShareOverlay(elements, onAccept) {
  hideTabShareOverlay(elements);
  tabShareOverlayActive = true;
  elements.playerOverlayMsg.innerHTML =
    "Tap to share <strong>this tab&rsquo;s audio</strong>"
    + "<br><small>Required for auto-sync on speakers</small>";
  elements.playerOverlay.classList.add("is-actionable");
  elements.playerOverlay.hidden = false;

  tabShareClickHandler = () => {
    onAccept();
  };
  elements.playerOverlay.addEventListener("click", tabShareClickHandler);
}

export function hideTabShareOverlay(elements) {
  if (tabShareClickHandler) {
    elements.playerOverlay.removeEventListener("click", tabShareClickHandler);
    tabShareClickHandler = null;
  }
  if (!tabShareOverlayActive) return;
  tabShareOverlayActive = false;
  elements.playerOverlay.classList.remove("is-actionable");
  elements.playerOverlay.hidden = true;
  elements.playerOverlayMsg.textContent = "";
}

// Theme always follows the OS. An inline script in index.html sets the initial
// value before first paint; here we just keep it in sync if the OS toggles.
export function initTheme() {
  const media = window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: light)")
    : null;

  const setTheme = (isLight) =>
    document.documentElement.setAttribute("data-theme", isLight ? "light" : "dark");

  setTheme(media ? media.matches : false);

  media?.addEventListener?.("change", (event) => {
    setTheme(event.matches);
    window.dispatchEvent(new CustomEvent("jamin:theme-changed"));
  });
}

export function makeIconButton(label, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn";
  button.textContent = label;
  button.title = title;
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

let deleteConfirmPending = false;

export function confirmDeleteTake(elements) {
  if (deleteConfirmPending) return Promise.resolve(false);
  return new Promise((resolve) => {
    deleteConfirmPending = true;
    elements.deleteTakeModal.hidden = false;

    const finish = (confirmed) => {
      deleteConfirmPending = false;
      elements.deleteTakeModal.hidden = true;
      elements.deleteTakeYes.removeEventListener("click", onYes);
      elements.deleteTakeNo.removeEventListener("click", onNo);
      backdrop?.removeEventListener("click", onNo);
      document.removeEventListener("keydown", onKey);
      resolve(confirmed);
    };

    const onYes = () => finish(true);
    const onNo = () => finish(false);
    const onKey = (event) => {
      if (event.key === "Escape") finish(false);
    };

    const backdrop = elements.deleteTakeModal.querySelector(".modal-backdrop");
    elements.deleteTakeYes.addEventListener("click", onYes);
    elements.deleteTakeNo.addEventListener("click", onNo);
    backdrop?.addEventListener("click", onNo);
    document.addEventListener("keydown", onKey);
    elements.deleteTakeNo.focus();
  });
}
