// Export / import tracks as .jmn files (zip of audio blobs + JSON metadata).

import * as db from "./db.js";
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

async function buildExistingByHash(videoId) {
  const existingByHash = new Map();
  for (const track of await db.getTracksByVideo(videoId)) {
    const buf = await track.blob.arrayBuffer();
    const hash = crc32(new Uint8Array(buf));
    if (!existingByHash.has(hash)) existingByHash.set(hash, track);
  }
  return existingByHash;
}

export function initExportImport({ elements, trackStore, videoStore, settings, notify }) {
  elements.exportBtn?.addEventListener("click", () => downloadTracks(trackStore, videoStore, settings, notify));
  elements.importBtn?.addEventListener("click", () => elements.importFile?.click());
  elements.shareBtn?.addEventListener("click", () => shareTracks(trackStore, videoStore, settings, notify));
  elements.importFile?.addEventListener("change", () => {
    const file = elements.importFile.files[0];
    elements.importFile.value = "";
    if (file) importFromFile(file, trackStore, videoStore, settings, notify);
  });

  initFileHandling(trackStore, videoStore, settings, notify);
}

function initFileHandling(trackStore, videoStore, settings, notify) {
  if (!("launchQueue" in window)) return;
  window.launchQueue.setConsumer(async (launchParams) => {
    const handle = launchParams.files?.[0];
    if (!handle) return;
    try {
      const file = await handle.getFile();
      await importFromFile(file, trackStore, videoStore, settings, notify);
    } catch (error) {
      reportError("launchQueue", error, "Could not open file.", notify);
    }
  });
}

async function buildTracksFile(trackStore, videoStore, settings) {
  const tracks = trackStore.getTracks();
  const currentVideoId = videoStore.getVideoId();
  if (!tracks.length) return null;

  const metadata = {
    videoId: currentVideoId,
    exportedAt: Date.now(),
    version: 1,
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
  return new File([zipBlob], `jamin-${currentVideoId}.jmn`, { type: "application/zip" });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function downloadTracks(trackStore, videoStore, settings, notify) {
  if (!trackStore.getTracks().length) {
    notify("No tracks to export for this video.");
    return;
  }

  try {
    const file = await buildTracksFile(trackStore, videoStore, settings);
    if (!file) return;
    downloadBlob(file, file.name);
    notify("Exported.", "success");
  } catch (error) {
    reportError("exportTracks", error, "Export failed.", notify);
  }
}

async function shareTracks(trackStore, videoStore, settings, notify) {
  if (!trackStore.getTracks().length) {
    notify("No tracks to share for this video.");
    return;
  }

  try {
    const file = await buildTracksFile(trackStore, videoStore, settings);
    if (!file) return;

    const currentVideoId = videoStore.getVideoId();
    const payload = {
      files: [file],
      title: "Jam-in! takes",
      text: `Voice takes for ${currentVideoId}`,
    };
    if (navigator.canShare?.(payload)) {
      await navigator.share(payload);
      notify("Shared.", "success");
    } else {
      downloadBlob(file, file.name);
      notify("Share not available — downloaded instead.");
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    reportError("shareTracks", error, "Share failed.", notify);
  }
}

async function importFromFile(file, trackStore, videoStore, settings, notify) {
  if (!file) return;

  try {
    const files = await readZip(file);
    const metadataBytes = files["metadata.json"];
    if (!metadataBytes) throw new Error("metadata.json missing");

    const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
    const currentVideoId = videoStore.getVideoId();
    const targetVideoId = metadata.videoId || currentVideoId;

    if (Number.isFinite(metadata.globalSyncOffset)) {
      settings.setLatencyOffset(metadata.globalSyncOffset);
    }

    const existingByHash = await buildExistingByHash(targetVideoId);
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
      existingByHash.set(hash, { id, videoId: targetVideoId, blob });
      added += 1;
    }

    const message = formatImportMessage(added, updated, unchanged);
    notify(message, added > 0 || updated > 0 ? "success" : undefined);
    if (targetVideoId === currentVideoId) {
      await videoStore.load(currentVideoId);
    } else if (confirm("Imported takes belong to a different video. Load it now?")) {
      await videoStore.load(targetVideoId);
    } else {
      videoStore.captureMeta(targetVideoId);
    }
  } catch (error) {
    reportError("importFromFile", error, `Import failed: ${error.message}`, notify);
  }
}
