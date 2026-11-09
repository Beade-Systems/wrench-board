/** Overlays operations on the shared PCB viewer state. */

export const overlaysMethods = {

    // ========================================================================
    // AGENT OVERLAY API — driven by bv_* tool events through pcb_viewer_bridge.
    // All distances inbound here are in millimetres (the viewer's world units).
    // The bridge converts mil-based event payloads before calling these.
    // ========================================================================

    /**
     * Lookup a component or pin by refdes from the existing hover index.
     * Returns the first match, preferring an actual component over a
     * pin-as-id (rare). Used by the bridge's bv_focus / bv_highlight /
     * bv_show_pin paths.
     */
    findItemByRefdes(refdes) {
        if (!refdes || !this._hoverableItems) return null;
        const target = String(refdes).trim();
        // Prefer the component's own group (no _instanceType set on it,
        // since createComponent pushes the bare comp object) over a pin.
        let best = null;
        for (const it of this._hoverableItems) {
            if (it.id !== target) continue;
            if (!it._instanceType) return it;  // it's a component
            if (!best) best = it;
        }
        return best;
    },


    /**
     * Toggle between the top and bottom faces. If currently in 'both',
     * pick the opposite of whatever face most of the camera centre lives
     * on (defaults to flipping to 'top' on first call). Mirrors the
     * legacy SVG renderer's flip semantics — a single agent gesture
     * swaps the visible side.
     */
    flipSide() {
        const next = this.sideMode === 'top' ? 'bottom'
                   : this.sideMode === 'bottom' ? 'top'
                   : 'top';  // 'both' → land on 'top' first
        if (typeof this.setSideMode === 'function') {
            this.setSideMode(next);
        }
        this.requestRender();
    },


    /**
     * Place a small label sprite pinned above a component, tracked under
     * `id` so subsequent calls / a reset_view can remove it. Replaces
     * any existing annotation with the same id (the backend reuses ids
     * when the agent revises a label).
     */
    addAnnotation(refdes, label, id) {
        if (!id) id = `ann-${Math.random().toString(36).slice(2, 10)}`;
        // Drop a previous annotation with the same id so callers can
        // edit-in-place without leaking sprites into the scene.
        this.removeAnnotation(id);
        const item = this.findItemByRefdes(refdes);
        if (!item) return;
        const text = String(label || '').trim();
        if (!text) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = document.createElement('canvas');
        canvas.width = 512 * dpr;
        canvas.height = 96 * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        // Pill background — bg-deep glass with a cyan rim, matching the
        // chat-callout aesthetic. Width auto-fits the rendered text.
        ctx.font = "600 28px 'Inter', system-ui, sans-serif";
        const metrics = ctx.measureText(text);
        const padX = 14, padY = 8;
        const tw = Math.min(metrics.width, 484) + padX * 2;
        const th = 40;
        const bx = (256 - tw / 2);
        const by = 48 - th / 2;
        ctx.fillStyle = 'rgba(7, 16, 31, 0.92)';  // bg-deep
        ctx.strokeStyle = '#67d4f5';              // cyan accent
        ctx.lineWidth = 1.5;
        const r = 6;
        ctx.beginPath();
        ctx.moveTo(bx + r, by);
        ctx.lineTo(bx + tw - r, by);
        ctx.quadraticCurveTo(bx + tw, by, bx + tw, by + r);
        ctx.lineTo(bx + tw, by + th - r);
        ctx.quadraticCurveTo(bx + tw, by + th, bx + tw - r, by + th);
        ctx.lineTo(bx + r, by + th);
        ctx.quadraticCurveTo(bx, by + th, bx, by + th - r);
        ctx.lineTo(bx, by + r);
        ctx.quadraticCurveTo(bx, by, bx + r, by);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#e2e8f0';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 256, 48, 484);

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
        });
        const sprite = new THREE.Sprite(material);
        // Anchor just above the component's top edge. item.x/item.y is the
        // centre (set by createComponent), so back out half-height to get the
        // top. The label used to render at a STATIC ~1.5 mm world height, so it
        // collapsed to a few unreadable pixels whenever the board was zoomed
        // out — you had to zoom in to read it. Instead size + position it in
        // SCREEN PIXELS and rebuild that on every zoom
        // (`_updateAgentAnnotationScale`), the same fixed-pixel approach as the
        // refdes labels and the arrows.
        sprite.position.x = item.x;
        sprite.position.z = 8;
        sprite.userData = {
            _agentAnnotation: id,
            _side: item._side || null,
            _annAspect: canvas.width / canvas.height,
            _annTopY: item.y + (item.height || 1) / 2,
        };
        this._layoutAgentAnnotation(sprite, this._agentArrowPixelSize());
        this.scene.add(sprite);
        this._agentAnnotations.set(id, { sprite, refdes, label: text });
        this.requestRender();
    },


    /**
     * Size + position one agent annotation for the current zoom. The pill is
     * held at a constant ON-SCREEN height (readable at any zoom, like a map
     * label) and pinned just above its component's top edge. The source canvas
     * is 512×96 with the pill band filling ~40/96 of the height, so the sprite
     * (which spans the full canvas) scales to `PILL_PX × 96/40` and the anchor
     * backs out half the pill band so its bottom hovers over — not on — the body.
     */
    _layoutAgentAnnotation(sprite, pixelSize) {
        const PILL_PX = 26;            // on-screen height of the visible pill band
        const CANVAS_RATIO = 96 / 40;  // full sprite height ÷ pill-band height
        const GAP_PX = 6;              // breathing room above the component
        const aspect = sprite.userData._annAspect || (512 / 96);
        const worldH = PILL_PX * CANVAS_RATIO * pixelSize;
        sprite.scale.set(worldH * aspect, worldH, 1);
        sprite.position.y = sprite.userData._annTopY + (GAP_PX + PILL_PX / 2) * pixelSize;
    },


    /** Keep every agent annotation at a constant on-screen size as zoom changes. */
    _updateAgentAnnotationScale() {
        if (!this._agentAnnotations || !this._agentAnnotations.size) return;
        const pixelSize = this._agentArrowPixelSize();
        for (const { sprite } of this._agentAnnotations.values()) {
            this._layoutAgentAnnotation(sprite, pixelSize);
        }
    },


    removeAnnotation(id) {
        const entry = this._agentAnnotations.get(id);
        if (!entry) return;
        this.scene.remove(entry.sprite);
        if (entry.sprite.material) {
            if (entry.sprite.material.map) entry.sprite.material.map.dispose();
            entry.sprite.material.dispose();
        }
        this._agentAnnotations.delete(id);
        this.requestRender();
    },


    clearAgentAnnotations() {
        for (const id of Array.from(this._agentAnnotations.keys())) {
            this.removeAnnotation(id);
        }
    },


    /**
     * Paint a numbered badge sprite per protocol step above the step's
     * target component. The active step (`currentId`) gets a saturated
     * cyan halo; pending/done steps render in muted cyan; failed/skipped
     * in amber. `steps` is an array of { id, target, status } objects
     * from `protocol.js`. Multiple steps targeting the same refdes are
     * stacked vertically (newer steps climb upward) so each step keeps
     * its own visible badge — mirrors the SVG renderer's grouping in
     * brd_viewer.js:702-764.
     *
     * Re-painted in full on every call (no diff). Old badges are dropped
     * via clearProtocolBadges() before the new set is laid down so a
     * mid-protocol revision (status flip, current_step_id change) lands
     * cleanly without leaking sprites or textures.
     */
    setProtocolBadges(steps, currentId) {
        this.clearProtocolBadges();
        if (!Array.isArray(steps) || steps.length === 0) return;

        // Group by target refdes so steps sharing a part stack vertically.
        const grouped = new Map();   // refdes → [{ step, displayIndex }]
        for (let i = 0; i < steps.length; i++) {
            const st = steps[i];
            if (!st || !st.target) continue;
            const arr = grouped.get(st.target) || [];
            arr.push({ step: st, displayIndex: i + 1 });
            grouped.set(st.target, arr);
        }

        const cyan = '#' + (this.tokens.cyan || 0x67d4f5).toString(16).padStart(6, '0');
        const amber = '#' + (this.tokens.amber || 0xe8b85a).toString(16).padStart(6, '0');
        const bgDeep = '#' + (this.tokens.bgDeep || 0x07101f).toString(16).padStart(6, '0');

        for (const [refdes, group] of grouped) {
            const item = this.findItemByRefdes(refdes);
            if (!item) continue;
            const halfH = (item.height || 1) / 2;
            // First badge sits ~1.5 mm above the bbox top edge; later
            // badges climb in 2 mm increments (matches SVG's 22-px stack
            // gap at typical zoom).
            for (let k = 0; k < group.length; k++) {
                const { step: st, displayIndex } = group[k];
                const isActive = st.id === currentId;
                const isDone   = st.status === 'done';
                const isFail   = st.status === 'failed';
                const isSkip   = st.status === 'skipped';
                const fill     = (isFail || isSkip) ? amber : cyan;
                const glyph    = isDone ? '✓'
                              : isFail ? '✗'
                              : isSkip ? '·'
                              : String(displayIndex);

                // Canvas-texture pattern (same as addAnnotation): a small
                // square texture, drawn with DPR scaling, then mapped to
                // a Sprite sized in world (mm) units.
                const dpr = Math.min(window.devicePixelRatio || 1, 2);
                const canvasSize = 64;
                const canvas = document.createElement('canvas');
                canvas.width = canvasSize * dpr;
                canvas.height = canvasSize * dpr;
                const ctx = canvas.getContext('2d');
                ctx.scale(dpr, dpr);

                const cx = canvasSize / 2;
                const cy = canvasSize / 2;

                // Active step: outer halo ring before the solid disc, so
                // it reads as "this is the one to do now" at a glance.
                if (isActive) {
                    ctx.fillStyle = fill;
                    ctx.globalAlpha = 0.35;
                    ctx.beginPath();
                    ctx.arc(cx, cy, 22, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.globalAlpha = 1.0;
                }

                ctx.fillStyle = fill;
                if (isDone && !isActive) ctx.globalAlpha = 0.7;
                ctx.beginPath();
                ctx.arc(cx, cy, 14, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1.0;

                ctx.fillStyle = bgDeep;
                ctx.font = "600 18px 'JetBrains Mono', monospace";
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(glyph, cx, cy + 1);

                const texture = new THREE.CanvasTexture(canvas);
                texture.minFilter = THREE.LinearFilter;
                texture.magFilter = THREE.LinearFilter;
                const material = new THREE.SpriteMaterial({
                    map: texture,
                    transparent: true,
                    depthTest: false,
                });
                const sprite = new THREE.Sprite(material);

                // Stack offset: 2 mm per slot above the bbox top.
                const offsetY = halfH + 1.5 + k * 2.0;
                sprite.position.set(item.x, item.y + offsetY, 9);
                // Badge size in world (mm) units. ~2 mm wide reads at
                // typical diagnostic zoom without dwarfing 0402s.
                sprite.scale.set(2.2, 2.2, 1);
                sprite.userData = { _protocolStep: st.id, _side: item._side || null };
                this.scene.add(sprite);
                this._protocolBadges.set(st.id, { sprite, refdes });
            }
        }
        this.requestRender();
    },


    /**
     * Drop every protocol badge sprite, dispose textures, and clear the
     * tracking Map. Called by setProtocolBadges before a repaint and by
     * protocol.js when the protocol ends / aborts.
     */
    clearProtocolBadges() {
        for (const [, entry] of this._protocolBadges) {
            this.scene.remove(entry.sprite);
            if (entry.sprite.material) {
                if (entry.sprite.material.map) entry.sprite.material.map.dispose();
                entry.sprite.material.dispose();
            }
        }
        this._protocolBadges.clear();
        this.requestRender();
    },


    /**
     * Project a refdes's part bbox-top centre through the camera and
     * return the result in viewport (page) pixel coordinates so callers
     * (e.g. protocol.js's floating refdes chip) can position a CSS
     * absolute-positioned element on top of the WebGL canvas. Returns
     * null when the refdes is not in the current board, when the part
     * is on the hidden face, or when the projected NDC is outside
     * [-1, 1] (off-screen).
     */
    refdesScreenPos(refdes) {
        if (!refdes) return null;
        const item = this.findItemByRefdes(refdes);
        if (!item) return null;
        // Hidden-face culling: when the user has constrained to one side,
        // the part is invisible and a screen-pos answer would point at
        // empty space. brd_viewer.js skips badge rendering on the hidden
        // side too — same rule here.
        if (item._side && this.sideMode !== 'both' && item._side !== this.sideMode) {
            return null;
        }
        // Build a world-space point at the bbox top-centre. Items live
        // in scene-local coords; the scene rotation (this.scene.rotation.z)
        // is baked into world by Three.js's matrix update on render, so
        // we let `Vector3.project(camera)` walk the full chain.
        const halfH = (item.height || 0) / 2;
        const localX = item.x;
        const localY = item.y + halfH;
        // Apply scene rotation manually since the scene's matrix may not
        // be up to date yet on the very first frame after a setSideMode
        // / rotate. updateMatrixWorld() makes the projection robust.
        this.scene.updateMatrixWorld();
        const v = new THREE.Vector3(localX, localY, 0);
        v.applyMatrix4(this.scene.matrixWorld);
        v.project(this.camera);
        // Off-screen guard — treat NDC outside [-1, 1] as "not visible"
        // so callers can hide the chip rather than pinning it to a canvas
        // edge.
        if (v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) return null;
        const rect = this.canvas.getBoundingClientRect();
        const x = rect.left + (v.x * 0.5 + 0.5) * rect.width;
        const y = rect.top  + (v.y * -0.5 + 0.5) * rect.height;
        return { x, y };
    },


    /**
     * Highlight every pin on `netName` and dim the rest. Uses the
     * existing user-side highlightNet() pipeline by selecting an
     * arbitrary pin on the net first, then triggering the same code
     * path the inspector net-row click runs. Falls back to a no-op if
     * no pin matches the name.
     */
    highlightNetByName(netName) {
        if (!netName) return;
        const target = String(netName).trim();
        if (!target || target === 'NC') return;
        // Find the first pin / test-pad on this net and route through
        // the existing select+highlight chain so the dim + fly-line +
        // trace-recolour pipeline runs identically to a user click.
        const anchor = (this._hoverableItems || []).find((it) => {
            const t = it._instanceType;
            return (t === 'pin' || t === 'rectPin' || t === 'testPad')
                && it.net === target;
        });
        if (!anchor) return;
        if (typeof this.selectItem === 'function') {
            this.selectItem(anchor);
        }
        if (typeof this.highlightNet === 'function') {
            this.highlightNet();
        }
        this.requestRender();
    },


    /**
     * Move the camera to a specific pin position (mils → mm conversion
     * already applied by the caller) and select the parent component
     * so the inspector populates and the cyan halo paints. Used by
     * bv_show_pin to direct the tech to a specific probe point.
     */
    showPinAt(refdes, posMm) {
        if (!refdes) return;
        const item = this.findItemByRefdes(refdes);
        if (!item) return;
        if (typeof this.selectItem === 'function') {
            this.selectItem(item);
        }
        // Centre on the pin position when supplied, otherwise on the
        // component centre. Tighten zoom so the pin reads clearly.
        const cx = (posMm && Number.isFinite(posMm.x)) ? posMm.x : item.x;
        const cy = (posMm && Number.isFinite(posMm.y)) ? posMm.y : item.y;
        this.camera.position.x = cx;
        this.camera.position.y = cy;
        const longSide = Math.max(item.width || 4, item.height || 4);
        this.frustumSize = Math.max(longSide * 8, 12);
        this.zoom = 100 / this.frustumSize;
        if (this.onResize) this.onResize();
        this.requestRender();
    },


    /**
     * Draw a directional arrow from one component centre to another in
     * world coordinates (mm). Tracks the resulting Group under `id` so
     * a future event or reset_view can drop it cleanly. Renders the
     * shaft as a Line and the head as two short converging Lines so it
     * stays sharp under the orthographic camera at any zoom.
     */
    addAgentArrow(fromMm, toMm, id) {
        if (!id) id = `arr-${Math.random().toString(36).slice(2, 10)}`;
        this.removeAgentArrow(id);
        if (!fromMm || !toMm) return;
        if (Math.hypot(toMm.x - fromMm.x, toMm.y - fromMm.y) < 0.01) return;

        // A WebGL `Line` ignores `linewidth` on virtually every platform, so the
        // old arrow was a 1px hairline shaft tipped with an open 1px "V" — it
        // barely read as an arrow. Build it as a filled 2D mesh instead
        // (rectangular shaft + solid triangular head + a soft halo), crisp under
        // the orthographic camera. All cross-axis sizes are screen-pixel constant
        // (see `_layoutAgentArrow`): the geometry is rebuilt on zoom by
        // `_updateAgentArrowScale` so the arrow keeps the same slim weight on
        // screen regardless of zoom — only its length tracks the board.
        const group = new THREE.Group();
        const halo = new THREE.Mesh(
            new THREE.ShapeGeometry(new THREE.Shape()),
            new THREE.MeshBasicMaterial({ color: 0x7c3aed, transparent: true, opacity: 0.32, depthTest: false }),
        );
        halo.position.z = 5.9;
        halo.renderOrder = 10;
        const body = new THREE.Mesh(
            new THREE.ShapeGeometry(new THREE.Shape()),
            new THREE.MeshBasicMaterial({ color: 0xc084fc, transparent: true, opacity: 0.98, depthTest: false }),
        );
        body.position.z = 6;
        body.renderOrder = 11;
        group.add(halo);
        group.add(body);

        group.userData = {
            _agentArrow: id,
            fromMm: { x: fromMm.x, y: fromMm.y },
            toMm: { x: toMm.x, y: toMm.y },
            body,
            halo,
        };
        this._layoutAgentArrow(group, this._agentArrowPixelSize());

        this.scene.add(group);
        this._agentArrows.set(id, group);
        this.requestRender();
    },


    /** World units per screen pixel at the current zoom (mm/px). */
    _agentArrowPixelSize() {
        const h = (this.container && this.container.clientHeight) || 800;
        return this.frustumSize / h;
    },


    /**
     * (Re)build an agent arrow's geometry for the current zoom. The arrow is
     * authored in a local frame running along +X from the (inset) source to the
     * tip, then the whole group is rotated to the real heading and dropped at the
     * source. Cross-axis dimensions (shaft thickness, head size, insets) are in
     * SCREEN PIXELS × pixelSize, so they stay visually constant at any zoom;
     * only the shaft LENGTH follows the real board distance. If the two parts
     * sit closer than the head can fit, the arrow hides itself until zoom-in.
     */
    _layoutAgentArrow(group, pixelSize) {
        const { fromMm, toMm, body, halo } = group.userData;
        const dx = toMm.x - fromMm.x;
        const dy = toMm.y - fromMm.y;
        const len = Math.hypot(dx, dy);
        if (len < 0.01) { group.visible = false; return; }
        const ux = dx / len;
        const uy = dy / len;

        // Target on-screen weights (px) → world units. Slim, sharp, well-balanced.
        const shaftHalf  = 1.1 * pixelSize;   // ~2.2 px shaft
        const headLen    = 11  * pixelSize;   // tip length
        const headHalf   = 5   * pixelSize;   // ~10 px head base
        const haloOut     = 1.2 * pixelSize;  // halo outset
        const tipInset   = 7   * pixelSize;   // breathe off the target centre
        const startInset = 4   * pixelSize;   // breathe off the source centre

        const drawLen = len - tipInset - startInset;
        if (drawLen <= headLen * 1.15) { group.visible = false; return; }  // parts too close on screen
        group.visible = true;
        const shaftEnd = drawLen - headLen;

        const buildGeom = (out) => {
            const s = new THREE.Shape();
            s.moveTo(-out,           shaftHalf + out);
            s.lineTo(shaftEnd,       shaftHalf + out);
            s.lineTo(shaftEnd,       headHalf + out);
            s.lineTo(drawLen + out,  0);            // tip
            s.lineTo(shaftEnd,      -headHalf - out);
            s.lineTo(shaftEnd,      -shaftHalf - out);
            s.lineTo(-out,          -shaftHalf - out);
            s.closePath();
            return new THREE.ShapeGeometry(s);
        };

        body.geometry.dispose();
        body.geometry = buildGeom(0);
        halo.geometry.dispose();
        halo.geometry = buildGeom(haloOut);

        group.position.set(fromMm.x + ux * startInset, fromMm.y + uy * startInset, 0);
        group.rotation.z = Math.atan2(uy, ux);
    },


    /** Keep every agent arrow at a constant on-screen weight as zoom changes. */
    _updateAgentArrowScale() {
        if (!this._agentArrows || !this._agentArrows.size) return;
        const pixelSize = this._agentArrowPixelSize();
        for (const group of this._agentArrows.values()) {
            this._layoutAgentArrow(group, pixelSize);
        }
    },


    removeAgentArrow(id) {
        const group = this._agentArrows.get(id);
        if (!group) return;
        group.traverse((obj) => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) obj.material.dispose();
        });
        this.scene.remove(group);
        this._agentArrows.delete(id);
        this.requestRender();
    },


    clearAgentArrows() {
        for (const id of Array.from(this._agentArrows.keys())) {
            this.removeAgentArrow(id);
        }
    },


    /**
     * Draw a measurement line + distance label between two components.
     * Stored under `id` for later removal. The label text is provided
     * by the caller (typically the agent already computed mm and ships
     * it in the WS event), so this method just renders.
     */
    addMeasurement(fromRefdes, toRefdes, label, id) {
        if (!id) id = `mes-${Math.random().toString(36).slice(2, 10)}`;
        this.removeMeasurement(id);
        const a = this.findItemByRefdes(fromRefdes);
        const b = this.findItemByRefdes(toRefdes);
        if (!a || !b) return;

        const color = 0xfbbf24;  // amber — measurement / informational
        const mat = new THREE.LineBasicMaterial({
            color, transparent: true, opacity: 0.9, depthTest: false,
        });
        const group = new THREE.Group();
        const lineGeom = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(a.x, a.y, 5),
            new THREE.Vector3(b.x, b.y, 5),
        ]);
        group.add(new THREE.Line(lineGeom, mat));

        const text = String(label || '').trim();
        if (text) {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const canvas = document.createElement('canvas');
            canvas.width = 256 * dpr;
            canvas.height = 64 * dpr;
            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);
            ctx.font = "600 26px 'JetBrains Mono', monospace";
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const metrics = ctx.measureText(text);
            const tw = Math.min(metrics.width, 232) + 20;
            ctx.fillStyle = 'rgba(7, 16, 31, 0.9)';
            ctx.strokeStyle = '#fbbf24';
            ctx.lineWidth = 1.4;
            const bx = 128 - tw / 2, by = 32 - 16, th = 32, r = 5;
            ctx.beginPath();
            ctx.moveTo(bx + r, by);
            ctx.lineTo(bx + tw - r, by);
            ctx.quadraticCurveTo(bx + tw, by, bx + tw, by + r);
            ctx.lineTo(bx + tw, by + th - r);
            ctx.quadraticCurveTo(bx + tw, by + th, bx + tw - r, by + th);
            ctx.lineTo(bx + r, by + th);
            ctx.quadraticCurveTo(bx, by + th, bx, by + th - r);
            ctx.lineTo(bx, by + r);
            ctx.quadraticCurveTo(bx, by, bx + r, by);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#fde68a';
            ctx.fillText(text, 128, 32, 232);

            const texture = new THREE.CanvasTexture(canvas);
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
                map: texture, transparent: true, depthTest: false,
            }));
            sprite.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, 7);
            const aspect = canvas.width / canvas.height;
            const baseH = 1.2;
            sprite.scale.set(baseH * aspect, baseH, 1);
            group.add(sprite);
        }

        group.userData = { _agentMeasurement: id };
        this.scene.add(group);
        this._agentMeasurements.set(id, group);
        this.requestRender();
    },


    removeMeasurement(id) {
        const group = this._agentMeasurements.get(id);
        if (!group) return;
        group.traverse((obj) => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
                if (obj.material.map) obj.material.map.dispose();
                obj.material.dispose();
            }
        });
        this.scene.remove(group);
        this._agentMeasurements.delete(id);
        this.requestRender();
    },


    clearAgentMeasurements() {
        for (const id of Array.from(this._agentMeasurements.keys())) {
            this.removeMeasurement(id);
        }
    },


    /**
     * Apply / clear a refdes-prefix filter. When set, every component
     * whose id does not start with the prefix has its outline group
     * hidden, its refdes label sprite hidden, and its pins zero-scaled
     * out of the shared InstancedMesh slots (same idiom the DNP toggle
     * uses — see `_applySideToInstanced`). Filter axes compose with AND:
     * a pin is visible iff (side OK) AND (DNP OK) AND (refdes prefix OK).
     * Clearing the filter restores all three classes from their saved
     * `_matrices` / per-sprite zoom-aware visibility path.
     */
    setRefdesFilter(prefix) {
        const p = prefix ? String(prefix).trim().toUpperCase() : null;
        this._agentFilterPrefix = p || null;
        this._applyRefdesFilter();
        this.requestRender();
    },


    _applyRefdesFilter() {
        const p = this._agentFilterPrefix;
        const allow = (id) => !p || (id && id.toUpperCase().startsWith(p));
        // Component groups
        if (this.meshGroups && Array.isArray(this.meshGroups.components)) {
            for (const g of this.meshGroups.components) {
                const ud = g.userData || {};
                // Honour the side filter as before — only override the
                // visibility on the prefix axis when the side filter
                // would have allowed the part.
                const sideOk = (this.sideMode === 'both' || !ud._side
                    || ud._side === this.sideMode);
                g.visible = sideOk && allow(ud.id);
            }
        }
        // Pin / pad InstancedMeshes — `_applySideToInstanced` now ANDs
        // in `this._agentFilterPrefix` against each slot's stored
        // `_components[i]`, so a single pass per mesh recomputes the
        // composite (side AND DNP AND refdes) visibility. Same idiom as
        // setShowDnp uses.
        this._applySideToInstanced(this._circularPinInstance);
        this._applySideToInstanced(this._circularPinBorderInstance);
        if (this._rectPinInstances) {
            this._rectPinInstances.forEach(({ body }) => {
                this._applySideToInstanced(body);
            });
        }
        this._applySideToInstanced(this._testPadsInstance);
        if (this._testPadsBorderInstance) {
            this._applySideToInstanced(this._testPadsBorderInstance);
        }
        // Per-pin rect borders are individual Lines — flip their
        // visibility against the composite (side + DNP + refdes) gate.
        if (Array.isArray(this._pinBorderLines)) {
            const sideAllow = (side) => this.sideMode === 'both'
                || side == null
                || side === this.sideMode;
            for (const m of this._pinBorderLines) {
                const ud = m.userData || {};
                const sideOk = sideAllow(ud._side);
                const dnpOk = !ud._isDnp || this._showDnp;
                const refOk = allow(ud._component);
                m.visible = sideOk && dnpOk && refOk;
            }
        }
        // Refdes labels — gate by side AND prefix. The zoom-aware
        // updater below decides the final visibility based on screen
        // size, so we delegate to it whenever the prefix permits the
        // sprite (it already honours side + DNP + zoom).
        if (Array.isArray(this._componentLabels)) {
            for (const sprite of this._componentLabels) {
                const ud = sprite.userData || {};
                if (!allow(ud._refdes)) {
                    sprite.visible = false;
                }
            }
            if (typeof this._updateComponentLabelVisibility === 'function') {
                this._updateComponentLabelVisibility();
            }
        }
    },


    /**
     * Dim every component / pin not currently selected or highlighted
     * by the agent. The current `selectedItem` and any ongoing net
     * highlight stay full-bright. Mirrors the legacy SVG dim_unrelated
     * behaviour at the InstancedMesh level by lowering the unrelated
     * components' group opacity. Pins fall under the existing
     * `_dimUnrelatedPins(netName)` path when a net is active; with no
     * net this is a body-only dim, which is the SVG renderer's
     * behaviour too.
     */
    dimUnrelated() {
        this._agentDimActive = true;
        // Components: drop opacity on every group whose id is not the
        // selected item AND not on the current net's anchor refdes.
        const selId = this.selectedItem ? this.selectedItem.id : null;
        const selRefdes = this.selectedItem
            ? (this.selectedItem.component || this.selectedItem.id)
            : null;
        if (this.meshGroups && Array.isArray(this.meshGroups.components)) {
            for (const g of this.meshGroups.components) {
                const ud = g.userData || {};
                const keep = (ud.id === selId) || (ud.id === selRefdes);
                g.traverse((m) => {
                    if (!m.material) return;
                    // First time we touch the material, snapshot the
                    // pre-dim state so clearDim can restore precisely.
                    if (m.material._origOpacity == null) {
                        m.material._origOpacity = m.material.opacity == null ? 1 : m.material.opacity;
                        m.material._origTransparent = !!m.material.transparent;
                    }
                    if (!keep) {
                        m.material.transparent = true;
                        m.material.opacity = 0.18;
                    } else {
                        m.material.transparent = m.material._origTransparent;
                        m.material.opacity = m.material._origOpacity;
                    }
                    m.material.needsUpdate = true;
                });
            }
        }
        this.requestRender();
    },


    clearDim() {
        if (!this._agentDimActive) return;
        this._agentDimActive = false;
        if (this.meshGroups && Array.isArray(this.meshGroups.components)) {
            for (const g of this.meshGroups.components) {
                g.traverse((m) => {
                    if (!m.material) return;
                    if (m.material._origOpacity != null) {
                        m.material.opacity = m.material._origOpacity;
                        m.material.transparent = !!m.material._origTransparent;
                        delete m.material._origOpacity;
                        delete m.material._origTransparent;
                        m.material.needsUpdate = true;
                    }
                });
            }
        }
        this.requestRender();
    },


    /**
     * Toggle a single layer's visibility. The viewer's primary
     * face filter is `setSideMode('top'|'bottom'|'both')`, so map
     * (layer, visible) → side mode by treating "show top, hide
     * bottom" / "hide top, show bottom" as a side flip and otherwise
     * returning to 'both'.
     */
    setLayerVisibility(layer, visible) {
        if (layer !== 'top' && layer !== 'bottom') return;
        const other = layer === 'top' ? 'bottom' : 'top';
        // Maintain a per-layer flag so two consecutive calls (e.g. hide
        // top, then hide bottom) collapse to the right composite mode.
        if (!this._layerVisible) this._layerVisible = { top: true, bottom: true };
        this._layerVisible[layer] = !!visible;
        const anyVisible = this._layerVisible.top || this._layerVisible.bottom;
        if (!anyVisible) {
            // Both hidden — fall back to 'both' so the user isn't
            // staring at an empty canvas. This is a degenerate request.
            this.setSideMode('both');
            return;
        }
        if (this._layerVisible.top && this._layerVisible.bottom) {
            this.setSideMode('both');
        } else {
            this.setSideMode(this._layerVisible.top ? 'top' : 'bottom');
        }
    },


    /**
     * Reset every agent-driven overlay in one shot. Called by the
     * bv_reset_view path. Leaves the user's selection, the side mode,
     * and the camera position intact — the SVG renderer's reset has
     * the same scope.
     */
    resetAgentOverlays() {
        this.clearAgentAnnotations();
        this.clearAgentArrows();
        this.clearAgentMeasurements();
        this.clearProtocolBadges();
        this.clearDim();
        if (this._agentFilterPrefix) {
            this.setRefdesFilter(null);
        }
    }
};
