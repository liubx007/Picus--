/**
 * Picus Tomography Analyzer - Multi-Document Application Controller
 * Supports opening multiple PIT files in tabs.
 */

import { parsePIT, loadPITFile } from './pit-parser.js';
import { TomoRenderer } from './tomo-renderer.js';
import { CavityDetector, ZONE_COLORS, ZONE_LABELS } from './cavity-detector.js';
import { StrengthCalculator, DEFAULT_COEFFICIENTS } from './strength-calculator.js';
import { ReportGenerator } from './report.js';

/**
 * Represents a single open document (one PIT file).
 */
class Document {
    constructor(id, fileName) {
        this.id = id;
        this.fileName = fileName;
        this.pitData = null;
        this.classifiedPoints = null;
        this.strengthResult = null;
        this.cavityResult = null;
        this.zoneAreas = null;
        this.wallThickness = null;
        this.coefficients = { ...DEFAULT_COEFFICIENTS };
        this.overlays = {
            showCavities: true,
            showAxis: true,
            showWallThickness: false,
        };
        // Persist canvas view state per document
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
    }
}

class App {
    constructor() {
        this.documents = [];       // Array of Document
        this.activeDocId = null;   // ID of the currently active document
        this._nextDocId = 1;

        this.renderer = null;
        this.renderer3D = null;    // Lazy-loaded 3D renderer
        this.viewMode = '2d';      // '2d' or '3d'
        this.detector = new CavityDetector();
        this.calculator = new StrengthCalculator();
        this.reporter = new ReportGenerator();

        this._init();
    }

    get activeDoc() {
        return this.documents.find(d => d.id === this.activeDocId) || null;
    }

    _init() {
        // Canvas
        const canvas = document.getElementById('tomoCanvas');
        this.renderer = new TomoRenderer(canvas);
        this.renderer.onHover((pt, cx, cy) => this._onHover(pt, cx, cy));

        // File input — supports multiple files
        const fileInput = document.getElementById('fileInput');
        fileInput.setAttribute('multiple', '');
        fileInput.addEventListener('change', (e) => {
            for (const file of e.target.files) {
                this._loadFile(file);
            }
            fileInput.value = '';
        });

        document.getElementById('btnLoad').addEventListener('click', () => {
            fileInput.click();
        });

        // Drag and drop
        this._setupDragDrop();

        // Coefficient sliders
        this._setupSliders();

        // Action buttons
        document.getElementById('btnExportReport')?.addEventListener('click', () => this._exportReport());
        document.getElementById('btnExportPNG')?.addEventListener('click', () => this._exportPNG());
        document.getElementById('btnExportCoeff')?.addEventListener('click', () => this._exportCoefficients());
        document.getElementById('btnImportCoeff')?.addEventListener('click', () => {
            document.getElementById('coeffFileInput').click();
        });
        document.getElementById('coeffFileInput')?.addEventListener('change', (e) => {
            if (e.target.files.length > 0) this._importCoefficients(e.target.files[0]);
        });

        // Calculation detail modal
        document.getElementById('btnShowCalc')?.addEventListener('click', () => this._showCalculation());
        document.getElementById('calcModalClose')?.addEventListener('click', () => {
            document.getElementById('calcModal').style.display = 'none';
        });
        document.getElementById('calcModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
        });

        // Overlay toggles
        document.getElementById('toggleCavities')?.addEventListener('click', (e) => {
            if (!this.activeDoc) return;
            this.activeDoc.overlays.showCavities = !this.activeDoc.overlays.showCavities;
            e.target.classList.toggle('active');
            this._render();
        });
        document.getElementById('toggleAxis')?.addEventListener('click', (e) => {
            if (!this.activeDoc) return;
            this.activeDoc.overlays.showAxis = !this.activeDoc.overlays.showAxis;
            e.target.classList.toggle('active');
            this._render();
        });
        document.getElementById('toggleWall')?.addEventListener('click', (e) => {
            if (!this.activeDoc) return;
            this.activeDoc.overlays.showWallThickness = !this.activeDoc.overlays.showWallThickness;
            e.target.classList.toggle('active');
            this._render();
        });

        // 2D/3D view toggle
        document.getElementById('btn2D')?.addEventListener('click', () => this._setViewMode('2d'));
        document.getElementById('btn3D')?.addEventListener('click', () => this._setViewMode('3d'));

        // Resize
        window.addEventListener('resize', () => this.renderer.resize());
    }

    // ── View Mode ──

    async _setViewMode(mode) {
        if (mode === this.viewMode) return;
        this.viewMode = mode;

        const panel2D = document.getElementById('canvasPanel');
        const panel3D = document.getElementById('panel3D');
        const btn2D = document.getElementById('btn2D');
        const btn3D = document.getElementById('btn3D');

        btn2D.classList.toggle('active', mode === '2d');
        btn3D.classList.toggle('active', mode === '3d');

        if (mode === '3d') {
            panel2D.style.display = 'none';
            panel3D.style.display = 'block';
            await this._render3D();
        } else {
            panel3D.style.display = 'none';
            panel2D.style.display = 'block';
            if (this.renderer3D) {
                this.renderer3D.dispose();
                this.renderer3D = null;
            }
            this.renderer.resize();
            this._render();
        }
    }

    async _render3D() {
        const container = document.getElementById('container3D');
        const hint = document.getElementById('hint3D');

        // Wait for layout to settle
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        // IMPORTANT: Analyze ALL documents, not just active one
        for (const doc of this.documents) {
            if (doc.pitData && !doc.classifiedPoints) {
                doc.classifiedPoints = this.detector.classify(doc.pitData.tomoGrid);
                for (let i = 0; i < doc.pitData.tomoGrid.length; i++) {
                    doc.pitData.tomoGrid[i].zone = doc.classifiedPoints[i].zone;
                }
            }
        }

        const docs3D = this.documents
            .filter(d => d.pitData && d.classifiedPoints)
            .map(d => ({
                pitData: d.pitData,
                classifiedPoints: d.classifiedPoints,
                height: parseFloat(d.pitData.metadata.measurementHeight) || 0,
            }));

        if (docs3D.length === 0) {
            if (hint) { hint.style.display = 'block'; hint.textContent = 'No data loaded.'; }
            return;
        }

        // If all heights are the same, spread them for visualization
        const heights = docs3D.map(d => d.height);
        if (heights.every(h => h === heights[0])) {
            docs3D.forEach((d, i) => { d.height = i * 5; });
        }

        if (hint) hint.style.display = 'block'; // keep as status hint

        // Clean up previous
        if (this.renderer3D) {
            this.renderer3D.dispose();
            this.renderer3D = null;
        }

        try {
            const { Tomo3DRenderer } = await import('./tomo-3d-renderer.js');
            this.renderer3D = new Tomo3DRenderer(container);
            this.renderer3D.render(docs3D);
            this._setup3DControls();
        } catch (err) {
            console.error('[3D] Error:', err);
            if (hint) { hint.style.display = 'block'; hint.textContent = `Error: ${err.message}`; }
        }
    }

    _setup3DControls() {
        const clipToggle = document.getElementById('clipToggle');
        const clipAngle = document.getElementById('clipAngle');
        const clipSize = document.getElementById('clipSize');
        const heightScale = document.getElementById('heightScale');
        const clipControls = document.getElementById('clipControls');

        clipToggle?.addEventListener('change', () => {
            const on = clipToggle.checked;
            this.renderer3D?.setClipEnabled(on);
            if (clipControls) clipControls.style.display = on ? 'block' : 'none';
        });

        clipAngle?.addEventListener('input', () => {
            this.renderer3D?.setClipAngle(parseInt(clipAngle.value));
        });

        clipSize?.addEventListener('input', () => {
            this.renderer3D?.setClipSize(parseInt(clipSize.value));
        });

        heightScale?.addEventListener('input', () => {
            this.renderer3D?.setHeightScale(parseInt(heightScale.value) / 100);
        });
    }

    // ── Tab Management ──

    _createTab(doc) {
        const tabBar = document.getElementById('tabBar');
        const tab = document.createElement('div');
        tab.className = 'tab';
        tab.dataset.docId = doc.id;
        tab.innerHTML = `
            <span class="tab-label">${doc.fileName}</span>
            <button class="tab-close" title="Close">&times;</button>
        `;

        tab.querySelector('.tab-label').addEventListener('click', () => {
            this._switchTo(doc.id);
        });

        tab.querySelector('.tab-close').addEventListener('click', (e) => {
            e.stopPropagation();
            this._closeDoc(doc.id);
        });

        tabBar.appendChild(tab);
        this._switchTo(doc.id);
    }

    _updateTabBar() {
        const tabs = document.querySelectorAll('.tab');
        tabs.forEach(t => {
            t.classList.toggle('active', t.dataset.docId === String(this.activeDocId));
        });
    }

    _switchTo(docId) {
        // Save current view state
        if (this.activeDoc) {
            this.activeDoc.zoom = this.renderer.zoom;
            this.activeDoc.panX = this.renderer.panX;
            this.activeDoc.panY = this.renderer.panY;
        }

        this.activeDocId = docId;
        this._updateTabBar();

        const doc = this.activeDoc;
        if (!doc || !doc.pitData) {
            this.renderer.ctx.clearRect(0, 0, this.renderer.displayWidth, this.renderer.displayHeight);
            return;
        }

        // Restore view state
        this.renderer.zoom = doc.zoom;
        this.renderer.panX = doc.panX;
        this.renderer.panY = doc.panY;

        // Restore coefficient sliders
        this._syncSliders(doc);

        // Restore overlay toggles
        this._syncOverlayToggles(doc);

        // Update all UI
        this._updateTreeInfo();
        this._updateStrengthUI();
        this._updateAreaUI();
        this._updateMetricsUI();
        this._render();
    }

    _closeDoc(docId) {
        const idx = this.documents.findIndex(d => d.id === docId);
        if (idx === -1) return;

        this.documents.splice(idx, 1);

        // Remove tab element
        const tabEl = document.querySelector(`.tab[data-doc-id="${docId}"]`);
        if (tabEl) tabEl.remove();

        // Switch to another tab or show welcome
        if (this.documents.length > 0) {
            const newActive = this.documents[Math.min(idx, this.documents.length - 1)];
            this._switchTo(newActive.id);
        } else {
            this.activeDocId = null;
            document.getElementById('resultsContent').style.display = 'none';
            document.getElementById('welcomeScreen').style.display = '';
            this.renderer.ctx.clearRect(0, 0, this.renderer.displayWidth, this.renderer.displayHeight);
        }
    }

    _syncSliders(doc) {
        const zones = ['healthy', 'mild', 'moderate', 'severe', 'cavity'];
        for (const zone of zones) {
            const slider = document.getElementById(`slider-${zone}`);
            const valueEl = document.getElementById(`value-${zone}`);
            if (slider) slider.value = doc.coefficients[zone] * 100;
            if (valueEl) valueEl.textContent = doc.coefficients[zone].toFixed(2);
        }
    }

    _syncOverlayToggles(doc) {
        const map = {
            toggleCavities: doc.overlays.showCavities,
            toggleAxis: doc.overlays.showAxis,
            toggleWall: doc.overlays.showWallThickness,
        };
        for (const [id, active] of Object.entries(map)) {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('active', active);
        }
    }

    // ── File Loading ──

    _setupDragDrop() {
        const dropZone = document.getElementById('dropZone');
        let dragCounter = 0;

        document.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;
            dropZone.classList.add('active');
        });

        document.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                dropZone.classList.remove('active');
            }
        });

        document.addEventListener('dragover', (e) => e.preventDefault());

        document.addEventListener('drop', (e) => {
            e.preventDefault();
            dragCounter = 0;
            dropZone.classList.remove('active');
            for (const file of e.dataTransfer.files) {
                if (file.name.toLowerCase().endsWith('.pit')) {
                    this._loadFile(file);
                }
            }
        });
    }

    _setupSliders() {
        const zones = ['healthy', 'mild', 'moderate', 'severe', 'cavity'];
        for (const zone of zones) {
            const slider = document.getElementById(`slider-${zone}`);
            const valueEl = document.getElementById(`value-${zone}`);
            if (!slider) continue;

            slider.addEventListener('input', () => {
                if (!this.activeDoc) return;
                const val = parseInt(slider.value) / 100;
                this.activeDoc.coefficients[zone] = val;
                if (valueEl) valueEl.textContent = val.toFixed(2);
                this.calculator.setCoefficients(this.activeDoc.coefficients);
                if (this.activeDoc.classifiedPoints) this._recompute();
            });
        }
    }

    async _loadFile(file) {
        try {
            const doc = new Document(this._nextDocId++, file.name);
            doc.pitData = await loadPITFile(file);
            this.documents.push(doc);

            // Hide welcome, show results
            const welcome = document.getElementById('welcomeScreen');
            if (welcome) welcome.style.display = 'none';
            document.getElementById('resultsContent').style.display = 'block';

            // Create tab and switch to it
            this._createTab(doc);

            // Run analysis
            this._analyze();
        } catch (err) {
            console.error('Error loading PIT file:', err);
            alert('Error loading file: ' + err.message);
        }
    }

    // ── Analysis Pipeline ──

    _analyze() {
        const doc = this.activeDoc;
        if (!doc || !doc.pitData) return;

        doc.classifiedPoints = this.detector.classify(doc.pitData.tomoGrid);

        for (let i = 0; i < doc.pitData.tomoGrid.length; i++) {
            doc.pitData.tomoGrid[i].zone = doc.classifiedPoints[i].zone;
        }

        this._recompute();
        this._updateTreeInfo();
    }

    _recompute() {
        const doc = this.activeDoc;
        if (!doc || !doc.classifiedPoints || !doc.pitData) return;

        doc.zoneAreas = this.detector.computeZoneAreas(doc.classifiedPoints, doc.pitData.sensors);
        doc.cavityResult = this.detector.detectCavities(doc.classifiedPoints, doc.pitData.sensors);
        doc.wallThickness = this.detector.computeWallThickness(doc.classifiedPoints, doc.pitData.sensors);

        this.calculator.setCoefficients(doc.coefficients);
        doc.strengthResult = this.calculator.compute(doc.classifiedPoints, doc.pitData.sensors);

        this._updateStrengthUI();
        this._updateAreaUI();
        this._updateMetricsUI();
        this._render();
    }

    _render() {
        const doc = this.activeDoc;
        if (!doc || !doc.pitData) return;

        const overlays = {};

        if (doc.overlays.showCavities && doc.cavityResult) {
            overlays.cavityBoundaries = doc.cavityResult.regions;
        }

        if (doc.overlays.showAxis && doc.strengthResult) {
            overlays.principalAxis = {
                cx: doc.strengthResult.weightedCentroid.x,
                cy: doc.strengthResult.weightedCentroid.y,
                angle: doc.strengthResult.principalAxisAngle,
            };
        }

        if (doc.overlays.showWallThickness && doc.wallThickness) {
            overlays.wallThickness = doc.wallThickness;
        }

        this.renderer.render(doc.pitData, overlays);
    }

    // ── UI Updates ──

    _updateTreeInfo() {
        const doc = this.activeDoc;
        if (!doc || !doc.pitData) return;
        const m = doc.pitData.metadata;
        this._setText('infoSpecies', m.species || m.speciesLatin || 'N/A');
        this._setText('infoDate', m.date || 'N/A');
        this._setText('infoCircum', m.circumference ? `${m.circumference} mm` : 'N/A');
        this._setText('infoHeight', m.measurementHeight ? `${m.measurementHeight} cm` : 'N/A');
        this._setText('infoSensors', String(m.sensorCount || 12));
        this._setText('infoTreeNo', m.treeNumber || 'N/A');
    }

    _updateStrengthUI() {
        const doc = this.activeDoc;
        if (!doc || !doc.strengthResult) return;
        const r = doc.strengthResult;

        const gaugeEl = document.getElementById('strengthValue');
        if (gaugeEl) {
            gaugeEl.textContent = r.residualStrength;
            gaugeEl.className = `gauge-value ${r.assessment}`;
        }

        const badgeEl = document.getElementById('strengthBadge');
        if (badgeEl) {
            const labels = { safe: 'SAFE', warning: 'WARNING', critical: 'CRITICAL' };
            badgeEl.textContent = labels[r.assessment] || r.assessment;
            badgeEl.className = `badge badge-${r.assessment}`;
        }

        this._setText('metricEquivDiam', `${r.equivalentDiameter} cm`);
        this._setText('metricEquivPerim', `${r.equivalentPerimeter} cm`);
        this._setText('metricAxis', `${r.principalAxisAngle}°`);
        this._setText('metricMinWall', doc.wallThickness ? `${doc.wallThickness.minThickness.toFixed(1)} cm` : 'N/A');
    }

    _updateAreaUI() {
        const doc = this.activeDoc;
        if (!doc || !doc.zoneAreas) return;

        const zones = ['healthy', 'mild', 'moderate', 'severe', 'cavity'];
        const barEl = document.getElementById('areaBar');
        if (barEl) {
            barEl.innerHTML = zones.map(z => {
                const pct = doc.zoneAreas[z] || 0;
                if (pct < 1) return '';
                return `<div class="area-segment" style="flex:${pct};background:${ZONE_COLORS[z]}">${pct >= 5 ? pct.toFixed(0) + '%' : ''}</div>`;
            }).join('');
        }

        for (const z of zones) {
            const el = document.getElementById(`area-${z}`);
            if (el) el.textContent = `${(doc.zoneAreas[z] || 0).toFixed(1)}%`;
        }
    }

    _updateMetricsUI() {
        const doc = this.activeDoc;
        if (!doc || !doc.strengthResult) return;
        const r = doc.strengthResult;
        this._setText('metricTrunkArea', `${r.trunkArea} cm²`);
        this._setText('metricEffArea', `${r.effectiveAreaRatio}%`);
    }

    _onHover(pt, cx, cy) {
        const tooltip = document.getElementById('tooltip');
        if (!tooltip) return;

        if (!pt) {
            tooltip.style.display = 'none';
            return;
        }

        const doc = this.activeDoc;
        const zoneColor = ZONE_COLORS[pt.zone] || '#888';
        const zoneName = ZONE_LABELS[pt.zone] || pt.zone;
        const alpha = doc ? (doc.coefficients[pt.zone] ?? 0) : 0;

        tooltip.innerHTML = `
            <div><strong>x:</strong> ${pt.x.toFixed(1)} <strong>y:</strong> ${pt.y.toFixed(1)}</div>
            <div><span class="zone-dot" style="background:${zoneColor}"></span>${zoneName} (α=${alpha.toFixed(2)})</div>
            <div style="color:#999">RGB(${pt.r}, ${pt.g}, ${pt.b})</div>
        `;
        tooltip.style.display = 'block';
        tooltip.style.left = (cx + 15) + 'px';
        tooltip.style.top = (cy - 10) + 'px';
    }

    // ── Export ──

    _exportReport() {
        const doc = this.activeDoc;
        if (!doc || !doc.strengthResult) return;
        const imgUrl = this.renderer.exportPNG();
        const html = this.reporter.generate(
            doc.pitData, doc.strengthResult, doc.cavityResult,
            doc.zoneAreas, doc.wallThickness, doc.coefficients, imgUrl
        );
        this.reporter.openInNewWindow(html);
    }

    _exportPNG() {
        const url = this.renderer.exportPNG();
        const a = document.createElement('a');
        a.href = url;
        a.download = (this.activeDoc?.fileName || 'tomogram').replace('.pit', '') + '.png';
        a.click();
    }

    _exportCoefficients() {
        if (!this.activeDoc) return;
        this.reporter.exportCoefficients(this.activeDoc.coefficients);
    }

    async _importCoefficients(file) {
        const doc = this.activeDoc;
        if (!doc) return;
        try {
            const coeff = await this.reporter.importCoefficients(file);
            doc.coefficients = { ...DEFAULT_COEFFICIENTS, ...coeff };
            this.calculator.setCoefficients(doc.coefficients);
            this._syncSliders(doc);
            if (doc.classifiedPoints) this._recompute();
        } catch (err) {
            alert('Error importing coefficients: ' + err.message);
        }
    }

    _showCalculation() {
        const doc = this.activeDoc;
        if (!doc || !doc.strengthResult) return;

        const r = doc.strengthResult;
        const c = r.coefficientsUsed;
        const zones = ['healthy', 'mild', 'moderate', 'severe', 'cavity'];
        const za = doc.zoneAreas || {};

        const html = `
        <div class="calc-step">
            <div class="calc-step-title">Step 1 — Input Data</div>
            <table class="calc-table">
                <tr><td>Total inside points (N)</td><td>${r.pointCount}</td></tr>
                <tr><td>Cross-section area (A<sub>trunk</sub>)</td><td>${r.trunkArea} cm²</td></tr>
                <tr><td>Equivalent trunk diameter</td><td>${r.trunkDiameter} cm</td></tr>
            </table>
        </div>

        <div class="calc-step">
            <div class="calc-step-title">Step 2 — Decay Coefficients (α)</div>
            <table class="calc-table">
                <tr><th>Zone</th><th>α</th><th>Area %</th></tr>
                ${zones.map(z => `<tr><td>${z}</td><td>${c[z].toFixed(2)}</td><td>${(za[z] || 0).toFixed(1)}%</td></tr>`).join('')}
            </table>
        </div>

        <div class="calc-step">
            <div class="calc-step-title">Step 3 — Element Area (dA)</div>
            <div>Each grid point represents an equal portion of the trunk area:</div>
            <div class="calc-formula">dA = A_trunk / N = ${r.trunkArea} / ${r.pointCount} = ${r.dA.toFixed(4)} cm²</div>
        </div>

        <div class="calc-step">
            <div class="calc-step-title">Step 4 — Intact Reference (all α = 1)</div>
            <div>Compute moment of inertia as if the entire section were intact:</div>
            <div class="calc-formula">I_intact = Σ (yᵢ − ȳ)² × dA</div>
            <div>Then find the principal (minimum) axis and the maximum distance y<sub>max</sub> from centroid to the outline.</div>
            <div class="calc-formula">W_intact = I_min,intact / y_max,intact = <span class="calc-result">${r.W_intact} cm³</span></div>
        </div>

        <div class="calc-step">
            <div class="calc-step-title">Step 5 — Weighted Centroid</div>
            <div>The centroid shifts toward regions with higher α:</div>
            <div class="calc-formula">c̄ₓ = Σ(αᵢ × xᵢ × dA) / Σ(αᵢ × dA)</div>
            <div class="calc-formula">c̄ᵧ = Σ(αᵢ × yᵢ × dA) / Σ(αᵢ × dA)</div>
            <div>Weighted centroid: <span class="calc-result">(${r.weightedCentroid.x}, ${r.weightedCentroid.y})</span></div>
            <div>Effective area Σ(αᵢ × dA) = <span class="calc-result">${r.weightedArea} cm²</span>
                (${r.effectiveAreaRatio}% of total)</div>
        </div>

        <div class="calc-step">
            <div class="calc-step-title">Step 6 — Weighted Moments of Inertia</div>
            <div>About the weighted centroid, each point contributes proportionally to its α:</div>
            <div class="calc-formula">Iₓ = Σ αᵢ × (yᵢ − c̄ᵧ)² × dA = <span class="calc-result">${r.Ix} cm⁴</span></div>
            <div class="calc-formula">Iᵧ = Σ αᵢ × (xᵢ − c̄ₓ)² × dA = <span class="calc-result">${r.Iy} cm⁴</span></div>
        </div>

        <div class="calc-step">
            <div class="calc-step-title">Step 7 — Principal Axes</div>
            <div class="calc-formula">θ = ½ × atan2(−2Iₓᵧ, Iₓ − Iᵧ) = <span class="calc-result">${r.principalAxisAngle}°</span></div>
            <div class="calc-formula">I_min = (Iₓ+Iᵧ)/2 − √(((Iₓ−Iᵧ)/2)² + Iₓᵧ²) = <span class="calc-result">${r.I_min} cm⁴</span></div>
            <div class="calc-formula">I_max = (Iₓ+Iᵧ)/2 + √(...) = <span class="calc-result">${r.I_max} cm⁴</span></div>
        </div>

        <div class="calc-step">
            <div class="calc-step-title">Step 8 — Section Modulus</div>
            <div>y<sub>max</sub> = max perpendicular distance from weighted centroid to trunk outline along the weak axis</div>
            <div class="calc-formula">W_eff = I_min / y_max = <span class="calc-result">${r.W_effective} cm³</span></div>
        </div>

        <div class="calc-step">
            <div class="calc-step-title">Step 9 — Residual Strength</div>
            <div class="calc-formula">Residual = W_eff / W_intact × 100%</div>
            <div class="calc-formula">= ${r.W_effective} / ${r.W_intact} × 100%</div>
            <div class="calc-highlight ${r.assessment === 'critical' ? 'critical' : ''}">
                <div style="font-size:24px;font-weight:700">${r.residualStrength}%</div>
                <div style="font-size:11px;margin-top:4px">${r.assessmentDetails}</div>
                <div style="font-size:10px;color:var(--text-muted);margin-top:4px">
                    Threshold: ≥67% (≤1/3 loss) = Acceptable
                </div>
            </div>
        </div>

        <div class="calc-step">
            <div class="calc-step-title">Step 10 — Equivalent Section</div>
            <div>Solid circle with the same bending resistance as W_eff:</div>
            <div class="calc-formula">D_eq = ∛(32 × W_eff / π) = <span class="calc-result">${r.equivalentDiameter} cm</span></div>
            <div class="calc-formula">Perimeter = π × D_eq = <span class="calc-result">${r.equivalentPerimeter} cm</span></div>
        </div>
        `;

        document.getElementById('calcModalBody').innerHTML = html;
        document.getElementById('calcModal').style.display = 'flex';
    }

    _setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }
}

window.addEventListener('DOMContentLoaded', () => new App());
