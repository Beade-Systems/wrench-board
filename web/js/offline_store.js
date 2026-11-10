// Falls back to the English literal when i18n is absent or dictionaries aren't loaded.
const fill = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text);
const tr = (key, fallback, params) => {
  const translate = window.i18n?.t ?? window.t;
  const text = typeof translate === 'function' ? translate(key, params) : key;
  return text === key ? fill(fallback, params) : text;
};

async function db() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('wrench-board-offline', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('boards', {keyPath:'id'});
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
export async function store(action, value) {
  const database = await db();
  return new Promise((resolve,reject) => {
    const tx = database.transaction('boards', action === 'list' ? 'readonly' : 'readwrite');
    const object = tx.objectStore('boards');
    const request = action === 'list' ? object.getAll() : action === 'delete' ? object.delete(value) : object.put(value);
    tx.oncomplete = () => { database.close(); resolve(request.result); };
    tx.onerror = tx.onabort = () => { database.close(); reject(tx.error || new Error(tr('library.offline.error_storage', 'Offline storage is not available.'))); };
  });
}
export async function saveOffline(board) {
  if (!('serviceWorker' in navigator)) throw new Error(tr('library.offline.error_insecure', 'Offline use requires HTTPS or localhost.'));
  await navigator.serviceWorker.register('/offline-sw.js');
  await Promise.race([navigator.serviceWorker.ready, new Promise((_,reject)=>setTimeout(()=>reject(new Error(tr('library.offline.error_prepare', 'The offline files could not be prepared.'))),15000))]);
  await store('save', {id:board.file_hash || board.board_id, name:board.board_id, saved:new Date().toISOString(), board});
}
