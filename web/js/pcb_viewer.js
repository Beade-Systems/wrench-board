import { createRenderScheduler } from './shared/render_scheduler.js';
/** Public PCB viewer facade. Task-specific operations live in ./pcb/. */
import { PCB_DEFAULT_NET_HEX, loadPcbNetColors, savePcbNetColors, pcbHexStringToInt, readDesignTokens } from './pcb/palette.js';
import { colorsMethods } from './pcb/colors.js';
import { interactionMethods } from './pcb/interaction.js';
import { selectionMethods } from './pcb/selection.js';
import { sceneMethods } from './pcb/scene.js';
import { pinsMethods } from './pcb/pins.js';
import { layersMethods } from './pcb/layers.js';
import { componentsMethods } from './pcb/components.js';
import { navigationMethods } from './pcb/navigation.js';
import { searchMethods } from './pcb/search.js';
import { overlaysMethods } from './pcb/overlays.js';

let _activeViewer = null;

export class PCBViewerOptimized {
    constructor(canvasId) {
        _activeViewer = this;
        this.canvas = document.getElementById(canvasId);
        this.container = document.getElementById('pcb-canvas-container');
        this.boardData = null;
        this.selectedItem = null;
        this.highlightedItems = [];
        this.layers = { top: true, bottom: true };
        // Vias and copper traces OFF by default — GenCAD (.cad) boards
        // ship thousands of routing/stitching via dots and 30k+ routed
        // copper segments that crush perf and clutter the canvas during
        // diagnosis. The board outline still renders (createTrace forces
        // `isOutline` segments visible regardless). The toolbar toggles
        // reveal them on demand.
        this.showVias = false;
        this.showTraces = false;
        this.isFlipped = false;
        // Scene rotation in degrees (0/90/180/270). Applied at the
        // scene root so every mesh follows; the camera is recentred
        // on the visible bbox through the same rotation after each
        // toggle so the board stays in frame.
        this.rotationDeg = 0;

        // Dual view mode
        this.isDualView = false;
        this.dualViewGroup = null;

        // Dual-outline (XZZ) — when the parser surfaces top + bottom
        // views in the same coordinate space, `dualOutline` holds the
        // two polygons and the split axis. `sideMode` cycles through
        // 'top' / 'bottom' / 'both' to filter visibility per face.
        this.dualOutline = null;
        this.sideMode = 'both';
        // Outlines tracked separately so the side filter can hide /
        // show each face's contour independently.
        this._outlineMeshes = [];
        // Inspection markers (XZZ type_03) tracked so the side filter
        // can hide / show fill + border per face.
        this._markerMeshes = [];
        // Per-rect-pin border lines, tracked for the side filter
        // (they're built one-per-pin since THREE.Line has no instancing).
        this._pinBorderLines = [];
        // Standalone component fills + silkscreen body-line segments
        // emitted by `createComponent` for XZZ parts that ship body_lines:
        // they live OUTSIDE the per-part `group` (so XZZ-baked rotation
        // doesn't double-rotate), so the side filter has to track them
        // separately rather than rely on the Group's visibility.
        this._componentExtras = [];

        // Performance: render on demand
        this._disposed = false;
        this.lastHoverCheck = 0;
        this.hoverThrottleMs = 33;
        this.lastMouseMoveTime = 0;
        this.mouseMoveThrottleMs = 16;

        // === INSTANCED MESH SYSTEM ===
        this._circularPinInstance = null;      // InstancedMesh for all circular pins
        this._circularPinBorderInstance = null;
        this._rectPinInstances = new Map();    // Map<sizeKey, {body: InstancedMesh, border: InstancedMesh}>
        this._viasOuterInstance = null;
        this._viasInnerInstance = null;
        this._testPadsInstance = null;
        this._testPadsBorderInstance = null;

        // Instance ID to data mapping for hover/selection
        this._pinInstanceData = [];            // Array[instanceId] = pinData
        this._viaInstanceData = [];
        this._testPadInstanceData = [];

        // Component groups (kept as individual meshes - fewer objects)
        this.meshGroups = { components: [], traces: [] };

        // Per-component refdes label sprites — populated in createComponent,
        // visibility toggled by _updateComponentLabelVisibility() based on
        // current zoom so they don't clutter the full-board view.
        this._componentLabels = [];
        // Big silkscreen labels for 0-pin parts (BADGE / REFORM / etc.) —
        // tracked separately so we can clamp their screen pixel height on
        // zoom (they would otherwise grow unbounded).
        this._silkscreenLabels = [];
        this._labelMinPx = 32;
        this._refdesPixelHeight = 14;
        this._silkscreenMaxPixelHeight = 32;

        // === SPATIAL GRID for O(1) hover ===
        this._spatialGrid = {};
        this._gridCellSize = 5;
        this._hoverableItems = []; // Flat array for hover checks

        // === AGENT OVERLAY STATE ===
        // Annotations + arrows + measurements painted by the diagnostic
        // agent's bv_* tool calls. Distinct from the user's hover/select
        // path so a chat-driven scene survives a manual click and vice
        // versa. Tracked as Maps keyed by an id (annotation id, arrow id,
        // measurement id) so the legacy event flow can address them
        // individually for incremental clear/replace; cleared as a group
        // by the bv_reset_view path.
        this._agentAnnotations = new Map();   // id → { sprite, refdes, label }
        this._agentArrows = new Map();        // id → THREE.Group (filled shaft+head mesh + halo)
        this._agentMeasurements = new Map();  // id → THREE.Group (line + label)
        // Protocol step badges — numbered cyan/amber pins above each step's
        // target component, set by bv_propose_protocol via the bridge.
        // Keyed by step.id (string) → { sprite, refdes }. Cleared as a
        // group by clearProtocolBadges; rebuilt on every setProtocolBadges
        // call (no diff — protocol updates are infrequent enough that a
        // full repaint is simpler than an incremental update).
        this._protocolBadges = new Map();     // stepId → { sprite, refdes }
        // Refdes-prefix filter applied by the bv_filter_by_type tool.
        // Null = no filter (everything visible). When set, components +
        // pins whose part_refdes does not start with the prefix get
        // dimmed / hidden via _applyRefdesFilter.
        this._agentFilterPrefix = null;
        // Active dim-unrelated state — when truthy, every component /
        // pin not currently highlighted by the agent is dimmed. The
        // current selectedItem + agent highlights stay full-bright.
        this._agentDimActive = false;

        // Design tokens — single source of truth for the scene palette.
        // Resolved once at init from tokens.css; no live reactivity.
        this.tokens = readDesignTokens();

        // Net-category palette — shared with the SVG renderer via
        // localStorage so user customizations carry over.
        this.netColors = loadPcbNetColors();

        // Scene palette — sourced from tokens.css for chrome (background,
        // outlines, highlight) and from PCB_DEFAULT_NET_HEX for pins so
        // the WebGL viewer stays in lockstep with brd_viewer.js's
        // user-customizable net palette. Ground gets pre-blended toward
        // bg-deep to reproduce the SVG renderer's alpha-0.55 darkening
        // (otherwise GND #6e7d96 lands too close to signal #a9b6cc on
        // screen — both read as 'medium grey').
        const nc = this.netColors;
        const bg = this.tokens.bgDeep;
        this.colors = {
            background:       bg,
            boardOutline:     pcbHexStringToInt(nc.boardOutline || '#67d4f5'),
            boardFill:        pcbHexStringToInt(nc.boardFill    || '#07101f'),
            componentOutline: this.tokens.cyan,
            copper:           this.tokens.text,
            silkscreen:       this.tokens.text,
            pinDefault:       pcbHexStringToInt(nc['no-net']),
            // Explicit NC pins (string == 'NC') get hardcoded black so
            // they drop out of the active net family. Looser fallbacks
            // (null / N/A / UNCONNECTED) keep the user-customisable
            // 'no-net' shade above.
            pinNC:            0x000000,
            // Net-category pins: read from the user-customisable
            // palette (loaded from localStorage / falling back to
            // PCB_DEFAULT_NET_HEX). Earlier revisions hardcoded
            // pinPower / pinGround for visual distinctness, which made
            // edits to the defaults silently no-op until the user
            // touched the picker. Now defaults flow through.
            pinPower:         pcbHexStringToInt(nc.power),
            pinSignal:        pcbHexStringToInt(nc.signal),
            pinGround:        pcbHexStringToInt(nc.ground),
            pinClock:         pcbHexStringToInt(nc.clock),
            pinReset:         pcbHexStringToInt(nc.reset),
            via:              pcbHexStringToInt(nc.via || '#c084fc'),
            // Unified "test pad" colour — applies to the XZZ type_09
            // solid pad InstancedMesh (rare), TEST_POINT pins (XW /
            // TPxxx), AND mounting-hole vias. The previous split
            // (orange testPad + hardcoded gold pinTestPadSignal) made
            // the picker only update one slot at a time, leaving the
            // visually dominant yellow probe pads stuck.
            testPad:          pcbHexStringToInt(nc.testPad || '#d4af37'),
            pinTestPadSignal: pcbHexStringToInt(nc.testPad || '#d4af37'),
            highlight:        this.tokens.cyan,
            hover:            this.tokens.text2,
            netLine:          this.tokens.cyan,
        };

        // Shared geometries (created once)
        this._sharedGeometries = {};
        // Dash texture for fly-lines — built once, reused as the
        // `map` of every fly-line material. UV repeat per plane
        // controls how many dash cycles tile along each segment.
        this._flyDashTexture = this._createFlyDashTexture();
        this._sharedMaterials = {};

        this.init();
    }


    init() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(this.colors.background);

        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        const aspect = w / h;
        this.frustumSize = 100;
        this.camera = new THREE.OrthographicCamera(
            -this.frustumSize * aspect / 2, this.frustumSize * aspect / 2,
            this.frustumSize / 2, -this.frustumSize / 2, 0.1, 1000
        );
        this.camera.position.z = 100;

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            powerPreference: 'high-performance'
        });
        this.renderer.setSize(w, h, false);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Cap at 2x for performance

        this.mouse = new THREE.Vector2();
        this.isPanning = false;
        this.lastMousePos = { x: 0, y: 0 };
        this.zoom = 1;

        this._renderScheduler = createRenderScheduler(() => {
            this.renderer.render(this.scene, this.camera);
        });
        this._initSharedGeometries();
        this.setupEvents();
        this.animate();
    }


    // ========================
    // RENDER LOOP
    // ========================

    // Kept as a compatibility alias for existing callers.
    animate() {
        this.requestRender();
    }

    requestRender() {
        this._renderScheduler?.request();
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._eventController?.abort();
        this._renderScheduler?.dispose();
        if (this._cursorFrame != null) cancelAnimationFrame(this._cursorFrame);
        const geometries = new Set(Object.values(this._sharedGeometries));
        const materials = new Set(Object.values(this._sharedMaterials));
        const textures = new Set();
        this.scene.traverse(object => {
            if (object.geometry) geometries.add(object.geometry);
            for (const material of [object.material].flat().filter(Boolean)) materials.add(material);
            if (object.isInstancedMesh) object.dispose();
        });
        for (const material of materials) {
            for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
            material.dispose();
        }
        for (const geometry of geometries) geometry.dispose();
        for (const texture of textures) texture.dispose();
        this.scene.clear();
        this.renderer.dispose();
        this.boardData = null;
        this._hoverableItems = [];
        this._spatialGrid = {};
        if (_activeViewer === this) _activeViewer = null;
    }

}

Object.assign(PCBViewerOptimized.prototype, colorsMethods, interactionMethods, selectionMethods, sceneMethods, pinsMethods, layersMethods, componentsMethods, navigationMethods, searchMethods, overlaysMethods);


// Export for use — bridge consumes via window.PCBViewerOptimized.
if (typeof window !== 'undefined') {
    window.PCBViewerOptimized = PCBViewerOptimized;
}

// ---------- Net-category colour API (window globals) ----------
//
// The Tweaks colour picker (web/js/main.js) drives net-category colours through
// these four globals. They were historically defined by the legacy SVG
// brd_viewer.js; that file is retired, so pcb_viewer — which already owns the
// palette defaults (PCB_DEFAULT_NET_HEX), the 'msa.pcb.netColors' store, and the
// live recolour path (setNetCategoryColor) — now provides them directly.
// `get*` are pure data (usable before any board loads); the setters push a live
// recolour to the active viewer when one exists AND persist, so a choice made
// with no board on screen still survives to the next load.
if (typeof window !== 'undefined') {
    window.getBoardviewColorDefaults = () => ({ ...PCB_DEFAULT_NET_HEX });
    window.getBoardviewColors = () => loadPcbNetColors();
    window.setBoardviewNetColor = (category, hex) => {
        if (_activeViewer) {
            // setNetCategoryColor persists (savePcbNetColors) AND recolours.
            _activeViewer.setNetCategoryColor(category, hex);
            return;
        }
        // No board on screen yet — persist only. Mirror setNetCategoryColor's
        // 'default' -> 'no-net' storage-key remap so the next load matches.
        const hexStr = typeof hex === 'string'
            ? (hex.startsWith('#') ? hex : '#' + hex)
            : '#' + Number(hex).toString(16).padStart(6, '0');
        const storeKey = category === 'default' ? 'no-net' : category;
        const colors = loadPcbNetColors();
        if (storeKey in colors) {
            colors[storeKey] = hexStr;
            savePcbNetColors(colors);
        }
    };
    window.resetBoardviewColors = () => {
        savePcbNetColors({ ...PCB_DEFAULT_NET_HEX });
        if (_activeViewer) {
            for (const [cat, hex] of Object.entries(PCB_DEFAULT_NET_HEX)) {
                _activeViewer.setNetCategoryColor(cat, hex);
            }
        }
    };
}
