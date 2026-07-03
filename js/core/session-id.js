// Jam session identity: legacy session "0" per video, or UUID for new jams.

export const LEGACY_SESSION_ID = "0";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sessionStorageKey(videoId, sessionId) {
  return `${videoId}:${sessionId}`;
}

export function resolveSessionId(raw) {
  if (raw == null || raw === "") return LEGACY_SESSION_ID;
  if (raw === LEGACY_SESSION_ID || UUID_RE.test(raw)) return raw;
  return LEGACY_SESSION_ID;
}

export function isValidSessionId(raw) {
  return raw === LEGACY_SESSION_ID || UUID_RE.test(raw);
}
