// ============================================================
// main.js — bootstrap: wire UI, video, recording, sync, storage.
// ============================================================

import { Player } from "./youtube.js";
import { Recorder, recordingSupportError } from "./recorder.js";
import { PlaybackEngine } from "./playback.js";
import { bindElements, initTheme, showToast } from "./ui.js";
import { initLatencyOffset } from "./latency.js";
import { initSearch } from "./search-ui.js";
import { initRecording } from "./recording.js";
import { createTrackListController } from "./tracks-ui.js";
import { initHistory } from "./history-ui.js";
import { initExportImport } from "./export-import.js";
import { initPwa } from "./pwa.js";
import { initPlayhead } from "./timeline-playhead.js";
import { initMenu } from "./menu-ui.js";
import { initAudioDevices } from "./audio-devices.js";
import { createEventBus } from "./core/events.js";
import { createTrackStore } from "./core/track-store.js";
import { createSettingsStore } from "./core/settings-store.js";
import { createVideoStore } from "./core/video-store.js";
import { createRecordingSession } from "./core/recording-session.js";
import { initTimelineSync } from "./core/timeline-sync.js";

// Touch-primary devices get Share instead of Export/Import.
const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches;
document.documentElement.dataset.platform = coarsePointer ? "mobile" : "desktop";

const elements = bindElements();
const player = new Player("player");
const recorder = new Recorder();
const engine = new PlaybackEngine(() => player.getCurrentTime());
const notify = (message, kind) => showToast(elements, message, kind);

const bus = createEventBus();
const trackStore = createTrackStore({ engine, bus });
const settings = createSettingsStore({ engine, recorder, bus });
const videoStore = createVideoStore({ player, trackStore, elements, bus, notify });
const recordingSession = createRecordingSession({
  player,
  recorder,
  engine,
  trackStore,
  videoStore,
  settings,
  elements,
  bus,
  notify,
});

const trackList = createTrackListController({
  trackStore,
  settings,
  videoStore,
  player,
  elements,
  bus,
  notify,
});

initHistory({ elements, videoStore, trackStore, bus, notify });
initTimelineSync({ player, videoStore, bus });
initPlayhead({ player, elements, bus });
initTheme();
initLatencyOffset({ elements, settings, bus });
initMenu({ elements, bus, trackList, settings });
initAudioDevices({ elements, settings });
initSearch({ elements, videoStore, settings, notify });
initRecording({ player, recordingSession });
initExportImport({ elements, trackStore, videoStore, settings, notify });
initPwa({ elements });

const recordingError = recordingSupportError();
if (recordingError) notify(recordingError, "error");

videoStore.loadInitial();

window.addEventListener("resize", () => {
  trackList.redrawWaveforms();
  trackList.layoutAllTrackRows();
});
window.addEventListener("jamin:theme-changed", () => trackList.redrawWaveforms());
