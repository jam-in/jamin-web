// ============================================================
// db.js — IndexedDB persistence for jam sessions and tracks.
// ============================================================

import { reportError } from "./errors.js";
import { LEGACY_SESSION_ID, sessionStorageKey } from "./core/session-id.js";

// A "track" record looks like:
//   {
//     id:          auto-increment number (primary key),
//     videoId:     string  — YouTube video ID,
//     sessionId:   string  — jam session ("0" legacy or UUID),
//     name, startTime, offset, duration, mimeType, volume, muted,
//     peaks, createdAt, blob,
//     dry (per-track: play bleed-removed version when true),
//     dryBlob, dryPeaks, refBlob, refSampleRate (bleed removal)
//   }
//
// A "session" record looks like:
//   {
//     id:          string  — `${videoId}:${sessionId}` (primary key),
//     sessionId:   string  — "0" or UUID,
//     videoId:     string  — YouTube video ID,
//     createdAt:   number  — epoch ms at first instantiation
//   }
//
// A "video" record (metadata) looks like:
//   { videoId, title, author, updatedAt }
// ============================================================

const DB_NAME = "jamin-db";
const DB_VERSION = 3;
const STORE = "tracks";
const VIDEO_STORE = "videos";
const SESSION_STORE = "sessions";

let dbPromise = null;

function migrateTracksToSessions(transaction) {
  const trackStore = transaction.objectStore(STORE);
  const sessionStore = transaction.objectStore(SESSION_STORE);
  const byVideo = new Map();

  return new Promise((resolve, reject) => {
    const req = trackStore.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        const track = cur.value;
        if (!track.sessionId) {
          track.sessionId = LEGACY_SESSION_ID;
          cur.update(track);
        }
        const videoId = track.videoId;
        const entry = byVideo.get(videoId) || { earliest: Infinity };
        entry.earliest = Math.min(entry.earliest, track.createdAt || Date.now());
        byVideo.set(videoId, entry);
        cur.continue();
        return;
      }

      for (const [videoId, info] of byVideo) {
        sessionStore.put({
          id: sessionStorageKey(videoId, LEGACY_SESSION_ID),
          sessionId: LEGACY_SESSION_ID,
          videoId,
          createdAt: Number.isFinite(info.earliest) ? info.earliest : Date.now(),
        });
      }
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const transaction = req.transaction;
      let trackStore;

      if (!db.objectStoreNames.contains(STORE)) {
        trackStore = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        trackStore.createIndex("videoId", "videoId", { unique: false });
      } else {
        trackStore = transaction.objectStore(STORE);
      }

      if (!trackStore.indexNames.contains("sessionId")) {
        trackStore.createIndex("sessionId", "sessionId", { unique: false });
      }

      if (!db.objectStoreNames.contains(VIDEO_STORE)) {
        db.createObjectStore(VIDEO_STORE, { keyPath: "videoId" });
      }

      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: "id" })
          .createIndex("videoId", "videoId", { unique: false });

        if (event.oldVersion < 3) {
          migrateTracksToSessions(transaction).catch((error) => {
            reportError("db.migrate", error);
            transaction.abort();
          });
        }
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

function sessionTx(mode) {
  return open().then((db) => db.transaction(SESSION_STORE, mode).objectStore(SESSION_STORE));
}

export async function addTrack(track) {
  const store = await tx("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.add(track);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getTracksBySession(videoId, sessionId) {
  const store = await tx("readonly");
  return new Promise((resolve, reject) => {
    const out = [];
    const idx = store.index("videoId");
    const req = idx.openCursor(IDBKeyRange.only(videoId));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        if (cur.value.sessionId === sessionId) out.push(cur.value);
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

// ---------- Jam sessions ----------

export async function putSession(session) {
  const store = await sessionTx("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.put(session);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getSession(videoId, sessionId) {
  const store = await sessionTx("readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(sessionStorageKey(videoId, sessionId));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// [{ sessionId, videoId, createdAt, count, latest, title, author }]
export async function getSessionsWithRecordings() {
  const store = await tx("readonly");
  const bySession = await new Promise((resolve, reject) => {
    const map = new Map();
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        const v = cur.value;
        const sessionId = v.sessionId || LEGACY_SESSION_ID;
        const key = sessionStorageKey(v.videoId, sessionId);
        const e = map.get(key) || {
          sessionId,
          videoId: v.videoId,
          count: 0,
          latest: 0,
        };
        e.count += 1;
        e.latest = Math.max(e.latest, v.createdAt || 0);
        map.set(key, e);
        cur.continue();
      } else {
        resolve(map);
      }
    };
    req.onerror = () => reject(req.error);
  });

  const out = [];
  for (const entry of bySession.values()) {
    const session = await getSession(entry.videoId, entry.sessionId);
    const meta = await getVideoMeta(entry.videoId);
    out.push({
      sessionId: entry.sessionId,
      videoId: entry.videoId,
      createdAt: session?.createdAt || entry.latest,
      count: entry.count,
      latest: entry.latest,
      title: meta?.title || "",
      author: meta?.author || "",
    });
  }
  out.sort((a, b) => b.latest - a.latest);
  return out;
}

export async function deleteSession(videoId, sessionId) {
  const store = await tx("readwrite");
  const removed = await new Promise((resolve, reject) => {
    let n = 0;
    const idx = store.index("videoId");
    const req = idx.openCursor(IDBKeyRange.only(videoId));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        if (cur.value.sessionId === sessionId) {
          cur.delete();
          n += 1;
        }
        cur.continue();
      } else {
        resolve(n);
      }
    };
    req.onerror = () => reject(req.error);
  });

  const sstore = await sessionTx("readwrite");
  await new Promise((resolve, reject) => {
    const req = sstore.delete(sessionStorageKey(videoId, sessionId));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  return removed;
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
