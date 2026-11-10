// web/js/shared/errors.js
// Localise a failure by its stable machine code. The backend sends
// `{detail, code, params}` on coded HTTP errors (api/errors.py) and `code` /
// `params` on WS error events; `detail`/`message` stay the English fallback.

function translate(key, params) {
  const i18n = typeof window !== "undefined" ? window.i18n : null;
  if (!i18n || typeof i18n.t !== "function") return null;
  const val = i18n.t(key, params);
  return val === key ? null : val; // t() returns the key itself when missing
}

// `ns` is the dictionary prefix holding the codes, e.g. "stock.error".
// Returns the translated text, or `fallback` (the server's own sentence).
export function localizeCode(ns, code, params, fallback) {
  if (code) {
    const hit = translate(`${ns}.${String(code).replace(/-/g, "_")}`, params);
    if (hit) return hit;
  }
  return fallback == null ? "" : String(fallback);
}

// For an ApiError thrown by shared/api.js (or any Error).
export function localizeError(ns, err, fallback) {
  const body = err && err.body;
  const text = (err && err.message) || fallback;
  if (!body || typeof body !== "object") return text == null ? "" : String(text);
  // Coded body, or the legacy board-import shape {detail: {detail: code, message}}.
  const nested = body.detail && typeof body.detail === "object" ? body.detail : null;
  const code = body.code || (nested && (nested.code || nested.detail));
  const params = body.params || (nested && (nested.params || nested)) || undefined;
  const serverText = nested ? nested.message || fallback : text;
  return localizeCode(ns, code, params, serverText);
}
