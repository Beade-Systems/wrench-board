// First-diagnostic coaching — a one-shot guided tour of the repair workspace,
// played the very first time a diagnostic dashboard opens (gated by the
// profile's `state.first_diag_seen` flag — server-side so it's cross-device —
// via onboarding_state.js, with localStorage as a fast pre-gate). Unlike a static card, this walks the
// real surfaces in workflow order with anchored mascot bubbles, and actually
// NAVIGATES the rail views (PCB / schematic / graph) so the technician sees each
// page change in context — closing the "abandoned on the repair screen" gap.
//
// Tone: a small discreet mascot accompanies the bubbles (continuity with the
// landing onboarding), but the dense pro workbench is otherwise untouched. Every
// step is escapable ("Skip the tour") and the whole thing plays once.
//
// The persistent, replayable counterpart is the "?" affordance in the dashboard
// header → openInfoModal("repair") (wired in dashboard.js); this module owns the
// scripted first-run only. Styling reuses .mascot-bubble + .ob-* in
// web/styles/onboarding.css; the mascot host is .ob-coach-mascot.

import { t } from "../../../i18n.js";
import { mountMascot, setMascotState } from "../../../mascot.js";
import { showBubble, hideBubble } from "../../../mascot_bubble.js";
import { repairHash } from "../../../router.js";
import { hasSeenOnboarding, markOnboardingSeen } from "../../../onboarding_state.js";

let _running = false;   // re-entry guard (renderRepairDashboard re-runs on nav)
let _aborted = false;   // set when the tech hits "Skip the tour"
let _mascot = null;     // mounted mascot <svg>
let _mascotHost = null; // fixed-position host element

function _mountMascot() {
  _mascotHost = document.createElement("div");
  _mascotHost.className = "ob-coach-mascot";
  _mascotHost.setAttribute("aria-hidden", "true");
  document.body.appendChild(_mascotHost);
  _mascot = mountMascot(_mascotHost, { size: "sm", state: "idle" });
}

// Switch the workspace to a repair vue and resolve once it's actually on screen.
// Navigation is async (main.js owns hashchange → syncContextFromUrl → navigate),
// so we poll the rail's active state — the reliable "navigate() finished" signal
// — then wait one frame so the target section has painted. Resolves regardless
// after a short deadline so the tour can never wedge on a missed signal.
function _navTo(rid, vue) {
  window.location.hash = repairHash(rid, vue);
  return new Promise((resolve) => {
    const sel = `.rail-btn[data-rail="${vue}"][data-rail-level="repair"]`;
    const tick = (tries) => {
      const btn = document.querySelector(sel);
      if (btn && btn.classList.contains("active")) {
        requestAnimationFrame(() => resolve());
        return;
      }
      if (tries <= 0) { resolve(); return; }
      setTimeout(() => tick(tries - 1), 60);
    };
    tick(25); // ~1.5 s ceiling
  });
}

// Show one bubble and resolve when the tech advances. "Skip the tour" sets
// _aborted and resolves too — the caller checks the flag and tears down.
function _step({ anchor, text, placement = "bottom", mascot = "idle", last = false, doneLabel = null, spotlight = false }) {
  if (_mascot) setMascotState(_mascot, mascot);
  return new Promise((resolve) => {
    showBubble({
      anchor: typeof anchor === "string" ? document.querySelector(anchor) : anchor,
      placement,
      text,
      spotlight,
      nextLabel: last ? (doneLabel || t("onboarding.coach.done")) : t("onboarding.next"),
      skipLabel: t("onboarding.coach.skip"),
      next: () => resolve(),
      skip: () => { _aborted = true; resolve(); },
    });
  });
}

export async function maybeShowFirstDiagCoaching(rid) {
  if (_running) return;
  if (hasSeenOnboarding("first_diag_seen")) return; // already toured

  _running = true;
  _aborted = false;
  _mountMascot();

  const cancelled = () => _aborted || !document.body.contains(_mascotHost);

  // ── Phase 1: the diagnostic dashboard (current view) ──────────────────────
  await _step({ anchor: ".rd-head", text: t("onboarding.coach.session"), placement: "bottom", mascot: "success", spotlight: true });
  if (cancelled()) return finishFirstDiagCoaching();
  await _step({ anchor: "#rdCap", text: t("onboarding.coach.cap"), placement: "bottom", mascot: "scanning", spotlight: true });
  if (cancelled()) return finishFirstDiagCoaching();
  await _step({ anchor: "#rdCards", text: t("onboarding.coach.cards"), placement: "top", mascot: "idle", spotlight: true });
  if (cancelled()) return finishFirstDiagCoaching();

  // ── Phase 2: walk the rail views (the page actually changes) ──────────────
  // Anchored to each rail button (far left) so the arrow ties "this button →
  // this page". Skipped wholesale when there's no repair id to navigate with.
  if (rid) {
    const railSel = (vue) => `.rail-btn[data-rail="${vue}"][data-rail-level="repair"]`;

    // ── PCB — light up a real component so the bubble points at something concrete.
    await _navTo(rid, "pcb");
    if (cancelled()) return finishFirstDiagCoaching();
    await _step({ anchor: railSel("pcb"), text: t("onboarding.coach.pcb"), placement: "right", mascot: "idle" });
    if (cancelled()) return finishFirstDiagCoaching();

    // ── Schematic — on the demo, click the LPC_VCC rail (fallback U14) so the
    // tech sees the schematic isolate the rail + its cascade, not just hears about it.
    await _navTo(rid, "schematic");
    if (cancelled()) return finishFirstDiagCoaching();
    await _step({ anchor: railSel("schematic"), text: t("onboarding.coach.schematic"), placement: "right", mascot: "idle" });
    if (cancelled()) return finishFirstDiagCoaching();

    // ── Graph (memory) — on the demo, click a node so the right-hand detail panel
    // opens (the "how it reasons" panel), then flip to the Raw tab to show the
    // underlying memory, then restore Visual.
    await _navTo(rid, "graph");
    if (cancelled()) return finishFirstDiagCoaching();
    await _step({ anchor: railSel("graph"), text: t("onboarding.coach.graph"), placement: "right", mascot: "scanning" });
    if (cancelled()) return finishFirstDiagCoaching();

    // Back to the diagnostic dashboard for the closing step.
    await _navTo(rid, "diagnostic");
    if (cancelled()) return finishFirstDiagCoaching();
  }

  // ── Phase 3: how to actually diagnose ─────────────────────────────────────
  await _step({ anchor: "#llmToggle", text: t("onboarding.coach.chat"), placement: "bottom", mascot: "working", last: true });
  finishFirstDiagCoaching();
}

// True while the first-run tour is playing OR still owed (flag unset). Callers
// use this to hold back competing surfaces during the tour — notably the chat
// panel auto-open, so the early bubbles (header / capabilities / cards) aren't
// covered. The tour's closing step points the tech at the chat toggle to open
// it themselves.
export function firstDiagTourPending() {
  if (_running) return true;
  return !hasSeenOnboarding("first_diag_seen");
}

export function finishFirstDiagCoaching() {
  hideBubble();
  // Safety net: if the tech skips mid-tour, a detail panel opened by the demo's
  // synthetic clicks (graph #inspector is a global aside; schematic #schInspector)
  // would otherwise stay open across views. Close both.
  try {
    document.getElementById("inspector")?.classList.remove("open");
    document.getElementById("schInspector")?.classList.remove("open");
  } catch { /* best effort */ }
  if (_mascotHost) { _mascotHost.remove(); _mascotHost = null; _mascot = null; }
  markOnboardingSeen("first_diag_seen"); // server (cross-device) + localStorage cache
  _running = false;
}
