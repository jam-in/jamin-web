// Play history dropdown — jam sessions that have recorded takes.

import * as db from "./db.js";
import { reportError } from "./errors.js";
import { escapeHtml, makeIconButton } from "./ui.js";

let historyDeps = null;

function formatSessionDate(epochMs) {
  if (!epochMs) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(epochMs);
}

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
  const currentSessionId = videoStore.getSessionId();
  let entries = [];

  try {
    entries = await db.getSessionsWithRecordings();
  } catch (error) {
    reportError("renderHistory", error, null, notify);
  }

  elements.historyList.innerHTML = "";
  elements.historyEmpty.hidden = entries.length > 0;

  for (const entry of entries) {
    const isCurrent =
      entry.videoId === currentVideoId && entry.sessionId === currentSessionId;
    const listItem = document.createElement("li");
    listItem.className = "history-item" + (isCurrent ? " current" : "");

    const loadButton = document.createElement("button");
    loadButton.className = "history-load";
    loadButton.title = "Load this jam session";

    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = entry.title || "(untitled video)";

    const meta = document.createElement("span");
    meta.className = "history-meta";
    const takeLabel = `${entry.count} take${entry.count === 1 ? "" : "s"}`;
    const authorPrefix = entry.author ? `${entry.author} · ` : "";
    const sessionLabel = formatSessionDate(entry.createdAt);
    meta.innerHTML =
      `${escapeHtml(authorPrefix)}<span class="history-id">${escapeHtml(entry.videoId)}</span>`
      + (sessionLabel ? ` · ${escapeHtml(sessionLabel)}` : "")
      + ` · ${takeLabel}`;

    loadButton.append(title, meta);
    loadButton.addEventListener("click", () => {
      hideHistory();
      videoStore.load(entry.videoId, { sessionId: entry.sessionId });
    });

    const link = document.createElement("a");
    link.className = "history-link";
    link.href = `https://youtu.be/${entry.videoId}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.title = "Open on YouTube";
    link.textContent = "↗";

    const deleteButton = makeIconButton("🗑", "Remove this jam session (deletes its takes)", async () => {
      const label = entry.title || entry.videoId;
      if (!confirm(
        `Remove this jam session for "${label}"?\n`
        + `This permanently deletes its ${entry.count} recorded take${entry.count === 1 ? "" : "s"}.`
      )) return;

      try {
        await db.deleteSession(entry.videoId, entry.sessionId);
        if (isCurrent) {
          await trackStore.clearForSessionDelete();
        }
        await renderHistory();
        notify("Jam session removed.");
      } catch (error) {
        reportError("deleteSession", error, "Could not remove jam session.", notify);
      }
    });
    deleteButton.classList.add("danger", "history-del");

    listItem.append(loadButton, link, deleteButton);
    elements.historyList.append(listItem);
  }
}
