// Device catalogue read service — single cached source for the flattened
// device list, fed by GET /pipeline/taxonomy. Consumed by the landing
// autocomplete (features/global/landing/index.js) and the catalogue modal
// (features/global/landing/catalogue.js). Data-only: no DOM, no rendering.

import { apiGet } from "../shared/api.js";
import { prettifySlug } from "../shared/dom.js";

let _cache = null;

// Flatten a TaxonomyTree into one entry PER pack — every board revision /
// variant a model has surfaces as its own suggestion (e.g. the two iPhone X
// boards, Qualcomm vs Intel), disambiguated by `version`. Same set as
// flattenBoards (the catalogue), only re-sorted for the autocomplete: complete
// first, then alphabetical by label. Collapsing to one-per-(brand,model) used
// to hide the non-canonical variant — unreachable from search even though the
// catalogue showed it.
export function flattenTaxonomy(tree) {
  const out = flattenBoards(tree);
  out.sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return out;
}

// Cached for the session. `force: true` re-fetches (e.g. after a new build).
export async function loadDevices({ force = false } = {}) {
  if (_cache && !force) return _cache;
  const tree = await apiGet("/pipeline/taxonomy");
  _cache = flattenTaxonomy(tree);
  return _cache;
}

// One entry PER pack (board revision) — every variant of a model (e.g. both
// MacBook Pro 13" boards: the A1706/A1708 and the M1 A2338) disambiguated by
// `version`. The base of flattenTaxonomy too (which only re-sorts the result);
// kept separate so the catalogue's board step gets the packs in API order.
export function flattenBoards(tree) {
  const out = [];
  const push = (brand, model, p) => out.push({
    label: model || p.device_label || prettifySlug(p.device_slug),
    subtitle: brand || null,
    slug: p.device_slug,
    device_label: p.device_label || model || prettifySlug(p.device_slug),
    version: p.version || null,
    form_factor: p.form_factor || null,
    complete: Boolean(p.complete),
    has_electrical_graph: Boolean(p.has_electrical_graph),
    device_kind: p.device_kind || null,
    aliases: Array.isArray(p.aliases) ? p.aliases : [],
  });
  const brands = (tree && tree.brands) || {};
  for (const [brand, models] of Object.entries(brands)) {
    for (const [model, packs] of Object.entries(models || {})) {
      for (const p of packs || []) push(brand, model, p);
    }
  }
  for (const p of (tree && tree.uncategorized) || []) {
    if (p && p.device_slug) push(null, p.device_label || prettifySlug(p.device_slug), p);
  }
  return out;
}

let _boardsCache = null;

export async function loadBoards({ force = false } = {}) {
  if (_boardsCache && !force) return _boardsCache;
  const tree = await apiGet("/pipeline/taxonomy");
  _boardsCache = flattenBoards(tree);
  return _boardsCache;
}

// Hardware catalogue search — the indexed board/schematic source behind the PCB
// library (GET /api/library/source/devices, one row per brand/model/board#).
// Unlike the pack taxonomy this is queried server-side per keystroke (tens of
// thousands of rows). Returns [] when no source is configured or on any error:
// callers then simply show packs only.
export async function searchHardware(query, { limit = 6 } = {}) {
  const q = (query || "").trim();
  if (q.length < 2) return [];
  try {
    const res = await apiGet(`/api/library/source/devices?q=${encodeURIComponent(q)}&limit=${limit}`);
    return (res.items || []).map((d) => {
      const brand = (d.brand || "").trim();
      const model = (d.model || "").trim();
      // Folder-derived model names sometimes repeat the brand ("Acer Nitro 5").
      const label = model.toLowerCase().startsWith(brand.toLowerCase())
        ? model : [brand, model].filter(Boolean).join(" ");
      const shown = label || d.board_number || "";
      // The board number is what tells two catalogue rows of one model apart,
      // so `pick` (the text that lands in the device input) carries it.
      const bn = d.board_number || "";
      const pick = bn && !shown.toLowerCase().includes(bn.toLowerCase()) ? `${shown} ${bn}` : shown;
      return {
        label: shown,
        pick,
        subtitle: brand || null,
        board_number: d.board_number || null,
        board_count: d.board_count || 0,
        pdf_count: d.pdf_count || 0,
      };
    }).filter((d) => d.label);
  } catch {
    return [];
  }
}
