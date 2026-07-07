// PWA install prompt, offline service worker registration, and update checks.

import { reportWarning } from "./errors.js";
import { showActionToast } from "./ui.js";

export function initPwa({ elements }) {
  const installBtn = elements.installBtn;
  let deferredInstallPrompt = null;
  let registrationRef = null;
  let updatePromptShown = false;
  let reloading = false;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (installBtn) installBtn.hidden = false;
  });

  installBtn?.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn.hidden = true;
  });

  if (!("serviceWorker" in navigator)) return;

  function promptReload() {
    if (updatePromptShown || reloading) return;
    updatePromptShown = true;
    showActionToast(
      elements,
      "New version ready — tap to reload",
      () => {
        reloading = true;
        location.reload();
      },
      "success"
    );
  }

  function watchWorker(worker) {
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      // installed + existing controller means an update (not first install).
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        promptReload();
      }
    });
  }

  async function checkForUpdates() {
    if (!registrationRef) return;
    try {
      await registrationRef.update();
    } catch (error) {
      reportWarning("serviceWorker.update", error);
    }
  }

  function bindUpdateChecks() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdates();
    });
    window.addEventListener("focus", checkForUpdates);
    // Installed PWAs on mobile often only resume — check then too.
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) checkForUpdates();
    });
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .then((registration) => {
        registrationRef = registration;
        bindUpdateChecks();
        checkForUpdates();

        if (registration.waiting) promptReload();

        registration.addEventListener("updatefound", () => {
          watchWorker(registration.installing);
        });

        navigator.serviceWorker.addEventListener("controllerchange", () => {
          // New SW claimed clients; page still runs old JS until reload.
          if (navigator.serviceWorker.controller) promptReload();
        });
      })
      .catch((error) => {
        reportWarning("serviceWorker.register", error);
      });
  });
}
