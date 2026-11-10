/** Scene operations on the shared PCB viewer state. */
import { localizeCode } from '../shared/errors.js';

export const sceneMethods = {

    // ========================
    // BOARD LOADING - OPTIMIZED
    // ========================

    loadBoard(data) {
        console.time('[PERF] loadBoard');

        this.boardData = data;
        this.clearScene();

        if (data.error) {
            console.error('Load error:', data.message);
            const translate = window.i18n?.t ?? window.t;
            // A coded payload (`code` + `params`) is translated; `message` stays the fallback.
            const message = localizeCode('library.error', data.code, { ...data.params, message: data.message }, data.message);
            const text = typeof translate === 'function' ? translate('pcb.viewer.load_error', { message }) : '';
            alert(text && text !== 'pcb.viewer.load_error' ? text : 'Error: ' + message);
            return;
        }

        this.offsetX = data.board_offset_x || 0;
        this.offsetY = data.board_offset_y || 0;

        // XZZ-style dual layout (top + bottom views in the same coord
        // space). When present, the backend has already tagged every
        // entity with `_side` and the side toggle defaults to 'both'.
        this.dualOutline = data.dual_outline || null;
        this.sideMode = 'both';

        // Net diagnostic expectations (XZZ post-v6 block on some boards
        // manufacturer dumps). Indexed by net name for O(1) lookup at
        // selection time. Empty Map on boards without diagnostic data
        // — the inspector keeps the rows hidden in that case.
        this._netDiagnostics = new Map();
        for (const d of (data.net_diagnostics || [])) {
            this._netDiagnostics.set(d.name, d);
        }

        // 1. Create board outline
        this.createBoard(data);

        // 2. Geometric edge-finger detection — must run BEFORE component
        //    and pin meshes are built so its mutations on `comp.layer`
        //    (clearing the side designation for edge connectors) and
        //    on each finger pin's shape / size land on the data the
        //    builders read.
        if (data.pins && data.components) {
            this._applyEdgeFingerDetection(data.pins, data.components);
        }

        // 3. Create components (individual meshes - usually < 500)
        console.time('[PERF] components');
        // Build a refdes -> component lookup once so the info panel can
        // resolve `dnp_alternates` refdes back to their footprint /
        // value without re-scanning the array on every selection.
        this._compIndex = new Map();
        if (data.components) {
            for (const c of data.components) this._compIndex.set(c.id, c);
            data.components.forEach(c => this.createComponent(c));
        }
        console.timeEnd('[PERF] components');

        // 4. Create pins using InstancedMesh (MAJOR optimization)
        console.time('[PERF] pins-instanced');
        if (data.pins) {
            this._createPinsInstanced(data.pins);
        }
        console.timeEnd('[PERF] pins-instanced');

        // 4. Create vias using InstancedMesh
        console.time('[PERF] vias-instanced');
        if (data.vias && data.vias.length > 0) {
            this._createViasInstanced(data.vias);
        }
        console.timeEnd('[PERF] vias-instanced');

        // 5. Create test pads using InstancedMesh
        console.time('[PERF] testpads-instanced');
        if (data.test_pads) {
            this._createTestPadsInstanced(data.test_pads);
        }
        console.timeEnd('[PERF] testpads-instanced');

        // 6. Create traces (lines)
        if (data.traces) {
            data.traces.forEach(t => this.createTrace(t));
        }

        // 6b. Manufacturer inspection markers (XZZ type_03 overlays).
        // Empty on most boards — some boards ship 15 such rectangles
        // that the OEM tagged as zones of interest for diagnosis.
        // Render as semi-transparent amber-stroked rectangles above
        // the board layer, below the pins, no fill.
        if (data.markers && data.markers.length > 0) {
            this._createInspectionMarkers(data.markers);
        }

        // 6c. Mechanical holes — `$MECH HOLE` from GenCAD `.cad` files.
        // Fixation holes (4 PCB-corner screws) render as a steel-grey
        // ring around a hollow centre at full radius; centre fiducials
        // render as a small filled gold dot. Always visible, can't be
        // toggled — they're board structure, not signal data.
        if (data.mech_holes && data.mech_holes.length > 0) {
            this._createMechHoles(data.mech_holes);
        }

        // 7. Build spatial grid for O(1) hover
        console.time('[PERF] spatial-grid');
        this._buildSpatialGrid();
        console.timeEnd('[PERF] spatial-grid');

        // Center camera
        const centerX = this.offsetX + data.board_width / 2;
        const centerY = this.offsetY + data.board_height / 2;
        this.camera.position.x = centerX;
        this.camera.position.y = centerY;
        this.frustumSize = Math.max(data.board_width, data.board_height) * 1.2;
        this.zoom = 100 / this.frustumSize;
        this.onResize();
        // Restore the technician's preferred side mode. Falls back to
        // 'both' on first run or when localStorage is unavailable.
        let savedMode = 'both';
        try {
            const v = localStorage.getItem('pcb.sideMode');
            if (v === 'top' || v === 'bottom' || v === 'both') savedMode = v;
        } catch (_) {}
        this.setSideMode(savedMode);

        // Update stats
        document.getElementById('stats-components').textContent = data.components_count || 0;
        document.getElementById('stats-pins').textContent = data.pins_count || 0;
        document.getElementById('stats-nets').textContent = data.nets_count || 0;
        document.getElementById('zoom-level').textContent = Math.round(this.zoom * 100);
        document.getElementById('no-file-message').classList.add('hidden');

        // Handle format-specific UI
        const formatType = (data.format_type || '').toLowerCase();
        const dualBtn = document.getElementById('dual-view');
        const flipBtn = document.getElementById('flip-board');

        if (formatType === 'brd') {
            if (dualBtn) dualBtn.classList.remove('hidden');
            if (flipBtn) flipBtn.classList.remove('hidden');
            if (!this.isDualView) {
                this.isDualView = true;
                if (dualBtn) {
                    dualBtn.classList.remove('bg-dark-600', 'text-gray-400', 'border-dark-500');
                    dualBtn.classList.add('bg-green-500/20', 'text-green-400', 'border-green-500/30');
                }
                this.createDualViewGroup();
                this.centerDualView();
            }
        } else if (formatType === 'pcb' || formatType === 'xzz') {
            if (dualBtn) dualBtn.classList.add('hidden');
            if (flipBtn) flipBtn.classList.add('hidden');
            if (this.isDualView) {
                this.isDualView = false;
                this.removeDualViewGroup();
            }
        } else {
            if (dualBtn) dualBtn.classList.remove('hidden');
            if (flipBtn) flipBtn.classList.remove('hidden');
            if (this.isDualView) {
                this.createDualViewGroup();
                this.centerDualView();
            }
        }

        this.requestRender();
        console.timeEnd('[PERF] loadBoard');

        const totalObjects = (data.pins?.length || 0) + (data.vias?.length || 0) + (data.test_pads?.length || 0);
        console.log(`[PERF] Loaded ${totalObjects} objects with InstancedMesh optimization`);
    },


    /**
     * Detect edge-finger connectors and retune each finger's pad
     * shape / dimensions before pin instancing.
     *
     * An "edge finger" pattern is the dense single-row pad layout used
     * by every PCIe / CrossFire / SLI / MXM / DDR / sodimm-style slot:
     * 15+ pads arranged on a single line with a regular pitch. The
     * pads are physically long rectangles oriented perpendicular to
     * the line so they can mate with a card edge. Some sources only
     * carry the small probe-target square per pad (~22 mils on PCIe),
     * which renders as a row of dots that hides the connector layout
     * — this pass restores the visual connector identity.
     *
     * Detection is purely geometric: we look at every component with
     * ≥ 15 pins, check that one axis is wide and the other is narrow
     * (collinear), and confirm the inter-pin pitch is regular within
     * 30 % stddev / mean. When that holds, each pin's `shape` becomes
     * `'rect'` and its width/height are retuned so the long edge
     * follows the body silkscreen's perpendicular extent (typically
     * ~55 % of `comp.height` for a horizontal slot) and the short
     * edge takes ~55 % of the pitch — proportions that match the
     * physical pad layout of a real edge connector.
     */
    _applyEdgeFingerDetection(pins, components) {
        const compIndex = new Map();
        for (const c of (components || [])) compIndex.set(c.id, c);

        const pinsByComp = new Map();
        for (const p of pins) {
            if (!p.component) continue;
            let bucket = pinsByComp.get(p.component);
            if (!bucket) {
                bucket = [];
                pinsByComp.set(p.component, bucket);
            }
            bucket.push(p);
        }

        const MIN_FINGERS = 15;
        const PITCH_REGULARITY_MAX_CV = 0.30;  // gap stddev / mean cap
        const COLLINEAR_RATIO = 0.05;  // perpendicular spread must be ≤ 5% of axis spread
        const COLLINEAR_FLOOR_MM = 0.05;  // floor (probe-target jitter on a perfect line)
        const PITCH_MM_MIN = 0.3;
        const PITCH_MM_MAX = 5.0;
        const PAD_ALONG_FRAC = 0.55;
        const PAD_PERP_FRAC = 0.55;

        let detected = 0;
        for (const [refdes, compPins] of pinsByComp) {
            if (compPins.length < MIN_FINGERS) continue;

            const xs = compPins.map(p => p.x);
            const ys = compPins.map(p => p.y);
            const xMin = Math.min(...xs), xMax = Math.max(...xs);
            const yMin = Math.min(...ys), yMax = Math.max(...ys);
            const spreadX = xMax - xMin;
            const spreadY = yMax - yMin;

            const isHorizontalAxis = spreadX >= spreadY;
            const axisSpread = isHorizontalAxis ? spreadX : spreadY;
            const perpSpread = isHorizontalAxis ? spreadY : spreadX;
            if (axisSpread <= 0) continue;
            if (perpSpread > axisSpread * COLLINEAR_RATIO + COLLINEAR_FLOOR_MM) continue;

            const axisVals = (isHorizontalAxis ? xs : ys).slice().sort((a, b) => a - b);
            const gaps = [];
            for (let i = 1; i < axisVals.length; i++) {
                const g = axisVals[i] - axisVals[i - 1];
                if (g > 1e-6) gaps.push(g);
            }
            if (gaps.length === 0) continue;
            const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            if (meanGap < PITCH_MM_MIN || meanGap > PITCH_MM_MAX) continue;
            const variance = gaps.reduce((s, g) => s + (g - meanGap) ** 2, 0) / gaps.length;
            const stddev = Math.sqrt(variance);
            if (stddev / meanGap > PITCH_REGULARITY_MAX_CV) continue;

            // Estimate the perpendicular pad extent from the
            // component's silkscreen body when available — fingers run
            // ~55 % of the body's perpendicular extent on real
            // connectors. Fall back to 4 × pitch for components
            // without body_lines.
            const comp = compIndex.get(refdes);
            let perpExtent = meanGap * 4.0;
            if (comp && Array.isArray(comp.body_lines) && comp.body_lines.length > 0) {
                let minP = Infinity, maxP = -Infinity;
                for (const seg of comp.body_lines) {
                    const v1 = isHorizontalAxis ? seg.y1 : seg.x1;
                    const v2 = isHorizontalAxis ? seg.y2 : seg.x2;
                    if (v1 < minP) minP = v1;
                    if (v2 < minP) minP = v2;
                    if (v1 > maxP) maxP = v1;
                    if (v2 > maxP) maxP = v2;
                }
                const bodyPerp = maxP - minP;
                if (isFinite(bodyPerp) && bodyPerp > 0) {
                    perpExtent = bodyPerp;
                }
            }

            const padAlong = meanGap * PAD_ALONG_FRAC;
            const padPerp = perpExtent * PAD_PERP_FRAC;

            for (const p of compPins) {
                p.shape = 'rect';
                if (isHorizontalAxis) {
                    p.width = padAlong;
                    p.height = padPerp;
                } else {
                    p.width = padPerp;
                    p.height = padAlong;
                }
                // Edge connectors physically carry fingers on BOTH
                // faces of the PCB, but the source only ships the
                // probe-testable face. Mark the pin so the viewer
                // surfaces it regardless of the TOP / BOTTOM side
                // filter — same logical pad, visible on either
                // viewing direction. Storing the marker on the pin
                // (rather than mutating its `layer`) keeps the
                // existing layer-derived bookkeeping (z position,
                // hover dispatch, info panel) untouched.
                p._edgeFinger = true;
            }
            // Same treatment for the component itself: clearing its
            // side designation lets the body silkscreen / bbox / label
            // appear in either face-only mode. Without this, the pads
            // would show but the carrier component would vanish from
            // TOP-only view (or BOTTOM-only on the opposite case),
            // giving the connector a "ghost pads with no body"
            // appearance.
            if (comp) {
                comp._edgeFinger = true;
                comp._side = null;
                comp.layer = null;
            }
            detected += 1;
        }
        if (detected > 0) {
            console.log(`[edge-fingers] retuned pads on ${detected} connector(s)`);
        }
    },


    createBoard(data) {
        // Source the polygons. When the backend tagged a dual-outline
        // (XZZ side-by-side / stacked layout), use the explicit per-face
        // polygons so each contour mesh carries the correct `_side` tag
        // and the side toggle can hide / show them independently.
        const tagged = [];
        if (data.dual_outline && data.dual_outline.top && data.dual_outline.bottom) {
            tagged.push({ poly: data.dual_outline.top, side: 'top' });
            tagged.push({ poly: data.dual_outline.bottom, side: 'bottom' });
        } else if (data.outline) {
            let polys = [];
            if (data.outline.polygons) {
                polys = data.outline.polygons;
            } else if (Array.isArray(data.outline) && data.outline.length >= 3) {
                polys = [data.outline];
            }
            polys.forEach(p => tagged.push({ poly: p, side: null }));
        }

        tagged.forEach(({ poly, side }) => {
            if (!poly || poly.length < 3) return;

            const cleanedOutline = [poly[0]];
            for (let i = 1; i < poly.length; i++) {
                const prev = cleanedOutline[cleanedOutline.length - 1];
                const curr = poly[i];
                if (Math.abs(curr.x - prev.x) > 0.01 || Math.abs(curr.y - prev.y) > 0.01) {
                    cleanedOutline.push(curr);
                }
            }

            if (cleanedOutline.length >= 3) {
                const outlinePoints = cleanedOutline.map(p => new THREE.Vector3(p.x, p.y, 0.5));
                outlinePoints.push(new THREE.Vector3(cleanedOutline[0].x, cleanedOutline[0].y, 0.5));

                const outlineGeom = new THREE.BufferGeometry().setFromPoints(outlinePoints);
                const outlineMat = new THREE.LineBasicMaterial({
                    color: this.colors.boardOutline,
                    transparent: true,
                    opacity: 0.95,
                });
                const outline = new THREE.Line(outlineGeom, outlineMat);
                outline.userData._side = side;
                this.scene.add(outline);
                this._outlineMeshes.push(outline);

                // Filled substrate behind the contour. Hidden when the
                // user's picked fill colour matches the canvas
                // background — that's the "no fill" state. A real
                // pick (different from bg-deep) makes the substrate
                // visible. Always created so the colour picker can
                // show / hide it live without rebuilding the board.
                try {
                    const fillShape = new THREE.Shape(
                        cleanedOutline.map(p => new THREE.Vector2(p.x, p.y))
                    );
                    const fillGeom = new THREE.ShapeGeometry(fillShape);
                    const fillMat = new THREE.MeshBasicMaterial({
                        color: this.colors.boardFill,
                        transparent: true,
                        opacity: this.colors.boardFill === this.colors.background ? 0 : 0.85,
                        depthWrite: false,
                    });
                    const fillMesh = new THREE.Mesh(fillGeom, fillMat);
                    fillMesh.position.z = 0.4;  // just below the outline line at 0.5
                    fillMesh.userData._side = side;
                    this.scene.add(fillMesh);
                    this._outlineMeshes.push(fillMesh);
                } catch (err) {
                    console.warn("[PCBViewer] board fill triangulation skipped", err);
                }
            }
        });
    },


    /**
     * Recolour the board outline (line meshes) — called from the
     * Tweaks picker. Walks every entry in `_outlineMeshes` and updates
     * the one(s) that are line geometries (Mesh fills are touched by
     * `_recolorBoardFill`).
     */
    _recolorBoardOutline(hexInt) {
        this.colors.boardOutline = hexInt;
        for (const m of this._outlineMeshes) {
            if (m.material && m.material.type === 'LineBasicMaterial') {
                m.material.color.setHex(hexInt);
            }
        }
    },


    /**
     * Recolour the board substrate fill. When the picked colour
     * matches the canvas background (the "no fill" sentinel), the
     * fill mesh is hidden via opacity:0.
     */
    _recolorBoardFill(hexInt) {
        this.colors.boardFill = hexInt;
        const isInvisible = hexInt === this.colors.background;
        for (const m of this._outlineMeshes) {
            if (m.material && m.material.type === 'MeshBasicMaterial') {
                m.material.color.setHex(hexInt);
                m.material.opacity = isInvisible ? 0 : 0.85;
                m.material.transparent = true;
                m.material.needsUpdate = true;
            }
        }
    },


    clearScene() {
        // Remove instanced meshes
        if (this._circularPinInstance) {
            this.scene.remove(this._circularPinInstance);
            this._circularPinInstance.dispose();
            this._circularPinInstance = null;
        }
        if (this._circularPinBorderInstance) {
            this.scene.remove(this._circularPinBorderInstance);
            this._circularPinBorderInstance.dispose();
            this._circularPinBorderInstance = null;
        }
        this._rectPinInstances.forEach(({ body, geometry }) => {
            this.scene.remove(body);
            body.dispose();
            geometry.dispose();
        });
        this._rectPinInstances.clear();

        if (this._viasOuterInstance) {
            this.scene.remove(this._viasOuterInstance);
            this._viasOuterInstance.dispose();
            this._viasOuterInstance = null;
        }
        if (this._viasInnerInstance) {
            this.scene.remove(this._viasInnerInstance);
            this._viasInnerInstance.dispose();
            this._viasInnerInstance = null;
        }
        if (this._testPadsInstance) {
            this.scene.remove(this._testPadsInstance);
            this._testPadsInstance.dispose();
            this._testPadsInstance = null;
        }
        if (this._testPadsBorderInstance) {
            this.scene.remove(this._testPadsBorderInstance);
            this._testPadsBorderInstance.dispose();
            this._testPadsBorderInstance = null;
        }
        // GenCAD `$MECH HOLE` meshes — plain `THREE.Mesh` (not Instanced),
        // dispose their geometry on clear so reload doesn't leak.
        if (this._mechHoleMeshes && this._mechHoleMeshes.length) {
            this._mechHoleMeshes.forEach((m) => {
                this.scene.remove(m);
                if (m.geometry) m.geometry.dispose();
            });
            this._mechHoleMeshes = [];
        }

        // Clear data arrays
        this._outlineMeshes = [];
        this._markerMeshes = [];
        this._pinBorderLines = [];
        this._componentExtras = [];
        this._componentLabels = [];
        this._silkscreenLabels = [];
        this._netHiddenMarkers = [];
        this.dualOutline = null;
        this.sideMode = 'both';
        // Reset scene rotation so a fresh board doesn't inherit the
        // previous board's orientation.
        this.rotationDeg = 0;
        this.scene.rotation.z = 0;
        this._pinInstanceData = [];
        this._viaInstanceData = [];
        this._testPadInstanceData = [];
        this._hoverableItems = [];
        this._spatialGrid = {};

        // Remove component groups
        this.meshGroups.components.forEach(m => this.scene.remove(m));
        this.meshGroups.components = [];
        this.meshGroups.traces.forEach(m => this.scene.remove(m));
        this.meshGroups.traces = [];

        // Remove all remaining children
        while (this.scene.children.length > 0) {
            this.scene.remove(this.scene.children[0]);
        }

        this.selectedItem = null;
        this.hoveredItem = null;
    }
};
