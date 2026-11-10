import { apiFetch } from './shared/api.js';
const labels = {idle:'Bereit',running:'Läuft',complete:'Abgeschlossen',cancelled:'Gestoppt',ok:'Erfolgreich',error:'Fehler',key_missing:'Schlüssel fehlt',unsupported:'Nicht unterstützt',incomplete:'Unvollständig',timeout:'Zeitlimit',too_large:'Zu groß'};
const $ = id => document.getElementById(id);
let folders = [], directory = '', timer;
async function api(path = '', options = {}) {
  const response = await apiFetch(`/api/workbench/settings${path}`, { ...options, headers: { 'X-Workbench-Settings': '1', 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Einstellungen konnten nicht verarbeitet werden.');
  return body;
}
function notice(message) { $('status').textContent = message; }
function renderFolders(active = $('active-folder').value) {
  $('folders').replaceChildren(); $('active-folder').replaceChildren(new Option('Keine', ''));
  for (const path of folders) {
    const row = document.createElement('div'); row.className = 'folder-entry';
    const label = document.createElement('span'); label.textContent = path;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Entfernen';
    remove.onclick = () => { folders = folders.filter(p => p !== path); renderFolders(active === path ? '' : active); };
    row.append(label, remove); $('folders').append(row); $('active-folder').add(new Option(path, path));
  }
  $('active-folder').value = active;
}
function show(data) {
  $('allegro-heap').value = data.allegro_heap_mb;
  folders = data.folders; renderFolders(data.active_folder);
  $('model-main').value = data.anthropic_model_main; $('model-fast').value = data.anthropic_model_fast;
  for (const [id, key] of [['fz','fz_key'],['xzz','xzz_key'],['api','anthropic_api_key']]) {
    $(`${id}-state`).textContent = data.configured[key] ? '✓ vorhanden' : (id === 'xzz' ? 'Standard aktiv' : 'Nicht eingerichtet');
    $(`${id}-key`).value = ''; $(`clear-${id}`).checked = false;
  }
}
$('add-folder').onclick = () => { const path = $('folder-path').value.trim(); if (path && !folders.includes(path)) folders.push(path); renderFolders($('active-folder').value || path); };
$('settings-form').onsubmit = async event => {
  event.preventDefault();
  const data = { allegro_heap_mb: Number($('allegro-heap').value), folders, active_folder: $('active-folder').value, anthropic_model_main: $('model-main').value, anthropic_model_fast: $('model-fast').value };
  for (const [id,key] of [['fz','fz_key'],['xzz','xzz_key'],['api','anthropic_api_key']]) {
    if ($(`clear-${id}`).checked) data[key] = ''; else if ($(`${id}-key`).value.trim()) data[key] = $(`${id}-key`).value.trim();
  }
  try { show(await api('', {method:'PUT', body:JSON.stringify(data)})); notice('Gespeichert. Die Bibliothek verwendet jetzt die aktive Sammlung.'); }
  catch (error) { notice(error.message); }
};
$('fetch-fz').onclick = async () => { $('fetch-fz').disabled = true; try { const data = await api('/fz-key', {method:'POST'}); $('fz-key').value = data.key; $('clear-fz').checked = false; notice('Schlüssel geladen. Bitte Einstellungen speichern.'); } catch(error) { notice(error.message); } finally { $('fetch-fz').disabled = false; } };
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
    $('audit-status').textContent = `${labels[data.state] || data.state} · ${data.checked} geprüft · ${Object.entries(data.counts).map(([k,v]) => `${labels[k] || k}: ${v}`).join(' · ')}${data.current ? ` · ${data.current}` : ''}`;
    $('audit-results').textContent = data.recent.map(r => `${labels[r.status] || r.status}: ${r.file}${r.message ? ` — ${r.message}` : ''}`).join('\n');
    if (running) timer = setTimeout(poll, 1500);
  } catch(error) { notice(error.message); }
}
$('audit-start').onclick = async () => { try { await api('/audit', {method:'POST', body:JSON.stringify({folder:$('audit-folder').value,limit:Number($('audit-limit').value)})}); poll(); } catch(error) { notice(error.message); } };
$('audit-cancel').onclick = async () => { try { const data = await api('/audit/cancel', {method:'POST'}); notice(data.message); } catch(error) { notice(error.message); } };
$('audit-download').onclick = async () => { try { const data = await api('/audit/report'); const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)], {type:'application/json'})); const a = document.createElement('a'); a.href=url; a.download='wrench-board-importbericht.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); } catch(error) { notice(error.message); } };
api().then(show).catch(error => notice(error.message)); poll();

api('/formats').then(data => { $('format-status').textContent = `KiCad: ${data.kicad || 'nicht verfügbar'}. ` + Object.entries(data.native).map(([name,available]) => `${name}: ${available ? 'verfügbar' : 'Importer fehlt'}`).join(' · '); }).catch(error=>{$('format-status').textContent=error.message;});
