import {store} from './offline_store.js';
import {LibraryViewer} from './pcb_library_viewer.js';

// This page must work without network, and the service worker caches neither
// i18n.js nor the dictionaries, so its strings ship inline. The keys mirror
// web/i18n/_modules/library.*.json; keep both in step.
const STRINGS = {
  en: {
    'library.offline.page_title': 'Offline boards · Wrench Board',
    'library.offline.header': 'Offline boards',
    'library.offline.heading': 'Your saved boards',
    'library.offline.intro': 'These copies live in this browser. New original files and AI diagnostics need the backend.',
    'library.offline.board': 'Board',
    'library.offline.remove': 'Delete offline copy',
    'library.offline.fit': 'Fit',
    'library.offline.side_aria': 'Board side',
    'library.offline.side_both': 'Both sides',
    'library.offline.side_top': 'Top side',
    'library.offline.side_bottom': 'Bottom side',
    'library.offline.search': 'Find component',
    'library.offline.search_placeholder': 'For example U1',
    'library.offline.canvas_aria': 'Offline board view',
    'library.offline.status': '{parts} components · {pins} pins · saved {date}',
    'library.offline.empty': 'No board saved yet. Open a board while online and choose “Save offline”.',
    'library.offline.error_storage': 'Offline storage is not available.',
    'library.offline.error_insecure': 'Offline use requires HTTPS or localhost.',
    'library.offline.error_prepare': 'The offline files could not be prepared.',
    'library.viewer.pane_top': 'Top side',
    'library.viewer.pane_bottom': 'Bottom side',
    'library.viewer.pane_mirrored': 'mirrored',
  },
  de: {
    'library.offline.page_title': 'Offline-Platinen · Wrench Board',
    'library.offline.header': 'Offline-Platinen',
    'library.offline.heading': 'Deine gespeicherten Platinen',
    'library.offline.intro': 'Diese Kopien liegen in diesem Browser. Neue Originaldateien und KI-Diagnosen benötigen das Backend.',
    'library.offline.board': 'Platine',
    'library.offline.remove': 'Offline-Kopie löschen',
    'library.offline.fit': 'Einpassen',
    'library.offline.side_aria': 'Platinenseite',
    'library.offline.side_both': 'Beide Seiten',
    'library.offline.side_top': 'Oberseite',
    'library.offline.side_bottom': 'Unterseite',
    'library.offline.search': 'Bauteil suchen',
    'library.offline.search_placeholder': 'Zum Beispiel U1',
    'library.offline.canvas_aria': 'Offline-Platinenansicht',
    'library.offline.status': '{parts} Bauteile · {pins} Pins · gespeichert {date}',
    'library.offline.empty': 'Noch keine Platine gespeichert. Öffne online eine Platine und wähle „Offline speichern“.',
    'library.offline.error_storage': 'Offline-Speicher nicht verfügbar.',
    'library.offline.error_insecure': 'Offline-Nutzung benötigt HTTPS oder localhost.',
    'library.offline.error_prepare': 'Offline-Dateien konnten nicht vorbereitet werden.',
    'library.viewer.pane_top': 'Oberseite',
    'library.viewer.pane_bottom': 'Unterseite',
    'library.viewer.pane_mirrored': 'gespiegelt',
  },
};
const INTL_TAGS = { en: 'en-US', de: 'de-DE' };

/** Same resolution order as i18n.js: ?lang= → explicit choice → browser → stored → English. */
function pickLocale() {
  const supported = Object.keys(STRINGS);
  const fromUrl = new URLSearchParams(window.location.search).get('lang');
  if (supported.includes(fromUrl)) return fromUrl;
  let stored = null, explicit = false;
  try {
    const raw = localStorage.getItem('wb.locale');
    if (supported.includes(raw)) stored = raw;
    explicit = localStorage.getItem('wb.locale.explicit') === '1';
  } catch { /* storage blocked: fall through to the browser languages */ }
  if (stored && (explicit || stored !== 'en')) return stored;
  for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const base = String(tag || '').toLowerCase().split('-')[0];
    if (supported.includes(base)) return base;
  }
  return stored || 'en';
}

const locale = pickLocale();
const t = (key, params) => {
  const text = STRINGS[locale][key] ?? STRINGS.en[key];
  if (text === undefined) return key;
  return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text;
};
// The viewer and the store translate through window.i18n; this stand-in serves them here.
window.i18n ??= { t, locale, intlTag: INTL_TAGS[locale], onReady: fn => fn(), onChange: () => () => {} };

function applyDom() {
  document.documentElement.lang = locale;
  document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll('[data-i18n-attr]').forEach(node => {
    for (const pair of node.dataset.i18nAttr.split(',')) {
      const [attr, key] = pair.split(':').map(part => part.trim());
      if (attr && key) node.setAttribute(attr, t(key));
    }
  });
  // Labels that wrap a control: only their leading text node is translated.
  document.querySelectorAll('[data-i18n-node]').forEach(host => {
    const target = [...host.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.nodeValue.trim());
    if (target) target.nodeValue = t(host.dataset.i18nNode);
  });
}
applyDom();

const $ = id => document.getElementById(id);
let boards = [];
const viewer = new LibraryViewer($('canvas'), selected => { $('selection').textContent = selected ? JSON.stringify(selected,null,2) : ''; });
function show() {
  const entry = boards.find(b=>b.id===$('boards').value); viewer.load(entry?.board || null);
  $('offline-status').textContent = entry
    ? t('library.offline.status', { parts: entry.board.parts.length, pins: entry.board.pins.length, date: new Date(entry.saved).toLocaleString(INTL_TAGS[locale]) })
    : t('library.offline.empty');
}
async function refresh() { try {boards=await store('list'); $('boards').replaceChildren(...boards.map(b=>new Option(b.name,b.id)));show();}catch(error){$('offline-status').textContent=error.message;} }
$('boards').onchange=show;
$('remove').onclick=async()=>{await store('delete',$('boards').value);refresh();};
$('fit').onclick=()=>viewer.fit();
$('side').onchange=()=>viewer.setView({ ...viewer.getView(), side:Number($('side').value) });
$('search').oninput=()=>{const board=boards.find(b=>b.id===$('boards').value)?.board;const part=board?.parts.find(p=>p.refdes.toLowerCase()===$('search').value.trim().toLowerCase());if(part) viewer.select({kind:'part', item:part}, true);};
refresh();
