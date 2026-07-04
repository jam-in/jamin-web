// Web Share helpers for deeplink sharing.
// Link sharing must run synchronously from the click handler (no await before share).

export function copyShareText(text, notify) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => {
      notify("Link copied to clipboard.", "success");
    });
  }
  notify(text);
  return Promise.resolve();
}

/** Invoke from a click handler without awaiting anything before navigator.share(). */
export function shareLinkNow({ url, title, text }, notify) {
  if (!navigator.share) {
    copyShareText(`${text}\n${url}`, notify);
    return;
  }

  // Prefer minimal payloads — some platforms reject title+text+url together.
  const payloads = [{ url }, { url, title }, { url, title, text }];

  for (const payload of payloads) {
    if (!navigator.canShare?.(payload)) continue;
    navigator.share(payload)
      .then(() => notify("Link shared.", "success"))
      .catch((error) => {
        if (error?.name === "AbortError") return;
        copyShareText(`${text}\n${url}`, notify).catch(() => {
          notify("Share failed — copy the link from the address bar.", "error");
        });
      });
    return;
  }

  copyShareText(`${text}\n${url}`, notify);
}
