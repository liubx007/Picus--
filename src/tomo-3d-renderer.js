/**
 * 3D Tomography Renderer
 * Stacks multiple cross-sections with interpolation, clipping plane (pie slice),
 * and transparency controls.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Tomo3DRenderer {
    constructor(container) {
        this.container = container;
        this.layers = [];
        this._materials = []; // track all materials for clipping updates

        let w = container.clientWidth || container.parentElement?.clientWidth || 800;
        let h = container.clientHeight || container.parentElement?.clientHeight || 600;

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xf0f2f5);

        // Camera
        this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 2000);
        this.camera.position.set(60, 80, 60);

        // Renderer with clipping enabled
        this.webglRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.webglRenderer.setSize(w, h);
        this.webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.webglRenderer.localClippingEnabled = true;
        container.appendChild(this.webglRenderer.domElement);

        // Clipping planes for pie slice
        this._clipEnabled = false;
        this._clipAngle = 0;         // start angle in radians
        this._clipSize = Math.PI / 2; // wedge size in radians (default 90°)
        this._clipPlane1 = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
        this._clipPlane2 = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);

        // Controls
        this.controls = new OrbitControls(this.camera, this.webglRenderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.minDistance = 10;
        this.controls.maxDistance = 500;

        this._setupLights();

        // Animation
        this._animating = true;
        this._animate();

        this._resizeObserver = new ResizeObserver(() => this._onResize());
        this._resizeObserver.observe(container);
    }

    _setupLights() {
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const dir = new THREE.DirectionalLight(0xffffff, 0.8);
        dir.position.set(40, 60, 30);
        this.scene.add(dir);
        const dir2 = new THREE.DirectionalLight(0x8ecae6, 0.3);
        dir2.position.set(-30, 40, -20);
        this.scene.add(dir2);
    }

    _animate() {
        if (!this._animating) return;
        requestAnimationFrame(() => this._animate());
        this.controls.update();
        this.webglRenderer.render(this.scene, this.camera);
    }

    _onResize() {
        const w = this.container.clientWidth || 800;
        const h = this.container.clientHeight || 600;
        if (w === 0 || h === 0) return;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.webglRenderer.setSize(w, h);
    }

    dispose() {
        this._animating = false;
        this._resizeObserver?.disconnect();
        this.controls?.dispose();
        this.webglRenderer?.dispose();
        this.webglRenderer?.domElement?.remove();
    }

    // ── Public API ──

    /** Set pie-slice clip angle (degrees, 0-360) */
    setClipAngle(deg) {
        this._clipAngle = (deg * Math.PI) / 180;
        this._updateClipPlanes();
    }

    /** Set pie-slice opening size (degrees, 0-180) */
    setClipSize(deg) {
        this._clipSize = (deg * Math.PI) / 180;
        this._updateClipPlanes();
    }

    /** Enable/disable clipping */
    setClipEnabled(enabled) {
        this._clipEnabled = enabled;
        this._updateClipPlanes();
    }

    /** Set spacing multiplier between layers */
    setHeightScale(scale) {
        // Rebuild geometry at new scale
        if (this._lastDocs) {
            this._heightScale = scale;
            this.render(this._lastDocs);
        }
    }

    _updateClipPlanes() {
        const a1 = this._clipAngle;
        const a2 = this._clipAngle + this._clipSize;

        // Two planes forming a wedge to cut away
        this._clipPlane1.normal.set(-Math.sin(a1), 0, Math.cos(a1));
        this._clipPlane1.constant = 0;
        this._clipPlane2.normal.set(Math.sin(a2), 0, -Math.cos(a2));
        this._clipPlane2.constant = 0;

        for (const mat of this._materials) {
            if (this._clipEnabled) {
                mat.clippingPlanes = [this._clipPlane1, this._clipPlane2];
                mat.clipIntersection = true; // clip only where BOTH planes agree
            } else {
                mat.clippingPlanes = [];
            }
            mat.needsUpdate = true;
        }
    }

    // ── Render ──

    render(documents) {
        this._clearScene();
        this._materials = [];
        this._lastDocs = documents;
        this._heightScale = this._heightScale || 1;

        if (!documents || documents.length === 0) return;

        this.layers = documents
            .map(doc => ({
                points: doc.classifiedPoints || doc.pitData.tomoGrid,
                sensors: doc.pitData.sensors,
                height: doc.height,
                gridBounds: doc.pitData.gridBounds,
            }))
            .sort((a, b) => a.height - b.height);

        const firstBounds = this.layers[0].gridBounds;
        this.centerX = (firstBounds.minX + firstBounds.maxX) / 2;
        this.centerY = (firstBounds.minY + firstBounds.maxY) / 2;
        this.baseHeight = this.layers[0].height;

        const scale = this._heightScale;

        // Build spatial index for each layer (for fast nearest-neighbor lookup)
        const layerGrids = this.layers.map(layer => {
            const cellSize = 2;
            const grid = new Map();
            for (const pt of layer.points) {
                const key = `${Math.round(pt.x / cellSize)},${Math.round(pt.y / cellSize)}`;
                if (!grid.has(key)) grid.set(key, []);
                grid.get(key).push(pt);
            }
            return { grid, cellSize, points: layer.points };
        });

        // Create continuous fill between all layers
        if (this.layers.length === 1) {
            // Single layer — just one disc
            const y = 0;
            this._createSolidLayer(this.layers[0].points, y, 1.0, 1.0);
        } else {
            // Multiple layers — fill continuously from bottom to top
            for (let i = 0; i < this.layers.length - 1; i++) {
                const la = this.layers[i];
                const lb = this.layers[i + 1];
                const yA = (la.height - this.baseHeight) * scale;
                const yB = (lb.height - this.baseHeight) * scale;
                const dist = yB - yA;

                // Step size ~0.8 units for smooth continuous fill
                const stepSize = Math.min(0.8, dist / 3);
                const steps = Math.max(3, Math.ceil(dist / stepSize));
                const cubeH = dist / steps; // exact height per cube — no gaps

                for (let s = 0; s < steps; s++) {
                    const t = s / (steps - 1 || 1);
                    const y = yA + s * cubeH;
                    const colors = this._interpolateColors(
                        la.points, layerGrids[i + 1], t
                    );
                    this._createSolidLayer(colors, y, 1.0, cubeH);
                }
            }

            // Cap the top layer
            const topLayer = this.layers[this.layers.length - 1];
            const yTop = (topLayer.height - this.baseHeight) * scale;
            this._createSolidLayer(topLayer.points, yTop, 1.0, 0.8);
        }

        // Trunk shell
        this._createTrunkShell(scale);

        // Ground grid
        this._addGroundGrid();

        // Height labels
        this._addHeightLabels(scale);

        // Apply current clipping state
        this._updateClipPlanes();

        this._fitCamera();
    }

    _clearScene() {
        const toRemove = [];
        this.scene.traverse(obj => {
            if (obj !== this.scene && !obj.isLight) toRemove.push(obj);
        });
        for (const obj of toRemove) {
            obj.geometry?.dispose();
            if (obj.material) {
                (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(m => m.dispose());
            }
            obj.parent?.remove(obj);
        }
    }

    /**
     * Create a solid layer of voxels. cubeH = vertical height of each cube.
     */
    _createSolidLayer(points, yPos, opacity, cubeH) {
        if (!points || points.length === 0) return;

        const cubeW = 0.9;
        const geom = new THREE.BoxGeometry(cubeW, Math.max(cubeH, 0.1), cubeW);
        const mat = new THREE.MeshLambertMaterial({
            transparent: opacity < 1,
            opacity,
        });
        this._materials.push(mat);

        const mesh = new THREE.InstancedMesh(geom, mat, points.length);
        const dummy = new THREE.Object3D();
        const color = new THREE.Color();

        for (let i = 0; i < points.length; i++) {
            const pt = points[i];
            dummy.position.set(
                pt.x - this.centerX,
                yPos + cubeH / 2,  // center vertically
                -(pt.y - this.centerY)
            );
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
            color.setRGB(pt.r / 255, pt.g / 255, pt.b / 255);
            mesh.setColorAt(i, color);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
        this.scene.add(mesh);
    }

    /**
     * Interpolate colors between pointsA and layerGridB at factor t.
     * Returns an array of {x, y, r, g, b} with blended colors.
     */
    _interpolateColors(pointsA, layerGridB, t) {
        const result = [];
        const { grid, cellSize } = layerGridB;

        for (const ptA of pointsA) {
            const key = `${Math.round(ptA.x / cellSize)},${Math.round(ptA.y / cellSize)}`;
            const candidates = grid.get(key) || [];
            let nearest = null, bestDist = Infinity;
            for (const c of candidates) {
                const d = (c.x - ptA.x) ** 2 + (c.y - ptA.y) ** 2;
                if (d < bestDist) { bestDist = d; nearest = c; }
            }

            let r, g, b;
            if (nearest) {
                r = ptA.r + (nearest.r - ptA.r) * t;
                g = ptA.g + (nearest.g - ptA.g) * t;
                b = ptA.b + (nearest.b - ptA.b) * t;
            } else {
                r = ptA.r; g = ptA.g; b = ptA.b;
            }

            result.push({ x: ptA.x, y: ptA.y, r, g, b });
        }
        return result;
    }

    _createTrunkShell(scale) {
        if (this.layers.length < 1) return;

        const rings = this.layers.map(layer => {
            if (!layer.sensors || layer.sensors.length < 3) return null;
            return layer.sensors.map(s => new THREE.Vector3(
                s.x - this.centerX,
                (layer.height - this.baseHeight) * scale,
                -(s.y - this.centerY)
            ));
        }).filter(Boolean);

        if (rings.length === 0) return;

        if (rings.length === 1) {
            const r = rings[0];
            rings.unshift(r.map(v => new THREE.Vector3(v.x, v.y - 1, v.z)));
            rings.push(r.map(v => new THREE.Vector3(v.x, v.y + 1, v.z)));
        }

        const n = rings[0].length;
        const verts = [];
        const idx = [];

        for (const ring of rings) {
            for (let i = 0; i < n; i++) {
                const p = ring[i % ring.length];
                verts.push(p.x, p.y, p.z);
            }
        }

        for (let r = 0; r < rings.length - 1; r++) {
            for (let i = 0; i < n; i++) {
                const a = r * n + i, b = r * n + (i + 1) % n;
                const c = (r + 1) * n + i, d = (r + 1) * n + (i + 1) % n;
                idx.push(a, c, b, b, c, d);
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();

        const mat = new THREE.MeshPhysicalMaterial({
            color: 0x90caf9,
            transparent: true,
            opacity: 0.08,
            side: THREE.DoubleSide,
            roughness: 0.5,
            depthWrite: false,
        });
        this._materials.push(mat);
        this.scene.add(new THREE.Mesh(geo, mat));

        // Wireframe rings
        const wireMat = new THREE.LineBasicMaterial({ color: 0x42a5f5, opacity: 0.25, transparent: true });
        this._materials.push(wireMat);
        for (let r = 0; r < rings.length; r++) {
            const rv = [];
            for (let i = 0; i <= n; i++) {
                const vi = r * n + (i % n);
                rv.push(verts[vi * 3], verts[vi * 3 + 1], verts[vi * 3 + 2]);
            }
            const line = new THREE.Line(
                new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(rv, 3)),
                wireMat
            );
            this.scene.add(line);
        }
    }

    _addGroundGrid() {
        const grid = new THREE.GridHelper(120, 24, 0xd0d0d0, 0xe8e8e8);
        grid.position.y = -2;
        grid.material.opacity = 0.3;
        grid.material.transparent = true;
        this.scene.add(grid);
    }

    _addHeightLabels(scale) {
        // Use sprite labels for each measurement height
        for (const layer of this.layers) {
            const y = (layer.height - this.baseHeight) * scale;
            const canvas = document.createElement('canvas');
            canvas.width = 128;
            canvas.height = 32;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.font = 'bold 18px Inter, sans-serif';
            ctx.fillText(`${layer.height} cm`, 4, 22);

            const tex = new THREE.CanvasTexture(canvas);
            const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true });
            const sprite = new THREE.Sprite(spriteMat);

            // Position at the edge of the model
            const bounds = layer.gridBounds;
            const edgeX = bounds.maxX - this.centerX + 3;
            sprite.position.set(edgeX, y, 0);
            sprite.scale.set(8, 2, 1);
            this.scene.add(sprite);
        }
    }

    _fitCamera() {
        const box = new THREE.Box3();
        this.scene.traverse(obj => {
            if (obj.isMesh && !obj.isSprite) {
                try {
                    const b = new THREE.Box3().setFromObject(obj);
                    if (!b.isEmpty()) box.union(b);
                } catch (e) { /* skip */ }
            }
        });
        if (box.isEmpty()) return;

        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);

        this.controls.target.copy(center);
        this.camera.position.set(
            center.x + maxDim * 0.9,
            center.y + maxDim * 0.7,
            center.z + maxDim * 0.9
        );
        this.controls.update();
    }
}
