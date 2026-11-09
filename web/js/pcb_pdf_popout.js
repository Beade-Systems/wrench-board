// Detached PDF window: hosts a PdfView and talks to its PdfPanel over wb-pdf.
import { PDF_CHANNEL, POPOUT_DOCK_ICON, PdfView } from './pcb_pdf_panel.js';

const session = new URLSearchParams(window.location.search).get('s');
const root = document.getElementById('pdf-root');
const channel = new BroadcastChannel(PDF_CHANNEL);

function post(type, payload = {}) {
  channel.postMessage({ type, session, ...payload });
}

let stateTimer = 0;

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
  detach: { icon: POPOUT_DOCK_ICON, label: 'Wieder andocken', onClick: closeWindow },
});

async function reply(id, work) {
  const result = await work;
  if (id) post('reply', { id, result });
}

channel.onmessage = ({ data: msg }) => {
  if (!msg || msg.session !== session) return;
  switch (msg.type) {
    case 'open':
      document.title = msg.title ? `${msg.title} · Schaltplan` : 'Schaltplan';
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

window.addEventListener('pagehide', () => post('closed'));
post('ready');
view.root.focus({ preventScroll: true });
