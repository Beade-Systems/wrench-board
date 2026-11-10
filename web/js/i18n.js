// i18n core — vanilla, no build step.
//
// Loads per-module JSON dictionaries from /i18n/_modules/{module}.{lang}.json
// and exposes a global `i18n` API. Locales: English, German. New locales = drop a
// `_modules/{module}.{lang}.json` alongside the existing ones, add the lang to
// SUPPORTED, and seed an empty bucket in `dicts`.
//
// Public API:
//   i18n.t(key, params?)       → translated string, params interpolate {name}
//   i18n.locale                → current 'en' | 'de'
//   i18n.intlTag               → BCP-47 tag for Intl date/number formatting
//   i18n.setLocale(lang, opts?) → switch + persist + re-apply DOM. Counts as an
//                                explicit user choice on this device unless
//                                opts.explicit === false (e.g. a value synced
//                                from the stored profile).
//   i18n.hasExplicitChoice     → true once the user picked a language here
//   i18n.applyDom(root?)       → re-translate `[data-i18n]` / `[data-i18n-attr]`
//   i18n.ready                 → Promise resolved once first dictionary loaded
//   i18n.onReady(fn)           → run fn once dictionaries are loaded
//   i18n.onChange(fn)          → notify on locale switch (re-render hook)
//
// Locale resolution order: ?lang= → explicit choice made on this device →
// browser languages → last persisted locale → English. A persisted English
// value without the explicit marker is ambiguous (English is also the profile
// schema default), so the browser languages outrank it.
//
// Single instance: this file is imported under more than one URL (bare and
// with a `?v=` cache-bust), and the browser evaluates each URL as its own
// module. Every copy after the first re-exports the first copy's API instead
// of booting a second dictionary set with its own locale state.
import { apiFetch } from "./shared/api.js";

const SUPPORTED = ['en', 'de'];
const DEFAULT_LOCALE = 'en';
const STORAGE_KEY = 'wb.locale';
const EXPLICIT_KEY = 'wb.locale.explicit';
const INTL_TAGS = { en: 'en-US', de: 'de-DE' };

// Static module list — keep alphabetic. Each entry expects one file per
// supported locale: web/i18n/_modules/{name}.en.json
const MODULES = [
  'brd',
  'camera',
  'chat',
  'common',
  'graph',
  'home',
  'intro',
  'landing',
  'library',
  'mascot',
  'memory_bank',
  'onboarding',
  'pcb',
  'pipeline',
  'profile',
  'protocol',
  'repair',
  'router',
  'schematic',
  'stock',
  'workbench',
];

const dicts = { en: {}, de: {} };
const changeListeners = new Set();
let currentLocale = pickInitialLocale();
let readyResolve;
const ready = new Promise((res) => { readyResolve = res; });

function hasExplicitChoice() {
  try { return localStorage.getItem(EXPLICIT_KEY) === '1'; } catch { return false; }
}

function pickInitialLocale() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('lang');
  if (fromUrl && SUPPORTED.includes(fromUrl)) return fromUrl;
  let stored = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && SUPPORTED.includes(raw)) stored = raw;
  } catch {}
  // A language the user picked on this device always wins. A persisted
  // non-default locale is honoured too: it can only come from a real choice.
  if (stored && (hasExplicitChoice() || stored !== DEFAULT_LOCALE)) return stored;
  // No explicit choice: match the browser's preferred languages. Falls
  // through to the persisted value, then English, when nothing matches.
  try {
    const navLangs = navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language];
    for (const tag of navLangs) {
      if (!tag) continue;
      const base = tag.toLowerCase().split('-')[0];
      if (SUPPORTED.includes(base)) return base;
    }
  } catch {}
  return stored || DEFAULT_LOCALE;
}

async function loadModule(name, lang) {
  try {
    const res = await apiFetch(`/i18n/_modules/${name}.${lang}.json`, { cache: 'no-cache' });
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

async function loadLocale(lang) {
  const merged = {};
  const results = await Promise.all(MODULES.map((m) => loadModule(m, lang)));
  for (let i = 0; i < MODULES.length; i++) {
    const ns = MODULES[i];
    merged[ns] = results[i] || {};
  }
  dicts[lang] = merged;
}

function lookup(key, lang) {
  const dict = dicts[lang];
  if (!dict) return undefined;
  const parts = key.split('.');
  let node = dict;
  for (const p of parts) {
    if (node && typeof node === 'object' && p in node) node = node[p];
    else return undefined;
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(tpl, params) {
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}

function t(key, params) {
  let val = lookup(key, currentLocale);
  if (val === undefined && currentLocale !== DEFAULT_LOCALE) {
    val = lookup(key, DEFAULT_LOCALE);
  }
  if (val === undefined) return key; // visible fallback for missing keys
  return interpolate(val, params);
}

function applyDom(root) {
  const scope = root || document;
  // Text content
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (!key) return;
    const val = t(key);
    if (el.dataset.i18nHtml === '1') el.innerHTML = val;
    else el.textContent = val;
  });
  // Attributes: data-i18n-attr="placeholder:chat.input.placeholder,title:chat.input.title"
  scope.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    const spec = el.getAttribute('data-i18n-attr');
    if (!spec) return;
    spec.split(',').forEach((pair) => {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (!attr || !key) return;
      el.setAttribute(attr, t(key));
    });
  });
  // <html lang="…">
  if (document.documentElement) document.documentElement.setAttribute('lang', currentLocale);
}

async function setLocale(lang, opts) {
  if (!SUPPORTED.includes(lang)) return;
  if (!opts || opts.explicit !== false) {
    try {
      localStorage.setItem(EXPLICIT_KEY, '1');
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {}
  }
  if (lang === currentLocale && Object.keys(dicts[lang] || {}).length) return;
  currentLocale = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
  if (!Object.keys(dicts[lang] || {}).length) await loadLocale(lang);
  applyDom();
  for (const fn of changeListeners) {
    try { fn(currentLocale); } catch (e) { console.error('[i18n] listener error', e); }
  }
}

function onChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); }
function onReady(fn) { ready.then(fn); }

async function init() {
  // The active locale and the English fallback load side by side. The locale
  // is re-read after the await: a setLocale() issued meanwhile must not be
  // painted over with the boot locale.
  const bootLocale = currentLocale;
  const wanted = bootLocale === DEFAULT_LOCALE ? [bootLocale] : [bootLocale, DEFAULT_LOCALE];
  await Promise.all(wanted.map((lang) => loadLocale(lang)));
  if (currentLocale !== bootLocale && !Object.keys(dicts[currentLocale] || {}).length) {
    await loadLocale(currentLocale);
  }
  applyDom();
  readyResolve();
}

const ownApi = { t, applyDom, setLocale, onChange, onReady, ready, get locale() { return currentLocale; }, get intlTag() { return INTL_TAGS[currentLocale] || INTL_TAGS[DEFAULT_LOCALE]; }, get hasExplicitChoice() { return hasExplicitChoice(); }, SUPPORTED, isI18nCore: true };

// First copy to evaluate owns the state; later copies delegate to it.
const prior = window.i18n && window.i18n.isI18nCore ? window.i18n : null;
const api = prior || ownApi;

if (!prior) {
  window.i18n = api;
  window.t = t; // global shortcut for convenience inside JS files
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}

const { t: tShared, applyDom: applyDomShared, setLocale: setLocaleShared, onChange: onChangeShared, onReady: onReadyShared } = api;

export default api;
export {
  tShared as t,
  applyDomShared as applyDom,
  setLocaleShared as setLocale,
  onChangeShared as onChange,
  onReadyShared as onReady,
};
