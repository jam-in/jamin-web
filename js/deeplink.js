// Parse and build ?youtube=ID&session=ID&play=BOOL deeplinks.

import { parseVideoId } from "./youtube.js";
import { resolveSessionId } from "./core/session-id.js";
import { shareLinkNow } from "./share.js";

function parsePlayFlag(value) {
  if (value == null || value === "") return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return false;
}

export function parseDeeplink() {
  const params = new URLSearchParams(location.search);
  const youtube = params.get("youtube");
  const videoId = youtube ? parseVideoId(youtube) : null;
  const sessionRaw = params.get("session");
  const sessionId = videoId && sessionRaw != null && sessionRaw !== ""
    ? resolveSessionId(sessionRaw)
    : null;
  return { videoId, sessionId, play: parsePlayFlag(params.get("play")) };
}

export function buildDeeplinkUrl(videoId, { sessionId, play = false } = {}) {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("youtube", videoId);
  url.searchParams.set("session", resolveSessionId(sessionId));
  if (play) url.searchParams.set("play", "true");
  return url.href;
}

export function shareDeeplink(videoStore, notify) {
  const videoId = videoStore.getVideoId();
  if (!videoId) {
    notify("No video loaded.");
    return;
  }

  const url = buildDeeplinkUrl(videoId, { sessionId: videoStore.getSessionId() });
  const title = videoStore.getVideoTitleSync();

  let text = "Join the jam over this YouTube video:\n\n";
  if (title) text += `${title}\n`;

  shareLinkNow({ url, title: "Jam-in!", text }, notify);
}
