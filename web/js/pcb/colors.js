/** Colors operations on the shared PCB viewer state. */
import { PCB_NET_CLOCK_RE, PCB_NET_RESET_RE, PCB_NET_POWER_RE, PCB_NET_GROUND_RE, savePcbNetColors, pcbHexStringToInt } from './palette.js';

export const colorsMethods = {

    /**
     * Pre-create shared geometries used by instanced meshes
     */
    _initSharedGeometries() {
        // Standard circular pin (most common)
        // 32 segments: smooth round pads at any zoom; the InstancedMesh
        // shares a single geometry so the per-instance cost is negligible.
        this._sharedGeometries.circlePin = new THREE.CircleGeometry(1, 32);
        // Thin border ring around each pin (~6% of the pad radius).
        // Drawn behind the fill in a darker tone so each pad reads as
        // a defined object instead of a flat blob.
        this._sharedGeometries.circlePinRing = new THREE.RingGeometry(0.94, 1.0, 32);

        // Via geometries — outer ring + inner hole
        this._sharedGeometries.viaOuter = new THREE.RingGeometry(0.6, 1, 32);
        this._sharedGeometries.viaInner = new THREE.CircleGeometry(0.4, 32);

        // Test pad — solid circle, no border ring
        this._sharedGeometries.testPad = new THREE.CircleGeometry(1, 32);

        // Shared materials. Per-instance color is set via setColorAt on
        // the InstancedMesh, so the base material's colour is mostly
        // illustrative.
        this._sharedMaterials.pinFill = new THREE.MeshBasicMaterial({ color: this.colors.pinDefault });
        this._sharedMaterials.via = new THREE.MeshBasicMaterial({ color: this.colors.via, side: THREE.DoubleSide });
        this._sharedMaterials.viaHole = new THREE.MeshBasicMaterial({ color: this.colors.background });
        // Test pads (ICT probe targets, mostly TVW) render as a discreet
        // secondary layer — half-opacity so the dense ICT probe field on
        // a graphics-card bottom view doesn't drown out real SMD pads.
        this._sharedMaterials.testPad = new THREE.MeshBasicMaterial({
            color: this.colors.testPad,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
        });
    },


    /**
     * Classify a net name into one of the brd-color-grid categories so
     * pins can be coloured accordingly. Mirrors:
     *   - reset / clock regexes from web/brd_viewer.js (word-boundaried,
     *     priority reset > clock > power > ground > signal so CLK_3V3
     *     reads as clock)
     *   - power / ground regexes from
     *     api/board/parser/test_link.py (_POWER_RE, _GROUND_RE) — the
     *     canonical patterns the backend uses to set Net.is_power /
     *     Net.is_ground.
     *
     * Without word boundaries, the previous heuristic ('^[+-]?\\d' for
     * power) misclassified XZZ nets like '12_DATA_BUS' as power and
     * showed them in amber.
     */
    _netCategory(name) {
        if (name === 'NC') return 'nc';
        if (!name || name === 'N/A' || name === 'UNCONNECTED') {
            return 'default';
        }
        if (PCB_NET_RESET_RE.test(name)) return 'reset';
        if (PCB_NET_CLOCK_RE.test(name)) return 'clock';
        if (PCB_NET_POWER_RE.test(name)) return 'power';
        if (PCB_NET_GROUND_RE.test(name)) return 'ground';
        return 'signal';
    },


    _pinColorForCategory(cat) {
        switch (cat) {
            case 'power':  return this.colors.pinPower;
            case 'ground': return this.colors.pinGround;
            case 'signal': return this.colors.pinSignal;
            case 'clock':  return this.colors.pinClock;
            case 'reset':  return this.colors.pinReset;
            case 'nc':     return this.colors.pinNC;
            default:       return this.colors.pinDefault;
        }
    },


    /**
     * Resolve a pin's display colour, factoring in the parent
     * component_type. Test points (XW probe pads, TEST_PAD_*, TPxxx)
     * carrying a non-ground signal use the dedicated gold colour —
     * mirrors some board markings where probe pads on
     * active signals are hand-tinted gold while GND probe pads stay
     * grey/inert. Pins on regular components fall through to the
     * net-category colour.
     */
    _resolvePinColor(pin, cat) {
        if (pin.component_type === 'TEST_POINT' && cat !== 'ground') {
            return this.colors.pinTestPadSignal;
        }
        return this._pinColorForCategory(cat);
    },


    /**
     * Reassign the colour of every pin instance whose net falls in
     * `category`. Persists the change to the same localStorage entry
     * the SVG renderer reads, so the picker / WebGL / SVG paths stay
     * in sync. `category` accepts the SVG-side names too ('no-net').
     */
    setNetCategoryColor(category, hex) {
        const hexStr = typeof hex === 'string'
            ? (hex.startsWith('#') ? hex : '#' + hex)
            : '#' + hex.toString(16).padStart(6, '0');
        const hexInt = pcbHexStringToInt(hexStr);

        const storeKey = category === 'default' ? 'no-net' : category;
        const targetCat = category === 'no-net' ? 'default' : category;
        if (storeKey in this.netColors) {
            this.netColors[storeKey] = hexStr;
            savePcbNetColors(this.netColors);
        }

        // Entity-typed pseudo-categories — recolour every instance of
        // the matching mesh type, regardless of net name.
        if (category === 'testPad') {
            this.colors.testPad = hexInt;
            this._recolorAllTestPads(hexInt);
            this.requestRender();
            return;
        }
        if (category === 'via') {
            this.colors.via = hexInt;
            this._recolorElectricalVias(hexInt);
            this.requestRender();
            return;
        }
        if (category === 'boardOutline') {
            this._recolorBoardOutline(hexInt);
            this.requestRender();
            return;
        }
        if (category === 'boardFill') {
            this._recolorBoardFill(hexInt);
            this.requestRender();
            return;
        }

        const colorKey = 'pin' + (targetCat === 'default' ? 'Default' :
            targetCat[0].toUpperCase() + targetCat.slice(1));
        // No more bg-blend on ground — the user's picked hex is taken
        // verbatim, matching the constructor path. A previous revision
        // pre-blended ground at 55% toward bg-deep "to keep it inert",
        // but that meant the picker output never matched what the
        // user clicked.
        const sceneInt = hexInt;
        this.colors[colorKey] = sceneInt;

        const newColor = new THREE.Color(sceneInt);
        // Walk every hoverable pin / pad — `_pinInstanceData` only
        // contains circular pins, so iterating it alone left rect SMD
        // pads (the bulk of pins on most boards) and test pads stuck
        // at the previous colour until reload. Iterate `_hoverableItems`
        // instead so the picker is live across all instance types.
        const dirtyRect = new Set();
        let dirtyCircular = false;
        let dirtyTestPad = false;
        for (const item of this._hoverableItems) {
            const t = item._instanceType;
            if (t !== 'pin' && t !== 'rectPin' && t !== 'testPad') continue;
            const cat = item.is_gnd ? 'ground' : this._netCategory(item.net);
            if (cat !== targetCat) continue;
            item.originalColor = sceneInt;
            if (item._restColor != null) item._restColor = sceneInt;
            if (t === 'pin' && this._circularPinInstance) {
                this._circularPinInstance.setColorAt(item._instanceId, newColor);
                dirtyCircular = true;
            } else if (t === 'rectPin' && item._sizeKey) {
                const rect = this._rectPinInstances.get(item._sizeKey);
                if (rect && rect.body) {
                    rect.body.setColorAt(item._instanceId, newColor);
                    dirtyRect.add(rect.body);
                }
            } else if (t === 'testPad' && this._testPadsInstance) {
                this._testPadsInstance.setColorAt(item._instanceId, newColor);
                dirtyTestPad = true;
            }
        }
        if (dirtyCircular) this._circularPinInstance.instanceColor.needsUpdate = true;
        dirtyRect.forEach((mesh) => { mesh.instanceColor.needsUpdate = true; });
        if (dirtyTestPad) this._testPadsInstance.instanceColor.needsUpdate = true;
        this.requestRender();
    },


    /**
     * Repaint every "test-pad-like" entity to a single colour. The
     * picker bucket "Test pad" historically split across three
     * internal colour slots:
     *   - colors.testPad         → XZZ type_09 solid InstancedMesh
     *   - colors.pinTestPadSignal → TEST_POINT pins (XW, TPxxx) + mounting-hole vias
     * The user sees them as one family ("the gold/yellow pads"), so
     * we unify the recolour: every entity that was painted with one
     * of those two colours flips to the picked hex in one go.
     */
    _recolorAllTestPads(hexInt) {
        const newColor = new THREE.Color(hexInt);
        this.colors.testPad = hexInt;
        this.colors.pinTestPadSignal = hexInt;

        let dirtyTestPad = false;
        let dirtyCircular = false;
        const dirtyRect = new Set();
        let dirtyVia = false;

        for (const item of this._hoverableItems) {
            const t = item._instanceType;
            // 1. XZZ type_09 solid test pads (their own InstancedMesh).
            if (t === 'testPad' && this._testPadsInstance) {
                item.originalColor = hexInt;
                if (item._restColor != null) item._restColor = hexInt;
                this._testPadsInstance.setColorAt(item._instanceId, newColor);
                dirtyTestPad = true;
                continue;
            }
            // 2. Pins inside a TEST_POINT component (the visually
            //    dominant "yellow probe pads").
            if ((t === 'pin' || t === 'rectPin')
                && item.component_type === 'TEST_POINT'
                && !item.is_gnd) {
                item.originalColor = hexInt;
                if (item._restColor != null) item._restColor = hexInt;
                if (t === 'pin' && this._circularPinInstance) {
                    this._circularPinInstance.setColorAt(item._instanceId, newColor);
                    dirtyCircular = true;
                } else if (t === 'rectPin' && item._sizeKey) {
                    const rect = this._rectPinInstances.get(item._sizeKey);
                    if (rect && rect.body) {
                        rect.body.setColorAt(item._instanceId, newColor);
                        dirtyRect.add(rect.body);
                    }
                }
                continue;
            }
            // 3. Mounting-hole vias (no net — drawn in the same gold
            //    by `_createViasInstanced`, line 1995).
            if (t === 'via' && this._viasOuterInstance) {
                const isMounting = !item.net || item.net === '' || item.net === 'NC';
                if (isMounting) {
                    item.originalColor = hexInt;
                    if (item._restColor != null) item._restColor = hexInt;
                    this._viasOuterInstance.setColorAt(item._instanceId, newColor);
                    dirtyVia = true;
                }
            }
        }

        if (dirtyTestPad && this._testPadsInstance.instanceColor) {
            this._testPadsInstance.instanceColor.needsUpdate = true;
        }
        if (dirtyCircular && this._circularPinInstance.instanceColor) {
            this._circularPinInstance.instanceColor.needsUpdate = true;
        }
        dirtyRect.forEach(m => { if (m.instanceColor) m.instanceColor.needsUpdate = true; });
        if (dirtyVia && this._viasOuterInstance.instanceColor) {
            this._viasOuterInstance.instanceColor.needsUpdate = true;
        }
    },


    /**
     * Repaint electrical vias only — vias whose `net` is set to a
     * meaningful name. Mounting holes (no net) keep their gold ring
     * because they're a distinct affordance, not part of an
     * electrical net family.
     */
    _recolorElectricalVias(hexInt) {
        if (!this._viasOuterInstance) return;
        const newColor = new THREE.Color(hexInt);
        for (const item of this._hoverableItems) {
            if (item._instanceType !== 'via') continue;
            const isMounting = !item.net || item.net === '' || item.net === 'NC';
            if (isMounting) continue;
            item.originalColor = hexInt;
            if (item._restColor != null) item._restColor = hexInt;
            this._viasOuterInstance.setColorAt(item._instanceId, newColor);
        }
        if (this._viasOuterInstance.instanceColor) {
            this._viasOuterInstance.instanceColor.needsUpdate = true;
        }
    }
};
