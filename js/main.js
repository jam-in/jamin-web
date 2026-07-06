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
import { initPwa } from "./pwa.js";
import { initPlayhead } from "./timeline-playhead.js";
import { initMenu } from "./menu-ui.js";
import { initAudioDevices } from "./audio-devices.js";
import { createEventBus } from "./core/events.js";
import { createTrackStore } from "./core/track-store.js";
import { createSettingsStore } from "./core/settings-store.js";
import { createVideoStore } from "./core/video-store.js";
import { createSessionStore } from "./core/session-store.js";
import { createRecordingSession } from "./core/recording-session.js";
import { createAutoSync } from "./core/auto-sync.js";
import { createReferenceCapture } from "./reference-capture.js";
import { createBleedingProcessor } from "./core/bleeding-processor.js";
import { initTimelineSync } from "./core/timeline-sync.js";
import { parseDeeplink } from "./deeplink.js";

const elements = bindElements();
const player = new Player("player");
const recorder = new Recorder();
const engine = new PlaybackEngine(() => player.getCurrentTime());
const notify = (message, kind) => showToast(elements, message, kind);

const bus = createEventBus();
const settings = createSettingsStore({ engine, recorder, bus });
const trackStore = createTrackStore({ engine, settings, bus });
const bleedingProcessor = createBleedingProcessor({ trackStore, settings });
trackStore.attachBleedingProcessor(bleedingProcessor);
const sessionStore = createSessionStore({ bus });
const referenceCapture = createReferenceCapture();
const videoStore = createVideoStore({
  player,
  trackStore,
  sessionStore,
  elements,
  bus,
  notify,
});
const autoSync = createAutoSync({
  referenceCapture,
  settings,
  trackStore,
  player,
  recorder,
  elements,
  bus,
  notify,
});
const recordingSession = createRecordingSession({
  player,
  recorder,
  engine,
  trackStore,
  videoStore,
  settings,
  autoSync,
  bleedingProcessor,
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
initPlayhead({ player, elements, bus, autoSync });
initTheme();
initLatencyOffset({ elements, settings, bus, autoSync });
initMenu({ elements, bus, trackList, trackStore, settings, videoStore, notify });
initAudioDevices({ settings });
initSearch({ elements, videoStore, settings, notify });
initRecording({ player, recordingSession });
const deeplink = parseDeeplink();
const appReady = videoStore.loadInitial(deeplink.videoId, deeplink.sessionId);
if (deeplink.play) {
  appReady.then((loaded) => {
    if (loaded) player.play();
  });
}
initPwa({ elements });

const recordingError = recordingSupportError();
if (recordingError) notify(recordingError, "error");

window.addEventListener("resize", () => {
  trackList.redrawWaveforms();
  trackList.layoutAllTrackRows();
});
window.addEventListener("jamin:theme-changed", () => trackList.redrawWaveforms());
