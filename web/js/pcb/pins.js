/** Pins operations on the shared PCB viewer state. */

export const pinsMethods = {

    /**
     * Create all pins using InstancedMesh - single draw call for all circular pins
     */
    _createPinsInstanced(pins) {
        // Single pipeline for placed AND DFM-alternate (DNP) pins.
        // Each pin carries an `is_dnp` flag in the payload; the
        // builders below stash it per-instance in `_dnpFlags` so
        // `setShowDnp` flips the matrices via `_applySideToInstanced`
        // (same zero-scale mechanism as the side filter), and every
        // standard pipeline (hover, colour by net, info panel, net
        // highlight) handles DNP pins as ordinary pins automatically.
        const circularPins = [];
        const rectPinsBySize = new Map();
        const kindMap = { square: 's', oval: 'o', rect: 'r' };

        pins.forEach((pin, index) => {
            if (pin.shape === 'circle') {
                circularPins.push({ ...pin, _originalIndex: index });
            } else {
                const kind = kindMap[pin.shape] || 'r';
                const sizeKey = `${kind}_${Math.round(pin.width * 1000)}_${Math.round(pin.height * 1000)}`;
                if (!rectPinsBySize.has(sizeKey)) rectPinsBySize.set(sizeKey, []);
                rectPinsBySize.get(sizeKey).push({ ...pin, _originalIndex: index });
            }
        });

        if (circularPins.length > 0) this._createCircularPinsInstanced(circularPins);
        rectPinsBySize.forEach((rectPins, sizeKey) => {
            this._createRectPinsInstanced(rectPins, sizeKey);
        });
    },


    // _createDnpCircularPinsMesh / _createDnpRectPinsMesh are kept for
    // back-compat against any external caller, but the main pipeline
    // now bakes DNP pins straight into `_circularPinInstance` /
    // `_rectPinInstances` with a `_dnpFlags` mask, so these helpers
    // are no-ops in the standard load path.
    _createDnpCircularPinsMesh(pins) {
        const count = pins.length;
        const geometry = this._sharedGeometries.circlePin;
        const material = new THREE.MeshBasicMaterial({
            color: 0x6b7280,
            transparent: true,
            opacity: 0.4,
            depthWrite: false,
        });
        const mesh = new THREE.InstancedMesh(geometry, material, count);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const matrix = new THREE.Matrix4();
        pins.forEach((pin, i) => {
            const r = pin.width / 2;
            matrix.makeScale(r, r, 1);
            const z = pin.layer === 'top' ? 2 : (pin.layer === 'bottom' ? 1 : 1.5);
            matrix.setPosition(pin.x, pin.y, z);
            if (pin.rotation) {
                const rot = new THREE.Matrix4().makeRotationZ(pin.rotation * Math.PI / 180);
                matrix.multiply(rot);
            }
            mesh.setMatrixAt(i, matrix);
            // Register hoverable so click on a DNP pin opens the info
            // panel just like a placed pin would. The hover code reads
            // `_instanceType` to dispatch to the right mesh; we use a
            // dedicated 'dnpPin' kind so hover-colour ops don't try to
            // recolour the DNP mesh's instances (we want them to stay
            // uniform grey).
            this._hoverableItems.push({
                ...pin,
                _instanceType: 'dnpPin',
                _instanceId: i,
                _side: pin._edgeFinger ? null : (pin._side || pin.layer || null),
                originalColor: 0x6b7280,
                type: 'Pin',
            });
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.visible = !!this._showDnp;
        mesh.userData._dnpLayer = true;
        this.scene.add(mesh);
        this._dnpMeshes.push(mesh);
    },


    /**
     * Standalone InstancedMesh for DFM-alternate rectangular pads.
     * Same shape geometry as the placed rect-pin builder (rounded
     * corners with the absolute-cap to keep big pads visibly square),
     * but uniform muted grey + low opacity + no per-pin border line.
     */
    _createDnpRectPinsMesh(pins, sizeKey) {
        const count = pins.length;
        const w = pins[0].width;
        const h = pins[0].height;
        const kind = sizeKey ? sizeKey.charAt(0) : 'r';
        let radiusFactor = 0.15;
        let radiusCapMm = 0.12;
        if (kind === 's') { radiusFactor = 0; radiusCapMm = 0; }
        else if (kind === 'o') { radiusFactor = 0.5; radiusCapMm = Infinity; }
        const shape = new THREE.Shape();
        const r = Math.min(Math.min(w, h) * radiusFactor, radiusCapMm);
        this._createRoundedRectShape(shape, w, h, r);
        const geometry = new THREE.ShapeGeometry(shape);

        const material = new THREE.MeshBasicMaterial({
            color: 0x6b7280,
            transparent: true,
            opacity: 0.4,
            depthWrite: false,
        });
        const mesh = new THREE.InstancedMesh(geometry, material, count);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const matrix = new THREE.Matrix4();
        pins.forEach((pin, i) => {
            matrix.identity();
            const z = pin.layer === 'top' ? 2 : (pin.layer === 'bottom' ? 1 : 1.5);
            matrix.setPosition(pin.x, pin.y, z);
            if (pin.rotation) {
                const rot = new THREE.Matrix4().makeRotationZ(pin.rotation * Math.PI / 180);
                matrix.multiply(rot);
            }
            mesh.setMatrixAt(i, matrix);
            this._hoverableItems.push({
                ...pin,
                _instanceType: 'dnpPin',
                _instanceId: i,
                _side: pin._edgeFinger ? null : (pin._side || pin.layer || null),
                originalColor: 0x6b7280,
                type: 'Pin',
            });
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.visible = !!this._showDnp;
        mesh.userData._dnpLayer = true;
        this.scene.add(mesh);
        this._dnpMeshes.push(mesh);
    },


    _createCircularPinsInstanced(pins) {
        const count = pins.length;
        const geometry = this._sharedGeometries.circlePin;
        const material = this._sharedMaterials.pinFill.clone();

        // Create instanced mesh
        const instancedMesh = new THREE.InstancedMesh(geometry, material, count);
        instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

        // Enable per-instance colors
        instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(
            new Float32Array(count * 3), 3
        );

        // Per-instance state for the side filter: keep the matrix that
        // was set at build time so we can swap between it and a zero
        // matrix when the user toggles top/bottom/both. `_dnpFlags`
        // tracks DFM-alternate (DNP) instances so the same zero-scale
        // mechanism gates them when the DNP toggle is off.
        instancedMesh.userData._matrices = new Array(count);
        instancedMesh.userData._sides = new Array(count);
        instancedMesh.userData._dnpFlags = new Array(count);
        // Parent-component refdes per slot — drives the bv_filter_by_type
        // refdes-prefix filter. `_applySideToInstanced` ANDs this in
        // alongside the side + DNP gates.
        instancedMesh.userData._components = new Array(count);

        const matrix = new THREE.Matrix4();
        const color = new THREE.Color();

        pins.forEach((pin, i) => {
            const radius = pin.width / 2;
            const cat = (pin.is_gnd || pin.net === 'GND') ? 'ground' : this._netCategory(pin.net);
            const pinColor = this._resolvePinColor(pin, cat);

            // Set position and scale. DNP instances start zero-scaled
            // until the DNP toggle is enabled.
            const isDnp = !!pin.is_dnp;
            if (isDnp && !this._showDnp) {
                matrix.identity();
                matrix.makeScale(0, 0, 0);
            } else {
                matrix.makeScale(radius, radius, 1);
                const zPos = pin.layer === 'top' ? 2 : (pin.layer === 'bottom' ? 1 : 1.5);
                matrix.setPosition(pin.x, pin.y, zPos);
                if (pin.rotation) {
                    const rotMatrix = new THREE.Matrix4().makeRotationZ(pin.rotation * Math.PI / 180);
                    matrix.multiply(rotMatrix);
                }
            }

            instancedMesh.setMatrixAt(i, matrix);

            // Store the *full-scale* matrix in `_matrices` regardless
            // so the side+DNP refresh routine restores the pin to its
            // real position when both filters allow it.
            const fullMatrix = new THREE.Matrix4().makeScale(radius, radius, 1);
            const zPos = pin.layer === 'top' ? 2 : (pin.layer === 'bottom' ? 1 : 1.5);
            fullMatrix.setPosition(pin.x, pin.y, zPos);
            if (pin.rotation) {
                fullMatrix.multiply(new THREE.Matrix4().makeRotationZ(pin.rotation * Math.PI / 180));
            }
            instancedMesh.userData._matrices[i] = fullMatrix;
            instancedMesh.userData._sides[i] = pin._side || null;
            instancedMesh.userData._dnpFlags[i] = isDnp;
            instancedMesh.userData._components[i] = pin.component || null;

            // Set color
            color.setHex(pinColor);
            instancedMesh.setColorAt(i, color);

            // Store data for hover/selection
            const itemData = {
                ...pin,
                _instanceType: 'pin',
                _instanceId: i,
                _side: pin._edgeFinger ? null : (pin._side || null),
                originalColor: pinColor,
                type: 'Pin'
            };
            this._pinInstanceData.push(itemData);
            this._hoverableItems.push(itemData);
        });

        instancedMesh.instanceMatrix.needsUpdate = true;
        instancedMesh.instanceColor.needsUpdate = true;

        this._circularPinInstance = instancedMesh;
        this.scene.add(instancedMesh);

        // Per-pin thin border ring drawn just above the fill in a
        // mid-grey that contrasts both the navy background and most
        // pad colours — so each pad reads as a defined object even on
        // densely-packed connectors / ICs.
        const ringGeom = this._sharedGeometries.circlePinRing;
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0x4b5563,  // tailwind gray-600 — readable on both pad fill and bg-deep
            transparent: true,
            opacity: 0.95,
            side: THREE.DoubleSide,
            depthTest: false,
        });
        const ringMesh = new THREE.InstancedMesh(ringGeom, ringMat, count);
        ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        ringMesh.userData._matrices = new Array(count);
        ringMesh.userData._sides = new Array(count);
        ringMesh.userData._dnpFlags = new Array(count);
        ringMesh.userData._components = new Array(count);
        pins.forEach((pin, i) => {
            const radius = pin.width / 2;
            const isDnp = !!pin.is_dnp;
            const fullMatrix = new THREE.Matrix4().makeScale(radius, radius, 1);
            const zPos = pin.layer === 'top' ? 2.05 : (pin.layer === 'bottom' ? 1.05 : 1.55);
            fullMatrix.setPosition(pin.x, pin.y, zPos);
            if (pin.rotation) {
                fullMatrix.multiply(new THREE.Matrix4().makeRotationZ(pin.rotation * Math.PI / 180));
            }
            // Initial render-time matrix: zero-scale DNP rings until
            // the toggle is on, full-scale otherwise.
            const visible = !isDnp || this._showDnp;
            ringMesh.setMatrixAt(i, visible
                ? fullMatrix
                : new THREE.Matrix4().makeScale(0, 0, 0));
            ringMesh.userData._matrices[i] = fullMatrix;
            ringMesh.userData._sides[i] = pin._side || null;
            ringMesh.userData._dnpFlags[i] = isDnp;
            ringMesh.userData._components[i] = pin.component || null;
        });
        ringMesh.instanceMatrix.needsUpdate = true;
        this._circularPinBorderInstance = ringMesh;
        this.scene.add(ringMesh);

        console.log(`[PERF] Created ${count} circular pins + borders with 2 draw calls`);
    },


    _createRectPinsInstanced(pins, sizeKey) {
        const count = pins.length;
        const [kind, widthStr, heightStr] = sizeKey.split('_');
        // sizeKey buckets in micrometres (see _createPinsInstanced).
        const w = parseFloat(widthStr) / 1000;
        const h = parseFloat(heightStr) / 1000;

        // Square = sharp corners (board-to-board connector lands).
        // Rect   = soft 15% rounded corners (standard SMD pads), but
        //          capped to a small absolute value so large pads
        //          (MOSFET DRAIN, electrolytic SMD lands at 4-6 mm)
        //          stay visibly rectangular instead of shading into a
        //          disk. Without the cap, 15% of a 4.5 mm pad gives a
        //          0.7 mm chamfer that reads as a round corner under
        //          antialias.
        // Oval   = full half-axis radius (pill / capsule for oblong
        //          test pad landings).
        let radiusFactor = 0.15;
        let radiusCapMm = 0.12;     // ~5 mil — chamfer barely visible on big pads
        if (kind === 's') {
            radiusFactor = 0;
            radiusCapMm = 0;
        } else if (kind === 'o') {
            radiusFactor = 0.5;
            radiusCapMm = Infinity; // pill caps want full half-axis
        }
        const shape = new THREE.Shape();
        const r = Math.min(Math.min(w, h) * radiusFactor, radiusCapMm);
        this._createRoundedRectShape(shape, w, h, r);
        const geometry = new THREE.ShapeGeometry(shape);

        const material = this._sharedMaterials.pinFill.clone();
        const instancedMesh = new THREE.InstancedMesh(geometry, material, count);
        instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

        instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(
            new Float32Array(count * 3), 3
        );
        instancedMesh.userData._matrices = new Array(count);
        instancedMesh.userData._sides = new Array(count);
        instancedMesh.userData._dnpFlags = new Array(count);
        instancedMesh.userData._components = new Array(count);

        const matrix = new THREE.Matrix4();
        const color = new THREE.Color();

        pins.forEach((pin, i) => {
            const cat = (pin.is_gnd || pin.net === 'GND') ? 'ground' : this._netCategory(pin.net);
            const pinColor = this._resolvePinColor(pin, cat);
            const isDnp = !!pin.is_dnp;

            const fullMatrix = new THREE.Matrix4();
            fullMatrix.identity();
            // Edge fingers: lift to z=2.3 so they sit above both faces'
            // ordinary pads / probes. The edge connector physically
            // exists on both sides of the PCB, and its fingers are the
            // canonical visual cue for the slot — keep them on top.
            const zPos = pin._edgeFinger
                ? 2.3
                : (pin.layer === 'top' ? 2 : (pin.layer === 'bottom' ? 1 : 1.5));
            fullMatrix.setPosition(pin.x, pin.y, zPos);
            if (pin.rotation) {
                fullMatrix.multiply(new THREE.Matrix4().makeRotationZ(pin.rotation * Math.PI / 180));
            }

            const visible = !isDnp || this._showDnp;
            instancedMesh.setMatrixAt(i, visible
                ? fullMatrix
                : new THREE.Matrix4().makeScale(0, 0, 0));
            instancedMesh.userData._matrices[i] = fullMatrix;
            instancedMesh.userData._sides[i] = pin._edgeFinger ? null : (pin._side || null);
            instancedMesh.userData._dnpFlags[i] = isDnp;
            instancedMesh.userData._components[i] = pin.component || null;
            color.setHex(pinColor);
            instancedMesh.setColorAt(i, color);

            const itemData = {
                ...pin,
                _instanceType: 'rectPin',
                _instanceId: i,
                _sizeKey: sizeKey,
                _side: pin._edgeFinger ? null : (pin._side || null),
                originalColor: pinColor,
                type: 'Pin'
            };
            this._hoverableItems.push(itemData);
        });

        instancedMesh.instanceMatrix.needsUpdate = true;
        instancedMesh.instanceColor.needsUpdate = true;

        // Per-pin thin border drawn just above the fill in a dark
        // tone, so each rect/square/oval pad reads as a defined object
        // instead of a flat blob. Build a closed Line from the same
        // Shape used for the fill — Three.js sees it as a separate
        // buffer geometry, so we instance it the same way.
        const borderPts = shape.getPoints(48);
        if (borderPts.length) {
            // Close the loop
            borderPts.push(borderPts[0].clone());
            const borderGeom = new THREE.BufferGeometry().setFromPoints(
                borderPts.map(p => new THREE.Vector3(p.x, p.y, 0))
            );
            const borderMat = new THREE.LineBasicMaterial({
                color: 0x4b5563,  // grey contrasting both pad fill and bg-deep
                transparent: true,
                opacity: 0.95,
                depthTest: false,
            });
            // No InstancedMesh equivalent for THREE.Line — clone per pin
            // (count is small enough; rect pins are O(thousands) max).
            pins.forEach((pin) => {
                const line = new THREE.Line(borderGeom, borderMat);
                const zPos = pin._edgeFinger
                    ? 2.35
                    : (pin.layer === 'top' ? 2.05 : (pin.layer === 'bottom' ? 1.05 : 1.55));
                line.position.set(pin.x, pin.y, zPos);
                if (pin.rotation) line.rotation.z = pin.rotation * Math.PI / 180;
                line.userData._side = pin._edgeFinger ? null : (pin._side || null);
                line.userData._isDnp = !!pin.is_dnp;
                line.userData._component = pin.component || null;
                if (pin.is_dnp) line.visible = !!this._showDnp;
                this.scene.add(line);
                this._pinBorderLines.push(line);
            });
        }

        this._rectPinInstances.set(sizeKey, { body: instancedMesh, geometry });
        this.scene.add(instancedMesh);
    },


    _createRoundedRectShape(shape, w, h, r) {
        const hw = w / 2, hh = h / 2;
        r = Math.min(r, hw, hh);
        shape.moveTo(-hw + r, -hh);
        shape.lineTo(hw - r, -hh);
        shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
        shape.lineTo(hw, hh - r);
        shape.quadraticCurveTo(hw, hh, hw - r, hh);
        shape.lineTo(-hw + r, hh);
        shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
        shape.lineTo(-hw, -hh + r);
        shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
    },


    /**
     * Ghost-rendering of a DFM-alternate (DNP) component. Pre-built at
     * load time but `visible=false` until the toolbar toggle flips
     * `_showDnp`. We draw three things so the tech reads it as a real
     * (just-not-stuffed) component:
     *   1. Semi-transparent grey body fill — same shape as the placed
     *      sibling but quarter opacity, so the alternate's footprint
     *      bbox is visually obvious.
     *   2. Dashed cyan outline — convention for "alternate / DNP" in
     *      every PCB CAD tool.
     *   3. Faded refdes label sprite at the centre.
     * No pads — the populated sibling already owns the physical pads
     * at the same physical seat; rendering them again would just
     * stack circles on top of the placed pads.
     */
    _createDnpOutline(comp) {
        if (!this._dnpMeshes) this._dnpMeshes = [];
        const w = comp.width, h = comp.height;
        const hw = w / 2, hh = h / 2;
        const cx = comp.x + hw, cy = comp.y + hh;
        const z = comp.layer === 'top' ? 1.05 : (comp.layer === 'bottom' ? 0.55 : 0.8);

        // Body fill — semi-transparent grey-blue rectangle. Same colour
        // family as the regular component fill (#2a3140) but opacity
        // 0.22 so the placed sibling beneath stays the visually
        // dominant element.
        const fillGeom = new THREE.PlaneGeometry(w, h);
        const fillMat = new THREE.MeshBasicMaterial({
            color: 0x2a3140,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
        });
        const fill = new THREE.Mesh(fillGeom, fillMat);
        fill.position.set(cx, cy, z - 0.02);
        fill.visible = !!this._showDnp;
        this.scene.add(fill);
        this._dnpMeshes.push(fill);

        // Dashed outline — solid LineSegments built from explicit pairs
        // (avoids the per-mesh computeLineDistances() cost; one shared
        // LineDashedMaterial across all DNPs and we still get the
        // dashed look thanks to the manual pair geometry).
        const dashLen = Math.max(0.15, Math.min(w, h) * 0.06);
        const gapLen = dashLen * 0.7;
        const points = [];
        const sides = [
            [-hw, -hh, hw, -hh],   // bottom
            [hw, -hh, hw, hh],     // right
            [hw, hh, -hw, hh],     // top
            [-hw, hh, -hw, -hh],   // left
        ];
        for (const [x1, y1, x2, y2] of sides) {
            const len = Math.hypot(x2 - x1, y2 - y1);
            const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
            let t = 0;
            while (t < len) {
                const a = t;
                const b = Math.min(t + dashLen, len);
                points.push(new THREE.Vector3(x1 + ux * a, y1 + uy * a, 0));
                points.push(new THREE.Vector3(x1 + ux * b, y1 + uy * b, 0));
                t = b + gapLen;
            }
        }
        const dashGeom = new THREE.BufferGeometry().setFromPoints(points);
        const dashMat = new THREE.LineBasicMaterial({
            color: this.colors.componentOutline || 0x80c0d0,
            transparent: true,
            opacity: 0.85,
        });
        const dashed = new THREE.LineSegments(dashGeom, dashMat);
        dashed.position.set(cx, cy, z);
        dashed.visible = !!this._showDnp;
        dashed.userData = {
            _instanceType: 'dnpOutline',
            _refdes: comp.id,
            _comp: comp,
        };
        this.scene.add(dashed);
        this._dnpMeshes.push(dashed);

        // Hover-target — same shape as a placed component's hoverable
        // entry (`type: 'Component'`) so the info panel pipes through
        // unchanged. `x` and `y` here are the BBOX CENTRE (matching
        // the placed-component path on line ~2660), so the cursor-
        // distance check reduces to 0 inside the rectangle.
        this._hoverableItems.push({
            ...comp,
            x: cx,
            y: cy,
            type: 'Component',
            _instanceType: 'dnpComp',
            _side: comp._side || comp.layer || null,
        });

        // Refdes label — reuses the placed-component label path. The
        // sprite is pushed into `_componentLabels` and shows/hides via
        // `_updateComponentLabelVisibility` (zoom + side filter), so
        // we mark it `_dnpLabel` and gate visibility on `_showDnp`
        // alongside the rest of the DNP overlay.
        if (typeof this._addComponentRefdesLabel === 'function') {
            const before = this._componentLabels.length;
            this._addComponentRefdesLabel(comp);
            for (let i = before; i < this._componentLabels.length; i++) {
                const sprite = this._componentLabels[i];
                sprite.userData._dnpLabel = true;
                sprite.visible = !!this._showDnp;
                if (sprite.material) sprite.material.opacity = 0.6;
                this._dnpMeshes.push(sprite);
            }
        }
    }
};
