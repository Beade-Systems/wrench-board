/** Components operations on the shared PCB viewer state. */

export const componentsMethods = {

    createComponent(comp) {
        // DFM-alternate / DNP — the populated sibling carries the BOM
        // value and gets drawn normally. The non-stuffed footprint
        // gets a separate dashed-outline render that's hidden by
        // default and toggled via `_showDnp`. Pads aren't drawn for
        // the DNP (the placed sibling already covers the same physical
        // pads), so the overlay is just the alternate body footprint.
        if (comp.is_dnp) {
            this._createDnpOutline(comp);
            return;
        }

        const group = new THREE.Group();
        const w = comp.width;
        const h = comp.height;
        const hw = w / 2;
        const hh = h / 2;
        const isTestPoint = comp.type === 'TEST_POINT';

        // Whether to fall back to the AABB outline rectangle. We only
        // draw the AABB when the part has NO silkscreen body_lines —
        // otherwise the silkscreen segments below already trace the
        // package outline and the AABB rectangle just stacks a second
        // outline on top of them (visible as a 'double contour' on
        // RF107 / RF770 / CF730 / etc.). XZZ populates body_lines for
        // most parts; KiCad/BRD don't.
        const hasBodyLines = Array.isArray(comp.body_lines) && comp.body_lines.length > 0;

        // Body fill — soft grey rectangle behind the pads so each
        // component reads as a defined object on the dense board.
        // For XZZ parts with body_lines we fill
        // the body_lines bbox in absolute coords (no group rotation,
        // since body_lines are absolute too); for KiCad/BRD parts
        // (no body_lines) we fill the AABB inside the rotated group.
        if (!isTestPoint) {
            const fillMat = new THREE.MeshBasicMaterial({
                color: 0x2a3140,            // dim grey-blue, between bg-deep and panel
                transparent: true,
                opacity: 0.55,
                depthWrite: false,
            });
            if (hasBodyLines) {
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                for (const seg of comp.body_lines) {
                    if (seg.x1 < minX) minX = seg.x1;
                    if (seg.x2 < minX) minX = seg.x2;
                    if (seg.x1 > maxX) maxX = seg.x1;
                    if (seg.x2 > maxX) maxX = seg.x2;
                    if (seg.y1 < minY) minY = seg.y1;
                    if (seg.y2 < minY) minY = seg.y2;
                    if (seg.y1 > maxY) maxY = seg.y1;
                    if (seg.y2 > maxY) maxY = seg.y2;
                }
                const fw = maxX - minX, fh = maxY - minY;
                if (fw > 0 && fh > 0) {
                    const fillGeom = new THREE.PlaneGeometry(fw, fh);
                    const fillMesh = new THREE.Mesh(fillGeom, fillMat);
                    fillMesh.position.set((minX + maxX) / 2, (minY + maxY) / 2, 0.6);
                    fillMesh.userData._side = comp._side || null;
                    this.scene.add(fillMesh);
                    this._componentExtras.push(fillMesh);
                }
            } else {
                // No body_lines — fill the AABB inside the rotated
                // group so the fill rotates with the part.
                const fillGeom = new THREE.PlaneGeometry(w, h);
                const fillMesh = new THREE.Mesh(fillGeom, fillMat);
                fillMesh.position.set(0, 0, 0.01);
                // Stash own original colour so hover-out via the null-
                // sentinel branch in `setMeshColor` restores the fill
                // back to grey-blue instead of inheriting the parent
                // component's outline cyan.
                fillMesh.userData.origColor = 0x2a3140;
                group.add(fillMesh);
            }
        }

        if (isTestPoint) {
            // No special centred overlay — the per-pin instanced
            // renderer now colours TEST_POINT pins in orange directly
            // (component_type field flows through the pin payload).
        } else if (!hasBodyLines) {
            // Outline-only rectangle, no fill, no per-type shape
            // variants. Matches the SVG renderer's reference look.
            const points = [
                new THREE.Vector3(-hw, -hh, 0.02),
                new THREE.Vector3( hw, -hh, 0.02),
                new THREE.Vector3( hw,  hh, 0.02),
                new THREE.Vector3(-hw,  hh, 0.02),
                new THREE.Vector3(-hw, -hh, 0.02),
            ];
            const borderGeom = new THREE.BufferGeometry().setFromPoints(points);
            const borderMat = new THREE.LineBasicMaterial({
                color: this.colors.componentOutline,
                transparent: true,
                opacity: 0.85,
            });
            const borderLine = new THREE.Line(borderGeom, borderMat);
            // Stash for the per-mesh hover-out restore path.
            borderLine.userData.origColor = this.colors.componentOutline;
            group.add(borderLine);
        }

        const compZ = comp.layer === 'top' ? 1 : (comp.layer === 'bottom' ? 0.5 : 0.75);
        group.position.set(comp.x + w / 2, comp.y + h / 2, compZ);

        // Silkscreen body lines stay in absolute board coordinates and
        // render as a separate scene mesh — XZZ bakes rotation into the
        // segment endpoints, so adding them inside the rotated group
        // would double-rotate them. Coloured in componentOutline (cyan)
        // not the white silkscreen token: otherwise XZZ components
        // (which DO populate body_lines) read as a wash of white over
        // the cyan AABB box, making them look greyish — KiCad/MNT
        // (which DON'T populate body_lines) stays pure cyan, and the
        // mismatch was visible side by side.
        if (hasBodyLines) {
            const silkPts = [];
            for (const seg of comp.body_lines) {
                silkPts.push(new THREE.Vector3(seg.x1, seg.y1, compZ + 0.04));
                silkPts.push(new THREE.Vector3(seg.x2, seg.y2, compZ + 0.04));
            }
            const silkGeom = new THREE.BufferGeometry().setFromPoints(silkPts);
            const silkMat = new THREE.LineBasicMaterial({
                color: this.colors.componentOutline,
                transparent: true,
                opacity: 0.7,
            });
            const silkMesh = new THREE.LineSegments(silkGeom, silkMat);
            silkMesh.userData._side = comp._side || null;
            this.scene.add(silkMesh);
            this._componentExtras.push(silkMesh);
        }

        if (comp.rotation) {
            group.rotation.z = comp.rotation * Math.PI / 180;
        }

        // Silkscreen label sprite for 0-pin parts (logos, badges,
        // region labels — BADGE / REFORM / CPU / MPCIE on the MNT
        // Reform, NOTOUCH zones, etc.). Mirrors brd_viewer.js's
        // 'annotations' loop. Renders the label as a flat sprite at
        // the bbox centre in absolute board coords (so silkscreen text
        // doesn't double-rotate with the part group).
        if (!comp.pin_count) {
            this._addSilkscreenLabel(comp);
        } else {
            // Real components get a refdes sprite that auto-hides at low zoom.
            this._addComponentRefdesLabel(comp);
        }

        // Hover/select uses `item.x, item.y` as the *centre* (so the
        // AABB-distance check in `checkHover` reduces to 0 when the
        // cursor sits inside the rectangle). The render payload's
        // `comp.x, comp.y` is the bbox bottom-left — pass the centre
        // explicitly so hover lights up the entire component, not
        // just a 20-px radius around its corner.
        const itemData = {
            ...comp,
            x: comp.x + w / 2,
            y: comp.y + h / 2,
            _mesh: group,
            _side: comp._side || null,
            originalColor: isTestPoint ? this.colors.testPad : this.colors.componentOutline,
        };
        group.userData = itemData;
        this._hoverableItems.push(itemData);

        this.scene.add(group);
        this.meshGroups.components.push(group);
    },


    _addComponentRefdesLabel(comp) {
        const refdes = comp.id;
        if (!refdes) return;

        const w = comp.width;
        const h = comp.height;
        const longSide = Math.max(w, h);
        // No size cutoff: XZZ passives can be 0.25 mm × 0.15 mm (smaller
        // than half a millimetre) but readable when zoomed in. Visibility
        // is exclusively driven by the screen-pixel threshold in
        // _updateComponentLabelVisibility, so the label hides at low zoom
        // and pops in once the part covers enough on-screen pixels.

        // Higher resolution canvas + DPR-aware so crisp at any zoom.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = document.createElement('canvas');
        canvas.width = 256 * dpr;
        canvas.height = 64 * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        const hex = '#' + this.colors.silkscreen.toString(16).padStart(6, '0');
        ctx.font = "800 38px 'Inter', system-ui, sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Subtle dark stroke under the fill so the text reads cleanly
        // against bright pads / busy areas. Anthropic-style: weighted
        // sans, crisp edges, soft glow via additive blending below.
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(7,16,31,0.85)';   // bg-deep
        ctx.strokeText(refdes, 128, 32);
        ctx.fillStyle = hex;
        ctx.fillText(refdes, 128, 32);

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            opacity: 0.95,
            blending: THREE.AdditiveBlending,
        });
        const sprite = new THREE.Sprite(material);

        // Scale set to a fixed screen pixel height by
        // _updateRefdesLabelScale, refreshed on every zoom change so
        // refdes labels stay readable (~14 px tall) regardless of zoom
        // level. Initial scale is just a placeholder.
        const aspect = canvas.width / canvas.height;  // 4
        sprite.scale.set(1, 1 / aspect, 1);
        sprite.position.set(comp.x + w / 2, comp.y + h / 2, 3);
        sprite.visible = false;  // _updateComponentLabelVisibility will flip

        // Stash long side for the zoom-driven visibility check + canvas
        // aspect for the pixel-height scaler.
        sprite.userData.compLong = longSide;
        sprite.userData.aspect = aspect;
        sprite.userData._refdes = refdes;
        sprite.userData._side = comp._side || null;
        this._componentLabels.push(sprite);
        this.scene.add(sprite);
    },


    /**
     * Refdes labels render at a fixed screen pixel height (~14 px) so
     * they stay readable at any zoom. World units are recomputed each
     * zoom from the current pixelSize.
     */
    _updateRefdesLabelScale() {
        if (!this._componentLabels.length) return;
        const h = (this.container && this.container.clientHeight) || 800;
        const pixelSize = this.frustumSize / h;
        const targetH = this._refdesPixelHeight * pixelSize;
        for (const sprite of this._componentLabels) {
            const aspect = sprite.userData.aspect || 4;
            sprite.scale.set(targetH * aspect, targetH, 1);
        }
    },


    /**
     * Compute world-unit dash + gap size targeting ~10 px dashes and
     * ~7 px gaps regardless of zoom. Used by highlightNet at create-time
     * and by _updateFlyLineDashes on every zoom change.
     */
    _flyDashWorld() {
        const h = (this.container && this.container.clientHeight) || 800;
        const pixelSize = this.frustumSize / h;
        // Heavy dash, light gap: 14 px ON / 6 px OFF.
        return { dashWorld: 14 * pixelSize, gapWorld: 6 * pixelSize };
    },


    _flyThicknessWorld() {
        const h = (this.container && this.container.clientHeight) || 800;
        const pixelSize = this.frustumSize / h;
        // ~1.5 CSS pixels thick — fine but still visibly above the
        // 1-device-px floor that THREE.Line would land on.
        return 1.5 * pixelSize;
    },


    /**
     * Build the dashed-pattern alpha texture used by fly-lines. 20 px
     * wide canvas: 14 px opaque white, 6 px transparent (70 % duty).
     * The texture is set to wrap horizontally so plane UV repeats
     * tile the dashes along each fly-line segment.
     */
    _createFlyDashTexture() {
        const c = document.createElement('canvas');
        c.width = 20; c.height = 4;
        const ctx = c.getContext('2d');
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.fillRect(0, 0, 14, 4);
        // Last 6 pixels stay transparent → the gap between dashes.
        const tex = new THREE.CanvasTexture(c);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.premultiplyAlpha = true;
        return tex;
    },


    /**
     * Set a PlaneGeometry's X-axis UVs so the bound texture tiles
     * `repeatX` times across the plane. PlaneGeometry vertex order:
     * [bl, br, tl, tr] — we keep Y untouched and stretch X.
     */
    _setUVRepeatX(geometry, repeatX) {
        const uvs = geometry.attributes.uv;
        if (!uvs) return;
        uvs.setXY(0, 0, 0);
        uvs.setXY(1, repeatX, 0);
        uvs.setXY(2, 0, 1);
        uvs.setXY(3, repeatX, 1);
        uvs.needsUpdate = true;
    },


    /**
     * Draw a dashed segment between two endpoints as a sequence of
     * short PlaneGeometry rectangles, oriented along the segment and
     * spaced with `gapWorld` gaps. Each plane is `thickness` units
     * wide. We can't use THREE.Line / LineDashedMaterial because
     * WebGL on Chromium ignores `linewidth` (clamps to 1 px), making
     * the dashes effectively invisible at HiDPI; PlaneGeometry has
     * real world-unit width that scales correctly.
     *
     * `material` is shared across all planes for one fly-line group
     * so the colour update path stays cheap.
     */
    /**
     * Single-plane fly-line: one PlaneGeometry stretched between
     * start and end, with a dashed alpha-mapped material. UV repeat
     * tiles the dash pattern along the segment so we don't have to
     * spawn one mesh per dash. On zoom, only `scale.y` (thickness)
     * and the UV repeat need refreshing — `_updateFlyLineDashes`
     * does both in place without rebuilding the scene graph.
     */
    _createFlyLineDashed(startPos, endPos, material, thickness, dashWorld, gapWorld) {
        const dx = endPos.x - startPos.x;
        const dy = endPos.y - startPos.y;
        const length2D = Math.sqrt(dx * dx + dy * dy);
        if (length2D < 1e-4) return;
        const angle = Math.atan2(dy, dx);
        const stride = dashWorld + gapWorld;

        // Unit-square plane scaled to (length, thickness) — keeps a
        // single shared geometry vertex layout while letting each
        // mesh stretch independently. UVs default to [0..1]; we
        // stretch X only so the dash texture tiles `repeatX` times.
        const geom = new THREE.PlaneGeometry(1, 1);
        const repeatX = length2D / stride;
        this._setUVRepeatX(geom, repeatX);
        const mesh = new THREE.Mesh(geom, material);
        mesh.position.set(
            (startPos.x + endPos.x) / 2,
            (startPos.y + endPos.y) / 2,
            (startPos.z + endPos.z) / 2,
        );
        mesh.rotation.z = angle;
        mesh.scale.set(length2D, thickness, 1);
        // Stash the segment length so `_updateFlyLineDashes` can
        // recompute the UV repeat at the new dash stride on zoom
        // without re-walking the original endpoints.
        mesh.userData._flyLength = length2D;
        this.scene.add(mesh);
        this.netLines.push(mesh);
    },


    /**
     * Recompute dashSize / gapSize on every active fly-line so the
     * dashed trace stays at a consistent ~10 px dash regardless of
     * zoom. Without this, zooming in turns each dash into a huge slab
     * (the world-unit dashSize stays fixed but the pixel size grows),
     * and zooming out makes them sub-pixel and effectively solid.
     */
    _updateFlyLineDashes() {
        if (!this.netLines || !this.netLines.length) return;
        // In-place update: each fly-line is now a single Plane mesh
        // with a tiled dash texture, so a zoom step just needs to
        // refresh the world-unit thickness (mesh.scale.y) and the
        // X-axis UV repeat (so dashes stay ~14 px ON / 6 px OFF on
        // screen at the new zoom). No add / remove on the scene
        // graph — fast even at the 200-fly-line cap.
        const thickness = this._flyThicknessWorld();
        const { dashWorld, gapWorld } = this._flyDashWorld();
        const stride = dashWorld + gapWorld;
        for (const mesh of this.netLines) {
            const len = mesh.userData && mesh.userData._flyLength;
            if (!len) continue;
            mesh.scale.y = thickness;
            this._setUVRepeatX(mesh.geometry, len / stride);
        }
    },



    /**
     * Flip refdes-label visibility based on current zoom: a label only
     * shows once its component is at least `_labelMinPx` pixels wide on
     * screen. Without this, zooming out paints the entire board with
     * unreadable refdes spam.
     */
    _updateComponentLabelVisibility() {
        if (!this._componentLabels.length) return;
        const h = this.container.clientHeight;
        if (!h) return;
        const pixelSize = this.frustumSize / h;       // world units per pixel
        const minWorld = this._labelMinPx * pixelSize;
        const mode = this.sideMode;
        const prefix = this._agentFilterPrefix;
        const refdesOk = (id) => !prefix
            || (id && id.toUpperCase().startsWith(prefix));
        for (const sprite of this._componentLabels) {
            const side = sprite.userData._side;
            const sideOk = mode === 'both' || side == null || side === mode;
            // DNP-alternate labels are gated additionally by `_showDnp`
            // so the alternates' refdes only appear when the user has
            // toggled the DFM overlay on.
            if (sprite.userData._dnpLabel && !this._showDnp) {
                sprite.visible = false;
                continue;
            }
            // Refdes-prefix filter (set by bv_filter_by_type) hides
            // labels whose refdes does not match the active prefix.
            // Applied as the third axis in the side AND DNP AND refdes
            // composite gate so all three filters compose cleanly.
            if (!refdesOk(sprite.userData._refdes)) {
                sprite.visible = false;
                continue;
            }
            sprite.visible = sideOk && sprite.userData.compLong >= minWorld;
        }
    },


    _addSilkscreenLabel(comp) {
        const raw = (comp.value || comp.id || '').replace(/^(LABEL_|LOGO_)/, '');
        if (!raw) return;

        const w = comp.width;
        const h = comp.height;
        const longSide = Math.max(w, h);
        const shortSide = Math.min(w, h);
        if (longSide < 1) return;  // bbox too small to render readably
        const landscape = w >= h;

        // Render text into a high-DPR canvas. Hex from token
        // (--text = #e6edf7). No background fill, but a thin dark
        // stroke around the glyphs so the text reads on busy areas.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = document.createElement('canvas');
        canvas.width = 512 * dpr;
        canvas.height = 128 * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        const hex = '#' + this.colors.silkscreen.toString(16).padStart(6, '0');
        ctx.font = "800 64px 'Inter', system-ui, sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(7,16,31,0.85)';
        ctx.strokeText(raw, 256, 64);
        ctx.fillStyle = hex;
        ctx.fillText(raw, 256, 64);

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        const material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            opacity: 0.95,
            blending: THREE.AdditiveBlending,
        });

        // Plane sized to ~85% of long side x proportional short side.
        // Using a Plane (not a Sprite) so we can rotate it -90° for
        // portrait bboxes — same rule as brd_viewer.js: KiCad footprint
        // rotation is implicit in the bbox proportions, so a tall bbox
        // means the silkscreen text was printed vertically.
        const aspect = canvas.width / canvas.height;  // 4
        const geom = new THREE.PlaneGeometry(1, 1 / aspect);
        const mesh = new THREE.Mesh(geom, material);
        // +PI/2 (CCW) so the text reads upward / top-to-bottom in the
        // Three.js Y-up scene — brd_viewer.js's -PI/2 was for canvas 2D
        // Y-down, the rotation sign flips between the two coord systems.
        if (!landscape) mesh.rotation.z = Math.PI / 2;
        mesh.position.set(comp.x + w / 2, comp.y + h / 2, 4);

        // Stash measurements; _updateSilkscreenLabelScale picks the
        // smaller of (bbox-fit world width) and (cap world width from
        // the screen pixel ceiling) on every zoom change.
        mesh.userData.longSide = longSide;
        mesh.userData.aspect = aspect;
        mesh.userData._side = comp._side || null;
        this._silkscreenLabels.push(mesh);
        this.scene.add(mesh);
    },


    /**
     * Silkscreen labels stay anchored to the bbox (so a small zone reads
     * with smaller text, a big zone with bigger text), but cap the
     * pixel height at `_silkscreenMaxPixelHeight` so they don't blow
     * up to comic-sans size when zoomed in close on a large region
     * label like BADGE.
     */
    _updateSilkscreenLabelScale() {
        if (!this._silkscreenLabels.length) return;
        const h = (this.container && this.container.clientHeight) || 800;
        const pixelSize = this.frustumSize / h;
        const maxLong = this._silkscreenMaxPixelHeight * pixelSize *
            (this._silkscreenLabels[0].userData.aspect || 4);
        for (const mesh of this._silkscreenLabels) {
            const aspect = mesh.userData.aspect || 4;
            const fitLong = mesh.userData.longSide * 0.85;
            const targetLong = Math.min(fitLong, maxLong);
            mesh.scale.set(targetLong, targetLong / aspect, 1);
        }
    },



    createTrace(trace) {
        if (trace.points.length < 2) return;

        // Layer 28 in XZZ is the board edge / outline. Render it brighter
        // (silkscreen white) and slightly thicker than copper traces so
        // the board contour pops on the dark scene background. Layer 17
        // is silkscreen — same neutral white. Copper traces (layers
        // 1..16) inherit their net's category colour (power copper-orange,
        // ground dark grey, signal light grey, etc.) so each net's
        // routing reads visually consistent with its pins. Traces with
        // no net (rare — connector strips or mechanical) fall back to
        // the neutral copper hue.
        const isOutline = trace.layer === 28;
        const isSilkscreen = trace.layer === 17;
        let color;
        if (isOutline || isSilkscreen) {
            color = this.colors.silkscreen;
        } else if (trace.net) {
            const cat = (trace.is_gnd || trace.net === 'GND')
                ? 'ground'
                : this._netCategory(trace.net);
            color = this._pinColorForCategory(cat);
        } else {
            color = this.colors.copper;
        }
        const opacity = isOutline ? 0.95 : 0.6;
        const zPos = isOutline ? 0.5 : 0.3;

        const points = trace.points.map(p => new THREE.Vector3(p.x, p.y, zPos));
        const geom = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({
            color: color,
            transparent: !isOutline,
            opacity: opacity,
            linewidth: isOutline ? 2 : 1,
        });
        const line = new THREE.Line(geom, mat);
        line.userData = {
            ...trace,
            type: 'TRACE',
            _side: trace._side || null,
            // Stash parse-time material values so the net-highlight /
            // unhighlight path can restore them without a global
            // colors.copper lookup (which would already have changed
            // if the user retuned the palette).
            origColor: color,
            origOpacity: opacity,
            _kind: isOutline ? 'outline' : (isSilkscreen ? 'silkscreen' : 'copper'),
        };
        // Always show the board outline, even when the user disabled
        // copper-trace overlay.
        line.visible = isOutline ? true : this.showTraces;

        this.scene.add(line);
        this.meshGroups.traces.push(line);
    }
};
