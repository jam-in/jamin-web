// Logo dropdown menu: share link, Advanced toggle, bleeding, default sync, About.

import { JAMIN_VERSION, STORAGE_KEYS } from "./constants.js";
import { shareDeeplink } from "./deeplink.js";

export function initMenu({ elements, bus, trackList, trackStore, settings, videoStore, notify }) {
  const savedAdvancedUI = localStorage.getItem(STORAGE_KEYS.advancedUI) === "on";
  applyAdvancedUI(elements, savedAdvancedUI);

  if (elements.aboutVersion) {
    elements.aboutVersion.textContent = `Version ` + JAMIN_VERSION;
  }

  if (elements.bleedingMode) {
    elements.bleedingMode.value = settings.getBleedingMode();
    elements.bleedingMode.addEventListener("change", () => {
      settings.setBleedingMode(elements.bleedingMode.value);
      trackStore.refreshPlaybackForBleedingMode();
      trackList.redrawWaveforms();
    });
  }

  elements.logoBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (elements.mainMenu.hidden) openMenu(elements);
    else closeMenu(elements);
  });

  elements.advancedUiChk?.addEventListener("change", () => {
    applyAdvancedUI(elements, elements.advancedUiChk.checked);
    trackList.layoutAllTrackRows();
  });

  elements.shareLinkBtn?.addEventListener("click", () => {
    shareDeeplink(videoStore, notify);
  });

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

function applyAdvancedUI(elements, enabled) {
  document.documentElement.dataset.nudge = enabled ? "on" : "off";
  localStorage.setItem(STORAGE_KEYS.advancedUI, enabled ? "on" : "off");
  if (elements.advancedUiChk) elements.advancedUiChk.checked = enabled;
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
