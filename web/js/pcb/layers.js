/** Layers operations on the shared PCB viewer state. */

export const layersMethods = {

    /**
     * Toggle the DNP overlay layer. Pure visibility flip — no scene
     * rebuild, no payload re-fetch.
     */
    setShowDnp(show) {
        this._showDnp = !!show;
        // Body fills + dashed outlines tracked in `_dnpMeshes` —
        // simple visibility flip.
        if (this._dnpMeshes) {
            for (const m of this._dnpMeshes) m.visible = this._showDnp;
        }
        // Per-instance DNP pads live in the standard pin meshes with
        // `_dnpFlags`. `_applySideToInstanced` honours the flag, so
        // running it across all relevant meshes is enough to flip the
        // DNP pads' matrices to/from zero-scale.
        this._applySideToInstanced(this._circularPinInstance);
        this._applySideToInstanced(this._circularPinBorderInstance);
        if (this._rectPinInstances) {
            this._rectPinInstances.forEach(({ body }) => {
                this._applySideToInstanced(body);
            });
        }
        // Per-pin rect borders are individual Lines — flip their
        // visibility against the side filter and the refdes-prefix
        // filter so the three axes (side, DNP, refdes) compose cleanly.
        if (this._pinBorderLines) {
            const allow = (side) => this.sideMode === 'both'
                || side == null
                || side === this.sideMode;
            const prefix = this._agentFilterPrefix;
            const refdesOk = (id) => !prefix
                || (id && id.toUpperCase().startsWith(prefix));
            for (const m of this._pinBorderLines) {
                if (!m.userData || !m.userData._isDnp) continue;
                m.visible = this._showDnp
                    && allow(m.userData._side)
                    && refdesOk(m.userData._component);
            }
        }
        if (typeof this._updateComponentLabelVisibility === 'function') {
            this._updateComponentLabelVisibility();
        }
        if (typeof this.requestRender === 'function') this.requestRender();
    },


    /**
     * Toggle the vias layer. GenCAD boards ship thousands of vias
     * (every BGA ball + routing stitching) which can clutter the
     * canvas around dense areas. The user toggles them off when
     * diagnosing pad-level work, on when looking at routing.
     */
    setShowVias(show) {
        this._showVias = !!show;
        if (this._viasOuterInstance) this._viasOuterInstance.visible = this._showVias;
        if (this._viasInnerInstance) this._viasInnerInstance.visible = this._showVias;
    },


    _createViasInstanced(vias) {
        const count = vias.length;

        // Outer ring
        const outerGeom = this._sharedGeometries.viaOuter;
        const outerMat = this._sharedMaterials.via.clone();
        const outerMesh = new THREE.InstancedMesh(outerGeom, outerMat, count);
        outerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Per-instance colour so mounting holes (no net) render in
        // gold while electrical vias keep the standard violet.
        outerMesh.instanceColor = new THREE.InstancedBufferAttribute(
            new Float32Array(count * 3), 3
        );
        outerMesh.userData._matrices = new Array(count);
        outerMesh.userData._sides = new Array(count);

        // Inner hole
        const innerGeom = this._sharedGeometries.viaInner;
        const innerMat = this._sharedMaterials.viaHole.clone();
        const innerMesh = new THREE.InstancedMesh(innerGeom, innerMat, count);
        innerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        innerMesh.userData._matrices = new Array(count);
        innerMesh.userData._sides = new Array(count);

        const matrix = new THREE.Matrix4();
        const innerMatrix = new THREE.Matrix4();
        const tmpColor = new THREE.Color();

        vias.forEach((via, i) => {
            const radius = via.radius || 0.3;

            matrix.makeScale(radius, radius, 1);
            matrix.setPosition(via.x, via.y, 0.8);
            outerMesh.setMatrixAt(i, matrix);
            outerMesh.userData._matrices[i] = matrix.clone();
            outerMesh.userData._sides[i] = via._side || null;

            innerMatrix.makeScale(radius, radius, 1);
            innerMatrix.setPosition(via.x, via.y, 0.81);
            innerMesh.setMatrixAt(i, innerMatrix);
            innerMesh.userData._matrices[i] = innerMatrix.clone();
            innerMesh.userData._sides[i] = via._side || null;

            // A via with no net is a mechanical drill (mounting hole,
            // screw hole) — paint its outer ring in the same gold as
            // signal test pads to mirror the silkscreen
            // convention. Electrical vias inherit their net's category
            // colour so they visually integrate with the rails / signals
            // they belong to (power vias copper-orange, ground vias dark
            // grey, signal vias light grey, etc.).
            const isMounting = !via.net || via.net === '' || via.net === 'NC';
            let ringHex;
            if (isMounting) {
                ringHex = this.colors.pinTestPadSignal;  // gold
            } else {
                const cat = (via.is_gnd || via.net === 'GND')
                    ? 'ground'
                    : this._netCategory(via.net);
                ringHex = this._pinColorForCategory(cat);
            }
            tmpColor.setHex(ringHex);
            outerMesh.setColorAt(i, tmpColor);

            this._viaInstanceData.push({
                ...via,
                _instanceType: 'via',
                _instanceId: i,
                _side: via._side || null,
                originalColor: ringHex,
                type: 'VIA'
            });
        });

        outerMesh.instanceMatrix.needsUpdate = true;
        outerMesh.instanceColor.needsUpdate = true;
        innerMesh.instanceMatrix.needsUpdate = true;

        outerMesh.visible = this.showVias;
        innerMesh.visible = this.showVias;

        this._viasOuterInstance = outerMesh;
        this._viasInnerInstance = innerMesh;
        this.scene.add(outerMesh);
        this.scene.add(innerMesh);

        console.log(`[PERF] Created ${count} vias with 2 draw calls (was ${count * 2})`);
    },


    /**
     * Render `$MECH HOLE` entries from a GenCAD `.cad` file.
     *
     * - Fixation holes (corner screws, ø > 100 mils): outer steel-grey
     *   ring on top of a black drill centre. Drawn slightly above the
     *   via z-plane so they read as physical structure even when there
     *   are vias right next to them.
     * - Fiducials (centre dots, ø ≤ 100 mils): single filled gold disc
     *   to mirror the optical reference dots on the silkscreen.
     *
     * Holes are mechanical, not electrical — no net, no hover/select
     * intent at this stage. Five-or-so per board so plain `THREE.Mesh`
     * is enough; no need for InstancedMesh.
     */
    _createMechHoles(holes) {
        const fixationColor = 0xa1a1aa;  // slate-400 — steel pad finish
        const drillColor = this.colors.background;  // hollow centre
        const fiducialColor = this.colors.pinTestPadSignal;  // gold

        // Lazy-create the materials once. Re-use across renders.
        if (!this._mechHoleMaterials) {
            this._mechHoleMaterials = {
                fixationRing: new THREE.MeshBasicMaterial({
                    color: fixationColor,
                    side: THREE.DoubleSide,
                }),
                fixationDrill: new THREE.MeshBasicMaterial({
                    color: drillColor,
                    side: THREE.DoubleSide,
                }),
                fiducial: new THREE.MeshBasicMaterial({
                    color: fiducialColor,
                    side: THREE.DoubleSide,
                }),
            };
        }
        const M = this._mechHoleMaterials;
        const meshes = [];

        // Z-plane: above board substrate (0.5), below pins (1.0).
        const Z_RING = 0.85;
        const Z_DRILL = 0.86;

        holes.forEach((h) => {
            const r = (h.diameter || 0.5) / 2;
            if (h.is_fiducial) {
                const geom = new THREE.CircleGeometry(r, 32);
                const mesh = new THREE.Mesh(geom, M.fiducial);
                mesh.position.set(h.x, h.y, Z_RING);
                this.scene.add(mesh);
                meshes.push(mesh);
            } else {
                // Outer ring: an annulus from r*0.55 to r so the drill
                // hole reads. Inner drill on top in board background
                // colour for the "see-through" look.
                const ringGeom = new THREE.RingGeometry(r * 0.55, r, 32);
                const drillGeom = new THREE.CircleGeometry(r * 0.55, 32);
                const ringMesh = new THREE.Mesh(ringGeom, M.fixationRing);
                const drillMesh = new THREE.Mesh(drillGeom, M.fixationDrill);
                ringMesh.position.set(h.x, h.y, Z_RING);
                drillMesh.position.set(h.x, h.y, Z_DRILL);
                this.scene.add(ringMesh);
                this.scene.add(drillMesh);
                meshes.push(ringMesh, drillMesh);
            }
        });

        this._mechHoleMeshes = meshes;
        console.log(`[PERF] Created ${holes.length} mechanical holes (${meshes.length} meshes)`);
    },


    _createTestPadsInstanced(testPads) {
        const count = testPads.length;

        const geom = this._sharedGeometries.testPad;
        const mat = this._sharedMaterials.testPad.clone();
        const instancedMesh = new THREE.InstancedMesh(geom, mat, count);
        instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

        // Enable per-instance colors for highlight support
        instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(
            new Float32Array(count * 3), 3
        );
        instancedMesh.userData._matrices = new Array(count);
        instancedMesh.userData._sides = new Array(count);
        instancedMesh.userData._components = new Array(count);

        const matrix = new THREE.Matrix4();
        const color = new THREE.Color(this.colors.testPad);

        testPads.forEach((tp, i) => {
            const radius = tp.radius || 0.5;
            const zPos = tp.layer === 'top' ? 2.5 : (tp.layer === 'bottom' ? 2 : 2.25);

            matrix.makeScale(radius, radius, 1);
            matrix.setPosition(tp.x, tp.y, zPos);
            instancedMesh.setMatrixAt(i, matrix);
            instancedMesh.userData._matrices[i] = matrix.clone();
            instancedMesh.userData._sides[i] = tp._side || null;
            instancedMesh.userData._components[i] = tp.component || tp.id || null;
            instancedMesh.setColorAt(i, color);

            const itemData = {
                ...tp,
                _instanceType: 'testPad',
                _instanceId: i,
                _side: tp._side || null,
                originalColor: this.colors.testPad,
                type: 'TEST_PAD'
            };
            this._testPadInstanceData.push(itemData);
            this._hoverableItems.push(itemData);
        });

        instancedMesh.instanceMatrix.needsUpdate = true;
        instancedMesh.instanceColor.needsUpdate = true;

        this._testPadsInstance = instancedMesh;
        this.scene.add(instancedMesh);

        console.log(`[PERF] Created ${count} test pads with 1 draw call`);
    },


    /**
     * Render XZZ type_03 blocks as undocumented-component overlays.
     * Each one is a real part on the physical board (verified by the
     * user against a board they own) — but the file
     * ships only its bounding box, not its pins or net assignments.
     * Some vendors strip the pin layout the same way they strip
     * the real refdes (U1 placeholder seen on every component name).
     *
     * Render style mirrors a regular "headless" component (no
     * silkscreen body_lines) — soft grey-blue fill + cyan outline —
     * so the tech reads it as a component, not as a probe-pad
     * highlight. We keep the orange `testPad` accent off these to
     * avoid the misleading "diagnostic zone" cue we used initially.
     */
    _createInspectionMarkers(markers) {
        // Per-marker fill material so the highlight branch in
        // `_setItemHighlight` (which patches `material.color` on the
        // mesh) doesn't bleed into every other marker via a shared
        // material.
        const outlineMat = new THREE.LineBasicMaterial({
            color: this.colors.componentOutline,
            transparent: true,
            opacity: 0.7,
        });
        const baseFillHex = 0x2a3140;
        const z = 0.7;
        const zOutline = 0.72;
        markers.forEach((m, i) => {
            const xMin = m.x_min, yMin = m.y_min;
            const xMax = m.x_max, yMax = m.y_max;
            const w = xMax - xMin, h = yMax - yMin;
            if (w <= 0 || h <= 0) return;

            const cx = (xMin + xMax) / 2;
            const cy = (yMin + yMax) / 2;

            // Per-mesh material so per-instance hover highlight is
            // isolated.
            const fillMat = new THREE.MeshBasicMaterial({
                color: baseFillHex,
                transparent: true,
                opacity: 0.45,
                depthWrite: false,
            });
            const fillGeom = new THREE.PlaneGeometry(w, h);
            const fillMesh = new THREE.Mesh(fillGeom, fillMat);
            fillMesh.position.set(cx, cy, z);
            fillMesh.userData._side = m._side || null;
            fillMesh.userData.origColor = baseFillHex;
            this.scene.add(fillMesh);
            this._markerMeshes.push(fillMesh);

            const pts = [
                new THREE.Vector3(xMin, yMin, zOutline),
                new THREE.Vector3(xMax, yMin, zOutline),
                new THREE.Vector3(xMax, yMax, zOutline),
                new THREE.Vector3(xMin, yMax, zOutline),
                new THREE.Vector3(xMin, yMin, zOutline),
            ];
            const lineGeom = new THREE.BufferGeometry().setFromPoints(pts);
            const lineMesh = new THREE.Line(lineGeom, outlineMat);
            lineMesh.userData._side = m._side || null;
            this.scene.add(lineMesh);
            this._markerMeshes.push(lineMesh);

            // Wire into the existing hover/select machinery: spatial
            // grid lookup uses `x, y` (centre), `_setItemHighlight`
            // patches `_mesh.material.color`, `selectItem` reads id /
            // value / type / layer / width / height / net to populate
            // the inspector. Marker is anonymous (the file ships the
            // bbox without pinout), so id is synthesized "IC_N" and
            // value tells the tech the data is stripped.
            const itemData = {
                id: `IC_${i + 1}`,
                x: cx,
                y: cy,
                width: w,
                height: h,
                layer: "top",
                type: "IC (pinout stripped)",
                value: "Pinout indisponible (stripé par le constructeur)",
                net: "",
                _instanceType: "marker",
                _mesh: fillMesh,
                _side: m._side || null,
                originalColor: baseFillHex,
                marker_id: m.marker_id,
            };
            this._hoverableItems.push(itemData);
        });
        console.log(`[PERF] Rendered ${markers.length} stripped-pin parts`);
    }
};
