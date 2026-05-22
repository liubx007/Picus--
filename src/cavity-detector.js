/**
 * Cavity Detector - Color Zone Classification & Connected-Component Analysis
 * 
 * Classifies each tomography grid point into decay zones based on RGB color,
 * then detects contiguous cavity regions using flood-fill.
 */

/** Decay zone constants */
export const ZONE = {
    HEALTHY: 'healthy',
    MILD: 'mild',
    MODERATE: 'moderate',
    SEVERE: 'severe',
    CAVITY: 'cavity'
};

/** Display colors for each zone */
export const ZONE_COLORS = {
    healthy:  '#8B6914',
    mild:     '#B8860B',
    moderate: '#2E8B57',
    severe:   '#9932CC',
    cavity:   '#4169E1'
};

/** Zone labels (Chinese + English) */
export const ZONE_LABELS = {
    healthy:  '健康 Healthy',
    mild:     '轻微 Mild',
    moderate: '中度 Moderate',
    severe:   '重度 Severe',
    cavity:   '空洞 Cavity'
};

// ──────────────────────────────────────────────
// Color Space Helpers
// ──────────────────────────────────────────────

/**
 * Convert RGB to HSL.
 * @param {number} r - 0-255
 * @param {number} g - 0-255
 * @param {number} b - 0-255
 * @returns {{ h: number, s: number, l: number }} h: 0-360, s: 0-100, l: 0-100
 */
export function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;

    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }

    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// ──────────────────────────────────────────────
// Point-in-Polygon (Ray Casting)
// ──────────────────────────────────────────────

/**
 * Test if point (x,y) is inside polygon.
 * @param {number} x
 * @param {number} y
 * @param {Array<{x: number, y: number}>} polygon
 * @returns {boolean}
 */
export function pointInPolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

// ──────────────────────────────────────────────
// Cavity Detector Class
// ──────────────────────────────────────────────

export class CavityDetector {
    constructor() {
        this.classified = [];
        this.rasterGrid = null;
        this.rasterW = 0;
        this.rasterH = 0;
        this.cellSize = 0.5; // cm per cell
    }

    /**
     * Classify each grid point into a decay zone based on its RGB color.
     * Uses HSL color space for robust classification matching Picus color scheme:
     *   - Brown tones → HEALTHY (sound wood, high velocity)
     *   - Light brown  → MILD (slight degradation)
     *   - Green tones  → MODERATE (intermediate decay)
     *   - Purple/Magenta → SEVERE (advanced decay)
     *   - Blue/Light   → CAVITY (void or extreme decay)
     *
     * @param {Array<{x,y,r,g,b}>} tomoGrid
     * @returns {Array} Points with added 'zone' property
     */
    classify(tomoGrid) {
        this.classified = tomoGrid.map(pt => {
            const { h, s, l } = rgbToHsl(pt.r, pt.g, pt.b);
            let zone;

            // Very dark = solid wood (black in Picus = max velocity)
            if (l < 12) {
                zone = ZONE.HEALTHY;
            }
            // Very light or near-white = cavity / void
            else if (l > 82 && s < 30) {
                zone = ZONE.CAVITY;
            }
            // Brown range: hue roughly 0-55°, warm tones
            else if ((h <= 55 || h >= 340) && s > 12 && l < 55) {
                zone = l < 35 ? ZONE.HEALTHY : ZONE.MILD;
            }
            // Green range: hue 56-170°
            else if (h > 55 && h <= 170) {
                zone = ZONE.MODERATE;
            }
            // Blue range: hue 171-260°
            else if (h > 170 && h <= 260) {
                zone = ZONE.CAVITY;
            }
            // Purple/Magenta: hue 261-339°
            else if (h > 260 && h < 340) {
                zone = ZONE.SEVERE;
            }
            // Fallback: use lightness
            else if (l > 65) {
                zone = ZONE.CAVITY;
            } else if (l > 45) {
                zone = ZONE.MILD;
            } else {
                zone = ZONE.HEALTHY;
            }

            return { ...pt, zone, hsl: { h, s, l } };
        });

        return this.classified;
    }

    /**
     * Rasterize irregular tomo points onto a regular grid.
     * Each cell gets the zone of the nearest tomo point.
     */
    _rasterize(classifiedPoints, bounds) {
        const { minX, maxX, minY, maxY } = bounds;
        const cs = this.cellSize;
        this.rasterW = Math.ceil((maxX - minX) / cs) + 1;
        this.rasterH = Math.ceil((maxY - minY) / cs) + 1;

        // Initialize grid
        this.rasterGrid = Array.from({ length: this.rasterH }, () =>
            Array(this.rasterW).fill(null)
        );

        // Build a spatial index for fast nearest-neighbor lookup
        // Simple approach: for each grid cell, find closest point
        // Optimization: bucket points into cells first
        const buckets = new Map();
        for (const pt of classifiedPoints) {
            const bx = Math.floor((pt.x - minX) / cs);
            const by = Math.floor((pt.y - minY) / cs);
            const key = `${bx},${by}`;
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(pt);
        }

        for (let gy = 0; gy < this.rasterH; gy++) {
            for (let gx = 0; gx < this.rasterW; gx++) {
                // Search in this cell and neighbors for closest point
                let bestPt = null;
                let bestDist = Infinity;
                const cx = minX + gx * cs + cs / 2;
                const cy = minY + gy * cs + cs / 2;

                for (let dy = -2; dy <= 2; dy++) {
                    for (let dx = -2; dx <= 2; dx++) {
                        const key = `${gx + dx},${gy + dy}`;
                        const bucket = buckets.get(key);
                        if (!bucket) continue;
                        for (const pt of bucket) {
                            const d = (pt.x - cx) ** 2 + (pt.y - cy) ** 2;
                            if (d < bestDist) {
                                bestDist = d;
                                bestPt = pt;
                            }
                        }
                    }
                }

                if (bestPt && bestDist < (cs * 3) ** 2) {
                    this.rasterGrid[gy][gx] = bestPt.zone;
                }
            }
        }

        return { grid: this.rasterGrid, w: this.rasterW, h: this.rasterH, cellSize: cs, minX, minY };
    }

    /**
     * Detect contiguous cavity/severe regions using connected-component labeling.
     * @param {Array} classifiedPoints - Points with zone classification
     * @param {Array} sensorPositions - Sensor positions defining trunk outline
     * @param {Set<string>} damagedZones - Zones considered as "damaged"
     * @returns {Object} Detection results
     */
    detectCavities(classifiedPoints, sensorPositions, damagedZones = new Set([ZONE.CAVITY, ZONE.SEVERE])) {
        // Compute bounds
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const pt of classifiedPoints) {
            if (pt.x < minX) minX = pt.x;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y < minY) minY = pt.y;
            if (pt.y > maxY) maxY = pt.y;
        }

        const raster = this._rasterize(classifiedPoints, { minX, maxX, minY, maxY });
        const { grid, w, h, cellSize } = raster;

        // Create trunk outline polygon from sensors
        const outline = sensorPositions.map(s => ({ x: s.x, y: s.y }));

        // Connected-component labeling
        const visited = Array.from({ length: h }, () => Array(w).fill(false));
        const regions = [];

        for (let gy = 0; gy < h; gy++) {
            for (let gx = 0; gx < w; gx++) {
                if (visited[gy][gx]) continue;
                if (!grid[gy][gx]) continue;
                if (!damagedZones.has(grid[gy][gx])) continue;

                // Check if inside trunk outline
                const px = minX + gx * cellSize + cellSize / 2;
                const py = minY + gy * cellSize + cellSize / 2;
                if (!pointInPolygon(px, py, outline)) continue;

                // Flood fill
                const cells = [];
                const stack = [[gx, gy]];
                while (stack.length > 0) {
                    const [cx, cy] = stack.pop();
                    if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
                    if (visited[cy][cx]) continue;
                    if (!grid[cy][cx] || !damagedZones.has(grid[cy][cx])) continue;

                    visited[cy][cx] = true;
                    cells.push({ gx: cx, gy: cy });

                    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
                }

                // Filter tiny regions (noise)
                if (cells.length < 5) continue;

                // Compute region metrics
                const area = cells.length * cellSize * cellSize; // cm²
                let sumX = 0, sumY = 0;
                let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;

                for (const cell of cells) {
                    const x = minX + cell.gx * cellSize + cellSize / 2;
                    const y = minY + cell.gy * cellSize + cellSize / 2;
                    sumX += x;
                    sumY += y;
                    if (x < bMinX) bMinX = x;
                    if (x > bMaxX) bMaxX = x;
                    if (y < bMinY) bMinY = y;
                    if (y > bMaxY) bMaxY = y;
                }

                const centroid = { x: sumX / cells.length, y: sumY / cells.length };

                // Find boundary cells (cells with at least one non-damaged neighbor)
                const boundary = [];
                for (const cell of cells) {
                    const { gx: cx, gy: cy } = cell;
                    const neighbors = [[cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]];
                    for (const [nx, ny] of neighbors) {
                        if (nx < 0 || nx >= w || ny < 0 || ny >= h ||
                            !grid[ny]?.[nx] || !damagedZones.has(grid[ny][nx])) {
                            boundary.push({
                                x: minX + cx * cellSize + cellSize / 2,
                                y: minY + cy * cellSize + cellSize / 2
                            });
                            break;
                        }
                    }
                }

                regions.push({
                    id: regions.length + 1,
                    area,
                    centroid,
                    boundingBox: { minX: bMinX, maxX: bMaxX, minY: bMinY, maxY: bMaxY },
                    boundary,
                    cellCount: cells.length,
                    equivalentDiameter: 2 * Math.sqrt(area / Math.PI),
                });
            }
        }

        // Sort regions by area (largest first)
        regions.sort((a, b) => b.area - a.area);

        // Compute total trunk area (from sensor outline using shoelace)
        const totalArea = polygonArea(outline);
        const totalCavityArea = regions.reduce((sum, r) => sum + r.area, 0);

        return {
            regions,
            totalCavityArea,
            totalArea,
            cavityRatio: totalArea > 0 ? (totalCavityArea / totalArea) * 100 : 0,
            raster,
        };
    }

    /**
     * Compute area percentage for each zone.
     */
    computeZoneAreas(classifiedPoints, sensorPositions) {
        const outline = sensorPositions.map(s => ({ x: s.x, y: s.y }));
        const counts = { healthy: 0, mild: 0, moderate: 0, severe: 0, cavity: 0 };
        let total = 0;

        for (const pt of classifiedPoints) {
            if (pointInPolygon(pt.x, pt.y, outline)) {
                counts[pt.zone] = (counts[pt.zone] || 0) + 1;
                total++;
            }
        }

        const result = {};
        for (const zone of Object.keys(counts)) {
            result[zone] = total > 0 ? (counts[zone] / total) * 100 : 0;
        }
        return result;
    }

    /**
     * Compute wall thickness in all directions.
     * Casts rays from trunk center outward every 10°.
     * Wall thickness = distance from trunk edge inward to first damaged zone.
     */
    computeWallThickness(classifiedPoints, sensorPositions, damagedZones = new Set([ZONE.CAVITY, ZONE.SEVERE])) {
        const outline = sensorPositions.map(s => ({ x: s.x, y: s.y }));

        // Trunk center
        const cx = outline.reduce((s, p) => s + p.x, 0) / outline.length;
        const cy = outline.reduce((s, p) => s + p.y, 0) / outline.length;

        // Build spatial index for fast lookup
        const cellSize = 0.5;
        const pointMap = new Map();
        for (const pt of classifiedPoints) {
            const key = `${Math.round(pt.x / cellSize)},${Math.round(pt.y / cellSize)}`;
            if (!pointMap.has(key)) pointMap.set(key, []);
            pointMap.get(key).push(pt);
        }

        const thicknessProfile = [];
        let minThickness = Infinity, maxThickness = 0;

        for (let angle = 0; angle < 360; angle += 10) {
            const rad = angle * Math.PI / 180;
            const dx = Math.cos(rad);
            const dy = Math.sin(rad);

            // Find intersection with trunk outline (approximate: walk outward from center)
            let trunkRadius = 0;
            for (let r = 0; r < 50; r += 0.3) {
                const px = cx + dx * r;
                const py = cy + dy * r;
                if (!pointInPolygon(px, py, outline)) {
                    trunkRadius = r;
                    break;
                }
            }

            // Walk inward from trunk edge, find where healthy wood ends
            let wallThickness = 0;
            for (let r = trunkRadius; r > 0; r -= 0.3) {
                const px = cx + dx * r;
                const py = cy + dy * r;

                // Find nearest classified point
                const gx = Math.round(px / cellSize);
                const gy = Math.round(py / cellSize);
                let nearestZone = null;
                let nearestDist = Infinity;

                for (let dgy = -1; dgy <= 1; dgy++) {
                    for (let dgx = -1; dgx <= 1; dgx++) {
                        const key = `${gx + dgx},${gy + dgy}`;
                        const pts = pointMap.get(key);
                        if (!pts) continue;
                        for (const p of pts) {
                            const d = (p.x - px) ** 2 + (p.y - py) ** 2;
                            if (d < nearestDist) {
                                nearestDist = d;
                                nearestZone = p.zone;
                            }
                        }
                    }
                }

                if (nearestZone && damagedZones.has(nearestZone)) {
                    wallThickness = trunkRadius - r;
                    break;
                }
            }

            if (wallThickness === 0) wallThickness = trunkRadius; // All healthy

            thicknessProfile.push({ angle, thickness: wallThickness, trunkRadius });
            if (wallThickness < minThickness) minThickness = wallThickness;
            if (wallThickness > maxThickness) maxThickness = wallThickness;
        }

        return {
            minThickness: minThickness === Infinity ? 0 : minThickness,
            maxThickness,
            avgThickness: thicknessProfile.reduce((s, t) => s + t.thickness, 0) / thicknessProfile.length,
            thicknessProfile,
            center: { x: cx, y: cy },
        };
    }
}

/**
 * Compute polygon area using Shoelace formula.
 * @param {Array<{x: number, y: number}>} polygon
 * @returns {number} Area in same units as coordinates squared
 */
export function polygonArea(polygon) {
    let area = 0;
    const n = polygon.length;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += polygon[i].x * polygon[j].y;
        area -= polygon[j].x * polygon[i].y;
    }
    return Math.abs(area) / 2;
}
