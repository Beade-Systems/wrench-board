/** Selection operations on the shared PCB viewer state. */

export const selectionMethods = {

    /**
     * Set highlight state for an item (works with instanced meshes)
     * @param {object} item - The item data
     * @param {boolean} highlighted - Whether to highlight or restore original color
     * @param {number} [customColor] - Optional custom highlight color (default: 0x666666 for hover)
     */
    /**
     * Push every pin / rect-pin / test-pad NOT on `netName` toward the
     * deep background colour so the highlighted net stands alone. The
     * selected pin and same-net pins were already recoloured by
     * `_setItemHighlight` calls above and are skipped here. One pass
     * over `_hoverableItems`, then a single instanceColor.needsUpdate
     * per InstancedMesh.
     */
    _dimUnrelatedPins(netName) {
        if (!netName || netName === 'NC') return;
        this._dimActive = true;
        const dimFactor = 0.18;  // 18% of original brightness — keeps a
                                 // hint of colour without making the
                                 // unrelated pins competitively bright.
        const bg = new THREE.Color(this.tokens.bgDeep || 0x07101f);
        const tmp = new THREE.Color();
        for (const item of this._hoverableItems) {
            const t = item._instanceType;
            if (t !== 'pin' && t !== 'rectPin' && t !== 'testPad') continue;
            if (item.net === netName) continue;
            tmp.setHex(item.originalColor || 0x808080);
            // lerp(original, bg, 1 - factor) → factor=0.18 keeps 18%
            // of the original, blends 82% into bg-deep.
            tmp.lerp(bg, 1 - dimFactor);
            // Stash the dimmed hex so hover-out snaps back to dim, not
            // to the pin's original full-brightness colour.
            item._restColor = tmp.getHex();
            this._writeInstanceColor(item, tmp);
        }
        this._markPinInstanceColorDirty();
    },


    /**
     * Boost the copper traces on `netName` to the net's family colour
     * at full opacity. Other traces are LEFT UNTOUCHED — every copper
     * trace belongs to some net by definition, so dimming the rest
     * would arbitrarily fade out other nets' paths the user might
     * still want to read alongside. Outline / silkscreen layers stay
     * out of scope.
     */
    _highlightNetTraces(netName, lineColor) {
        if (!this.meshGroups || !this.meshGroups.traces) return;
        this._tracesNetActive = true;
        const lineColorObj = new THREE.Color(lineColor);
        for (const line of this.meshGroups.traces) {
            const ud = line.userData;
            if (!ud || ud._kind !== 'copper') continue;
            if (!line.material) continue;
            if (ud.net && ud.net === netName) {
                line.material.color.set(lineColorObj);
                line.material.opacity = 1.0;
                line.material.needsUpdate = true;
                // Force visible — net highlight overrides the toolbar
                // showTraces toggle for matched traces so the user
                // always sees the routing of the clicked net even when
                // the global trace layer is off. _undimAllTraces puts
                // the toolbar gate back when the highlight clears.
                line.visible = true;
            }
        }
    },


    /**
     * Push a hex toward white until its luminance reaches ~210/255.
     * Fly-lines render as 1-pixel dashed segments on Chromium (the
     * `linewidth` GL hint is ignored), so anything darker than mid-grey
     * effectively disappears against the navy canvas. Compute the
     * exact white-blend ratio that hits the target luminance instead
     * of capping at a fixed factor — Power #B16628 (lum 117) needs
     * ~50 % white, Ground #40455C (lum 70) needs ~75 %, while bright
     * hues (cyan netLine lum 183, peach reset lum 156) stay close to
     * their family colour.
     */
    _brightenForFlyLine(hexInt) {
        const r = (hexInt >> 16) & 0xff;
        const g = (hexInt >> 8) & 0xff;
        const b = hexInt & 0xff;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const target = 210;
        if (lum >= target) return hexInt;
        // White luminance is 255. Solve: lum + (255 - lum) * t = target
        //   → t = (target - lum) / (255 - lum)
        const t = (target - lum) / (255 - lum);
        const nr = Math.round(r + (255 - r) * t);
        const ng = Math.round(g + (255 - g) * t);
        const nb = Math.round(b + (255 - b) * t);
        return (nr << 16) | (ng << 8) | nb;
    },


    _undimAllTraces() {
        if (!this._tracesNetActive) return;
        this._tracesNetActive = false;
        if (!this.meshGroups || !this.meshGroups.traces) return;
        for (const line of this.meshGroups.traces) {
            const ud = line.userData;
            if (!ud || ud._kind !== 'copper') continue;
            if (!line.material) continue;
            line.material.color.setHex(ud.origColor);
            line.material.opacity = ud.origOpacity;
            line.material.needsUpdate = true;
            // Restore the toolbar showTraces gate. Outline / silkscreen
            // layers stay visible regardless (createTrace forces them
            // visible at parse time and the loop above skips non-copper
            // _kinds).
            line.visible = this.showTraces;
        }
    },


    _undimAllPins() {
        if (!this._dimActive) return;
        this._dimActive = false;
        const tmp = new THREE.Color();
        for (const item of this._hoverableItems) {
            const t = item._instanceType;
            if (t !== 'pin' && t !== 'rectPin' && t !== 'testPad') continue;
            tmp.setHex(item.originalColor || 0x808080);
            // Drop the dim resting override so subsequent hovers snap
            // back to the parse-time colour again.
            delete item._restColor;
            this._writeInstanceColor(item, tmp);
        }
        this._markPinInstanceColorDirty();
    },


    _writeInstanceColor(item, color) {
        if (item._instanceType === 'pin' && this._circularPinInstance) {
            this._circularPinInstance.setColorAt(item._instanceId, color);
        } else if (item._instanceType === 'rectPin' && item._sizeKey) {
            const rect = this._rectPinInstances.get(item._sizeKey);
            if (rect && rect.body) rect.body.setColorAt(item._instanceId, color);
        } else if (item._instanceType === 'testPad' && this._testPadsInstance) {
            this._testPadsInstance.setColorAt(item._instanceId, color);
        }
    },


    _markPinInstanceColorDirty() {
        if (this._circularPinInstance && this._circularPinInstance.instanceColor) {
            this._circularPinInstance.instanceColor.needsUpdate = true;
        }
        this._rectPinInstances.forEach(({ body }) => {
            if (body && body.instanceColor) body.instanceColor.needsUpdate = true;
        });
        if (this._testPadsInstance && this._testPadsInstance.instanceColor) {
            this._testPadsInstance.instanceColor.needsUpdate = true;
        }
    },


    _setItemHighlight(item, highlighted, customColor = 0x666666) {
        if (!item) return;

        const highlightColor = new THREE.Color(customColor);
        // Resting (un-hovered) colour — `_restColor` overrides the
        // parse-time `originalColor` when the item is currently in a
        // non-default state (member of a highlighted net, dimmed because
        // an unrelated net is selected, …). Without this, hover-out on
        // such an item snaps it back to the wrong colour and breaks the
        // visual story (dimmed pins look hover-stuck-bright; same-net
        // pins lose their net colour on hover-out).
        const restingHex = item._restColor != null
            ? item._restColor
            : item.originalColor;
        const restingColor = new THREE.Color(restingHex);
        const targetColor = highlighted ? highlightColor : restingColor;

        // Circular pins
        if (item._instanceType === 'pin' && this._circularPinInstance) {
            this._circularPinInstance.setColorAt(item._instanceId, targetColor);
            this._circularPinInstance.instanceColor.needsUpdate = true;
        }
        // Rectangular pins
        else if (item._instanceType === 'rectPin' && item._sizeKey) {
            const rectInstance = this._rectPinInstances.get(item._sizeKey);
            if (rectInstance && rectInstance.body) {
                rectInstance.body.setColorAt(item._instanceId, targetColor);
                rectInstance.body.instanceColor.needsUpdate = true;
            }
        }
        // Test pads
        else if (item._instanceType === 'testPad' && this._testPadsInstance) {
            this._testPadsInstance.setColorAt(item._instanceId, targetColor);
            this._testPadsInstance.instanceColor.needsUpdate = true;
        }
        // Components (regular meshes) — pass `null` on hover-out so
        // each child material restores its OWN userData.origColor
        // instead of all of them snapping to the parent's single
        // restingHex (which used to recolour the component fill cyan
        // and leave it stuck there).
        else if (item._mesh) {
            this.setMeshColor(item._mesh, highlighted ? customColor : null);
        }
    },


    /**
     * Walk a mesh tree and recolour every Mesh / Line material it
     * contains. When `color` is the sentinel `null`, each child is
     * restored to its individually-stashed `userData.origColor` —
     * needed because a component group on KiCad / BRD bundles a cyan
     * Line outline AND a grey-blue Mesh fill: snapping both back to
     * the same hex on hover-out used to leave the fill stuck in
     * outline cyan ("component stays lit up after hover").
     */
    setMeshColor(mesh, color) {
        const applyColor = (obj) => {
            if (obj.material && (obj.material.type === 'MeshBasicMaterial' ||
                                 obj.material.type === 'LineBasicMaterial')) {
                let target;
                if (color === null) {
                    target = (obj.userData && obj.userData.origColor != null)
                        ? obj.userData.origColor
                        : obj.material.color.getHex();
                } else {
                    target = color;
                }
                obj.material.color.setHex(target);
            }
            if (obj.children) {
                obj.children.forEach(child => applyColor(child));
            }
        };
        applyColor(mesh);
    },


    _getGridKey(x, y) {
        const cellX = Math.floor(x / this._gridCellSize);
        const cellY = Math.floor(y / this._gridCellSize);
        return `${cellX},${cellY}`;
    },


    _getNearbyItems(worldX, worldY) {
        const items = [];
        const cellX = Math.floor(worldX / this._gridCellSize);
        const cellY = Math.floor(worldY / this._gridCellSize);

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const key = `${cellX + dx},${cellY + dy}`;
                if (this._spatialGrid[key]) {
                    items.push(...this._spatialGrid[key]);
                }
            }
        }
        return items;
    },


    _buildSpatialGrid() {
        this._spatialGrid = {};

        for (const item of this._hoverableItems) {
            const key = this._getGridKey(item.x, item.y);
            if (!this._spatialGrid[key]) {
                this._spatialGrid[key] = [];
            }
            this._spatialGrid[key].push(item);
        }

        console.log(`[PERF] Spatial grid: ${Object.keys(this._spatialGrid).length} cells for ${this._hoverableItems.length} items`);
    },


    selectItem(item) {
        this.clearSelection();
        this.selectedItem = item;

        // Apply cyan highlight color for selection
        this._setItemHighlight(item, true, this.colors.highlight);

        // Show inspector and populate fields. The DOM lives in
        // index.html under <aside class="brd-inspector">.
        const inspector = document.getElementById('component-info');
        if (inspector) inspector.hidden = false;

        const setText = (id, txt) => {
            const el = document.getElementById(id);
            if (el) el.textContent = txt;
        };
        setText('info-id', item.id || '…');
        setText('info-value', item.value || item.net || '…');
        setText('info-type', (item.type || 'Pin').toUpperCase());
        setText('info-layer', (item.layer || 'top').toUpperCase());
        setText('info-pos',
            `X: ${(item.x || 0).toFixed(2)}  Y: ${(item.y || 0).toFixed(2)}`);
        setText('info-size', item.width
            ? `${item.width.toFixed(1)} × ${(item.height || 0).toFixed(1)} mm`
            : '');

        // Component metadata — only meaningful when the selected item
        // is a part (footprint name from the source format, pin
        // count). Pins / vias / test pads / markers don't carry
        // these so the rows stay hidden. `item.footprint` and
        // `item.pin_count` come straight from the render payload's
        // `components[]` shape (see api/board/render.py).
        const fpEl = document.getElementById('info-footprint');
        const pcEl = document.getElementById('info-pincount');
        const hasFootprint = !!(item.footprint && typeof item.footprint === 'string');
        if (fpEl) {
            fpEl.hidden = !hasFootprint;
            if (hasFootprint) fpEl.textContent = `Footprint: ${item.footprint}`;
        }
        const hasPinCount = Number.isFinite(item.pin_count) && item.pin_count > 0;
        if (pcEl) {
            pcEl.hidden = !hasPinCount;
            if (hasPinCount) {
                pcEl.textContent = item.pin_count > 1
                    ? `${item.pin_count} pins`
                    : `1 pin`;
            }
        }

        // Net row visibility
        const netLabel = document.getElementById('info-net-label');
        const netRow = document.getElementById('info-net-row');
        const hasNet = item.net && item.net !== 'NC' &&
            item.net !== 'N/A' && item.net !== 'UNCONNECTED';
        if (netLabel) netLabel.hidden = !hasNet;
        if (netRow) netRow.hidden = !hasNet;
        if (hasNet) setText('info-net', item.net);

        // Manufacturer-tagged diagnostic expectation for this net,
        // when the source format ships one (XZZ post-v6 block on
        // some dumps, see api/board/parser/_xzz_engine_extras
        // .py). Hides the whole block when the net is unknown or
        // carries no expectation.
        const diagLabel = document.getElementById('info-diag-label');
        const diagRow = document.getElementById('info-diag-row');
        const diagR = document.getElementById('info-diag-resistance');
        const diagV = document.getElementById('info-diag-voltage');
        const diag = (hasNet && this._netDiagnostics)
            ? this._netDiagnostics.get(item.net) : null;
        const hasDiagR = diag && (diag.expected_resistance_ohms !== null || diag.expected_open);
        const hasDiagV = diag && diag.expected_voltage_v !== null;
        if (diagLabel) diagLabel.hidden = !(hasDiagR || hasDiagV);
        if (diagRow)   diagRow.hidden   = !(hasDiagR || hasDiagV);
        if (diagR) {
            diagR.hidden = !hasDiagR;
            if (hasDiagR) {
                if (diag.expected_open) {
                    diagR.textContent = 'Résistance : OL (≥1 kΩ ou circuit ouvert)';
                } else {
                    const ohms = diag.expected_resistance_ohms;
                    // Format: 0 → court / GND ; <1000 → "Ω" ; ≥1000 → "kΩ".
                    let r;
                    if (ohms === 0)        r = 'court (~0 Ω, GND ou rail)';
                    else if (ohms < 1000)  r = `${ohms.toFixed(0)} Ω`;
                    else                   r = `${(ohms / 1000).toFixed(2)} kΩ`;
                    diagR.textContent = `Résistance : ${r}`;
                }
            }
        }
        if (diagV) {
            diagV.hidden = !hasDiagV;
            if (hasDiagV) diagV.textContent = `Tension : ${diag.expected_voltage_v.toFixed(2)} V`;
        }

        // DFM alternate (DNP) section. The placed sibling carries a list
        // of refdes that share its physical seat but are not stuffed on
        // this board variant. We look each one up in the components
        // index to surface its footprint / value when known.
        const altLabel = document.getElementById('info-alt-label');
        const altRow = document.getElementById('info-alt-row');
        const altList = document.getElementById('info-alt-list');
        const alternates = Array.isArray(item.dnp_alternates) ? item.dnp_alternates : [];
        const hasAlternates = alternates.length > 0;
        if (altLabel) altLabel.hidden = !hasAlternates;
        if (altRow)   altRow.hidden   = !hasAlternates;
        if (altList) {
            altList.innerHTML = '';
            if (hasAlternates) {
                const compIndex = this._compIndex || new Map();
                for (const refdes of alternates) {
                    const alt = compIndex.get(refdes);
                    const li = document.createElement('li');
                    if (alt) {
                        const fp = alt.footprint || alt.id;
                        const v = alt.value || '(non listé au BOM, DNP)';
                        li.innerHTML =
                            `<span class="mono">${refdes}</span> ` +
                            `<span class="muted">${fp}</span><br>` +
                            `<span class="muted">${v}</span>`;
                    } else {
                        li.innerHTML = `<span class="mono">${refdes}</span> <span class="muted">(DNP)</span>`;
                    }
                    altList.appendChild(li);
                }
            }
        }

        this.updateConnectionsPanel(item.net, item.id);

        // For a pin selection, light up every other pin on the same net
        // automatically — that's the action the user expects when they
        // click a pad. Components don't trigger net highlight (would
        // colour every pin tied to whichever net the first pin happened
        // to be on, which is misleading).
        if (item._instanceType === 'pin' || item._instanceType === 'rectPin'
            || item._instanceType === 'dnpPin') {
            if (hasNet) this.highlightNet();
        }

        this.requestRender();
    },


    updateConnectionsPanel(netName, currentId) {
        const label = document.getElementById('info-connections-label');
        const list = document.getElementById('connections-list');
        const countEl = document.getElementById('connections-count');
        if (!list) return;

        list.innerHTML = '';

        if (!netName || netName === 'N/A' || netName === 'NC' ||
            netName === 'UNCONNECTED') {
            if (label) label.hidden = true;
            if (countEl) countEl.hidden = true;
            return;
        }

        const connectedPins = this._hoverableItems.filter(it =>
            it.net === netName && it.id !== currentId
        );
        if (!connectedPins.length) {
            if (label) label.hidden = true;
            if (countEl) countEl.hidden = true;
            return;
        }

        // Group by component
        const byComponent = {};
        for (const pin of connectedPins) {
            const c = pin.component || pin.id;
            (byComponent[c] = byComponent[c] || []).push(pin);
        }
        const names = Object.keys(byComponent).sort();
        const maxDisplay = 12;

        if (label) label.hidden = false;
        for (const compName of names.slice(0, maxDisplay)) {
            const pins = byComponent[compName];
            const li = document.createElement('li');
            li.className = 'brd-ins-link';
            const ref = document.createElement('span');
            ref.className = 'brd-ins-link-ref';
            ref.textContent = compName;
            const cnt = document.createElement('span');
            cnt.className = 'brd-ins-link-count';
            cnt.textContent = pins.length > 1 ? `${pins.length} pins` : '1 pin';
            li.appendChild(ref);
            li.appendChild(cnt);
            li.addEventListener('click', () => this.focusOnItem(pins[0]));
            list.appendChild(li);
        }

        if (countEl) {
            if (names.length > maxDisplay) {
                countEl.hidden = false;
                countEl.textContent = `+ ${names.length - maxDisplay} autres composants`;
            } else {
                countEl.hidden = true;
            }
        }
    },


    focusOnItem(item) {
        if (!item) return;

        this.camera.position.x = item.x;
        this.camera.position.y = item.y;
        this.onResize();
        this.selectItem(item);
    },


    clearSelection() {
        if (this.selectedItem) {
            this._setItemHighlight(this.selectedItem, false);
            this.selectedItem = null;
            this.requestRender();
        }
        this.clearNetHighlight();
        const inspector = document.getElementById('component-info');
        if (inspector) inspector.hidden = true;
    },


    highlightNet() {
        if (!this.selectedItem) return;
        const netName = this.selectedItem.net;
        if (!netName || netName === 'NC') return;

        this.clearNetHighlight();

        const selectedX = this.selectedItem.x;
        const selectedY = this.selectedItem.y;

        // Only PINS belong on the same net — _hoverableItems also holds
        // components, whose `net` field mirrors the first pin's net but
        // are not themselves nodes on that net. Without this filter, the
        // selected pin's net "highlights" every component that happens to
        // have any pin on the same net, with bogus star-pattern lines to
        // each component centroid (looks like extra connections that
        // don't exist).
        const sameNetItems = this._hoverableItems.filter(item =>
            (item._instanceType === 'pin' || item._instanceType === 'rectPin' ||
             item._instanceType === 'testPad') &&
            item.net === netName && item !== this.selectedItem
        );

        this.netLines = [];
        this.highlightedItems = [];

        // Fly-lines tint by the net's category for the meaningful
        // ones (power=amber, ground=darkened, clock=violet, reset=peach).
        // For 'default' (no-net) and 'signal' the category colours are
        // grey/text — they'd disappear against the navy background and
        // the grey pins themselves — so fall back to cyan as the agent
        // overlay colour.
        const cat = this.selectedItem.is_gnd
            ? 'ground'
            : this._netCategory(netName);
        const lineColor = (cat === 'default' || cat === 'signal')
            ? this.colors.netLine
            : this._pinColorForCategory(cat);

        // Recolour every linked pin to the trace colour so the family
        // reads as a unit — without this, signal pins on a clicked
        // signal net stay grey and visually disappear among the rest.
        // The selected pin keeps the cyan highlight (set in selectItem
        // above) as the click anchor.
        sameNetItems.forEach(item => {
            // _restColor: the colour hover-out should snap back to
            // (the net trace colour, not the pin's parse-time original).
            item._restColor = lineColor;
            this._setItemHighlight(item, true, lineColor);
            this.highlightedItems.push(item);
        });

        // Dim every pin / pad NOT on this net toward the deep
        // background colour so the net family reads cleanly without
        // the surrounding pins competing visually. Skipped on GND /
        // unnamed nets above already.
        this._dimUnrelatedPins(netName);
        // Symmetrically push the copper traces — bring matching-net
        // traces up to net-family colour at full opacity, fade the
        // unrelated ones down so the active net's path stands out.
        // Outline (layer 28) and silkscreen (layer 17) are left alone.
        this._highlightNetTraces(netName, lineColor);

        // Draw fly-lines only for sane-sized nets. On GND / NC /
        // multi-thousand-pin planes the star pattern is unreadable AND
        // tanks frame rate. Cap at 200 — covers nearly every named
        // power rail on iPhone-class boards (PP1V25_S2=144,
        // PPVDD_PCPU_AWAKE=142, PP0V6_S1_VDDQL=170, …) while still
        // protecting against GND (~4348 pins on X1799).
        const RATNEST_MAX_PINS = 200;
        if (sameNetItems.length + 1 > RATNEST_MAX_PINS) {
            this.requestRender();
            return;
        }

        // Dashed lines with additive blending: pointillés so the trace
        // reads as 'agent overlay' rather than real copper, plus
        // additive on the navy bg-deep makes the cyan dashes glow and
        // stay visible even at 1px width (WebGL ignores
        // LineBasicMaterial.linewidth on most drivers). depthWrite=false
        // so overlapping lines blend cleanly.
        //
        // Fly-lines are rendered as PlaneGeometry rectangles with a
        // tiled dash TEXTURE (one plane per segment, NOT one plane
        // per dash). Why: WebGL on Chromium clamps `linewidth` to
        // 1 device pixel, which on HiDPI ≈ 0.5 CSS pixels — too
        // thin to register, so we use real-mesh thickness instead.
        // And tiling via texture UV repeat keeps a 200-pin net at
        // 200 meshes total (vs 600+ when each dash was its own
        // plane), which lets onResize update them in place.
        const material = new THREE.MeshBasicMaterial({
            color: lineColor,
            map: this._flyDashTexture,
            opacity: 1.0,
            transparent: true,
            alphaTest: 0.5,
            depthWrite: false,
            depthTest: false,
            side: THREE.DoubleSide,
        });

        // Per-line z bumped well above pin instances (z=2/2.5) so
        // the fly-net floats over everything else.
        const flyZ = 6;
        // When the viewer is filtered to a single face (TOP / BOTTOM)
        // and the board ships dual outline, the hidden face's pins live
        // off in the side-by-side gap area — pointing fly-lines straight
        // at them looks broken (the lines fly into empty space). Project
        // them onto the visible face's frame and drop the endpoint
        // behind the board substrate so the line visibly "dives under"
        // the board, telling the tech the connection continues on the
        // hidden side. In BOTH mode, keep the original side-by-side
        // behaviour — the hidden pin is right there on screen.
        const startPos = this._netEndpointPos(this.selectedItem, flyZ);
        if (!this._netHiddenMarkers) this._netHiddenMarkers = [];
        const thickness = this._flyThicknessWorld();
        const { dashWorld, gapWorld } = this._flyDashWorld();
        sameNetItems.forEach(item => {
            const endPos = this._netEndpointPos(item, flyZ);
            this._createFlyLineDashed(
                startPos, endPos, material, thickness, dashWorld, gapWorld
            );
            // Cross-face endpoint? Drop a clickable down-arrow marker
            // at the projected XY so the tech sees "this connection
            // continues on the other face" and can flip to it directly.
            const isHidden = endPos.z < 0
                && item._side
                && this.sideMode !== 'both'
                && item._side !== this.sideMode;
            if (isHidden) {
                this._addSideFlipArrow(endPos.x, endPos.y, item._side);
            }
        });
        // Also drop an arrow at the start side if (rare) the selected
        // pin itself ended up on the hidden face — usually the agent
        // picks a visible pin, but `bv_highlight` from a refdes can
        // land on a hidden pin too.
        if (startPos.z < 0
            && this.selectedItem._side
            && this.sideMode !== 'both'
            && this.selectedItem._side !== this.sideMode) {
            this._addSideFlipArrow(startPos.x, startPos.y, this.selectedItem._side);
        }

        // Pin the chevrons to a fixed screen pixel height now that
        // the lot has been added.
        this._updateSideArrowScale();
        this.requestRender();
    },


    /**
     * Keep the side-flip chevrons at a fixed pixel height regardless
     * of zoom — same approach as the refdes labels — so they stay
     * easy to click without growing huge when the user is zoomed in.
     */
    _updateSideArrowScale() {
        if (!this._netHiddenMarkers || !this._netHiddenMarkers.length) return;
        const h = (this.container && this.container.clientHeight) || 800;
        const pixelSize = this.frustumSize / h;
        const targetPx = 28;
        const worldSize = targetPx * pixelSize;
        for (const sprite of this._netHiddenMarkers) {
            sprite.scale.set(worldSize, worldSize, 1);
            if (sprite.userData) {
                sprite.userData.width = worldSize;
                sprite.userData.height = worldSize;
            }
        }
    },


    /**
     * Paint a small clickable down-chevron at (x, y) marking a fly-line
     * endpoint that physically lives on the hidden face. Click flips
     * the viewer to that face. Tracked in `_netHiddenMarkers` so
     * `clearNetHighlight` removes them along with the lines.
     */
    _addSideFlipArrow(x, y, targetSide) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = document.createElement('canvas');
        canvas.width = 64 * dpr;
        canvas.height = 64 * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        // Glass-bg disc so the chevron reads on busy areas.
        ctx.fillStyle = 'rgba(15, 22, 35, 0.85)';
        ctx.beginPath();
        ctx.arc(32, 32, 26, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(95, 199, 255, 0.95)';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        // Down chevron.
        const chevColor = '#5fc7ff';
        ctx.strokeStyle = chevColor;
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(20, 26);
        ctx.lineTo(32, 40);
        ctx.lineTo(44, 26);
        ctx.stroke();

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
        });
        const sprite = new THREE.Sprite(material);
        // Sit above the fly-line z so the disc is opaque over the
        // dashed cyan; world size in mm is rescaled with zoom by
        // `_updateSideArrowScale` (kept ~22 px tall).
        sprite.position.set(x, y, 7);
        const worldSize = this.frustumSize ? this.frustumSize * 0.04 : 2.5;
        sprite.scale.set(worldSize, worldSize, 1);
        sprite.userData = {
            _instanceType: 'sideArrow',
            _targetSide: targetSide,
            x, y,
            width: worldSize,
            height: worldSize,
            type: 'SIDE_FLIP',
            id: '',
            net: '',
            // _side null so the side filter doesn't hide the arrow.
            _side: null,
            _mesh: sprite,
        };
        this._hoverableItems.push(sprite.userData);
        this._netHiddenMarkers.push(sprite);
        this.scene.add(sprite);
        // The spatial grid was built once at load; without inserting
        // the arrow's proxy into it, `_getNearbyItems` returns no
        // candidates around the cursor and the click never registers.
        this._addToSpatialGrid(sprite.userData);
    },


    _addToSpatialGrid(item) {
        if (!this._spatialGrid) return;
        const key = this._getGridKey(item.x, item.y);
        if (!this._spatialGrid[key]) this._spatialGrid[key] = [];
        this._spatialGrid[key].push(item);
    },


    /**
     * Resolve a pin / test-pad's fly-line endpoint XYZ given the current
     * side filter. When the pin lives on the hidden face (e.g. selected
     * pin is TOP-side, sideMode='top', target pin is BOTTOM-side), the
     * pin's display XY is in the empty gap region next to the visible
     * face — not where the tech expects the connection to go. Project
     * it onto the visible face's frame (subtract the inter-face delta
     * along the dual-outline axis) and drop z below the board so the
     * line dives under the substrate, signalling "this net continues
     * on the other side".
     */
    _netEndpointPos(item, defaultZ) {
        const visibleZ = defaultZ;
        const hiddenZ = -2;  // behind the board outline at z=0.5
        if (this.sideMode === 'both' || !item._side) {
            return { x: item.x, y: item.y, z: visibleZ };
        }
        if (item._side === this.sideMode) {
            return { x: item.x, y: item.y, z: visibleZ };
        }
        // Item on the hidden face. Without a dualOutline layout
        // (single-board formats: .fz / .cad GenCAD / KiCad / BRD), the
        // pin's display X/Y already matches its physical position on
        // the board — same XY for top-side and bottom-side. Drop Z
        // below the substrate so the fly-line "dives under" and the
        // side-flip chevron lands at the visible spot, letting the
        // tech click to flip to the actual face the pad sits on.
        if (!this.dualOutline) {
            return { x: item.x, y: item.y, z: hiddenZ };
        }
        // Pin is on the hidden face. Map its display position onto the
        // visible face's coordinate frame following the OpenBoardView
        // flip convention: for a side-by-side X split the
        // bottom view is the result of flipping the physical board
        // around its vertical edge, so the X axis is MIRRORED between
        // faces (left of top = right of bottom, same physical pin).
        // For a stacked Y split, mirror Y instead.
        //
        // The mirror formula `T.x + B.x + B.w - pin.x` is symmetric:
        // it works equally well for top→bottom and bottom→top because
        // a mirror is its own inverse. Y (the non-split axis under X
        // split) just translates by the inter-face origin delta — and
        // that delta flips sign depending on which face is the target.
        const dual = this.dualOutline;
        const top = dual.bbox_top;
        const bot = dual.bbox_bottom;
        let tx, ty;
        if (dual.axis === 'x') {
            tx = top.x + bot.x + bot.w - item.x;
            const tyOffset = this.sideMode === 'top'
                ? (top.y - bot.y)
                : (bot.y - top.y);
            ty = item.y + tyOffset;
        } else {
            ty = top.y + bot.y + bot.h - item.y;
            const txOffset = this.sideMode === 'top'
                ? (top.x - bot.x)
                : (bot.x - top.x);
            tx = item.x + txOffset;
        }
        return { x: tx, y: ty, z: hiddenZ };
    },


    clearNetHighlight() {
        if (this.highlightedItems && this.highlightedItems.length > 0) {
            // Drop the per-net resting override BEFORE restoring colour
            // so `_setItemHighlight(item, false)` snaps to originalColor
            // instead of looping back to the just-cleared net colour.
            this.highlightedItems.forEach(item => {
                delete item._restColor;
                this._setItemHighlight(item, false);
            });
            this.highlightedItems = [];
        }
        // Restore the dimmed pins back to their original colour.
        this._undimAllPins();
        // And restore the copper traces back to their parse-time
        // colour + opacity so the next net selection starts clean.
        this._undimAllTraces();

        if (this.netLines && this.netLines.length > 0) {
            this.netLines.forEach(line => this.scene.remove(line));
            this.netLines = [];
        }

        if (this._netHiddenMarkers && this._netHiddenMarkers.length > 0) {
            // Drop the side-flip arrows + their hoverable proxies so a
            // fresh selection doesn't accumulate stale chevrons or keep
            // the click target after the underlying line is gone.
            const markerProxies = new Set(
                this._netHiddenMarkers.map((s) => s.userData)
            );
            this._netHiddenMarkers.forEach((s) => this.scene.remove(s));
            this._netHiddenMarkers = [];
            this._hoverableItems = this._hoverableItems.filter(
                (it) => !markerProxies.has(it)
            );
            // Strip the same proxies out of every spatial grid cell
            // that referenced them — otherwise stale entries keep
            // matching `_getNearbyItems` after the chevron is gone.
            if (this._spatialGrid) {
                for (const key of Object.keys(this._spatialGrid)) {
                    this._spatialGrid[key] = this._spatialGrid[key].filter(
                        (it) => !markerProxies.has(it)
                    );
                }
            }
        }

        this.requestRender();
    }
};
