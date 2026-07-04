// Export / import tracks as .jmn files (zip of audio blobs + JSON metadata).

import * as db from "./db.js";
import { resolveSessionId, sessionStorageKey } from "./core/session-id.js";
import { reportError } from "./errors.js";
import { buildZip, crc32, readZip } from "./zip.js";

function importName(entry) {
  return entry.name || "Imported take";
}

function importOffset(entry) {
  return Math.round((entry.offset ?? 0) * 1000) / 1000;
}

function importVolume(entry) {
  return entry.volume ?? 1;
}

function trackMetadataMatches(existing, entry) {
  const offset = Math.round((existing.offset ?? 0) * 1000) / 1000;
  return existing.name === importName(entry)
    && offset === importOffset(entry)
    && (existing.volume ?? 1) === importVolume(entry);
}

function formatImportMessage(added, updated, unchanged) {
  if (added === 0 && updated === 0 && unchanged > 0) {
    return "Nothing to import — all takes already match.";
  }
  const parts = [];
  if (added > 0) parts.push(`Imported ${added} take${added === 1 ? "" : "s"}`);
  if (updated > 0) parts.push(`updated ${updated}`);
  if (unchanged > 0) parts.push(`${unchanged} unchanged`);
  if (added > 0 && (updated > 0 || unchanged > 0)) {
    return `${parts[0]} (${parts.slice(1).join(", ")}).`;
  }
  if (updated > 0 && unchanged > 0) {
    return `Updated ${updated} take${updated === 1 ? "" : "s"} (${unchanged} unchanged).`;
  }
  if (updated > 0) {
    return `Updated ${updated} take${updated === 1 ? "" : "s"}.`;
  }
  return `${parts[0]}.`;
}

async function buildExistingByHash(videoId, sessionId) {
  const existingByHash = new Map();
  for (const track of await db.getTracksBySession(videoId, sessionId)) {
    const buf = await track.blob.arrayBuffer();
    const hash = crc32(new Uint8Array(buf));
    if (!existingByHash.has(hash)) existingByHash.set(hash, track);
  }
  return existingByHash;
}

function looksLikeJmnFilename(name) {
  const lower = (name || "").toLowerCase();
  return lower.endsWith(".jmn") || lower.endsWith(".zip");
}

async function isJmnFile(file) {
  if (looksLikeJmnFilename(file.name)) return true;
  try {
    const files = await readZip(file);
    return !!files["metadata.json"];
  } catch {
    return false;
  }
}

function supportsLaunchQueue() {
  return "launchQueue" in window && "files" in LaunchParams.prototype;
}

export function initExportImport({ elements, trackStore, videoStore, settings, notify, appReady }) {
  elements.exportBtn?.addEventListener("click", () => exportTracks(trackStore, videoStore, settings, notify));
  elements.importBtn?.addEventListener("click", () => elements.importFile?.click());
  elements.importFile?.addEventListener("change", () => {
    const file = elements.importFile.files[0];
    elements.importFile.value = "";
    if (file) importFromFile(file, trackStore, videoStore, settings, notify);
  });

  initFileHandling(trackStore, videoStore, settings, notify, appReady);
}

function initFileHandling(trackStore, videoStore, settings, notify, appReady) {
  if (!supportsLaunchQueue()) return;
  window.launchQueue.setConsumer(async (launchParams) => {
    if (!launchParams.files?.length) return;
    try {
      await (appReady ?? Promise.resolve());
      for (const handle of launchParams.files) {
        const file = await handle.getFile();
        if (!(await isJmnFile(file))) {
          notify("Not a Jam-in! takes file (.jmn).");
          continue;
        }
        await importFromFile(file, trackStore, videoStore, settings, notify, { fromExternalOpen: true });
      }
    } catch (error) {
      reportError("launchQueue", error, "Could not open file.", notify);
    }
  });
}

async function buildTracksFile(trackStore, videoStore, settings) {
  const tracks = trackStore.getTracks();
  const currentVideoId = videoStore.getVideoId();
  const session = videoStore.getSession();
  if (!tracks.length || !currentVideoId || !session) return null;

  const metadata = {
    videoId: currentVideoId,
    sessionId: session.sessionId,
    sessionCreatedAt: session.createdAt,
    exportedAt: Date.now(),
    version: 2,
    globalSyncOffset: settings.getLatencyOffset(),
    tracks: [],
  };
  const entries = [];
  let index = 0;

  for (const track of tracks) {
    const extension = (track.mimeType || "").includes("ogg") ? "ogg"
      : (track.mimeType || "").includes("mp4") ? "m4a" : "webm";
    const filename = `audio/${index}.${extension}`;
    const audioBytes = new Uint8Array(await track.blob.arrayBuffer());
    entries.push({ name: filename, data: audioBytes });
    metadata.tracks.push({
      file: filename,
      name: track.name,
      startTime: track.startTime,
      offset: track.offset ?? 0,
      duration: track.duration,
      mimeType: track.mimeType,
      volume: track.volume,
      muted: track.muted,
      peaks: track.peaks,
      createdAt: track.createdAt,
      contentHash: crc32(audioBytes),
    });
    index += 1;
  }
  entries.push({
    name: "metadata.json",
    data: new TextEncoder().encode(JSON.stringify(metadata, null, 2)),
  });

  const zipBlob = buildZip(entries);
  const sessionTag = session.sessionId.slice(0, 8);
  return new File(
    [zipBlob],
    `jamin-${currentVideoId}-${sessionTag}.jmn`,
    { type: "application/zip" }
  );
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportTracks(trackStore, videoStore, settings, notify) {
  if (!trackStore.getTracks().length) {
    notify("No tracks to export for this video.");
    return;
  }

  let sharing = false;
  try {
    const file = await buildTracksFile(trackStore, videoStore, settings);
    if (!file) return;

    const currentVideoId = videoStore.getVideoId();
    const payload = {
      files: [file],
      title: "Jam-in! takes",
      text: `Voice takes for ${currentVideoId}`,
    };
    sharing = navigator.canShare?.(payload);
    if (sharing) {
      notify("Sharing takes...");
      await navigator.share(payload);
      notify("Shared.", "success");
    } else {
      notify("Saving takes...");
      downloadBlob(file, file.name);
      notify("Share not available — downloaded instead.");
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    reportError("shareTracks", error, (sharing ? "Share" : "Export") + " failed: " + error.message, notify);
  }
}

async function importFromFile(file, trackStore, videoStore, settings, notify, { fromExternalOpen = false } = {}) {
  if (!file) return;

  try {
    const files = await readZip(file);
    const metadataBytes = files["metadata.json"];
    if (!metadataBytes) throw new Error("metadata.json missing");

    const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
    const currentVideoId = videoStore.getVideoId();
    const currentSessionId = videoStore.getSessionId();
    const targetVideoId = metadata.videoId || currentVideoId;
    const targetSessionId = resolveSessionId(metadata.sessionId);

    if (Number.isFinite(metadata.globalSyncOffset)) {
      settings.setLatencyOffset(metadata.globalSyncOffset);
    }

    const existingSession = await db.getSession(targetVideoId, targetSessionId);
    if (!existingSession) {
      await db.putSession({
        id: sessionStorageKey(targetVideoId, targetSessionId),
        sessionId: targetSessionId,
        videoId: targetVideoId,
        createdAt: metadata.sessionCreatedAt || Date.now(),
      });
    }

    const existingByHash = await buildExistingByHash(targetVideoId, targetSessionId);
    let added = 0;
    let updated = 0;
    let unchanged = 0;

    for (const entry of metadata.tracks) {
      const bytes = files[entry.file];
      if (!bytes) continue;

      const hash = Number.isFinite(entry.contentHash) ? entry.contentHash : crc32(bytes);
      const existing = existingByHash.get(hash);

      if (existing) {
        if (trackMetadataMatches(existing, entry)) {
          unchanged += 1;
          continue;
        }
        const nextTrack = {
          ...existing,
          name: importName(entry),
          offset: importOffset(entry),
          volume: importVolume(entry),
        };
        await db.updateTrack(nextTrack);
        existingByHash.set(hash, nextTrack);
        updated += 1;
        continue;
      }

      const blob = new Blob([bytes], { type: entry.mimeType || "audio/webm" });
      const id = await db.addTrack({
        videoId: targetVideoId,
        sessionId: targetSessionId,
        name: importName(entry),
        startTime: entry.startTime || 0,
        offset: importOffset(entry),
        duration: entry.duration || 0,
        mimeType: entry.mimeType || "audio/webm",
        volume: importVolume(entry),
        muted: !!entry.muted,
        peaks: entry.peaks || [],
        createdAt: entry.createdAt || Date.now(),
        blob,
      });
      existingByHash.set(hash, { id, videoId: targetVideoId, sessionId: targetSessionId, blob });
      added += 1;
    }

    let message = formatImportMessage(added, updated, unchanged);
    if (fromExternalOpen) message = `Opened from file — ${message}`;
    notify(message, added > 0 || updated > 0 ? "success" : undefined);

    const sameTarget =
      targetVideoId === currentVideoId && targetSessionId === currentSessionId;
    if (sameTarget) {
      await videoStore.load(currentVideoId, { sessionId: targetSessionId });
    } else if (
      confirm("Imported takes belong to a different jam session. Load it now?")
    ) {
      await videoStore.load(targetVideoId, { sessionId: targetSessionId });
    } else {
      videoStore.captureMeta(targetVideoId);
    }
  } catch (error) {
    reportError("importFromFile", error, `Import failed: ${error.message}`, notify);
  }
}
