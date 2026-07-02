// Export / import tracks as .jmn files (zip of audio blobs + JSON metadata).

import * as db from "./db.js";
import { reportError } from "./errors.js";
import { buildZip, readZip } from "./zip.js";

export function initExportImport({ elements, trackStore, videoStore, notify }) {
  elements.exportBtn?.addEventListener("click", () => downloadTracks(trackStore, videoStore, notify));
  elements.importBtn?.addEventListener("click", () => elements.importFile?.click());
  elements.shareBtn?.addEventListener("click", () => shareTracks(trackStore, videoStore, notify));
  elements.importFile?.addEventListener("change", () => {
    const file = elements.importFile.files[0];
    elements.importFile.value = "";
    if (file) importFromFile(file, trackStore, videoStore, notify);
  });

  initFileHandling(trackStore, videoStore, notify);
}

function initFileHandling(trackStore, videoStore, notify) {
  if (!("launchQueue" in window)) return;
  window.launchQueue.setConsumer(async (launchParams) => {
    const handle = launchParams.files?.[0];
    if (!handle) return;
    try {
      const file = await handle.getFile();
      await importFromFile(file, trackStore, videoStore, notify);
    } catch (error) {
      reportError("launchQueue", error, "Could not open file.", notify);
    }
  });
}

async function buildTracksFile(trackStore, videoStore) {
  const tracks = trackStore.getTracks();
  const currentVideoId = videoStore.getVideoId();
  if (!tracks.length) return null;

  const metadata = { videoId: currentVideoId, exportedAt: Date.now(), version: 1, tracks: [] };
  const entries = [];
  let index = 0;

  for (const track of tracks) {
    const extension = (track.mimeType || "").includes("ogg") ? "ogg"
      : (track.mimeType || "").includes("mp4") ? "m4a" : "webm";
    const filename = `audio/${index}.${extension}`;
    entries.push({ name: filename, data: new Uint8Array(await track.blob.arrayBuffer()) });
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

async function downloadTracks(trackStore, videoStore, notify) {
  if (!trackStore.getTracks().length) {
    notify("No tracks to export for this video.");
    return;
  }

  try {
    const file = await buildTracksFile(trackStore, videoStore);
    if (!file) return;
    downloadBlob(file, file.name);
    notify("Exported.", "success");
  } catch (error) {
    reportError("exportTracks", error, "Export failed.", notify);
  }
}

async function shareTracks(trackStore, videoStore, notify) {
  if (!trackStore.getTracks().length) {
    notify("No tracks to share for this video.");
    return;
  }

  try {
    const file = await buildTracksFile(trackStore, videoStore);
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

async function importFromFile(file, trackStore, videoStore, notify) {
  if (!file) return;

  try {
    const files = await readZip(file);
    const metadataBytes = files["metadata.json"];
    if (!metadataBytes) throw new Error("metadata.json missing");

    const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
    const currentVideoId = videoStore.getVideoId();
    const targetVideoId = metadata.videoId || currentVideoId;

    for (const entry of metadata.tracks) {
      const bytes = files[entry.file];
      if (!bytes) continue;
      const blob = new Blob([bytes], { type: entry.mimeType || "audio/webm" });
      await db.addTrack({
        videoId: targetVideoId,
        name: entry.name || "Imported take",
        startTime: entry.startTime || 0,
        offset: entry.offset ?? 0,
        duration: entry.duration || 0,
        mimeType: entry.mimeType || "audio/webm",
        volume: entry.volume ?? 1,
        muted: !!entry.muted,
        peaks: entry.peaks || [],
        createdAt: entry.createdAt || Date.now(),
        blob,
      });
    }

    notify("Imported.", "success");
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
