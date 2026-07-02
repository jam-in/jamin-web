// Play history dropdown — videos that have recorded takes.

import * as db from "./db.js";
import { reportError } from "./errors.js";
import { escapeHtml, makeIconButton } from "./ui.js";

let historyDeps = null;

export function initHistory(deps) {
  historyDeps = deps;
  deps.bus.on("video:meta-updated", () => renderHistory());
  deps.bus.on("tracks:changed", () => renderHistory());
  deps.bus.on("video:loaded", () => renderHistory());
}

export function showHistory() {
  const { elements } = historyDeps;
  elements.historyPanel.hidden = false;
  elements.searchInput.setAttribute("aria-expanded", "true");
  renderHistory();
}

export function hideHistory() {
  const { elements } = historyDeps;
  elements.historyPanel.hidden = true;
  if (elements.searchResults.hidden) {
    elements.searchInput.setAttribute("aria-expanded", "false");
  }
}

export async function renderHistory() {
  if (!historyDeps) return;
  const { elements, videoStore, trackStore, notify } = historyDeps;
  const currentVideoId = videoStore.getVideoId();
  let entries = [];

  try {
    entries = await db.getVideosWithRecordings();
  } catch (error) {
    reportError("renderHistory", error, null, notify);
  }

  elements.historyList.innerHTML = "";
  elements.historyEmpty.hidden = entries.length > 0;

  for (const entry of entries) {
    const listItem = document.createElement("li");
    listItem.className = "history-item" + (entry.videoId === currentVideoId ? " current" : "");

    const loadButton = document.createElement("button");
    loadButton.className = "history-load";
    loadButton.title = "Load this video";

    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = entry.title || "(untitled video)";

    const meta = document.createElement("span");
    meta.className = "history-meta";
    const takeLabel = `${entry.count} take${entry.count === 1 ? "" : "s"}`;
    const authorPrefix = entry.author ? `${entry.author} · ` : "";
    meta.innerHTML =
      `${escapeHtml(authorPrefix)}<span class="history-id">${escapeHtml(entry.videoId)}</span> · ${takeLabel}`;

    loadButton.append(title, meta);
    loadButton.addEventListener("click", () => {
      hideHistory();
      videoStore.load(entry.videoId);
    });

    const link = document.createElement("a");
    link.className = "history-link";
    link.href = `https://youtu.be/${entry.videoId}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.title = "Open on YouTube";
    link.textContent = "↗";

    const deleteButton = makeIconButton("🗑", "Remove from history (deletes its takes)", async () => {
      const label = entry.title || entry.videoId;
      if (!confirm(
        `Remove "${label}" from history?\nThis permanently deletes its ${entry.count} recorded take${entry.count === 1 ? "" : "s"}.`
      )) return;

      try {
        await db.deleteVideo(entry.videoId);
        if (entry.videoId === currentVideoId) {
          await trackStore.clearForVideoDelete();
        }
        await renderHistory();
        notify("Removed from history.");
      } catch (error) {
        reportError("deleteVideo", error, "Could not remove from history.", notify);
      }
    });
    deleteButton.classList.add("danger", "history-del");

    listItem.append(loadButton, link, deleteButton);
    elements.historyList.append(listItem);
  }
}
