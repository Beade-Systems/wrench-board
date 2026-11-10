// Stock section — donor management + search.
// See docs/superpowers/specs/2026-05-08-stock-inventory-design.md §11.

import i18n, { t, onChange } from "./i18n.js";
import { escapeHtml } from "./shared/dom.js";
import { apiFetch, apiGet, ApiError } from "./shared/api.js";
import { localizeError } from "./shared/errors.js";
import { openInfoModal } from "./info_modal.js";

const STOCK_INFO_FLAG = "wb_stock_info_seen";

const API = "/api/stock";

// One-letter type codes for the dense column layout. Keeps the row scanable
// at a glance — the full type name is in the tooltip.
const TYPE_LABEL = {
  capacitor: "C",
  resistor: "R",
  inductor: "L",
  diode: "D",
  transistor: "Q",
  ferrite: "FB",
  ic: "IC",
  connector: "J",
  led: "LED",
  crystal: "Y",
  oscillator: "Y",
  fuse: "F",
  switch: "SW",
  relay: "K",
  transformer: "TR",
  module: "M",
  power_symbol: "PS",
  test_point: "TP",
  mounting: "MT",
  antenna: "ANT",
  other: "?",
};

const TYPE_FAMILY = {
  // Passives → cyan family
  capacitor: "passive", resistor: "passive", inductor: "passive",
  diode: "passive", ferrite: "passive",
  // Actives → violet
  ic: "active", transistor: "active", led: "active",
  oscillator: "active", crystal: "active",
  // Mechanical → amber
  connector: "mech", switch: "mech", fuse: "mech",
  test_point: "mech", mounting: "mech", antenna: "mech",
};

// Keep state for the harvest mode so filter + sort survive checkbox toggles.
const _harvestState = {
  donorId: null,
  parts: [],
  filter: "",
  typeFilter: "",
  sort: "refdes",
};

async function fetchJson(path, opts) {
  const r = await apiFetch(API + path, opts);
  if (!r.ok) {
    // Keep the parsed body so the coded `{detail, code, params}` can be localised.
    let body = null;
    try { body = await r.json(); } catch { /* non-JSON error body */ }
    const detail = body && typeof body.detail === "string" ? body.detail : "";
    throw new ApiError(r.status, detail || `${r.status} ${r.statusText}`.trim(), body);
  }
  return r.json();
}

// Backend failure → sentence in the UI language (server text as fallback).
// `e.message` is the fallback for bodies without a code (e.g. a 422 validation list).
const errorText = (e) => localizeError("stock.error", e, e && e.message);

function reportActionError(e) {
  alert(t("stock.action_error", { error: errorText(e) }));
}

// Re-run `paint` on every language switch while an overlay is open, keeping
// the focused field (and its caret) across the rebuild. Returns the unsubscribe.
function repaintOnLocaleChange(overlay, paint) {
  const stop = onChange(() => {
    if (!overlay.isConnected) { stop(); return; }
    const active = overlay.contains(document.activeElement) ? document.activeElement : null;
    const focusId = active && active.id;
    let caret = null;
    try { caret = active ? [active.selectionStart, active.selectionEnd] : null; } catch { /* not a text field */ }
    paint();
    const again = focusId ? overlay.querySelector(`#${CSS.escape(focusId)}`) : null;
    if (!again) return;
    again.focus();
    try { if (caret && caret[0] != null) again.setSelectionRange(caret[0], caret[1]); } catch { /* ignore */ }
  });
  return stop;
}

// Localised label for a backend enum value (part type, role, criticality,
// donor condition). Falls back to the raw value when no key exists.
function enumLabel(prefix, value) {
  if (!value) return "";
  const key = `${prefix}${value}`;
  const label = t(key);
  return label === key ? String(value) : label;
}
const typeName = (type) => enumLabel("stock.type_", type);
const roleName = (role) => enumLabel("workbench.stock.role.", role);
const critName = (crit) => enumLabel("stock.crit_", crit);
const conditionName = (cond) => enumLabel("stock.condition_", cond);

function typeChip(type) {
  const label = TYPE_LABEL[type] || "?";
  const family = TYPE_FAMILY[type] || "other";
  return `<span class="type-chip type-${family}" title="${escapeHtml(typeName(type))}">${label}</span>`;
}

function roleChip(role, safety) {
  if (!role) return `<span class="role-chip role-unknown" title="${escapeHtml(t("stock.col_role"))}">${escapeHtml(t("workbench.common.none"))}</span>`;
  return `<span class="role-chip safety-${safety || "exact_only"}">${escapeHtml(roleName(role))}</span>`;
}

function critDot(crit) {
  return `<span class="crit-dot crit-${crit}" title="${escapeHtml(critName(crit))}"></span>`;
}

// A donor card. `pending` = the device has no parts_index yet (graph not
// ready) → nothing to harvest, so the card is dimmed, carries a "waiting"
// badge, and drops the Harvest action.
function donorCard(d, pending) {
  const head = pending
    ? `<span class="donor-pending-badge mono">${escapeHtml(t("stock.pending_badge"))}</span>`
    : `<span class="donor-condition mono">${escapeHtml(conditionName(d.condition))}</span>`;
  const stats = pending
    ? `<span class="donor-pending-hint">${escapeHtml(t("stock.pending_hint"))}</span>`
    : t("stock.parts_available", { available: `<b>${Number(d.parts_available)}</b>`, total: Number(d.parts_total) });
  const harvestBtn = pending
    ? ""
    : `<button class="btn-sm" data-action="harvest" data-donor="${escapeHtml(d.donor_id)}">${escapeHtml(t("stock.harvest"))}</button>`;
  return `
    <div class="donor-card${pending ? " pending" : ""}">
      <div class="donor-head">
        <span class="donor-id mono">${escapeHtml(d.donor_id)}</span>
        ${head}
      </div>
      <div class="donor-label">${escapeHtml(d.label)}</div>
      <div class="donor-stats mono">${stats}</div>
      <div class="donor-actions">
        ${harvestBtn}
        <button class="btn-sm btn-danger" data-action="unmark" data-donor="${escapeHtml(d.donor_id)}">${escapeHtml(t("stock.remove"))}</button>
      </div>
    </div>
  `;
}

function donorGroup(titleKey, donors, pending) {
  if (!donors.length) return "";
  return `
    <div class="donor-group-head${pending ? " pending" : ""}">
      <span>${escapeHtml(t(titleKey))}</span>
      <span class="mono dim">${donors.length}</span>
    </div>
    <div class="stock-donors-grid">${donors.map(d => donorCard(d, pending)).join("")}</div>
  `;
}

async function loadDonors() {
  const list = document.getElementById("stock-donors-list");
  // Never paint before the dictionaries are in (a deep-link to #stock would
  // otherwise render raw keys / English fallbacks that nothing repaints).
  if (i18n.ready) await i18n.ready;
  let donors;
  try {
    ({ donors } = await fetchJson("/donors"));
  } catch {
    // Don't die into a silent empty view (the 0/0/0 + "no donors" trap of a
    // lapsed session). Show why; the 401 path also fires wb:unauthorized.
    if (list) list.innerHTML = `<div class="stock-empty stock-error">${escapeHtml(t("stock.load_error"))}</div>`;
    return;
  }
  let totalAvail = 0;
  let totalCons = 0;
  const ready = [];
  const pending = [];
  for (const d of donors) {
    totalAvail += d.parts_available;
    totalCons += d.parts_consumed;
    // "Ready" = parts are searchable/harvestable (parts_index present). A pack
    // can exist with no index yet → the donor waits for its graph.
    (d.has_parts_index ? ready : pending).push(d);
  }

  if (!donors.length) {
    list.innerHTML = `
      <div class="stock-empty">
        <svg class="stock-empty-icon" viewBox="0 0 24 24" width="32" height="32" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>
        </svg>
        <div class="stock-empty-title">${escapeHtml(t("stock.empty_donors"))}</div>
        <div class="stock-empty-hint">${escapeHtml(t("stock.empty_hint"))}</div>
        <button type="button" class="btn-primary" id="stock-empty-add">${escapeHtml(t("stock.add_donor"))}</button>
      </div>`;
    const addBtn = document.getElementById("stock-empty-add");
    if (addBtn) addBtn.onclick = showAddDonorDialog;
  } else {
    list.innerHTML =
      donorGroup("stock.section_ready", ready, false) +
      donorGroup("stock.section_pending", pending, true);
  }

  document.getElementById("stock-donors-count").textContent = donors.length;
  document.getElementById("stock-available-count").textContent = totalAvail;
  document.getElementById("stock-consumed-count").textContent = totalCons;

  list.onclick = async (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    const donorId = btn.dataset.donor;
    if (btn.dataset.action === "unmark") {
      if (!confirm(t("stock.remove_confirm", { donor: donorId }))) return;
      try {
        await fetchJson(`/donors/${donorId}`, { method: "DELETE" });
      } catch (e) {
        reportActionError(e);
      }
      await loadDonors();
    } else if (btn.dataset.action === "harvest") {
      openHarvestMode(donorId);
    }
  };
}

function _filterAndSort(parts) {
  const q = _harvestState.filter.trim().toLowerCase();
  const tFilter = _harvestState.typeFilter;
  let rows = parts;
  if (q) {
    rows = rows.filter(p => {
      const hay = `${p.refdes} ${p.value_canonical || ""} ${p.role_in_design || ""} ${p.mpn || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }
  if (tFilter) rows = rows.filter(p => p.type === tFilter);

  const sortKey = _harvestState.sort;
  rows = rows.slice().sort((a, b) => {
    if (sortKey === "refdes") return a.refdes.localeCompare(b.refdes, undefined, { numeric: true });
    if (sortKey === "type") return (a.type || "").localeCompare(b.type || "") || a.refdes.localeCompare(b.refdes);
    if (sortKey === "value") return (a.value_canonical || "").localeCompare(b.value_canonical || "");
    if (sortKey === "role") return (a.role_in_design || "zzz").localeCompare(b.role_in_design || "zzz");
    if (sortKey === "crit") {
      const order = { high: 0, medium: 1, low: 2 };
      return (order[a.criticality_in_design] ?? 9) - (order[b.criticality_in_design] ?? 9);
    }
    return 0;
  });
  return rows;
}

function _renderHarvestRows() {
  const rows = _filterAndSort(_harvestState.parts);
  const tbody = document.getElementById("harvest-tbody");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="harvest-empty">${escapeHtml(t("workbench.stock.no_matching_parts"))}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(p => `
    <tr class="harvest-row ${p.available ? "" : "consumed"}">
      <td><input type="checkbox" data-refdes="${escapeHtml(p.refdes)}" ${p.available ? "" : "checked"}></td>
      <td class="mono refdes">${escapeHtml(p.refdes)}</td>
      <td>${typeChip(p.type)}</td>
      <td class="mono value">${escapeHtml(p.value_canonical || "…")}</td>
      <td class="mono pkg">${escapeHtml(p.package || "…")}</td>
      <td class="mono mpn dim">${escapeHtml(p.mpn || "")}</td>
      <td>${roleChip(p.role_in_design, p.safety_class)}</td>
      <td>${critDot(p.criticality_in_design)}</td>
      <td class="mono pages dim">${(p.pages || []).join(",") || "…"}</td>
    </tr>
  `).join("");

  // Header summary count
  const countEl = document.getElementById("harvest-row-count");
  if (countEl) countEl.textContent = `${rows.length} / ${_harvestState.parts.length}`;
}

async function openHarvestMode(donorId) {
  let parts;
  try {
    ({ parts } = await fetchJson(`/donors/${donorId}/parts`));
  } catch (e) {
    reportActionError(e);
    return;
  }
  _harvestState.donorId = donorId;
  _harvestState.parts = parts;
  _harvestState.filter = "";
  _harvestState.typeFilter = "";
  _harvestState.sort = "refdes";

  // Build the type filter options from what's actually present, in the
  // canonical order. Caps + resistors first (most populous on most boards).
  const typeCounts = {};
  for (const p of parts) typeCounts[p.type] = (typeCounts[p.type] || 0) + 1;
  const orderedTypes = Object.keys(typeCounts).sort((a, b) => typeCounts[b] - typeCounts[a]);

  const overlay = document.createElement("div");
  overlay.className = "harvest-overlay";

  // Full (re)build of the panel in the current language. Filter / type / sort
  // live in _harvestState, so a repaint on a language switch keeps them.
  function paint() {
    const typeOpts = [`<option value="">${escapeHtml(t("workbench.stock.all_types"))}</option>`]
      .concat(orderedTypes.map(ty => `<option value="${escapeHtml(ty)}">${TYPE_LABEL[ty] || "?"} · ${escapeHtml(typeName(ty))} (${typeCounts[ty]})</option>`))
      .join("");
    const scrollTop = overlay.querySelector(".harvest-table-wrap")?.scrollTop || 0;
    overlay.innerHTML = `
    <div class="harvest-panel glass">
      <header class="harvest-head">
        <div class="harvest-title">
          <h3>${escapeHtml(t("stock.harvest_title"))}</h3>
          <span class="mono dim">${escapeHtml(donorId)}</span>
        </div>
        <button class="btn-sm" data-close>${escapeHtml(t("stock.close"))}</button>
      </header>
      <div class="harvest-controls">
        <input class="harvest-filter" id="harvest-filter" type="search"
               placeholder="${escapeHtml(t("stock.filter_donor_placeholder"))}">
        <select class="harvest-type-filter" id="harvest-type-filter">${typeOpts}</select>
        <select class="harvest-sort" id="harvest-sort">
          <option value="refdes">↕ ${escapeHtml(t("stock.col_refdes"))}</option>
          <option value="type">↕ ${escapeHtml(t("stock.col_type"))}</option>
          <option value="value">↕ ${escapeHtml(t("stock.col_value"))}</option>
          <option value="role">↕ ${escapeHtml(t("stock.col_role"))}</option>
          <option value="crit">↕ ${escapeHtml(t("stock.sort_crit"))}</option>
        </select>
        <span class="mono dim" id="harvest-row-count"></span>
      </div>
      <div class="harvest-table-wrap">
        <table class="harvest-table">
          <thead>
            <tr>
              <th></th>
              <th>${t("stock.col_refdes")}</th>
              <th>${t("stock.col_type")}</th>
              <th>${t("stock.col_value")}</th>
              <th>${t("stock.col_pkg")}</th>
              <th>${escapeHtml(t("stock.col_mpn"))}</th>
              <th>${t("stock.col_role")}</th>
              <th>${t("stock.col_crit")}</th>
              <th>${t("stock.col_page")}</th>
            </tr>
          </thead>
          <tbody id="harvest-tbody"></tbody>
        </table>
      </div>
    </div>
  `;
    overlay.querySelector("#harvest-filter").value = _harvestState.filter;
    overlay.querySelector("#harvest-type-filter").value = _harvestState.typeFilter;
    overlay.querySelector("#harvest-sort").value = _harvestState.sort;
    _renderHarvestRows();
    const wrap = overlay.querySelector(".harvest-table-wrap");
    if (wrap) wrap.scrollTop = scrollTop;
  }

  document.body.appendChild(overlay);
  paint();
  const stopLocaleRepaint = repaintOnLocaleChange(overlay, paint);
  const close = () => { stopLocaleRepaint(); overlay.remove(); };

  // Delegated on the overlay itself — paint() replaces everything inside it.
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay || ev.target.closest("[data-close]")) close();
  });
  overlay.addEventListener("input", (ev) => {
    if (ev.target.id !== "harvest-filter") return;
    _harvestState.filter = ev.target.value;
    _renderHarvestRows();
  });

  overlay.addEventListener("change", async (ev) => {
    if (ev.target.id === "harvest-type-filter") {
      _harvestState.typeFilter = ev.target.value;
      _renderHarvestRows();
      return;
    }
    if (ev.target.id === "harvest-sort") {
      _harvestState.sort = ev.target.value;
      _renderHarvestRows();
      return;
    }
    const cb = ev.target.closest('input[type="checkbox"][data-refdes]');
    if (!cb) return;
    const ref = cb.dataset.refdes;
    try {
      if (cb.checked) {
        await fetchJson(`/donors/${donorId}/consume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refdes: ref }),
        });
      } else {
        await fetchJson(`/donors/${donorId}/consume/${ref}`, { method: "DELETE" });
      }
    } catch (e) {
      cb.checked = !cb.checked;
      reportActionError(e);
      return;
    }
    // Update local state so the row's class / sort survives a re-render.
    const part = _harvestState.parts.find(p => p.refdes === ref);
    if (part) part.available = !cb.checked;
  });
}

async function runSearch() {
  const body = {
    type: document.getElementById("stock-q-type").value || null,
    value_canonical: document.getElementById("stock-q-value").value || null,
    package: document.getElementById("stock-q-package").value || null,
    voltage_min: parseFloat(document.getElementById("stock-q-voltage").value) || null,
    requested_role: document.getElementById("stock-q-role").value || null,
  };
  Object.keys(body).forEach(k => body[k] == null && delete body[k]);
  if (!body.type) {
    alert(t("workbench.stock.select_type_alert"));
    return;
  }
  let res;
  try {
    res = await fetchJson("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    _lastSearch = null;
    const out = document.getElementById("stock-results");
    if (out) out.innerHTML = `<div class="empty stock-error">${escapeHtml(t("stock.search_error", { error: errorText(e) }))}</div>`;
    return;
  }
  renderSearchResults(res);
}

// The search endpoint reports why a result is empty as a stable
// `empty_reason_code` (+ params) next to the English `empty_reason` sentence.
// Translate by code (`stock.empty_reason_<code>`); the sentence map only
// serves responses that carry no code.
const EMPTY_REASON_CODES = {
  "no donors in stock": "no_donors",
  "no matching parts available": "no_match",
};
function emptyReasonLabel(res) {
  const code = res.empty_reason_code || EMPTY_REASON_CODES[res.empty_reason];
  if (!code) return res.empty_reason;
  const key = `stock.empty_reason_${String(code).replace(/-/g, "_")}`;
  const label = t(key, res.empty_reason_params || undefined);
  return label === key ? res.empty_reason : label;
}

// Last search response, kept so a locale switch can repaint the results.
let _lastSearch = null;

function renderSearchResults(res) {
  _lastSearch = res;
  const out = document.getElementById("stock-results");
  out.innerHTML = "";
  if (res.empty_reason) {
    out.innerHTML = `<div class="empty">${escapeHtml(emptyReasonLabel(res))}</div>`;
    return;
  }
  const section = (titleKey, matches, kind) => {
    if (!matches.length) return "";
    return `
      <div class="result-group result-${kind}">
        <h3>${escapeHtml(t(titleKey))} <span class="dim mono">(${matches.length})</span></h3>
        <table class="result-table">
          <thead>
            <tr>
              <th>${t("stock.col_refdes")}</th>
              <th>${t("stock.col_type")}</th>
              <th>${t("stock.col_value")}</th>
              <th>${t("stock.col_pkg")}</th>
              <th>${t("stock.col_donor")}</th>
              <th>${t("stock.col_page")}</th>
              <th>${t("stock.col_crit")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${matches.map(m => `
              <tr>
                <td class="mono refdes">${escapeHtml(m.refdes)}</td>
                <td>${typeChip(m.type || "")}</td>
                <td class="mono value">${escapeHtml(m.value_canonical || "…")}</td>
                <td class="mono pkg">${escapeHtml(m.package || "…")}</td>
                <td class="mono donor">${escapeHtml(m.donor_label)}</td>
                <td class="mono pages dim">${(m.pages || []).join(",") || "…"}</td>
                <td>${critDot(m.criticality_in_donor)}</td>
                <td><button class="btn-sm" data-mark-consumed
                            data-donor="${escapeHtml(m.donor_id)}"
                            data-refdes="${escapeHtml(m.refdes)}">${escapeHtml(t("stock.mark_consumed"))}</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  };
  out.innerHTML = section("stock.exact_matches", res.exact_matches, "exact");
  out.onclick = async (ev) => {
    const btn = ev.target.closest("[data-mark-consumed]");
    if (!btn) return;
    try {
      await fetchJson(`/donors/${btn.dataset.donor}/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refdes: btn.dataset.refdes }),
      });
    } catch (e) {
      reportActionError(e);
      return;
    }
    btn.disabled = true;
    btn.textContent = t("stock.consumed");
    await loadDonors();
  };
}

/* ---------- Add-donor modal — device selector (board type → brand → search) ---------- */

// Flat list of known devices from /pipeline/taxonomy, cached for the session.
// The selector only offers devices that already have a pack on disk (mark_donor
// requires the slug to exist); readiness (parts_index) is shown per row.
let _deviceEntries = null;

// Inline SVGs for the device picker rows — a board glyph (leading) and the
// selection tick (revealed by CSS on the selected row). 16×16, currentColor.
const _AD_BOARD_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h4M7 12h4M7 16h2"/><circle cx="16.5" cy="13" r="2.4"/></svg>`;
const _AD_CHECK_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

async function loadDeviceEntries() {
  if (_deviceEntries) return _deviceEntries;
  const tax = await apiGet("/pipeline/taxonomy");
  const entries = [];
  for (const [brand, models] of Object.entries(tax.brands || {})) {
    for (const [model, packs] of Object.entries(models)) {
      for (const p of packs) entries.push({ ...p, brand, model });
    }
  }
  for (const p of tax.uncategorized || []) entries.push({ ...p, brand: null, model: null });
  _deviceEntries = entries;
  return entries;
}

// lowercase, strip accents, collapse to single spaces — case/accent-agnostic match.
function _normalize(s) {
  return (s || "").toString().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

// Human label for a device_kind; falls back to the raw kind when no i18n key.
function _kindLabel(kind) {
  const key = `stock.kind_${kind}`;
  const lab = t(key);
  return lab === key ? kind : lab;
}

async function showAddDonorDialog() {
  let entries;
  let loadError = false;
  try {
    entries = await loadDeviceEntries();
  } catch {
    // A lapsed session (or any taxonomy failure) used to leave the picker
    // silently empty. Flag it so the list reports the failure instead.
    entries = [];
    loadError = true;
  }

  // Everything the user typed or picked lives here (not only in the DOM), so
  // paint() can rebuild the panel in another language without losing it.
  const state = {
    kind: "", brand: "", query: "", slug: null, label: null,
    labelText: "",          // donor label field
    labelAuto: true,        // label still is our own suggestion (re-suggested on repaint)
    condition: "donor_only",
    error: null,            // () => message, re-evaluated in the current language
  };

  // Labels shared by >1 pack (e.g. a bench/variant pack with the same human
  // label but a different slug). For those, show the slug to disambiguate.
  const _labelCounts = {};
  for (const e of entries) {
    const k = _normalize(e.device_label);
    _labelCounts[k] = (_labelCounts[k] || 0) + 1;
  }
  const isDuplicateLabel = (e) => _labelCounts[_normalize(e.device_label)] > 1;

  const overlay = document.createElement("div");
  overlay.className = "add-donor-overlay";
  // Assigned by paint() — the panel's DOM is rebuilt on a language switch.
  let kindSel, brandSel, searchInput, resultsEl, labelInput, conditionSel, submitBtn, errorEl;
  let submitting = false;

  function paint() {
    const scrollTop = overlay.querySelector("#dn-results")?.scrollTop || 0;
    overlay.innerHTML = `
    <div class="add-donor-panel glass">
      <header class="add-donor-head">
        <div class="add-donor-head-text">
          <h3>${t("stock.add_donor_title")}</h3>
          <p class="add-donor-sub">${t("stock.add_donor_subtitle")}</p>
        </div>
        <button class="dn-close" data-close aria-label="${t("stock.close")}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
               stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
        </button>
      </header>
      <div class="add-donor-body">
        <div class="add-donor-filters">
          <label class="add-donor-field">
            <span class="add-donor-lbl">${t("stock.field_kind")}</span>
            <select id="dn-kind"></select>
          </label>
          <label class="add-donor-field">
            <span class="add-donor-lbl">${t("stock.field_brand")}</span>
            <select id="dn-brand"></select>
          </label>
        </div>
        <label class="add-donor-field">
          <span class="add-donor-lbl">${t("stock.field_device")}</span>
          <span class="dn-search-wrap">
            <svg class="dn-search-icon" viewBox="0 0 24 24" width="15" height="15" fill="none"
                 stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
            </svg>
            <input id="dn-search" type="search" autocomplete="off"
                   placeholder="${t("stock.search_device_placeholder")}">
          </span>
        </label>
        <div class="add-donor-results" id="dn-results"></div>
        <div class="add-donor-row">
          <label class="add-donor-field grow">
            <span class="add-donor-lbl">${t("stock.field_label")}</span>
            <input id="dn-label" type="text" autocomplete="off">
          </label>
          <label class="add-donor-field">
            <span class="add-donor-lbl">${t("stock.field_condition")}</span>
            <select id="dn-condition">
              <option value="donor_only">${t("stock.condition_donor_only")}</option>
              <option value="potentially_repairable">${t("stock.condition_repairable")}</option>
            </select>
          </label>
        </div>
        <div class="add-donor-error" id="dn-error" hidden></div>
      </div>
      <footer class="add-donor-foot">
        <span class="dn-selection" id="dn-selection">${t("stock.nothing_selected")}</span>
        <div class="dn-foot-actions">
          <button class="btn-sm" data-close>${t("stock.cancel")}</button>
          <button class="btn-primary" id="dn-submit" disabled>${t("stock.create")}</button>
        </div>
      </footer>
    </div>
  `;
    kindSel = overlay.querySelector("#dn-kind");
    brandSel = overlay.querySelector("#dn-brand");
    searchInput = overlay.querySelector("#dn-search");
    resultsEl = overlay.querySelector("#dn-results");
    labelInput = overlay.querySelector("#dn-label");
    conditionSel = overlay.querySelector("#dn-condition");
    submitBtn = overlay.querySelector("#dn-submit");
    errorEl = overlay.querySelector("#dn-error");

    // Board-type options from the kinds actually present in the taxonomy.
    kindSel.innerHTML = `<option value="">${escapeHtml(t("stock.all_kinds"))}</option>`
      + kindsPresent.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(_kindLabel(k))}</option>`).join("");
    kindSel.value = state.kind;
    rebuildBrands();
    searchInput.value = state.query;
    // An untouched suggestion carries a translated suffix — refresh it; a label
    // the user edited is theirs and is restored verbatim.
    if (state.slug && state.labelAuto) state.labelText = suggestLabel(state.label);
    labelInput.value = state.labelText;
    conditionSel.value = state.condition;
    submitBtn.disabled = submitting || !state.slug;
    if (state.slug) {
      const sel = overlay.querySelector("#dn-selection");
      sel.textContent = state.label;
      sel.classList.add("active");
    }
    if (state.error) { errorEl.textContent = state.error(); errorEl.hidden = false; }
    renderResults();
    resultsEl.scrollTop = scrollTop;
    wire();
  }

  const kindsPresent = [...new Set(entries.map(e => e.device_kind).filter(k => k && k !== "unknown"))].sort();

  function rebuildBrands() {
    const pool = entries.filter(e => !state.kind || e.device_kind === state.kind);
    const brands = [...new Set(pool.map(e => e.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    brandSel.innerHTML = `<option value="">${escapeHtml(t("stock.all_brands"))}</option>`
      + brands.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join("");
    if (state.brand && !brands.includes(state.brand)) state.brand = "";
    brandSel.value = state.brand;
  }

  function matches() {
    const qn = _normalize(state.query);
    const qInline = qn.replace(/ /g, "");
    const qTokens = qn.split(" ").filter(Boolean);
    return entries.filter(e => {
      if (state.kind && e.device_kind !== state.kind) return false;
      if (state.brand && e.brand !== state.brand) return false;
      if (!qn) return true;
      const hay = _normalize(
        [e.device_label, e.device_slug, e.brand, e.model, e.version, e.form_factor].filter(Boolean).join(" ")
      );
      if (hay.includes(qn)) return true;
      if (qInline && hay.replace(/ /g, "").includes(qInline)) return true;
      return qTokens.every(tk => hay.includes(tk));
    }).sort((a, b) => a.device_label.localeCompare(b.device_label));
  }

  function renderResults() {
    const rows = matches();
    if (!rows.length) {
      const msg = loadError ? t("stock.devices_error") : t("stock.no_devices");
      resultsEl.innerHTML = `<div class="add-donor-empty${loadError ? " dn-error-state" : ""}">${escapeHtml(msg)}</div>`;
      return;
    }
    resultsEl.innerHTML = rows.slice(0, 60).map(e => {
      const badge = e.has_parts_index
        ? `<span class="dn-badge ready">✓ ${escapeHtml(t("stock.graph_ready"))}</span>`
        : `<span class="dn-badge pending">${escapeHtml(t("stock.graph_pending"))}</span>`;
      const meta = [
        isDuplicateLabel(e) ? e.device_slug : null,
        e.brand, e.version, e.form_factor,
      ].filter(Boolean).join(" · ");
      return `
        <button type="button" class="dn-option${state.slug === e.device_slug ? " selected" : ""}"
                data-slug="${escapeHtml(e.device_slug)}" data-label="${escapeHtml(e.device_label)}">
          <span class="dn-option-icon">${_AD_BOARD_ICON}</span>
          <span class="dn-option-main">
            <span class="dn-option-label">${escapeHtml(e.device_label)}</span>
            ${meta ? `<span class="dn-option-meta mono">${escapeHtml(meta)}</span>` : ""}
          </span>
          ${badge}
          <span class="dn-option-check">${_AD_CHECK_ICON}</span>
        </button>
      `;
    }).join("");
  }

  function suggestLabel(deviceLabel) {
    const date = new Date().toISOString().slice(0, 10);
    return `${deviceLabel} · ${t("stock.label_donor_suffix")} ${date}`;
  }

  function selectDevice(slug, label) {
    state.slug = slug;
    state.label = label;
    state.labelText = suggestLabel(label);
    state.labelAuto = true;
    state.error = null;
    labelInput.value = state.labelText;
    submitBtn.disabled = false;
    errorEl.hidden = true;
    const sel = overlay.querySelector("#dn-selection");
    if (sel) { sel.textContent = label; sel.classList.add("active"); }
    renderResults();
  }

  // `msgFn` (not a string) so an error still on screen follows a language switch.
  function showError(msgFn) {
    state.error = msgFn;
    errorEl.textContent = msgFn();
    errorEl.hidden = false;
  }

  let stopLocaleRepaint = () => {};
  function close() {
    document.removeEventListener("keydown", onKey);
    stopLocaleRepaint();
    overlay.remove();
  }
  function onKey(ev) {
    if (ev.key === "Escape") close();
  }

  // Handlers for the nodes paint() just created.
  function wire() {
    kindSel.onchange = () => { state.kind = kindSel.value; rebuildBrands(); renderResults(); };
    brandSel.onchange = () => { state.brand = brandSel.value; renderResults(); };
    searchInput.oninput = () => { state.query = searchInput.value; renderResults(); };
    labelInput.oninput = () => { state.labelText = labelInput.value; state.labelAuto = false; };
    conditionSel.onchange = () => { state.condition = conditionSel.value; };
    resultsEl.onclick = (ev) => {
      const opt = ev.target.closest(".dn-option");
      if (opt) selectDevice(opt.dataset.slug, opt.dataset.label);
    };
    overlay.querySelectorAll("[data-close]").forEach(b => { b.onclick = close; });
    submitBtn.onclick = submit;
  }

  async function submit() {
    if (!state.slug) { showError(() => t("stock.select_device_first")); return; }
    submitting = true;
    submitBtn.disabled = true;
    try {
      await fetchJson("/donors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_slug: state.slug,
          label: state.labelText.trim() || state.label,
          condition: state.condition,
        }),
      });
      close();
      await loadDonors();
    } catch (e) {
      submitting = false;
      submitBtn.disabled = false;
      showError(() => t("stock.create_error", { error: errorText(e) }));
    }
  }

  document.body.appendChild(overlay);
  paint();
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
  document.addEventListener("keydown", onKey);
  stopLocaleRepaint = repaintOnLocaleChange(overlay, paint);
  requestAnimationFrame(() => searchInput.focus());
}

// Donor cards and search results are rendered imperatively through t() —
// repaint them when the user switches language. Open overlays (harvest,
// add-donor) subscribe on their own — see repaintOnLocaleChange().
let _localeHookWired = false;
function wireStockI18n() {
  if (_localeHookWired) return;
  _localeHookWired = true;
  onChange(() => {
    const section = document.getElementById("stock");
    if (!section || section.classList.contains("hidden")) return;
    loadDonors();
    if (_lastSearch) renderSearchResults(_lastSearch);
  });
}

export function initStockSection() {
  wireStockI18n();
  document.getElementById("stock-search-btn").onclick = runSearch;
  document.getElementById("stock-add-donor-btn").onclick = showAddDonorDialog;
  const back = document.getElementById("stock-back-btn");
  if (back) back.onclick = () => { window.location.hash = "#home"; };
  // "?" explainer — always available; also auto-opens on the first visit.
  const info = document.getElementById("stock-info-btn");
  if (info) info.onclick = () => openInfoModal("stock");
  try {
    if (!localStorage.getItem(STOCK_INFO_FLAG)) {
      localStorage.setItem(STOCK_INFO_FLAG, "1");
      openInfoModal("stock");
    }
  } catch { /* private mode — skip the one-shot */ }
  loadDonors();
}
