// Central error reporting: meaningful console output + optional user toast.

/**
 * Log an error for developers and optionally notify the user.
 * @param {string} context - Short label, e.g. "loadVideo"
 * @param {unknown} error
 * @param {string} [userMessage] - Shown in the toast when provided
 * @param {(msg: string, kind?: string) => void} [notify]
 */
export function reportError(context, error, userMessage, notify) {
  console.error(`[Jam-in] ${context}:`, error);
  if (userMessage && notify) notify(userMessage, "error");
}

/**
 * Log a non-fatal warning (degraded behaviour, skipped track, etc.).
 * @param {string} context
 * @param {...unknown} details
 */
export function reportWarning(context, ...details) {
  console.warn(`[Jam-in] ${context}:`, ...details);
}
