/**
 * Weighted Cross-Section Residual Strength Calculator
 *
 * Computes residual bending strength using weighted moment of inertia,
 * where each decay zone contributes proportionally to its strength coefficient α.
 *
 * Core formula:
 *   I_weighted = Σ αᵢ × (yi - ȳ)² × ΔA
 *   W_effective = I_min / y_max
 *   Residual Strength = W_effective / W_intact × 100%
 */

import { polygonArea, pointInPolygon } from './cavity-detector.js';

/** Default decay coefficients */
export const DEFAULT_COEFFICIENTS = {
    healthy:  1.00,
    mild:     0.85,
    moderate: 0.50,
    severe:   0.20,
    cavity:   0.05,
};

export class StrengthCalculator {
    /**
     * @param {Object} coefficients - Decay zone coefficients { healthy: 1.0, ..., cavity: 0.05 }
     */
    constructor(coefficients = DEFAULT_COEFFICIENTS) {
        this.coefficients = { ...DEFAULT_COEFFICIENTS, ...coefficients };
    }

    /**
     * Update coefficients.
     * @param {Object} coefficients - Partial or full coefficient update
     */
    setCoefficients(coefficients) {
        this.coefficients = { ...this.coefficients, ...coefficients };
    }

    /**
     * Compute weighted residual cross-section strength.
     *
     * @param {Array<{x,y,zone}>} classifiedPoints - Points with zone classification
     * @param {Array<{id,x,y}>} sensorPositions - Sensor positions defining trunk outline
     * @returns {Object} Complete strength analysis results
     */
    compute(classifiedPoints, sensorPositions) {
        const outline = sensorPositions.map(s => ({ x: s.x, y: s.y }));

        // 1. Filter to points inside trunk outline
        const insidePoints = classifiedPoints.filter(pt =>
            pointInPolygon(pt.x, pt.y, outline)
        );

        if (insidePoints.length < 10) {
            return this._emptyResult();
        }

        // 2. Compute dA from trunk area / point count (correct normalization)
        //    This guarantees that Σ dA = trunkArea, preventing inflation from
        //    multi-pass overlapping grid data in PIT files.
        const trunkArea = polygonArea(outline);
        const dA = trunkArea / insidePoints.length;

        // 3. Assign alpha coefficient to each point
        const alphaPoints = insidePoints.map(pt => ({
            ...pt,
            alpha: this.coefficients[pt.zone] ?? 0.5,
        }));

        // 4. Compute INTACT reference numerically (same points, all α=1)
        //    This ensures weighted and intact use identical discretization.
        let intactSumX = 0, intactSumY = 0;
        const n = insidePoints.length;
        for (const pt of insidePoints) {
            intactSumX += pt.x;
            intactSumY += pt.y;
        }
        const intactCx = intactSumX / n;
        const intactCy = intactSumY / n;

        let intactIx = 0, intactIy = 0, intactIxy = 0;
        for (const pt of insidePoints) {
            const dx = pt.x - intactCx;
            const dy = pt.y - intactCy;
            intactIx  += dy * dy * dA;
            intactIy  += dx * dx * dA;
            intactIxy += dx * dy * dA;
        }
        const intactAvgI = (intactIx + intactIy) / 2;
        const intactDiffI = Math.sqrt(((intactIx - intactIy) / 2) ** 2 + intactIxy ** 2);
        const intactI_min = intactAvgI - intactDiffI;
        const intactTheta = 0.5 * Math.atan2(-2 * intactIxy, intactIx - intactIy);
        const intactYMax = this._maxDistToOutline(intactCx, intactCy, intactTheta, outline);
        const W_intact = intactYMax > 0 ? intactI_min / intactYMax : 1;

        // 5. Compute weighted centroid
        let sumAlpha = 0, sumAX = 0, sumAY = 0;
        for (const pt of alphaPoints) {
            const w = pt.alpha * dA;
            sumAlpha += w;
            sumAX += w * pt.x;
            sumAY += w * pt.y;
        }

        if (sumAlpha === 0) return this._emptyResult();

        const cx = sumAX / sumAlpha;
        const cy = sumAY / sumAlpha;

        // 6. Compute weighted moments of inertia about weighted centroid
        let Ix = 0, Iy = 0, Ixy = 0;
        for (const pt of alphaPoints) {
            const dx = pt.x - cx;
            const dy = pt.y - cy;
            const w = pt.alpha * dA;
            Ix  += w * dy * dy;
            Iy  += w * dx * dx;
            Ixy += w * dx * dy;
        }

        // 7. Principal axes (weighted)
        const theta = 0.5 * Math.atan2(-2 * Ixy, Ix - Iy);
        const avgI = (Ix + Iy) / 2;
        const diffI = Math.sqrt(((Ix - Iy) / 2) ** 2 + Ixy ** 2);
        const I_min = avgI - diffI;
        const I_max = avgI + diffI;

        // 8. Section modulus (weighted)
        const y_max = this._maxDistToOutline(cx, cy, theta, outline);
        const W_effective = y_max > 0 ? I_min / y_max : 0;

        // 9. Residual strength ratio (guaranteed ≤ 100%)
        const R_equiv = Math.sqrt(trunkArea / Math.PI);
        const D_equiv = 2 * R_equiv;
        const residualStrength = W_intact > 0 ? Math.min((W_effective / W_intact) * 100, 100) : 0;

        // Equivalent diameter: diameter of solid circle with same W as W_effective
        // W = π/32 × D³ → D = (32W/π)^(1/3)
        const D_eq = W_effective > 0 ? Math.cbrt((32 * W_effective) / Math.PI) : 0;
        const equivalentPerimeter = Math.PI * D_eq;

        // Assessment — 1/3 rule: ≤33% loss (≥67% remaining) is acceptable
        let assessment, assessmentDetails;
        if (residualStrength >= 67) {
            assessment = 'safe';
            assessmentDetails = 'Adequate residual strength (≤1/3 loss)';
        } else {
            assessment = 'critical';
            assessmentDetails = 'Strength loss exceeds 1/3 threshold — not acceptable';
        }

        return {
            residualStrength: Math.round(residualStrength * 10) / 10,
            equivalentDiameter: Math.round(D_eq * 10) / 10,
            equivalentPerimeter: Math.round(equivalentPerimeter * 10) / 10,
            principalAxisAngle: Math.round((theta * 180 / Math.PI + 360) % 180 * 10) / 10,
            weightedCentroid: {
                x: Math.round(cx * 100) / 100,
                y: Math.round(cy * 100) / 100
            },
            I_min: Math.round(I_min * 100) / 100,
            I_max: Math.round(I_max * 100) / 100,
            Ix: Math.round(Ix * 100) / 100,
            Iy: Math.round(Iy * 100) / 100,
            W_effective: Math.round(W_effective * 100) / 100,
            W_intact: Math.round(W_intact * 100) / 100,
            trunkArea: Math.round(trunkArea * 10) / 10,
            trunkDiameter: Math.round(D_equiv * 10) / 10,
            weightedArea: Math.round(sumAlpha * 10) / 10,
            effectiveAreaRatio: Math.round((sumAlpha / trunkArea) * 1000) / 10,
            assessment,
            assessmentDetails,
            coefficientsUsed: { ...this.coefficients },
            dA,
            pointCount: insidePoints.length,
        };
    }

    /**
     * Compute max distance from centroid to trunk outline along a given axis.
     * @param {number} cx - Centroid x
     * @param {number} cy - Centroid y
     * @param {number} theta - Axis angle in radians
     * @param {Array<{x,y}>} outline - Trunk outline polygon
     * @returns {number} Maximum distance
     */
    _maxDistToOutline(cx, cy, theta, outline) {
        let maxDist = 0;
        // The distance along the min-I axis is the perpendicular distance
        // from each outline point to the axis line through (cx, cy) at angle theta
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);

        for (const pt of outline) {
            const dx = pt.x - cx;
            const dy = pt.y - cy;
            // Perpendicular distance to the axis (axis direction = (cosT, sinT))
            // Perpendicular = |dx * sinT - dy * cosT|
            const perpDist = Math.abs(dx * sinT - dy * cosT);
            if (perpDist > maxDist) maxDist = perpDist;
        }

        // Also check intermediate points on outline edges
        for (let i = 0; i < outline.length; i++) {
            const j = (i + 1) % outline.length;
            for (let t = 0.1; t < 1; t += 0.1) {
                const px = outline[i].x + t * (outline[j].x - outline[i].x);
                const py = outline[i].y + t * (outline[j].y - outline[i].y);
                const dx = px - cx;
                const dy = py - cy;
                const perpDist = Math.abs(dx * sinT - dy * cosT);
                if (perpDist > maxDist) maxDist = perpDist;
            }
        }

        return maxDist;
    }

    /**
     * Estimate grid spacing from point distribution.
     * Takes the median of nearest-neighbor distances.
     */
    _estimateGridSpacing(points) {
        if (points.length < 2) return 1;

        // Sample a subset for efficiency
        const sample = points.length > 200
            ? points.filter((_, i) => i % Math.floor(points.length / 200) === 0)
            : points;

        const distances = [];
        for (let i = 0; i < Math.min(sample.length, 100); i++) {
            let minDist = Infinity;
            for (let j = 0; j < sample.length; j++) {
                if (i === j) continue;
                const d = Math.sqrt(
                    (sample[i].x - sample[j].x) ** 2 +
                    (sample[i].y - sample[j].y) ** 2
                );
                if (d > 0.01 && d < minDist) minDist = d;
            }
            if (minDist < Infinity) distances.push(minDist);
        }

        if (distances.length === 0) return 1;

        distances.sort((a, b) => a - b);
        const median = distances[Math.floor(distances.length / 2)];

        // dA = spacing²
        return median * median;
    }

    /**
     * Return empty result structure for edge cases.
     */
    _emptyResult() {
        return {
            residualStrength: 0,
            equivalentDiameter: 0,
            equivalentPerimeter: 0,
            principalAxisAngle: 0,
            weightedCentroid: { x: 0, y: 0 },
            I_min: 0, I_max: 0, Ix: 0, Iy: 0,
            W_effective: 0, W_intact: 0,
            trunkArea: 0, trunkDiameter: 0,
            weightedArea: 0, effectiveAreaRatio: 0,
            assessment: 'critical',
            assessmentDetails: '数据不足 / Insufficient data',
            coefficientsUsed: { ...this.coefficients },
            dA: 0, pointCount: 0,
        };
    }
}
