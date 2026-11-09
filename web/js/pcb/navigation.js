/** Navigation operations on the shared PCB viewer state. */

export const navigationMethods = {

    // ========================
    // UI CONTROLS
    // ========================

    toggleLayer(layer) {
        this.layers[layer] = !this.layers[layer];
        const btn = document.getElementById(`layer-${layer}`);

        if (this.layers[layer]) {
            btn.classList.remove('bg-dark-600', 'text-gray-400', 'border-dark-500');
            btn.classList.add(
                layer === 'top' ? 'bg-blue-500/20' : 'bg-red-500/20',
                layer === 'top' ? 'text-blue-400' : 'text-red-400',
                layer === 'top' ? 'border-blue-500/30' : 'border-red-500/30'
            );
        } else {
            btn.classList.remove('bg-blue-500/20', 'bg-red-500/20', 'text-blue-400', 'text-red-400', 'border-blue-500/30', 'border-red-500/30');
            btn.classList.add('bg-dark-600', 'text-gray-400', 'border-dark-500');
        }

        // Update component visibility
        this.meshGroups.components.forEach(mesh => {
            const meshLayer = mesh.userData.layer;
            if (meshLayer === layer) {
                mesh.visible = this.layers[layer];
            } else if (meshLayer === 'both') {
                mesh.visible = this.layers.top || this.layers.bottom;
            }
        });

        // For instanced meshes, we'd need to update visibility per-instance
        // For now, we rely on hover filtering by layer
        this.requestRender();
    },


    toggleVias() {
        this.showVias = !this.showVias;
        const btn = document.getElementById('toggle-vias');

        if (this.showVias) {
            btn.classList.remove('bg-dark-600', 'text-gray-400', 'border-dark-500');
            btn.classList.add('bg-fuchsia-500/20', 'text-fuchsia-400', 'border-fuchsia-500/30');
        } else {
            btn.classList.remove('bg-fuchsia-500/20', 'text-fuchsia-400', 'border-fuchsia-500/30');
            btn.classList.add('bg-dark-600', 'text-gray-400', 'border-dark-500');
        }

        if (this._viasOuterInstance) this._viasOuterInstance.visible = this.showVias;
        if (this._viasInnerInstance) this._viasInnerInstance.visible = this.showVias;
        this.requestRender();
    },


    toggleTraces() {
        // Pure model toggle — the bridge owns the button styling and
        // owns it under the current design system (`brdToggleTraces`,
        // `active` class). Old code here referenced a legacy
        // `toggle-traces` id with Tailwind orange/dark classes that no
        // longer exist, which crashed the new toolbar button.
        this.showTraces = !this.showTraces;
        this.meshGroups.traces.forEach(t => t.visible = this.showTraces);
        this.requestRender();
    },


    flipBoard() {
        // Legacy left/right mirror (BRD format chrome). Independent of
        // the rotation state — multiplies into scene.scale.x.
        this.isFlipped = !this.isFlipped;
        this.scene.scale.x = this.isFlipped ? -1 : 1;
        const btn = document.getElementById('flip-board');
        if (btn) btn.classList.toggle('active', this.isFlipped);
        this.requestRender();
    },


    rotateLeft() {
        // CCW from the viewer's POV: +90° around Z, which visually
        // tips the board's top edge toward the left of the screen.
        this.rotationDeg = (this.rotationDeg + 90) % 360;
        this._applyTransform();
    },


    rotateRight() {
        // CW: -90° (equivalently +270° mod 360).
        this.rotationDeg = (this.rotationDeg + 270) % 360;
        this._applyTransform();
    },


    /**
     * Apply the rotation to the scene root, then recentre the camera
     * on the side-mode bbox through the same rotation so the visible
     * content stays roughly under the cursor.
     */
    _applyTransform() {
        this.scene.rotation.z = this.rotationDeg * Math.PI / 180;
        this._recentreOnSideMode();
        this.requestRender();
    },


    // ========================
    // DUAL VIEW (simplified for now)
    // ========================

    toggleDualView() {
        if (!this.boardData) return;

        this.isDualView = !this.isDualView;
        const btn = document.getElementById('dual-view');

        if (this.isDualView) {
            btn.classList.remove('bg-dark-600', 'text-gray-400', 'border-dark-500');
            btn.classList.add('bg-green-500/20', 'text-green-400', 'border-green-500/30');
            this.createDualViewGroup();
        } else {
            btn.classList.remove('bg-green-500/20', 'text-green-400', 'border-green-500/30');
            btn.classList.add('bg-dark-600', 'text-gray-400', 'border-dark-500');
            this.removeDualViewGroup();
        }

        this.centerDualView();
        this.requestRender();
    },


    createDualViewGroup() {
        // Simplified dual view - just add labels for now
        // Full dual view with instanced meshes would require more complex handling
        if (!this.boardData) return;

        const data = this.boardData;
        const boardWidth = data.board_width;
        const boardHeight = data.board_height;
        const gap = boardWidth * 0.15;
        const offsetX = data.board_offset_x || 0;
        const offsetY = data.board_offset_y || 0;

        // TOP label
        const topCanvas = document.createElement('canvas');
        const topCtx = topCanvas.getContext('2d');
        topCanvas.width = 128;
        topCanvas.height = 48;
        topCtx.fillStyle = 'rgba(59, 130, 246, 0.8)';
        topCtx.roundRect(4, 4, 120, 40, 8);
        topCtx.fill();
        topCtx.fillStyle = 'white';
        topCtx.font = 'bold 24px Inter, Arial';
        topCtx.textAlign = 'center';
        topCtx.textBaseline = 'middle';
        topCtx.fillText('TOP', 64, 24);

        const topTexture = new THREE.CanvasTexture(topCanvas);
        const topMat = new THREE.SpriteMaterial({ map: topTexture, transparent: true, depthTest: false });
        this.topLabel = new THREE.Sprite(topMat);
        const labelScale = boardWidth * 0.15;
        this.topLabel.scale.set(labelScale, labelScale * 0.375, 1);
        this.topLabel.position.set(offsetX + boardWidth / 2, offsetY + boardHeight + labelScale * 0.3, 10);
        this.scene.add(this.topLabel);
    },


    removeDualViewGroup() {
        if (this.topLabel) {
            this.scene.remove(this.topLabel);
            this.topLabel = null;
        }
        if (this.bottomLabel) {
            this.scene.remove(this.bottomLabel);
            this.bottomLabel = null;
        }
        if (this.dualViewGroup) {
            this.scene.remove(this.dualViewGroup);
            this.dualViewGroup = null;
        }
    },


    centerDualView() {
        if (!this.boardData) return;

        const data = this.boardData;
        const offsetX = data.board_offset_x || 0;
        const offsetY = data.board_offset_y || 0;

        this.camera.position.x = offsetX + data.board_width / 2;
        this.camera.position.y = offsetY + data.board_height / 2;
        this.frustumSize = Math.max(data.board_width, data.board_height) * 1.2;

        this.zoom = 100 / this.frustumSize;
        this.onResize();
        document.getElementById('zoom-level').textContent = Math.round(this.zoom * 100);
    },


    // ========================
    // SIDE FILTER (XZZ dual outline)
    // ========================

    /**
     * Switch between rendering only the top face, only the bottom face,
     * or both. Only takes effect when the board ships dual outline data
     * (XZZ side-by-side / stacked layout); on single-outline formats
     * every entity has `_side === null` and stays visible regardless.
     *
     * Camera is recentred and rezoomed to fit the visible bbox so the
     * tech doesn't lose the board off-screen between toggles.
     */
    setSideMode(mode, opts = {}) {
        if (mode !== 'top' && mode !== 'bottom' && mode !== 'both') return;
        const prevMode = this.sideMode;
        this.sideMode = mode;
        // Persist across reloads — the tech usually settles on a
        // preferred face and expects every subsequent board to come up
        // in the same mode rather than reset to 'both' on load.
        try { localStorage.setItem('pcb.sideMode', mode); } catch (_) {}
        // Reflect the mode on the toolbar segment so calls that come from
        // outside the bridge (e.g. fresh board load resetting to 'both')
        // keep the visual state in sync with the actual filter.
        const segMap = {
            top: 'brdLayerTop',
            both: 'brdLayerBoth',
            bottom: 'brdLayerBottom',
        };
        Object.entries(segMap).forEach(([m, id]) => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('active', m === mode);
        });
        const allow = (side) => mode === 'both' || side == null || side === mode;

        // Plain meshes — flip visibility directly. DNP-layer meshes
        // are gated by `_showDnp` instead of the side filter; skip
        // them here so they don't reappear when the board switches
        // back to "top" or any side mode.
        const dnp = (m) => m && m.userData && m.userData._dnpLayer;
        this._outlineMeshes.forEach((m) => { m.visible = allow(m.userData._side); });
        this._markerMeshes.forEach((m) => { m.visible = allow(m.userData._side); });
        this._pinBorderLines.forEach((m) => {
            if (dnp(m)) return;
            // Skip DNP-flagged borders when the toggle is off; otherwise
            // follow the side filter (and the refdes-prefix filter when
            // bv_filter_by_type is active) for any other pin border.
            if (m.userData && m.userData._isDnp && !this._showDnp) {
                m.visible = false;
                return;
            }
            const sideOk = allow(m.userData ? m.userData._side : null);
            const refOk = !this._agentFilterPrefix
                || (m.userData && m.userData._component
                    && m.userData._component.toUpperCase()
                        .startsWith(this._agentFilterPrefix));
            m.visible = sideOk && refOk;
        });
        this._componentExtras.forEach((m) => {
            if (dnp(m)) return;
            m.visible = allow(m.userData._side);
        });
        const prefix = this._agentFilterPrefix;
        const refdesOk = (id) => !prefix
            || (id && id.toUpperCase().startsWith(prefix));
        this.meshGroups.components.forEach((m) => {
            if (dnp(m)) return;
            m.visible = allow(m.userData._side) && refdesOk(m.userData.id);
        });
        this.meshGroups.traces.forEach((m) => {
            const isOutline = m.userData && m.userData.layer === 28;
            // Outline traces are tied to the per-face polygon and follow
            // the side filter; copper traces follow the trace toggle too.
            const sideOk = allow(m.userData ? m.userData._side : null);
            m.visible = sideOk && (isOutline ? true : this.showTraces);
        });
        // Silkscreen labels (0-pin parts: BADGE / LOGO / region tags)
        // — visibility is driven solely by the side filter; they have
        // no zoom threshold. Refdes labels (`_componentLabels`) get
        // re-evaluated by `_updateComponentLabelVisibility()` below.
        this._silkscreenLabels.forEach((s) => {
            s.visible = allow(s.userData ? s.userData._side : null);
        });

        // InstancedMesh — zero-scale unwanted instances. The original
        // matrices are stashed in userData._matrices at build time.
        // DNP-layer meshes are gated by `_showDnp` instead of the side
        // filter; skip them here.
        this._applySideToInstanced(this._circularPinInstance);
        this._applySideToInstanced(this._circularPinBorderInstance);
        this._rectPinInstances.forEach(({ body }) => {
            if (dnp(body)) return;
            this._applySideToInstanced(body);
        });
        this._applySideToInstanced(this._viasOuterInstance);
        this._applySideToInstanced(this._viasInnerInstance);
        this._applySideToInstanced(this._testPadsInstance);
        this._applySideToInstanced(this._testPadsBorderInstance);

        // `keepView` flips between the two faces while preserving zoom
        // and the on-screen position — used by the dive-under-board
        // chevron click. Two cases:
        //   1. Dual-outline layout (XZZ side-by-side / stacked): the
        //      two faces live in different XY regions of the canvas,
        //      so keepView calls `_mirrorCameraAcrossFaces` to project
        //      the cursor onto the new face's frame.
        //   2. Single-outline layout (.fz / .cad / KiCad / BRD): both
        //      faces share the same XY coordinate space — flipping the
        //      filter just changes which pins are visible, the camera
        //      stays put. Skipping `_recentreOnSideMode` preserves
        //      zoom and pan.
        // We bail to a recentre when keepView is OFF, switching to /
        // from BOTH (no specific face to centre on), or staying on the
        // same face.
        const isFlip = opts.keepView
            && prevMode !== 'both'
            && mode !== 'both'
            && prevMode !== mode;
        if (isFlip && this.dualOutline) {
            this._mirrorCameraAcrossFaces(prevMode, mode);
        } else if (isFlip) {
            // Single-outline — nothing to do; camera position + frustum
            // size already match the new face's coordinate space.
        } else {
            this._recentreOnSideMode();
        }
        // Re-apply zoom-driven label visibility now that components flipped.
        if (this._updateComponentLabelVisibility) {
            this._updateComponentLabelVisibility();
        }
        // If a net is currently highlighted, rebuild its fly-lines so
        // cross-face endpoints get the dive-under-board treatment (or
        // the original side-by-side path) matching the new mode.
        if (this.selectedItem && this.selectedItem.net
            && this.selectedItem.net !== 'NC') {
            this.clearNetHighlight();
            this.highlightNet();
        }
        this.requestRender();
    },


    /**
     * Translate the current camera position from `fromMode`'s display
     * frame to `toMode`'s display frame using the same flip-over
     * mirror that `_netEndpointPos` applies to fly-line endpoints.
     * Frustum size is unchanged — zoom level stays exactly where it
     * was. The mirror is computed in scene-local coords so it composes
     * cleanly with the active rotation (we round-trip through
     * `_worldToLocal` and the forward rotation matrix).
     */
    _mirrorCameraAcrossFaces(fromMode, toMode) {
        if (!this.dualOutline) return;
        // Camera position lives in world (post-rotation) coords. Take
        // it back to scene-local before mirroring across faces.
        const localCam = this._worldToLocal(
            this.camera.position.x, this.camera.position.y
        );
        const dual = this.dualOutline;
        const top = dual.bbox_top;
        const bot = dual.bbox_bottom;
        let lx, ly;
        if (dual.axis === 'x') {
            lx = top.x + bot.x + bot.w - localCam.x;
            const tyOffset = toMode === 'top'
                ? (top.y - bot.y)
                : (bot.y - top.y);
            ly = localCam.y + tyOffset;
        } else {
            ly = top.y + bot.y + bot.h - localCam.y;
            const txOffset = toMode === 'top'
                ? (top.x - bot.x)
                : (bot.x - top.x);
            lx = localCam.x + txOffset;
        }
        // Re-rotate back to world.
        const rad = (this.rotationDeg || 0) * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        this.camera.position.x = lx * cos - ly * sin;
        this.camera.position.y = lx * sin + ly * cos;
        this.onResize();
    },


    _applySideToInstanced(mesh) {
        if (!mesh || !mesh.userData || !mesh.userData._matrices) return;
        const sides = mesh.userData._sides;
        const dnpFlags = mesh.userData._dnpFlags;
        const components = mesh.userData._components;
        const matrices = mesh.userData._matrices;
        const allow = (side) => this.sideMode === 'both'
            || side == null
            || side === this.sideMode;
        const prefix = this._agentFilterPrefix;
        const refdesOk = (id) => !prefix
            || (id && id.toUpperCase().startsWith(prefix));
        const zero = new THREE.Matrix4().makeScale(0, 0, 0);
        for (let i = 0; i < matrices.length; i++) {
            const sideOk = allow(sides[i]);
            const dnpOk = !dnpFlags || !dnpFlags[i] || this._showDnp;
            // Refdes filter only applies if the mesh recorded a parent
            // component per slot. Vias / mounting holes carry no parent
            // and stay visible regardless of the filter.
            const refOk = !components || refdesOk(components[i]);
            const ok = sideOk && dnpOk && refOk;
            mesh.setMatrixAt(i, ok ? matrices[i] : zero);
        }
        mesh.instanceMatrix.needsUpdate = true;
    },


    _recentreOnSideMode() {
        if (!this.boardData) return;
        const data = this.boardData;
        const dual = this.dualOutline;
        let bbox;
        if (dual && this.sideMode === 'top' && dual.bbox_top) {
            bbox = dual.bbox_top;
        } else if (dual && this.sideMode === 'bottom' && dual.bbox_bottom) {
            bbox = dual.bbox_bottom;
        } else {
            bbox = {
                x: data.board_offset_x || 0,
                y: data.board_offset_y || 0,
                w: data.board_width,
                h: data.board_height,
            };
        }
        // Project the bbox centre through the current scene rotation
        // so the camera keeps the same content visible after a rotate
        // toggle.
        const localCx = bbox.x + bbox.w / 2;
        const localCy = bbox.y + bbox.h / 2;
        const rad = (this.rotationDeg || 0) * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        this.camera.position.x = localCx * cos - localCy * sin;
        this.camera.position.y = localCx * sin + localCy * cos;
        // 90° / 270° swaps the visible width/height; flips don't change
        // extent. Math.max stays the same for any rotation, so the
        // frustum fits regardless.
        this.frustumSize = Math.max(bbox.w, bbox.h) * 1.2;
        this.zoom = 100 / this.frustumSize;
        this.onResize();
        const zoomEl = document.getElementById('zoom-level');
        if (zoomEl) zoomEl.textContent = Math.round(this.zoom * 100);
    },


    // ========================
    // ZOOM CONTROLS
    // ========================

    zoomIn() {
        this.frustumSize *= 0.75;
        // Match the wheel-zoom floor (0.5 mm) so the +/- buttons can
        // reach the same close-up as the wheel — 10 mm was too coarse
        // to actually inspect a 0402 pin pair.
        this.frustumSize = Math.max(0.5, this.frustumSize);
        this.zoom = 100 / this.frustumSize;
        this.onResize();
        document.getElementById('zoom-level').textContent = Math.round(this.zoom * 100);
    },


    zoomOut() {
        this.frustumSize *= 1.25;
        const maxSize = this.boardData ? Math.max(this.boardData.board_width, this.boardData.board_height) * 10 : 2000;
        this.frustumSize = Math.min(maxSize, this.frustumSize);
        this.zoom = 100 / this.frustumSize;
        this.onResize();
        document.getElementById('zoom-level').textContent = Math.round(this.zoom * 100);
    },


    resetView() {
        if (this.boardData) {
            const ox = this.boardData.board_offset_x || 0;
            const oy = this.boardData.board_offset_y || 0;
            this.camera.position.x = ox + this.boardData.board_width / 2;
            this.camera.position.y = oy + this.boardData.board_height / 2;
            this.frustumSize = Math.max(this.boardData.board_width, this.boardData.board_height) * 1.2;
            this.zoom = 100 / this.frustumSize;
            this.onResize();
            document.getElementById('zoom-level').textContent = Math.round(this.zoom * 100);
        }
    }
};
