/**
 * PCBViewerOptimized — High-performance Three.js PCB visualization.
 * Uses InstancedMesh for massive draw-call reduction on large PCBs
 * (20k-50k+ objects: 30k → 50-100 draw calls, 60 FPS constant, ~100 MB RAM).
 *
 * Consumes the JSON payload emitted by `api/board/render.py::to_render_payload`.
 * Exported on `window.PCBViewerOptimized` for the bridge layer
 * (`web/js/pcb_viewer_bridge.js`) to instantiate.
 */

// Net category regexes — extended over the backend's strict patterns
// to handle vendor-style XZZ naming (PPBUS_G3H, PP1V8_CODEC,
// GND_AUDIO_CODEC, L83_VCP_FILT_GND, …) which iPhone/MacBook
// boardviews use heavily. Without this, every such power rail and
// every suffixed ground net falls through to 'signal' and renders
// uniformly grey-white.
//
// Priority: reset > clock > power > ground > signal, so CLK_3V3 reads
// as clock (more specific cue).
const PCB_NET_CLOCK_RE = /(^|[_\-/.])(CLK|CLOCK|XTAL|X_?IN|X_?OUT|OSC(IN|OUT)?|SCLK|SCK|SYSCLK|[MHP]CLK)([_\-/.0-9]|$)/i;
const PCB_NET_RESET_RE = /(^|[_\-/.])(N_?RESET|N_?RST|RESET_?N|RST_?N|POR|PWR_?(GOOD|OK)|RESET|RST)([_\-/.0-9]|$)/i;
const PCB_NET_POWER_RE = new RegExp([
    '^\\+?\\d+V\\d*(_[A-Z0-9_]+)?$',          // +3V3, 5V0_USB, 1V8
    '^VCC[A-Z0-9_]*$',                         // VCC, VCC_3V3, VCCIO
    '^VDD[A-Z0-9_]*$',                         // VDD, VDD_CORE
    '^VBAT[A-Z0-9_]*$',                        // VBAT, VBAT_RTC
    '^VBUS[A-Z0-9_]*$',                        // VBUS, VBUS_USB
    '^V_[A-Z0-9_]+$',                          // V_AUDIO, V_3V3
    '^PP[A-Z0-9][A-Z0-9_]*$',                  // e.g. PPBUS_G3H, PP1V8_CODEC
    '^PWR[A-Z0-9_]*$',                         // PWR_GOOD, PWR_EN (rail-side)
    '^PVDD[A-Z0-9_]*$',                        // PVDD, PVDD_CPU
].join('|'), 'i');
// Ground: anchored AND token-boundaried — catches GND, VSS plus
// composite names like GND_AUDIO_CODEC, AVDD_GND, L83_VCP_FILT_GND.
const PCB_NET_GROUND_RE = /(^|[_\-/.])(GND|VSS|AGND|DGND|PGND)([_\-/.]|$)/i;

// Shared category defaults for the viewer and Tweaks colour picker.
// Persisted in the existing 'msa.pcb.netColors' localStorage entry.
const PCB_DEFAULT_NET_HEX = {
    signal:   '#a9b6cc',
    power:    '#B16628',
    ground:   '#40455C',
    clock:    '#c084fc',
    reset:    '#f58278',
    'no-net': '#e6edf7',
    // Entity-typed pseudo-categories — not net-name driven, but still
    // surfaced in the Tweaks picker so the technician can retune the
    // visually prominent test pads and vias the same way.
    testPad:  '#5a6378',
    via:      '#c084fc',
    // Board chrome — outline is the closed-polygon contour (cyan by
    // default), fill is the substrate behind it (default matches
    // bg-deep so it stays effectively invisible until the user picks
    // a colour).
    boardOutline: '#67d4f5',
    boardFill:    '#07101f',
};
const PCB_NET_COLOR_STORAGE_KEY = 'msa.pcb.netColors';

function loadPcbNetColors() {
    try {
        const raw = localStorage.getItem(PCB_NET_COLOR_STORAGE_KEY);
        if (!raw) return { ...PCB_DEFAULT_NET_HEX };
        return { ...PCB_DEFAULT_NET_HEX, ...JSON.parse(raw) };
    } catch (_) {
        return { ...PCB_DEFAULT_NET_HEX };
    }
}

function savePcbNetColors(hexMap) {
    try { localStorage.setItem(PCB_NET_COLOR_STORAGE_KEY, JSON.stringify(hexMap)); } catch (_) {}
}

function pcbHexStringToInt(hex) {
    const s = (hex || '').replace('#', '').padEnd(6, '0').slice(0, 6);
    return parseInt(s, 16) | 0;
}

/**
 * Pre-blend a foreground hex toward a background hex at `alpha` opacity.
 * The InstancedMesh path renders pins at full opacity (one shared
 * material), so we can't lean on the alpha-blending trick the SVG
 * renderer uses to darken ground pins. Bake the blend into the colour
 * up-front instead.
 */
function pcbBlendTowardBg(fg, bg, alpha) {
    const fr = (fg >> 16) & 0xff, fgG = (fg >> 8) & 0xff, fb = fg & 0xff;
    const br = (bg >> 16) & 0xff, bgG = (bg >> 8) & 0xff, bb = bg & 0xff;
    const r = Math.round(fr * alpha + br * (1 - alpha));
    const g = Math.round(fgG * alpha + bgG * (1 - alpha));
    const b = Math.round(fb * alpha + bb * (1 - alpha));
    return (r << 16) | (g << 8) | b;
}

/**
 * Resolve OKLCH design tokens from `tokens.css` to RGB hex once at init.
 * Returns hex numbers consumable by THREE.Color.
 *
 * Why canvas: getComputedStyle().color on `var(--cyan)` may return any of
 *   "rgb(r, g, b)" / "rgba(...)" / "color(srgb r g b)" / "oklch(...)"
 * depending on browser support and gamut. A naive regex over digits
 * collapses the OKLCH string ("oklch(0.82 0.14 210)") to (0, 82, 0) =
 * dark green for every token. Setting canvas2d.fillStyle to the same
 * string always normalizes to "#rrggbb" via the browser's colour pipeline.
 */
function readDesignTokens() {
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);

    const ctx = document.createElement('canvas').getContext('2d');

    const resolve = (cssVar, fallback) => {
        probe.style.color = '';
        probe.style.color = `var(${cssVar})`;
        const css = getComputedStyle(probe).color;
        if (!css) return fallback;
        try {
            ctx.fillStyle = '#000000';
            ctx.fillStyle = css;          // throws / no-op on unparseable input
            const hex = ctx.fillStyle;    // canonicalised to "#rrggbb"
            if (typeof hex === 'string' && hex.startsWith('#') && hex.length === 7) {
                return parseInt(hex.slice(1), 16);
            }
        } catch (_) { /* fallthrough */ }
        return fallback;
    };

    const tokens = {
        bgDeep:  resolve('--bg-deep', 0x07101f),
        cyan:    resolve('--cyan',    0x67d4f5),
        amber:   resolve('--amber',   0xe8b85a),
        emerald: resolve('--emerald', 0x6cd49a),
        violet:  resolve('--violet',  0xb89ce8),
        text:    resolve('--text',    0xe6edf7),
        text2:   resolve('--text-2',  0xa9b6cc),
        text3:   resolve('--text-3',  0x6e7d96),
    };
    document.body.removeChild(probe);
    return tokens;
}


export { PCB_NET_CLOCK_RE, PCB_NET_RESET_RE, PCB_NET_POWER_RE, PCB_NET_GROUND_RE, PCB_DEFAULT_NET_HEX, PCB_NET_COLOR_STORAGE_KEY, loadPcbNetColors, savePcbNetColors, pcbHexStringToInt, pcbBlendTowardBg, readDesignTokens };
