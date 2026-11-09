/** Interaction operations on the shared PCB viewer state. */

export const interactionMethods = {

    setupEvents() {
        this._eventController?.abort();
        this._eventController = new AbortController();
        const listen = (target, type, handler, options = {}) => target.addEventListener(
            type, handler, { ...options, signal: this._eventController.signal }
        );
        listen(window, 'resize', () => this.onResize());
        listen(this.canvas, 'wheel', (e) => this.onWheel(e), { passive: false });
        listen(this.canvas, 'mousedown', (e) => this.onMouseDown(e));
        listen(this.canvas, 'mouseup', () => this.onMouseUp());
        listen(this.canvas, 'mousemove', (e) => this.onMouseMove(e));
        listen(this.canvas, 'click', (e) => this.onClick(e));
        listen(this.canvas, 'contextmenu', (e) => e.preventDefault());

        // Touch: 1 finger = pan, 2 fingers = pinch-zoom (to the midpoint), a
        // short 1-finger tap = select (forwarded to the click path). passive:
        // false so we can preventDefault the browser's native pan/pinch-zoom.
        listen(this.canvas, 'touchstart', (e) => this.onTouchStart(e), { passive: false });
        listen(this.canvas, 'touchmove', (e) => this.onTouchMove(e), { passive: false });
        listen(this.canvas, 'touchend', (e) => this.onTouchEnd(e), { passive: false });
        listen(this.canvas, 'touchcancel', () => this.onTouchEnd(), { passive: false });
        // Disable native gestures (double-tap zoom, scroll) over the canvas.
        this.canvas.style.touchAction = 'none';

        const closeBtn = document.getElementById('info-close');
        if (closeBtn) listen(closeBtn, 'click', () => this.clearSelection());
    },


    onResize() {
        const w = this.container.clientWidth, h = this.container.clientHeight;
        const aspect = w / h;
        this.camera.left = -this.frustumSize * aspect / 2;
        this.camera.right = this.frustumSize * aspect / 2;
        this.camera.top = this.frustumSize / 2;
        this.camera.bottom = -this.frustumSize / 2;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h, false);
        this._updateComponentLabelVisibility();
        this._updateRefdesLabelScale();
        this._updateSilkscreenLabelScale();
        this._updateFlyLineDashes();
        this._updateSideArrowScale();
        this._updateAgentArrowScale();
        this._updateAgentAnnotationScale();
        this.requestRender();
    },


    onWheel(e) {
        e.preventDefault();
        const rect = this.container.getBoundingClientRect();
        // Zoom toward the cursor (see _zoomAtPoint).
        this._zoomAtPoint(e.clientX - rect.left, e.clientY - rect.top, e.deltaY > 0 ? 1.1 : 0.9);
    },


    // Zoom-to-point: convert the anchor's pixel position to the world point
    // BEFORE the frustum change, apply the zoom, then shift the camera so the
    // same world point still sits under the anchor. Shared by the wheel and the
    // two-finger pinch (anchor = cursor / pinch midpoint) so zoom-to-centre
    // never forces a re-pan after each step.
    _zoomAtPoint(offsetX, offsetY, zoomFactor) {
        const worldBefore = this.screenToWorld(offsetX, offsetY);
        this.frustumSize *= zoomFactor;
        // Allow generous zoom-out (10× the board diagonal) so dense
        // boards like the MSI V300 (46 mm GPU section, 5k+ vias) can
        // be panned/explored from a comfortable distance instead of
        // hitting the wall after one wheel notch.
        const maxSize = this.boardData ? Math.max(this.boardData.board_width, this.boardData.board_height) * 10 : 2000;
        this.frustumSize = Math.max(0.5, Math.min(maxSize, this.frustumSize));
        this.zoom = 100 / this.frustumSize;
        this.onResize();
        const worldAfter = this.screenToWorld(offsetX, offsetY);
        this.camera.position.x += worldBefore.x - worldAfter.x;
        this.camera.position.y += worldBefore.y - worldAfter.y;
        const zoomEl = document.getElementById('zoom-level');
        if (zoomEl) zoomEl.textContent = Math.round(this.zoom * 100);
        this.requestRender();
    },


    // Pan the camera by a pixel delta (shared by mouse drag + touch pan).
    _panByPixels(dxPx, dyPx) {
        const w = this.container.clientWidth, h = this.container.clientHeight;
        const aspect = w / h;
        this.camera.position.x -= dxPx * (this.frustumSize * aspect) / w;
        this.camera.position.y += dyPx * this.frustumSize / h;
        this.requestRender();
    },


    _touchDist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); },

    _touchMid(t) { return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 }; },


    // A single-finger tap with no real movement selects the item under it —
    // mobile has no hover, so we update the picking ray + hover at the tap
    // point, then route through the same onClick stack-picking path as mouse.
    _forwardTapAsClick(clientX, clientY) {
        const rect = this.container.getBoundingClientRect();
        const w = this.container.clientWidth, h = this.container.clientHeight;
        this.mouse.x = ((clientX - rect.left) / w) * 2 - 1;
        this.mouse.y = -((clientY - rect.top) / h) * 2 + 1;
        this.checkHover();
        this._pressStart = { x: clientX, y: clientY };
        this.onClick({ clientX, clientY });
    },


    onTouchStart(e) {
        if (e.touches.length === 1) {
            e.preventDefault();
            const t = e.touches[0];
            this._touchMode = 'pan';
            this._lastTouch = { x: t.clientX, y: t.clientY };
            this._touchStart = { x: t.clientX, y: t.clientY };
            this._touchMoved = false;
        } else if (e.touches.length === 2) {
            e.preventDefault();
            this._touchMode = 'pinch';
            this._pinchPrevDist = this._touchDist(e.touches);
            this._pinchPrevMid = this._touchMid(e.touches);
            this._touchMoved = true; // a pinch is never a tap
        }
    },


    onTouchMove(e) {
        if (this._touchMode === 'pan' && e.touches.length === 1) {
            e.preventDefault();
            const t = e.touches[0];
            if (Math.abs(t.clientX - this._touchStart.x) > 6 || Math.abs(t.clientY - this._touchStart.y) > 6) {
                this._touchMoved = true;
            }
            this._panByPixels(t.clientX - this._lastTouch.x, t.clientY - this._lastTouch.y);
            this._lastTouch = { x: t.clientX, y: t.clientY };
        } else if (this._touchMode === 'pinch' && e.touches.length === 2) {
            e.preventDefault();
            const dist = this._touchDist(e.touches);
            const mid = this._touchMid(e.touches);
            const rect = this.container.getBoundingClientRect();
            if (this._pinchPrevDist > 0) {
                // Fingers apart → dist↑ → factor<1 → frustum shrinks → zoom IN.
                this._zoomAtPoint(mid.x - rect.left, mid.y - rect.top, this._pinchPrevDist / dist);
            }
            // Two-finger drag also pans (midpoint movement).
            this._panByPixels(mid.x - this._pinchPrevMid.x, mid.y - this._pinchPrevMid.y);
            this._pinchPrevDist = dist;
            this._pinchPrevMid = mid;
        }
    },


    onTouchEnd(e) {
        if (this._touchMode === 'pan' && !this._touchMoved && this._touchStart) {
            this._forwardTapAsClick(this._touchStart.x, this._touchStart.y);
        }
        // One finger left after lifting the other (pinch → pan): keep panning
        // from its position; otherwise end the gesture.
        if (e && e.touches && e.touches.length === 1) {
            this._touchMode = 'pan';
            this._lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            this._touchStart = { ...this._lastTouch };
            this._touchMoved = true; // tail of a multi-touch, not a fresh tap
        } else {
            this._touchMode = null;
        }
    },


    onMouseDown(e) {
        // Stash the press position so `onClick` can tell a genuine
        // click ("click in empty space to deselect") from the tail of
        // a pan drag — the browser fires `click` after both, but we
        // only want to deselect on the former.
        this._pressStart = { x: e.clientX, y: e.clientY };

        // Right click, middle click, or shift+left click = always pan
        if (e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey)) {
            this.isPanning = true;
            this.lastMousePos = { x: e.clientX, y: e.clientY };
            this.canvas.style.cursor = 'grabbing';
            return;
        }

        // Left click: pan if clicking in empty space (no hovered item)
        if (e.button === 0 && !this.hoveredItem) {
            this.isPanning = true;
            this.lastMousePos = { x: e.clientX, y: e.clientY };
            this.canvas.style.cursor = 'grabbing';
        }
    },


    onMouseUp() {
        this.isPanning = false;
        this.canvas.style.cursor = 'default';
    },


    onMouseMove(e) {
        const now = performance.now();

        if (!this.isPanning && now - this.lastMouseMoveTime < this.mouseMoveThrottleMs) {
            return;
        }
        this.lastMouseMoveTime = now;

        const containerRect = this.container.getBoundingClientRect();
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;

        const offsetX = e.clientX - containerRect.left;
        const offsetY = e.clientY - containerRect.top;

        this.mouse.x = (offsetX / w) * 2 - 1;
        this.mouse.y = -(offsetY / h) * 2 + 1;

        if (this.isPanning) {
            const aspect = w / h;
            const dx = (e.clientX - this.lastMousePos.x) * (this.frustumSize * aspect) / w;
            const dy = (e.clientY - this.lastMousePos.y) * this.frustumSize / h;
            this.camera.position.x -= dx;
            this.camera.position.y += dy;
            this.lastMousePos = { x: e.clientX, y: e.clientY };
            this.requestRender();
        }

        // Update cursor position display
        if (!this.isPanning) {
            this._pendingCursorUpdate = { offsetX, offsetY };
            if (!this._cursorUpdateScheduled) {
                this._cursorUpdateScheduled = true;
                this._cursorFrame = requestAnimationFrame(() => {
                    this._cursorFrame = null;
                    if (this._pendingCursorUpdate) {
                        const worldPos = this.screenToWorld(this._pendingCursorUpdate.offsetX, this._pendingCursorUpdate.offsetY);
                        document.getElementById('cursor-x').textContent = worldPos.x.toFixed(2);
                        document.getElementById('cursor-y').textContent = worldPos.y.toFixed(2);
                    }
                    this._cursorUpdateScheduled = false;
                });
            }
        }

        // Throttle hover check
        if (!this.isPanning && now - this.lastHoverCheck >= this.hoverThrottleMs) {
            this.lastHoverCheck = now;
            this.checkHover();
        }
    },


    onClick(e) {
        // Empty-space click → deselect, BUT only when the cursor
        // didn't actually drag. The browser still fires `click` after
        // a small pan, so we gate on the mousedown→mouseup distance:
        // ≤ 4 px = genuine click, > 4 px = drag tail (preserve view).
        const start = this._pressStart;
        const dragged = start && (
            Math.abs(e.clientX - start.x) > 4
            || Math.abs(e.clientY - start.y) > 4
        );
        if (dragged) return;

        // Side-flip arrows sit at the dive-under-board fly-line
        // endpoints in TOP / BOTTOM mode. Clicking one switches the
        // viewer to the other face — handle them upfront so they
        // never get stuck in the cycle-through-stack logic below.
        if (this.hoveredItem && this.hoveredItem._instanceType === 'sideArrow') {
            this.setSideMode(this.hoveredItem._targetSide, { keepView: true });
            return;
        }

        // Stack-picking: collect ALL items hit at the cursor location,
        // sorted by tier (pin > component) then by AABB size (smaller
        // first). A click cycles through the stack — repeat clicks at
        // the same spot move to the item under the previous one. This
        // is how Altium / Cadence / KiCad let you reach a body sitting
        // under a pad, or a DNP alternate sitting under a placed body.
        const stack = this._collectClickStack();
        if (stack.length === 0) {
            if (this.selectedItem) this.clearSelection();
            return;
        }
        const cursorKey = `${e.clientX}_${e.clientY}`;
        const sameSpot = this._lastClickKey
            && Math.abs(e.clientX - this._lastClickPx) <= 4
            && Math.abs(e.clientY - this._lastClickPy) <= 4;
        if (sameSpot) {
            this._clickStackIndex = (this._clickStackIndex + 1) % stack.length;
        } else {
            this._clickStackIndex = 0;
        }
        this._lastClickKey = cursorKey;
        this._lastClickPx = e.clientX;
        this._lastClickPy = e.clientY;
        this.selectItem(stack[this._clickStackIndex]);
    },


    /**
     * Return every hoverable item the cursor is currently over, sorted
     * pin-tier-first then by AABB size. Same hit-test rules as
     * `checkHover` (side filter, DNP filter, layer filter, slop), but
     * instead of returning the single winner it returns the full stack
     * so `onClick` can cycle through it.
     */
    _collectClickStack() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        const aspect = w / h;
        const worldX = this.camera.position.x + this.mouse.x * (this.frustumSize * aspect / 2);
        const worldY = this.camera.position.y + this.mouse.y * (this.frustumSize / 2);
        const local = this._worldToLocal(worldX, worldY);
        const localX = local.x, localY = local.y;
        const nearby = this._getNearbyItems(localX, localY);
        const pixelSize = this.frustumSize / h;
        const pinSlop = 8 * pixelSize;
        const pinThresholdSq = pinSlop * pinSlop;
        const pinHits = [];
        const compHits = [];
        for (const item of nearby) {
            if (item.layer && !this.layers[item.layer]) continue;
            if (item._side && this.sideMode !== 'both' && item._side !== this.sideMode) continue;
            const t = item._instanceType;
            if (!this._showDnp && (item.is_dnp || t === 'dnpComp')) continue;
            const isPinTier = t === 'pin' || t === 'rectPin' || t === 'testPad'
                || t === 'via' || t === 'marker' || t === 'sideArrow';
            const dx = item.x - localX, dy = item.y - localY;
            const halfW = (item.width || 0) / 2, halfH = (item.height || 0) / 2;
            const ex = Math.max(0, Math.abs(dx) - halfW);
            const ey = Math.max(0, Math.abs(dy) - halfH);
            const distSq = ex * ex + ey * ey;
            const size = (item.width || 0.05) * (item.height || 0.05);
            if (isPinTier) {
                if (distSq > pinThresholdSq) continue;
                pinHits.push({ item, distSq, size });
            } else {
                if (distSq > 0) continue;
                compHits.push({ item, distSq, size });
            }
        }
        const sortFn = (a, b) => a.distSq - b.distSq || a.size - b.size;
        pinHits.sort(sortFn);
        compHits.sort(sortFn);
        return [...pinHits, ...compHits].map((h) => h.item);
    },


    screenToWorld(offsetX, offsetY) {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        const aspect = w / h;

        const ndcX = (offsetX / w) * 2 - 1;
        const ndcY = -(offsetY / h) * 2 + 1;

        const worldX = this.camera.position.x + ndcX * (this.frustumSize * aspect / 2);
        const worldY = this.camera.position.y + ndcY * (this.frustumSize / 2);

        return { x: worldX, y: worldY };
    },


    /**
     * Invert the scene rotation on a (worldX, worldY) point so the
     * result is comparable against item coordinates (which were stashed
     * pre-rotation at parse time). Used by hover and zoom-around-cursor
     * so they keep working after a rotate toggle.
     */
    _worldToLocal(wx, wy) {
        const rad = -(this.rotationDeg || 0) * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        return {
            x: wx * cos - wy * sin,
            y: wx * sin + wy * cos,
        };
    },


    /**
     * Spatial grid hover detection - O(1) lookup
     */
    checkHover() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        const aspect = w / h;

        const worldX = this.camera.position.x + this.mouse.x * (this.frustumSize * aspect / 2);
        const worldY = this.camera.position.y + this.mouse.y * (this.frustumSize / 2);

        // Items live in scene-local coords (their original XY). When
        // the scene is rotated / flipped, the cursor's world XY needs
        // to be inverted through the same transform before we can
        // match it against the spatial grid.
        const local = this._worldToLocal(worldX, worldY);
        const localX = local.x;
        const localY = local.y;

        // Get nearby items from spatial grid
        const nearbyItems = this._getNearbyItems(localX, localY);

        const pixelSize = this.frustumSize / h;
        // Pins / pads / vias / markers / arrows are small "interactive"
        // targets — generous slop (8 px) so the tech doesn't have to
        // pixel-hunt at low zoom. Components are large (mm-scale) and
        // would steal hovers from anything sitting on top of them, so
        // they only hover when the cursor is INSIDE their AABB (slop=0).
        const pinSlop = 8 * pixelSize;
        const compSlop = 0;
        const pinThresholdSq = pinSlop * pinSlop;

        // Two-tier search: pins first, components only as a fallback.
        // Within each tier, smallest AABB-distance wins. Pins always
        // beat components when both could match — fixes the long-
        // standing bug where clicking a pin sitting on top of a part
        // would select the part instead.
        let bestPin = null;
        let bestPinDistSq = Infinity;
        let bestPinSize = Infinity;
        let bestComp = null;
        let bestCompDistSq = Infinity;
        let bestCompSize = Infinity;

        for (const item of nearbyItems) {
            if (item.layer && !this.layers[item.layer]) continue;
            if (item._side && this.sideMode !== 'both' && item._side !== this.sideMode) continue;

            const t = item._instanceType;
            // DNP pins are baked into the placed-pin meshes with an
            // `is_dnp` flag carried on the hoverable item — when the
            // toggle is off, the matrix is zero-scaled so the pad is
            // invisible AND uninteractive. Same gate for DNP component
            // bodies (the `dnpComp` overlays).
            if (!this._showDnp && (item.is_dnp || t === 'dnpComp')) continue;

            const isPinTier = t === 'pin' || t === 'rectPin' || t === 'testPad'
                || t === 'via' || t === 'marker' || t === 'sideArrow';

            const dx = item.x - localX;
            const dy = item.y - localY;
            const halfW = (item.width || 0) / 2;
            const halfH = (item.height || 0) / 2;
            const ex = Math.max(0, Math.abs(dx) - halfW);
            const ey = Math.max(0, Math.abs(dy) - halfH);
            const distSq = ex * ex + ey * ey;

            if (isPinTier) {
                if (distSq > pinThresholdSq) continue;
                // Tie-breaker on identical distSq (very common — both
                // candidates are inside their AABB and distSq=0): prefer
                // the smaller item. The tighter AABB is the better
                // visual match; otherwise a small SMD pad always loses
                // to a wider rect pad it sits next to.
                const size = (item.width || 0.05) * (item.height || 0.05);
                if (distSq < bestPinDistSq
                    || (distSq === bestPinDistSq && size < bestPinSize)) {
                    bestPinDistSq = distSq;
                    bestPinSize = size;
                    bestPin = item;
                }
            } else {
                // Components / generic meshes — strict inside-AABB only.
                if (distSq > compSlop * compSlop) continue;
                const size = (item.width || 0.05) * (item.height || 0.05);
                if (distSq < bestCompDistSq
                    || (distSq === bestCompDistSq && size < bestCompSize)) {
                    bestCompDistSq = distSq;
                    bestCompSize = size;
                    bestComp = item;
                }
            }
        }

        const nearest = bestPin || bestComp;

        // Update hover state
        if (this.hoveredItem && this.hoveredItem !== nearest) {
            // Reset previous hover
            this._setItemHighlight(this.hoveredItem, false);
            this.requestRender();
        }

        if (nearest && nearest !== this.selectedItem) {
            this.hoveredItem = nearest;
            this._setItemHighlight(nearest, true);
            this.canvas.style.cursor = 'pointer';
            this.requestRender();
        } else if (!nearest) {
            this.hoveredItem = null;
            if (!this.isPanning) this.canvas.style.cursor = 'default';
        }
    }
};
