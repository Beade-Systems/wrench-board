// Detached PDF window: hosts a PdfView and talks to its PdfPanel over wb-pdf.
import { PDF_CHANNEL, POPOUT_DOCK_ICON, PdfView } from './pcb_pdf_panel.js';

// Falls back to the English literal when i18n is absent or dictionaries aren't loaded.
const fill = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text);
const tr = (key, fallback, params) => {
  const translate = window.i18n?.t ?? window.t;
  const text = typeof translate === 'function' ? translate(key, params) : key;
  return text === key ? fill(fallback, params) : text;
};

const session = new URLSearchParams(window.location.search).get('s');
const root = document.getElementById('pdf-root');
const channel = new BroadcastChannel(PDF_CHANNEL);

function post(type, payload = {}) {
  channel.postMessage({ type, session, ...payload });
}

let stateTimer = 0;
let docTitle = '';

function renderTitle() {
  const schematic = tr('library.pdf.window_title', 'Schematic');
  document.title = docTitle ? `${docTitle} · ${schematic}` : `${schematic} · Wrench Board`;
}

function closeWindow() {
  post('closed');
  window.close();
}

const view = new PdfView(root, {
  onTermClick: (token) => post('termClick', { token }),
  notify: (text) => post('notify', { text }),
  onNight: (value) => post('night', { value }),
  onState: (state) => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => post('state', state), 200);
  },
  detach: { icon: POPOUT_DOCK_ICON, label: () => tr('library.pdf.dock_again', 'Dock again'), onClick: closeWindow },
});

async function reply(id, work) {
  const result = await work;
  if (id) post('reply', { id, result });
}

channel.onmessage = ({ data: msg }) => {
  if (!msg || msg.session !== session) return;
  switch (msg.type) {
    case 'open':
      docTitle = msg.title || '';
      renderTitle();
      reply(msg.id, view.open({ url: msg.url, title: msg.title, page: msg.page, term: msg.term }));
      break;
    case 'search':
      reply(msg.id, view.search(msg.term));
      break;
    case 'next':
      view.next();
      break;
    case 'previous':
      view.previous();
      break;
    case 'night':
      view.setNight(msg.value, { silent: true });
      break;
    case 'close':
      window.close();
      break;
    default:
      break;
  }
};

window.i18n?.onReady?.(renderTitle);
window.i18n?.onChange?.(renderTitle);
window.addEventListener('pagehide', () => post('closed'));
post('ready');
view.root.focus({ preventScroll: true });
