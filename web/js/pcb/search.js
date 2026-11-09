/** Search operations on the shared PCB viewer state. */

export const searchMethods = {

    focusComponent(id) {
        const comp = this.meshGroups.components.find(m => m.userData.id === id);
        if (comp) {
            this.camera.position.x = comp.position.x;
            this.camera.position.y = comp.position.y;
            this.frustumSize = 25;
            this.zoom = 100 / this.frustumSize;
            this.onResize();
            this.selectItem(comp.userData);
            document.getElementById('zoom-level').textContent = Math.round(this.zoom * 100);
        }
    },


    // ========================
    // DIAGNOSTIC HIGHLIGHT API
    // ========================

    highlightComponents(componentIds) {
        if (!componentIds || componentIds.length === 0) return;

        this.clearDiagnosticHighlights();
        this.diagnosticHighlightedItems = [];

        let foundCount = 0;
        let firstFound = null;

        componentIds.forEach(compId => {
            const compIdUpper = compId.toUpperCase();

            // Check components (regular meshes)
            this.meshGroups.components.forEach(mesh => {
                const meshId = (mesh.userData.id || '').toUpperCase();
                if (meshId === compIdUpper || meshId.startsWith(compIdUpper + '.')) {
                    mesh.userData.diagnosticHighlighted = true;
                    this._setItemHighlight(mesh.userData, true, this.colors.highlight);
                    this.diagnosticHighlightedItems.push(mesh.userData);
                    foundCount++;
                    if (!firstFound) firstFound = mesh.userData;
                }
            });

            // Check hoverable items (pins, test pads) - supports all instance types
            this._hoverableItems.forEach(item => {
                const itemId = (item.id || '').toUpperCase();
                if (itemId === compIdUpper || itemId.startsWith(compIdUpper + '.')) {
                    item.diagnosticHighlighted = true;
                    this._setItemHighlight(item, true, this.colors.highlight);
                    this.diagnosticHighlightedItems.push(item);
                    foundCount++;
                    if (!firstFound) firstFound = item;
                }
            });
        });

        // Center on found items
        if (firstFound && foundCount > 0) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

            this.diagnosticHighlightedItems.forEach(item => {
                const x = item.x || (item._mesh ? item._mesh.position.x : 0);
                const y = item.y || (item._mesh ? item._mesh.position.y : 0);
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            });

            const centerX = (minX + maxX) / 2;
            const centerY = (minY + maxY) / 2;
            const viewSize = Math.max(maxX - minX, maxY - minY) + 10;

            this.camera.position.x = centerX;
            this.camera.position.y = centerY;
            this.frustumSize = Math.max(viewSize * 1.5, 30);
            this.zoom = 100 / this.frustumSize;
            this.onResize();
            document.getElementById('zoom-level').textContent = Math.round(this.zoom * 100);
        }

        this.requestRender();
        console.log(`Highlighted ${foundCount} items for: ${componentIds.join(', ')}`);
    },


    highlightComponent(componentId) {
        if (componentId) {
            this.highlightComponents([componentId]);
        }
    },


    clearDiagnosticHighlights() {
        if (this.diagnosticHighlightedItems && this.diagnosticHighlightedItems.length > 0) {
            // Restore original colors using unified highlight method
            this.diagnosticHighlightedItems.forEach(item => {
                item.diagnosticHighlighted = false;
                this._setItemHighlight(item, false);
            });

            this.diagnosticHighlightedItems = [];
            this.requestRender();
        }
    },


    searchAndFocus(query) {
        if (!query) return false;

        const queryUpper = query.toUpperCase();

        // Search components
        for (const mesh of this.meshGroups.components) {
            const id = (mesh.userData.id || '').toUpperCase();
            const net = (mesh.userData.net || '').toUpperCase();
            const value = (mesh.userData.value || '').toUpperCase();

            if (id.includes(queryUpper) || net.includes(queryUpper) || value.includes(queryUpper)) {
                this.highlightComponent(mesh.userData.id);
                return true;
            }
        }

        // Search hoverable items
        for (const item of this._hoverableItems) {
            const id = (item.id || '').toUpperCase();
            const net = (item.net || '').toUpperCase();

            if (id.includes(queryUpper) || net.includes(queryUpper)) {
                this.focusOnItem(item);
                return true;
            }
        }

        return false;
    }
};
