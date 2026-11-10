import {store} from './offline_store.js';
import {LibraryViewer} from './pcb_library_viewer.js';
const $ = id => document.getElementById(id);
let boards = [];
const viewer = new LibraryViewer($('canvas'), selected => { $('selection').textContent = selected ? JSON.stringify(selected,null,2) : ''; });
function show() { const entry = boards.find(b=>b.id===$('boards').value); viewer.load(entry?.board || null); $('offline-status').textContent=entry ? `${entry.board.parts.length} Bauteile · ${entry.board.pins.length} Pins · gespeichert ${new Date(entry.saved).toLocaleString('de-DE')}` : 'Noch keine Platine gespeichert. Öffne online eine Platine und wähle „Offline speichern“.'; }
async function refresh() { try {boards=await store('list'); $('boards').replaceChildren(...boards.map(b=>new Option(b.name,b.id)));show();}catch(error){$('offline-status').textContent=error.message;} }
$('boards').onchange=show;
$('remove').onclick=async()=>{await store('delete',$('boards').value);refresh();};
$('fit').onclick=()=>viewer.fit();
$('side').onchange=()=>viewer.setView({ ...viewer.getView(), side:Number($('side').value) });
$('search').oninput=()=>{const board=boards.find(b=>b.id===$('boards').value)?.board;const part=board?.parts.find(p=>p.refdes.toLowerCase()===$('search').value.trim().toLowerCase());if(part) viewer.select({kind:'part', item:part}, true);};
refresh();
