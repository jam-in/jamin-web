// ============================================================
// db.js — IndexedDB persistence, keyed by YouTube video ID.
// ============================================================

import { reportError } from "./errors.js";

// A "track" record looks like:
//   {
//     id:          auto-increment number (primary key),
//     videoId:     string  — YouTube video ID this take belongs to,
//     name:        string  — user-editable label,
//     startTime:   number  — video currentTime (seconds) when recording started,
//     offset:      number  — per-take sync nudge (seconds), on top of the
//                            device-wide latency offset; + plays the take earlier,
//     duration:    number  — length of the audio clip (seconds),
//     mimeType:    string  — e.g. "audio/webm;codecs=opus",
//     volume:      number  — 0..1 mix gain,
//     muted:       boolean,
//     peaks:       number[] — downsampled waveform peaks for preview,
//     createdAt:   number  — epoch ms,
//     blob:        Blob     — the recorded audio
//   }
//
// A "video" record (play-history metadata) looks like:
//   {
//     videoId:   string  — YouTube video ID (primary key),
//     title:     string  — video title (best-effort, may be empty),
//     author:    string  — channel / uploader name (best-effort),
//     updatedAt: number  — epoch ms of the last time we saw this video
//   }
// ============================================================

const DB_NAME = "jamin-db";
const DB_VERSION = 2;
const STORE = "tracks";
const VIDEO_STORE = "videos";

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        // Index by videoId so we can load all tracks for a given video quickly.
        store.createIndex("videoId", "videoId", { unique: false });
      }
      // v2: per-video metadata (title/author) for the play-history dropdown.
      if (!db.objectStoreNames.contains(VIDEO_STORE)) {
        db.createObjectStore(VIDEO_STORE, { keyPath: "videoId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      reportError("db.open", req.error);
      reject(req.error);
    };
  });
  return dbPromise;
}

function tx(mode) {
  return open().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

function videoTx(mode) {
  return open().then((db) => db.transaction(VIDEO_STORE, mode).objectStore(VIDEO_STORE));
}

export async function addTrack(track) {
  const store = await tx("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.add(track);
    req.onsuccess = () => resolve(req.result); // resolves to the new id
    req.onerror = () => reject(req.error);
  });
}

export async function getTracksByVideo(videoId) {
  const store = await tx("readonly");
  return new Promise((resolve, reject) => {
    const out = [];
    const idx = store.index("videoId");
    const req = idx.openCursor(IDBKeyRange.only(videoId));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        out.push(cur.value);
        cur.continue();
      } else {
        out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function updateTrack(track) {
  const store = await tx("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.put(track);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteTrack(id) {
  const store = await tx("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getTrack(id) {
  const store = await tx("readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- Video metadata (play history) ----------

export async function putVideoMeta(meta) {
  const store = await videoTx("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.put(meta);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getVideoMeta(videoId) {
  const store = await videoTx("readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(videoId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// Returns the play history: one entry per video that has at least one
// recording, joined with its stored title/author. Sorted by the most
// recent take first.
//   [{ videoId, count, latest, title, author }]
export async function getVideosWithRecordings() {
  const store = await tx("readonly");
  const byVideo = await new Promise((resolve, reject) => {
    const map = new Map(); // videoId -> { count, latest }
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        const v = cur.value;
        const e = map.get(v.videoId) || { count: 0, latest: 0 };
        e.count += 1;
        e.latest = Math.max(e.latest, v.createdAt || 0);
        map.set(v.videoId, e);
        cur.continue();
      } else {
        resolve(map);
      }
    };
    req.onerror = () => reject(req.error);
  });

  const out = [];
  for (const [videoId, info] of byVideo) {
    const meta = await getVideoMeta(videoId);
    out.push({
      videoId,
      count: info.count,
      latest: info.latest,
      title: (meta && meta.title) || "",
      author: (meta && meta.author) || "",
    });
  }
  out.sort((a, b) => b.latest - a.latest);
  return out;
}

// Remove a video from the play history: deletes ALL its recordings and its
// stored metadata. Returns the number of tracks removed.
export async function deleteVideo(videoId) {
  const store = await tx("readwrite");
  const removed = await new Promise((resolve, reject) => {
    let n = 0;
    const idx = store.index("videoId");
    const req = idx.openCursor(IDBKeyRange.only(videoId));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { cur.delete(); n += 1; cur.continue(); }
      else resolve(n);
    };
    req.onerror = () => reject(req.error);
  });

  const vstore = await videoTx("readwrite");
  await new Promise((resolve, reject) => {
    const req = vstore.delete(videoId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  return removed;
}
