// Logo dropdown menu: share link, export/import/share takes, Advanced toggle, mic mode, About.

import { JAMIN_VERSION, STORAGE_KEYS } from "./constants.js";
import { setRawMicOverride } from "./audio-devices.js";
import { shareDeeplink } from "./deeplink.js";

export function initMenu({ elements, bus, trackList, settings, videoStore, notify }) {
  const savedNudge = localStorage.getItem(STORAGE_KEYS.nudge) === "on";
  applyNudge(elements, savedNudge);

  if (elements.aboutVersion) {
    elements.aboutVersion.textContent = `Version ` + JAMIN_VERSION;
  }

  elements.logoBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (elements.mainMenu.hidden) openMenu(elements);
    else closeMenu(elements);
  });

  elements.advNudgeChk?.addEventListener("change", () => {
    applyNudge(elements, elements.advNudgeChk.checked);
    trackList.layoutAllTrackRows();
  });

  elements.advRawMic?.addEventListener("change", () => {
    setRawMicOverride(settings, elements.advRawMic.value);
  });

  elements.shareLinkBtn?.addEventListener("click", () => {
    closeMenu(elements);
    shareDeeplink(videoStore, notify);
  });

  for (const btn of [elements.exportBtn, elements.importBtn, elements.shareBtn]) {
    btn?.addEventListener("click", () => closeMenu(elements));
  }

  elements.aboutBtn?.addEventListener("click", () => {
    closeMenu(elements);
    openAbout(elements);
  });
  wireAbout(elements);

  document.addEventListener("click", (event) => {
    if (elements.mainMenu.hidden) return;
    if (!elements.mainMenu.contains(event.target)
      && !elements.logoBtn.contains(event.target)) {
      closeMenu(elements);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu(elements);
  });

  bus.on("timeline:ready", () => trackList.layoutAllTrackRows());
}

function applyNudge(elements, enabled) {
  document.documentElement.dataset.nudge = enabled ? "on" : "off";
  localStorage.setItem(STORAGE_KEYS.nudge, enabled ? "on" : "off");
  if (elements.advNudgeChk) elements.advNudgeChk.checked = enabled;
}

function openMenu(elements) {
  elements.mainMenu.hidden = false;
  elements.logoBtn.setAttribute("aria-expanded", "true");
}

function closeMenu(elements) {
  elements.mainMenu.hidden = true;
  elements.logoBtn.setAttribute("aria-expanded", "false");
}

function openAbout(elements) {
  if (elements.aboutModal) elements.aboutModal.hidden = false;
}

function closeAbout(elements) {
  if (elements.aboutModal) elements.aboutModal.hidden = true;
}

function wireAbout(elements) {
  if (!elements.aboutModal) return;
  elements.aboutClose?.addEventListener("click", () => closeAbout(elements));
  elements.aboutModal
    .querySelector(".modal-backdrop")
    ?.addEventListener("click", () => closeAbout(elements));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAbout(elements);
  });
}
