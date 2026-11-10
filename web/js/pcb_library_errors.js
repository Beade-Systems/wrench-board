// Turns server-supplied texts of the PCB library, catalog, settings and board
// endpoints into the reader's language. The backend sends a stable code (and
// params) next to every sentence; the sentence itself stays the fallback, so
// answers and stored records without a code still show their original text.
import { localizeCode } from './shared/errors.js';

const ERRORS = 'library.error';

/**
 * Message for a failed request, from its parsed JSON body.
 * Understands `{detail: "<text>", code, params}` (api/errors.py) and the board
 * import shape `{detail: {detail: "<kind>", message, code?, params?, ...}}`.
 * `fallback` is used when the body carries nothing readable.
 */
export function describeServerError(body, fallback = '') {
  if (!body || typeof body !== 'object') return fallback;
  const nested = body.detail && typeof body.detail === 'object' && !Array.isArray(body.detail) ? body.detail : null;
  if (!nested) {
    const text = typeof body.detail === 'string' ? body.detail : fallback;
    return localizeCode(ERRORS, body.code, body.params, text);
  }
  const text = typeof nested.message === 'string' && nested.message ? nested.message : fallback;
  if (text.includes('pcbnew not available')) return localizeCode(ERRORS, 'pcbnew_missing', undefined, text);
  const params = { ...nested, ...(nested.params || {}), message: text };
  if (Number.isFinite(nested.max_bytes)) params.max = Math.round(nested.max_bytes / 1048576);
  // The error kind is always known; a parser-specific code, when present, is more precise.
  const byKind = localizeCode(ERRORS, nested.detail, params, text);
  return nested.code ? localizeCode(ERRORS, nested.code, params, byKind) : byKind;
}

/** Same, for a failed `Response`; never throws. */
export async function describeResponseError(response, fallback = '') {
  try {
    return describeServerError(await response.json(), fallback);
  } catch {
    return fallback; // Not JSON: keep the caller's HTTP-status text.
  }
}

/** One import note: `entry` is its `{code, params}` or null for free text. */
export function noteText(text, entry) {
  return localizeCode('library.note', entry?.code, entry?.params, text);
}

/** Notes of a board, index-aligned with `board.parser_note_codes` when present. */
export function boardNotes(board) {
  const codes = Array.isArray(board?.parser_note_codes) ? board.parser_note_codes : [];
  return (board?.parser_notes || []).map((text, index) => noteText(text, codes[index]));
}

/** Message of an audit result or of the audit endpoints (`{message, code, params}`). */
export function auditMessage(item) {
  if (!item) return '';
  const text = item.message == null ? '' : String(item.message);
  // Parser failures reuse the import error codes.
  return localizeCode('library.audit.message', item.code, item.params, localizeCode(ERRORS, item.code, item.params, text));
}
