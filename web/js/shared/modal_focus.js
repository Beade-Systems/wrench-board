// web/js/shared/modal_focus.js
// Global keyboard focus trap for every `[aria-modal="true"]` dialog.
//
// The shell renders modals from many places (landing, onboarding, profile
// wizard, protocol confirm, info modal) and none of them constrained Tab, so
// keyboard focus walked out into the blurred page behind the backdrop. Rather
// than wire a trap into each modal, one document-level listener keeps focus
// inside the topmost *visible* modal dialog — new modals get it for free just
// by declaring `role="dialog" aria-modal="true"`.
//
// Native <dialog>.showModal() already traps focus; it is skipped here.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isVisible(el) {
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  }
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function topModal() {
  const open = [...document.querySelectorAll('[aria-modal="true"]')]
    .filter((el) => el.tagName !== 'DIALOG' && isVisible(el));
  return open.length ? open[open.length - 1] : null;
}

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(isVisible);
}

function onKeydown(e) {
  if (e.key !== 'Tab' || e.defaultPrevented) return;
  const modal = topModal();
  if (!modal) return;
  const items = focusables(modal);
  if (!items.length) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!modal.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

let installed = false;
export function installModalFocusTrap() {
  if (installed) return;
  installed = true;
  document.addEventListener('keydown', onKeydown, true);
}
