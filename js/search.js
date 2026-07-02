// ============================================================
// search.js — free-text YouTube search via public Piped / Invidious
// instances (no API key required).
//
// Browsers can't query YouTube's own search directly (no CORS), so we lean on
// the public Piped and Invidious APIs, which expose CORS-friendly JSON search
// endpoints. Public instances are frequently slow, rate-limited, or down, so
// we try a list of them in turn and return the first usable response.
//
// Each result is normalized to:
//   { videoId, title, author, duration }   // duration in seconds, may be null
//
// Thumbnails are NOT taken from the instance (its proxied URLs are often slow
// or broken). Build them from the video ID instead via thumbUrl(), which hits
// YouTube's image CDN directly — fine for <img> tags (no CORS needed).
//
// EMBEDDABILITY FILTER: many (karaoke) videos disable embedding, so loading
// them throws YouTube error 101/150 in the player. We pre-filter results via
// noembed.com — a CORS-enabled oEmbed proxy. It returns normal oEmbed JSON for
// embeddable videos and {"error": "401 …"} for embedding-disabled / private /
// removed ones. YouTube's own oEmbed endpoint gives the same signal but sends
// no CORS headers, so the browser can't read it; noembed can.
// ============================================================

const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://api.piped.private.coffee",
  "https://pipedapi.leptons.xyz",
  "https://pipedapi.reallyaweso.me",
];

const INVIDIOUS_INSTANCES = [
  "https://invidious.nerdvpn.de",
  "https://inv.nadeko.net",
  "https://yewtu.be",
];

const REQUEST_TIMEOUT_MS = 6500;
const PROBE_TIMEOUT_MS = 4500;   // per-video embeddability probe
const RAW_LIMIT = 24;            // max raw results we bother probing
const RESULT_LIMIT = 16;         // max embeddable results we return

export function thumbUrl(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

async function getJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function idFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/[?&]v=([\w-]{11})/);
  return m ? m[1] : null;
}

function normalizePiped(data) {
  const items = (data && data.items) || [];
  const out = [];
  for (const it of items) {
    if (it.type && it.type !== "stream") continue; // skip channels/playlists
    const id = idFromUrl(it.url) || (typeof it.videoId === "string" ? it.videoId : null);
    if (!id) continue;
    out.push({
      videoId: id,
      title: it.title || "",
      author: it.uploaderName || "",
      duration: Number.isFinite(it.duration) ? it.duration : null,
    });
  }
  return out;
}

function normalizeInvidious(data) {
  const arr = Array.isArray(data) ? data : [];
  const out = [];
  for (const it of arr) {
    if (it.type && it.type !== "video") continue;
    if (!it.videoId) continue;
    out.push({
      videoId: it.videoId,
      title: it.title || "",
      author: it.author || "",
      duration: Number.isFinite(it.lengthSeconds) ? it.lengthSeconds : null,
    });
  }
  return out;
}

import { reportWarning } from "./errors.js";

async function rawSearch(query) {
  const q = encodeURIComponent(query);

  for (const base of PIPED_INSTANCES) {
    try {
      const data = await getJson(`${base}/search?q=${q}&filter=videos`);
      const items = normalizePiped(data);
      if (items.length) return items;
    } catch (error) {
      reportWarning("search.piped", base, error);
    }
  }

  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const data = await getJson(`${base}/api/v1/search?q=${q}&type=video`);
      const items = normalizeInvidious(data);
      if (items.length) return items;
    } catch (error) {
      reportWarning("search.invidious", base, error);
    }
  }

  throw new Error("Search providers are unavailable right now. Try again, or paste a YouTube link.");
}

// Probe whether a video can be embedded in the IFrame player.
//   true  -> embeddable
//   false -> embedding disabled / private / removed
//   null  -> couldn't determine (probe service unreachable)
const embedCache = new Map();
export async function isEmbeddable(videoId) {
  if (embedCache.has(videoId)) return embedCache.get(videoId);
  let result;
  try {
    const data = await getJson(
      `https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`,
      PROBE_TIMEOUT_MS
    );
    result = !(data && data.error);
  } catch {
    result = null; // unknown — don't punish the video for a flaky probe
  }
  embedCache.set(videoId, result);
  return result;
}

// Search YouTube for `query`, trying public instances until one responds, then
// drop any results that can't be embedded. Videos with an unknown status (probe
// service down) are kept so the list never collapses to empty on a hiccup.
// Resolves to an array of normalized result objects, or throws if every search
// provider failed.
export async function searchYouTube(query) {
  const items = (await rawSearch(query)).slice(0, RAW_LIMIT);
  const flags = await Promise.all(items.map((it) => isEmbeddable(it.videoId)));
  return items.filter((_, i) => flags[i] !== false).slice(0, RESULT_LIMIT);
}
