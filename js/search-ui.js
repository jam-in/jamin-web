// YouTube search UI — searches as you type, and shows play history when empty.

import { SEARCH_KEYWORD } from "./constants.js";
import { reportError } from "./errors.js";
import { formatTime } from "./ui.js";
import { parseVideoId } from "./youtube.js";
import { searchYouTube, thumbUrl } from "./search.js";
import { showHistory, hideHistory } from "./history-ui.js";

const TYPING_PAUSE_MS = 900;
const MAX_TYPING_WAIT_MS = 3000;
const MIN_QUERY_LENGTH = 2;

export function initSearch({ elements, videoStore, settings, notify }) {
  const input = elements.searchInput;

  let debounceTimer = null;
  let burstStartedAt = 0;

  function cancelPending() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    burstStartedAt = 0;
  }

  function runNow(rawValue) {
    cancelPending();
    const text = rawValue.trim();
    if (!text) return;

    const directId = parseVideoId(text);
    if (directId) {
      hideSearchResults(elements);
      videoStore.load(directId);
      return;
    }
    performSearch(text);
  }

  function scheduleSearch() {
    const text = input.value.trim();
    if (text.length < MIN_QUERY_LENGTH && !parseVideoId(text)) {
      cancelPending();
      return;
    }
    const now = Date.now();
    if (!burstStartedAt) burstStartedAt = now;
    if (debounceTimer) clearTimeout(debounceTimer);
    const delay = Math.min(TYPING_PAUSE_MS, Math.max(0, MAX_TYPING_WAIT_MS - (now - burstStartedAt)));
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      burstStartedAt = 0;
      runNow(input.value);
    }, delay);
  }

  elements.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    runNow(input.value);
  });

  input.addEventListener("input", () => {
    if (!input.value.trim()) {
      cancelPending();
      hideSearchResults(elements);
      showHistory();
      return;
    }
    hideHistory();
    scheduleSearch();
  });

  const onFocus = () => {
    if (!input.value.trim()) {
      hideSearchResults(elements);
      showHistory();
    }
  };
  input.addEventListener("focus", onFocus);
  input.addEventListener("click", onFocus);

  document.addEventListener("click", (event) => {
    if (event.target === input) return;
    if (!elements.searchResults.hidden && !elements.searchResults.contains(event.target)) {
      hideSearchResults(elements);
    }
    if (!elements.historyPanel.hidden && !elements.historyPanel.contains(event.target)) {
      hideHistory();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideSearchResults(elements);
      hideHistory();
    }
  });

  async function performSearch(raw) {
    hideHistory();

    const sequence = settings.nextSearchSequence();
    const query = `${raw} ${SEARCH_KEYWORD}`;
    showSearchStatus(elements, "Searching & checking which videos allow embedding…");

    let results;
    try {
      results = await searchYouTube(query);
    } catch (error) {
      if (!settings.isStaleSearchSequence(sequence)) {
        const message = error.message || "Search failed.";
        reportError("searchYouTube", error, message, notify);
        showSearchStatus(elements, message);
      }
      return;
    }

    if (settings.isStaleSearchSequence(sequence)) return;
    renderSearchResults(results);
  }

  function renderSearchResults(results) {
    elements.searchResults.innerHTML = "";

    if (!results.length) {
      showSearchStatus(elements, "No embeddable results. Try different words or paste a YouTube link.");
      return;
    }

    for (const result of results) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "search-item";
      item.setAttribute("role", "option");

      const thumbWrap = document.createElement("div");
      thumbWrap.className = "search-thumb-wrap";

      const image = document.createElement("img");
      image.className = "search-thumb";
      image.loading = "lazy";
      image.src = thumbUrl(result.videoId);
      image.alt = "";
      thumbWrap.append(image);

      if (result.duration != null) {
        const duration = document.createElement("span");
        duration.className = "search-duration";
        duration.textContent = formatTime(result.duration);
        thumbWrap.append(duration);
      }

      const info = document.createElement("div");
      info.className = "search-info";

      const title = document.createElement("span");
      title.className = "search-title";
      title.textContent = result.title || "(untitled)";

      const author = document.createElement("span");
      author.className = "search-author";
      author.textContent = result.author || "";

      info.append(title, author);
      item.append(thumbWrap, info);
      item.addEventListener("click", () => {
        hideSearchResults(elements);
        videoStore.load(result.videoId, { createSession: true });
      });

      elements.searchResults.append(item);
    }
    openSearchResults(elements);
  }
}

function showSearchStatus(elements, message) {
  elements.searchResults.innerHTML = "";
  const paragraph = document.createElement("p");
  paragraph.className = "search-status";
  paragraph.textContent = message;
  elements.searchResults.append(paragraph);
  openSearchResults(elements);
}

function openSearchResults(elements) {
  elements.searchResults.hidden = false;
  elements.searchInput.setAttribute("aria-expanded", "true");
}

function hideSearchResults(elements) {
  elements.searchResults.hidden = true;
  if (elements.historyPanel.hidden) {
    elements.searchInput.setAttribute("aria-expanded", "false");
  }
}
