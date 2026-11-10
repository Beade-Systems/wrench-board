import { apiFetch } from './shared/api.js';
import { auditMessage, describeServerError } from './pcb_library_errors.js';
// Falls back to the English literal when i18n is absent or dictionaries aren't loaded.
const fill = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text);
const tr = (key, fallback, params) => {
  const translate = window.i18n?.t ?? window.t;
  const text = typeof translate === 'function' ? translate(key, params) : key;
  return text === key ? fill(fallback, params) : text;
};
const STATUS_FALLBACK = {idle:'Ready',running:'Running',complete:'Complete',cancelled:'Stopped',ok:'OK',error:'Error',key_missing:'Key missing',unsupported:'Not supported',incomplete:'Incomplete',timeout:'Timed out',too_large:'Too large'};
const statusLabel = status => (STATUS_FALLBACK[status] ? tr(`library.settings.audit.status.${status}`, STATUS_FALLBACK[status]) : status);
const $ = id => document.getElementById(id);
let folders = [], directory = '', timer;
// Last server answers and notice, kept so a locale switch can re-render them.
let configured = null, audit = null, formats = null, formatsError = '', lastNotice = null;

/** Translates the first text node of `[data-i18n-node]` elements, leaving child elements alone. */
function applyTextNodes() {
  document.querySelectorAll('[data-i18n-node]').forEach(host => {
    const key = host.getAttribute('data-i18n-node');
    const target = [...host.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.nodeValue.trim());
    const text = tr(key, '');
    if (!target || !text) return;
    const [, lead, tail] = target.nodeValue.match(/^(\s*)[\s\S]*?(\s*)$/);
    target.nodeValue = `${lead}${text}${tail}`;
  });
}
async function api(path = '', options = {}) {
  const response = await apiFetch(`/api/workbench/settings${path}`, { ...options, headers: { 'X-Workbench-Settings': '1', 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json().catch(() => null);
  const generic = tr('library.settings.error_generic', 'The settings could not be processed.');
  if (!response.ok || !body) throw new Error(describeServerError(body, generic));
  return body;
}
/** @param {string|(() => string)} message a function is re-evaluated on locale switches */
function notice(message) { lastNotice = typeof message === 'function' ? message : null; $('status').textContent = lastNotice ? lastNotice() : message; }
function renderFolders(active = $('active-folder').value) {
  $('folders').replaceChildren(); $('active-folder').replaceChildren(new Option(tr('library.settings.folders.none', 'None'), ''));
  for (const path of folders) {
    const row = document.createElement('div'); row.className = 'folder-entry';
    const label = document.createElement('span'); label.textContent = path;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = tr('library.settings.folders.remove', 'Remove');
    remove.onclick = () => { folders = folders.filter(p => p !== path); renderFolders(active === path ? '' : active); };
    row.append(label, remove); $('folders').append(row); $('active-folder').add(new Option(path, path));
  }
  $('active-folder').value = active;
}
function show(data) {
  $('allegro-heap').value = data.allegro_heap_mb;
  folders = data.folders; renderFolders(data.active_folder);
  $('model-main').value = data.anthropic_model_main; $('model-fast').value = data.anthropic_model_fast;
  configured = data.configured; renderKeyStates();
  for (const id of ['fz', 'xzz', 'api']) { $(`${id}-key`).value = ''; $(`clear-${id}`).checked = false; }
}
function renderKeyStates() {
  if (!configured) return;
  for (const [id, key] of [['fz','fz_key'],['xzz','xzz_key'],['api','anthropic_api_key']]) {
    $(`${id}-state`).textContent = configured[key] ? tr('library.settings.keys.state_present', '✓ stored')
      : (id === 'xzz' ? tr('library.settings.keys.state_default', 'Default active') : tr('library.settings.keys.state_missing', 'Not set up'));
  }
}
$('add-folder').onclick = () => { const path = $('folder-path').value.trim(); if (path && !folders.includes(path)) folders.push(path); renderFolders($('active-folder').value || path); };
$('settings-form').onsubmit = async event => {
  event.preventDefault();
  const data = { allegro_heap_mb: Number($('allegro-heap').value), folders, active_folder: $('active-folder').value, anthropic_model_main: $('model-main').value, anthropic_model_fast: $('model-fast').value };
  for (const [id,key] of [['fz','fz_key'],['xzz','xzz_key'],['api','anthropic_api_key']]) {
    if ($(`clear-${id}`).checked) data[key] = ''; else if ($(`${id}-key`).value.trim()) data[key] = $(`${id}-key`).value.trim();
  }
  try { show(await api('', {method:'PUT', body:JSON.stringify(data)})); notice(() => tr('library.settings.saved', 'Saved. The library now uses the active collection.')); }
  catch (error) { notice(error.message); }
};
$('fetch-fz').onclick = async () => { $('fetch-fz').disabled = true; try { const data = await api('/fz-key', {method:'POST'}); $('fz-key').value = data.key; $('clear-fz').checked = false; notice(() => tr('library.settings.keys.fetched', 'Key fetched. Now save the settings.')); } catch(error) { notice(error.message); } finally { $('fetch-fz').disabled = false; } };
async function browse(path) {
  try {
    const data = await api(`/directories?path=${encodeURIComponent(path)}`); directory = data.path; $('directory-current').textContent = directory;
    $('directories').replaceChildren(); $('directory-up').onclick = () => browse(data.parent);
    for (const path of data.directories) { const button = document.createElement('button'); button.textContent = path.split('/').pop(); button.onclick = () => browse(path); $('directories').append(button); }
    if (!$('directory-dialog').open) $('directory-dialog').showModal();
  } catch (error) { notice(error.message); }
}
$('browse').onclick = () => browse($('folder-path').value);
$('directory-close').onclick = () => $('directory-dialog').close();
$('directory-pick').onclick = () => { $('folder-path').value = directory; $('add-folder').click(); $('directory-dialog').close(); };
async function poll() {
  clearTimeout(timer);
  try { const data = await api('/audit'); const running = data.state === 'running';
    $('audit-start').disabled = running; $('audit-cancel').disabled = !running;
    audit = data; renderAudit();
    if (running) timer = setTimeout(poll, 1500);
  } catch(error) { notice(error.message); }
}
function renderAudit() {
  if (!audit) return;
  const parts = [statusLabel(audit.state), tr('library.settings.audit.checked', '{count} checked', { count: audit.checked }),
    ...Object.entries(audit.counts).map(([k,v]) => `${statusLabel(k)}: ${v}`)];
  if (audit.current) parts.push(audit.current);
  $('audit-status').textContent = parts.join(' · ');
  $('audit-results').textContent = audit.recent.map(r => `${statusLabel(r.status)}: ${r.file}${r.message ? ` — ${auditMessage(r)}` : ''}`).join('\n');
}
$('audit-start').onclick = async () => { try { await api('/audit', {method:'POST', body:JSON.stringify({folder:$('audit-folder').value,limit:Number($('audit-limit').value)})}); poll(); } catch(error) { notice(error.message); } };
$('audit-cancel').onclick = async () => { try { const data = await api('/audit/cancel', {method:'POST'}); notice(() => auditMessage(data)); } catch(error) { notice(error.message); } };
$('audit-download').onclick = async () => { try { const data = await api('/audit/report'); const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)], {type:'application/json'})); const a = document.createElement('a'); a.href=url; a.download=tr('library.settings.audit.report_filename', 'wrench-board-import-report.json'); a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); } catch(error) { notice(error.message); } };
api().then(show).catch(error => notice(error.message)); poll();

function renderFormats() {
  if (!formats && !formatsError) return;
  // From here on this module owns the line; applyDom() must not reset it.
  $('format-status').removeAttribute('data-i18n');
  $('format-status').textContent = formatsError || `KiCad: ${formats.kicad || tr('library.settings.formats.unavailable', 'not available')}. `
    + Object.entries(formats.native).map(([name,available]) => `${name}: ${available ? tr('library.settings.formats.available', 'available') : tr('library.settings.formats.importer_missing', 'importer missing')}`).join(' · ');
}
api('/formats').then(data => { formats = data; renderFormats(); }).catch(error => { formatsError = error.message; renderFormats(); });

// Language switch: an explicit choice persists for every page of this origin.
$('language').value = window.i18n?.locale || 'en';
$('language').onchange = () => window.i18n?.setLocale?.($('language').value);
$('language').disabled = !window.i18n;

/** Re-renders everything this module wrote, once dictionaries load and on every locale switch. */
function relocalize() {
  applyTextNodes();
  $('language').value = window.i18n?.locale || 'en';
  renderFolders(); renderKeyStates(); renderAudit(); renderFormats();
  if (lastNotice) $('status').textContent = lastNotice();
}
window.i18n?.onReady?.(relocalize);
window.i18n?.onChange?.(relocalize);
