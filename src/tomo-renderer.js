/**
 * Tomography Renderer - Canvas-based visualization for Picus 3 tomography data.
 * 
 * Renders the pre-computed tomography grid, trunk outline, sensor labels,
 * compass, color legend, and optional overlays (cavity boundaries, principal axis).
 */

export class TomoRenderer {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {Object} options
     */
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.options = {
            dotRadius: 5,
            showSensors: true,
            showOutline: true,
            showCompass: true,
            showGrid: true,
            showLegend: true,
            padding: 50,
            ...options,
        };

        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.pitData = null;
        this.transform = null; // data → canvas transform

        this._setupHiDPI();
        this._setupInteraction();
    }

    /** Setup retina/HiDPI rendering */
    _setupHiDPI() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.ctx.scale(dpr, dpr);
        this.displayWidth = rect.width;
        this.displayHeight = rect.height;
    }

    /** Setup mouse interaction for pan/zoom */
    _setupInteraction() {
        let isDragging = false;
        let lastX, lastY;

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            this.zoom = Math.max(0.3, Math.min(8, this.zoom * delta));
            if (this.pitData) this.render(this.pitData, this._lastOverlays);
        }, { passive: false });

        this.canvas.addEventListener('mousedown', (e) => {
            isDragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            this.canvas.style.cursor = 'grabbing';
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            this.panX += e.clientX - lastX;
            this.panY += e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            if (this.pitData) this.render(this.pitData, this._lastOverlays);
        });

        window.addEventListener('mouseup', () => {
            isDragging = false;
            this.canvas.style.cursor = 'crosshair';
        });

        this.canvas.style.cursor = 'crosshair';

        // Hover tooltip
        this._hoverCallback = null;
        this.canvas.addEventListener('mousemove', (e) => {
            if (isDragging || !this._hoverCallback || !this.pitData) return;
            const rect = this.canvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const pt = this.getPointAt(cx, cy);
            this._hoverCallback(pt, cx, cy);
        });
    }

    /** Register a hover callback: fn(point, canvasX, canvasY) */
    onHover(fn) { this._hoverCallback = fn; }

    /** Resize canvas to container */
    resize() {
        this._setupHiDPI();
        if (this.pitData) this.render(this.pitData, this._lastOverlays);
    }

    /**
     * Main render method.
     * @param {Object} pitData - Parsed PIT data from pit-parser
     * @param {Object} overlays - Optional overlay data
     */
    render(pitData, overlays = {}) {
        this.pitData = pitData;
        this._lastOverlays = overlays;
        const ctx = this.ctx;
        const w = this.displayWidth;
        const h = this.displayHeight;

        // Clear
        ctx.clearRect(0, 0, w, h);

        if (!pitData || !pitData.tomoGrid || pitData.tomoGrid.length === 0) return;

        // Compute transform: data coordinates → canvas coordinates
        this._computeTransform(pitData);

        // 1. Coordinate grid
        if (this.options.showGrid) this._drawGrid(ctx, pitData);

        // 2. Tomography dots
        this._drawTomoGrid(ctx, pitData, overlays);

        // 3. Trunk outline
        if (this.options.showOutline) this._drawOutline(ctx, pitData);

        // 4. Sensor markers
        if (this.options.showSensors) this._drawSensors(ctx, pitData);

        // 5. Compass
        if (this.options.showCompass) this._drawCompass(ctx, pitData);

        // 6. Legend
        if (this.options.showLegend) this._drawLegend(ctx);

        // 7. Overlays
        if (overlays.cavityBoundaries) this._drawCavityBoundaries(ctx, overlays.cavityBoundaries);
        if (overlays.principalAxis) this._drawPrincipalAxis(ctx, overlays.principalAxis);
        if (overlays.wallThickness) this._drawWallThickness(ctx, overlays.wallThickness);
    }

    /** Compute data-to-canvas transform */
    _computeTransform(pitData) {
        const { minX, maxX, minY, maxY } = pitData.gridBounds;
        const pad = this.options.padding;
        const w = this.displayWidth - pad * 2;
        const h = this.displayHeight - pad * 2;

        const dataW = maxX - minX || 1;
        const dataH = maxY - minY || 1;
        const scale = Math.min(w / dataW, h / dataH) * this.zoom;

        const offsetX = pad + (w - dataW * scale) / 2 + this.panX;
        const offsetY = pad + (h - dataH * scale) / 2 + this.panY;

        this.transform = { scale, offsetX, offsetY, minX, minY, maxX, maxY };
    }

    /** Convert data coordinates to canvas coordinates */
    dataToCanvas(x, y) {
        const t = this.transform;
        return {
            cx: t.offsetX + (x - t.minX) * t.scale,
            cy: t.offsetY + (t.maxY - y) * t.scale, // flip Y
        };
    }

    /** Convert canvas coordinates to data coordinates */
    canvasToData(cx, cy) {
        const t = this.transform;
        return {
            x: (cx - t.offsetX) / t.scale + t.minX,
            y: t.maxY - (cy - t.offsetY) / t.scale,
        };
    }

    /** Find nearest tomo grid point to canvas coordinates */
    getPointAt(cx, cy) {
        if (!this.pitData) return null;
        const { x, y } = this.canvasToData(cx, cy);
        let best = null, bestDist = Infinity;
        for (const pt of this.pitData.tomoGrid) {
            const d = (pt.x - x) ** 2 + (pt.y - y) ** 2;
            if (d < bestDist) {
                bestDist = d;
                best = pt;
            }
        }
        return bestDist < 4 ? best : null;
    }

    // ── Drawing Methods ──

    _drawGrid(ctx, pitData) {
        const t = this.transform;
        ctx.save();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)';
        ctx.lineWidth = 0.5;
        ctx.font = '10px Inter, sans-serif';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';

        const step = this._niceStep((t.maxX - t.minX) / 6);
        const startX = Math.ceil(t.minX / step) * step;
        const startY = Math.ceil(t.minY / step) * step;

        for (let x = startX; x <= t.maxX; x += step) {
            const { cx } = this.dataToCanvas(x, 0);
            ctx.beginPath();
            ctx.moveTo(cx, this.options.padding / 2);
            ctx.lineTo(cx, this.displayHeight - this.options.padding / 2);
            ctx.stroke();
            ctx.fillText(Math.round(x * 10) / 10, cx + 2, this.displayHeight - 8);
        }

        for (let y = startY; y <= t.maxY; y += step) {
            const { cy } = this.dataToCanvas(0, y);
            ctx.beginPath();
            ctx.moveTo(this.options.padding / 2, cy);
            ctx.lineTo(this.displayWidth - this.options.padding / 2, cy);
            ctx.stroke();
            ctx.fillText(Math.round(y * 10) / 10, 4, cy - 2);
        }

        ctx.restore();
    }

    _niceStep(rough) {
        const pow = Math.pow(10, Math.floor(Math.log10(rough)));
        const frac = rough / pow;
        if (frac <= 1.5) return pow;
        if (frac <= 3.5) return 2 * pow;
        if (frac <= 7.5) return 5 * pow;
        return 10 * pow;
    }

    _drawTomoGrid(ctx, pitData, overlays) {
        const r = this.options.dotRadius * this.zoom;
        const zoneAlpha = overlays.zoneAlpha; // optional per-zone opacity

        for (const pt of pitData.tomoGrid) {
            const { cx, cy } = this.dataToCanvas(pt.x, pt.y);

            // Skip points outside visible area
            if (cx < -r || cx > this.displayWidth + r || cy < -r || cy > this.displayHeight + r) continue;

            let alpha = 1.0;
            if (zoneAlpha && pt.zone) {
                alpha = zoneAlpha[pt.zone] ?? 1.0;
            }

            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${pt.r},${pt.g},${pt.b},${alpha})`;
            ctx.fill();

            // Subtle dark outline for contrast on light backgrounds
            ctx.strokeStyle = `rgba(0,0,0,0.15)`;
            ctx.lineWidth = 0.4;
            ctx.stroke();
        }
    }

    _drawOutline(ctx, pitData) {
        const sensors = pitData.sensors;
        if (!sensors || sensors.length < 3) return;

        ctx.save();
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);

        // Draw smooth closed curve through sensor points using cardinal spline
        const canvasPoints = sensors.map(s => this.dataToCanvas(s.x, s.y));
        this._drawCardinalSpline(ctx, canvasPoints, 0.5, true);

        ctx.restore();
    }

    /** Draw a closed cardinal spline through points */
    _drawCardinalSpline(ctx, points, tension = 0.5, closed = true) {
        const n = points.length;
        if (n < 2) return;

        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const p0 = points[(i - 1 + n) % n];
            const p1 = points[i];
            const p2 = points[(i + 1) % n];
            const p3 = points[(i + 2) % n];

            if (i === 0) ctx.moveTo(p1.cx, p1.cy);

            const cp1x = p1.cx + (p2.cx - p0.cx) / 6 * tension;
            const cp1y = p1.cy + (p2.cy - p0.cy) / 6 * tension;
            const cp2x = p2.cx - (p3.cx - p1.cx) / 6 * tension;
            const cp2y = p2.cy - (p3.cy - p1.cy) / 6 * tension;

            ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.cx, p2.cy);
        }

        if (closed) ctx.closePath();
        ctx.stroke();
    }

    _drawSensors(ctx, pitData) {
        ctx.save();
        for (const s of pitData.sensors) {
            const { cx, cy } = this.dataToCanvas(s.x, s.y);

            // Sensor dot — blue with white border
            ctx.beginPath();
            ctx.arc(cx, cy, 5, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(59, 130, 246, 0.85)';
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Label
            ctx.font = 'bold 10px Inter, sans-serif';
            ctx.fillStyle = 'rgba(30, 64, 175, 0.85)';
            ctx.textAlign = 'center';

            // Offset label away from center
            const centerX = (pitData.gridBounds.minX + pitData.gridBounds.maxX) / 2;
            const centerY = (pitData.gridBounds.minY + pitData.gridBounds.maxY) / 2;
            const dx = s.x - centerX;
            const dy = s.y - centerY;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const offX = (dx / dist) * 18;
            const offY = -(dy / dist) * 18;

            ctx.fillText(String(s.id), cx + offX, cy + offY + 4);
        }
        ctx.restore();
    }

    _drawCompass(ctx, pitData) {
        const northId = pitData.metadata.northSensor || 1;
        const sensor = pitData.sensors.find(s => s.id === northId);
        if (!sensor) return;

        const { cx, cy } = this.dataToCanvas(sensor.x, sensor.y);
        const centerX = (pitData.gridBounds.minX + pitData.gridBounds.maxX) / 2;
        const centerY = (pitData.gridBounds.minY + pitData.gridBounds.maxY) / 2;
        const { cx: ccx, cy: ccy } = this.dataToCanvas(centerX, centerY);

        const dx = cx - ccx;
        const dy = cy - ccy;
        const angle = Math.atan2(dy, dx);

        ctx.save();
        ctx.font = 'bold 14px Inter, sans-serif';
        ctx.fillStyle = 'rgba(16, 185, 129, 0.9)';
        ctx.textAlign = 'center';
        const nX = cx + Math.cos(angle) * 25;
        const nY = cy + Math.sin(angle) * 25;
        ctx.fillText('N', nX, nY + 5);

        ctx.strokeStyle = 'rgba(16, 185, 129, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * 10, cy + Math.sin(angle) * 10);
        ctx.lineTo(cx + Math.cos(angle) * 20, cy + Math.sin(angle) * 20);
        ctx.stroke();

        ctx.restore();
    }

    _drawLegend(ctx) {
        const x = 15;
        const y = 15;
        const w = 180;
        const h = 12;

        ctx.save();

        // Background pill
        const bgW = w + 70;
        const bgH = h + 22;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.beginPath();
        ctx.roundRect(x - 8, y - 6, bgW, bgH, 8);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
        ctx.lineWidth = 0.5;
        ctx.stroke();

        // Gradient bar
        const grad = ctx.createLinearGradient(x, y, x + w, y);
        grad.addColorStop(0, '#5D3A0A');
        grad.addColorStop(0.25, '#8B6914');
        grad.addColorStop(0.45, '#2E8B57');
        grad.addColorStop(0.65, '#9932CC');
        grad.addColorStop(0.85, '#4169E1');
        grad.addColorStop(1, '#87CEEB');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 3);
        ctx.fill();

        // Labels
        ctx.font = '9px Inter, sans-serif';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.textAlign = 'left';
        ctx.fillText('v:100%', x, y + h + 11);
        ctx.textAlign = 'right';
        ctx.fillText('v:0%', x + w, y + h + 11);

        ctx.restore();
    }

    _drawCavityBoundaries(ctx, boundaries) {
        ctx.save();
        const r = this.options.dotRadius * this.zoom;

        for (const region of boundaries) {
            if (!region.boundary || region.boundary.length < 2) continue;

            // Draw red rings directly on each boundary cell.
            // This is pixel-accurate: only marks actual damaged cells.
            for (const pt of region.boundary) {
                const { cx, cy } = this.dataToCanvas(pt.x, pt.y);
                ctx.beginPath();
                ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(220, 38, 38, 0.7)';
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }

            // Centroid marker — crosshair style
            const cc = this.dataToCanvas(region.centroid.x, region.centroid.y);
            const crossSize = 8;
            ctx.strokeStyle = 'rgba(220, 38, 38, 0.9)';
            ctx.lineWidth = 1.5;
            // Horizontal
            ctx.beginPath();
            ctx.moveTo(cc.cx - crossSize, cc.cy);
            ctx.lineTo(cc.cx + crossSize, cc.cy);
            ctx.stroke();
            // Vertical
            ctx.beginPath();
            ctx.moveTo(cc.cx, cc.cy - crossSize);
            ctx.lineTo(cc.cx, cc.cy + crossSize);
            ctx.stroke();
            // Circle
            ctx.beginPath();
            ctx.arc(cc.cx, cc.cy, 3, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(220, 38, 38, 0.9)';
            ctx.fill();

            // Label with frosted background
            const label = `#${region.id}: ${Math.round(region.area)}cm²`;
            ctx.font = '500 10px Inter, sans-serif';
            const tw = ctx.measureText(label).width;
            const lx = cc.cx - tw / 2 - 6;
            const ly = cc.cy - 26;
            // Background pill
            ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
            ctx.beginPath();
            ctx.roundRect(lx, ly, tw + 12, 18, 5);
            ctx.fill();
            ctx.strokeStyle = 'rgba(220, 38, 38, 0.3)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
            // Text
            ctx.fillStyle = 'rgba(185, 28, 28, 0.9)';
            ctx.textAlign = 'center';
            ctx.fillText(label, cc.cx, cc.cy - 14);
        }

        ctx.restore();
    }

    _drawPrincipalAxis(ctx, axis) {
        if (!axis) return;
        ctx.save();

        const { cx: pcx, cy: pcy } = this.dataToCanvas(axis.cx, axis.cy);
        const len = 100;
        const rad = axis.angle * Math.PI / 180;

        // Min axis (weakest direction) - red dashed
        ctx.strokeStyle = '#ff475780';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(pcx - Math.cos(rad) * len, pcy + Math.sin(rad) * len);
        ctx.lineTo(pcx + Math.cos(rad) * len, pcy - Math.sin(rad) * len);
        ctx.stroke();

        // Label
        ctx.font = '9px Inter, sans-serif';
        ctx.fillStyle = '#ff4757';
        ctx.textAlign = 'left';
        ctx.fillText(`I_min axis: ${Math.round(axis.angle)}°`, pcx + Math.cos(rad) * len + 5, pcy - Math.sin(rad) * len);

        ctx.setLineDash([]);
        ctx.restore();
    }

    _drawWallThickness(ctx, wallData) {
        if (!wallData || !wallData.thicknessProfile) return;
        ctx.save();

        const { cx: ccx, cy: ccy } = this.dataToCanvas(wallData.center.x, wallData.center.y);

        // Draw thickness arrows at min thickness direction
        let minEntry = wallData.thicknessProfile[0];
        for (const entry of wallData.thicknessProfile) {
            if (entry.thickness < minEntry.thickness) minEntry = entry;
        }

        const rad = minEntry.angle * Math.PI / 180;
        const startR = (minEntry.trunkRadius - minEntry.thickness) * this.transform.scale;
        const endR = minEntry.trunkRadius * this.transform.scale;

        ctx.strokeStyle = '#ffb347';
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.moveTo(ccx + Math.cos(rad) * startR, ccy - Math.sin(rad) * startR);
        ctx.lineTo(ccx + Math.cos(rad) * endR, ccy - Math.sin(rad) * endR);
        ctx.stroke();

        ctx.font = '10px Inter, sans-serif';
        ctx.fillStyle = '#ffb347';
        ctx.textAlign = 'center';
        const labelR = (startR + endR) / 2;
        ctx.fillText(
            `t=${minEntry.thickness.toFixed(1)}cm`,
            ccx + Math.cos(rad) * labelR + 15,
            ccy - Math.sin(rad) * labelR
        );

        ctx.setLineDash([]);
        ctx.restore();
    }

    /** Export canvas as PNG data URL */
    exportPNG() {
        return this.canvas.toDataURL('image/png');
    }
}
