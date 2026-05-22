/**
 * Picus 3 PIT File Parser
 * 
 * Parses the INI-style PIT file format produced by the Picus 3 Sonic Tomograph.
 * Extracts sensor positions, time-of-flight data, and pre-computed tomography grid.
 * 
 * PIT File Structure:
 *   [Comments]   - Tree metadata (species, location, date, etc.)
 *   [Main]       - Sensor count, measurement config
 *   [BPoints]    - Boundary/sensor positions (x/y in cm)
 *   [MPoints]    - Measurement point positions
 *   [ZBPoints]   - Z-heights for boundary points
 *   [ZMPoints]   - Z-heights for measurement points
 *   [NagelBorke] - Nail/bark thickness corrections
 *   [TreeSA]     - Static assessment parameters
 *   [oLink1..N]  - Time-of-flight data per sensor
 *   [Lines]      - Pre-computed tomography grid (x/y/colorARGB triplets)
 *   [Diagnoses]  - Diagnostic annotations
 */

/**
 * Decode a packed ARGB integer (stored as negative int in PIT files) to RGB.
 * PIT stores colors as negative 32-bit signed integers representing ARGB.
 * @param {number} value - Negative integer color value
 * @returns {{ r: number, g: number, b: number, a: number }}
 */
export function decodeARGB(value) {
    // Convert signed 32-bit to unsigned
    const uint = value < 0 ? (value + 0x100000000) : value;
    const a = (uint >>> 24) & 0xFF;
    const r = (uint >>> 16) & 0xFF;
    const g = (uint >>> 8) & 0xFF;
    const b = uint & 0xFF;
    return { r, g, b, a };
}

/**
 * Parse a PIT file string into structured data.
 * @param {string} text - Raw PIT file content
 * @returns {Object} Parsed PIT data structure
 */
export function parsePIT(text) {
    const sections = parseINI(text);

    const metadata = parseMetadata(sections);
    const mainConfig = parseMainConfig(sections);
    const sensors = parseSensorPositions(sections, mainConfig.sensorCount);
    const tofData = parseTOFData(sections, mainConfig.sensorCount);
    const tomoGrid = parseTomoGrid(sections);

    // Compute grid bounds
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pt of tomoGrid) {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
    }

    return {
        metadata: {
            ...metadata,
            ...mainConfig,
        },
        sensors,
        tofData,
        tomoGrid,
        gridBounds: { minX, maxX, minY, maxY },
        raw: sections,
    };
}

// ──────────────────────────────────────────────
// INI Parser
// ──────────────────────────────────────────────

/**
 * Parse INI-style text into sections.
 * @param {string} text
 * @returns {Object<string, Object<string, string>>}
 */
function parseINI(text) {
    const sections = {};
    let currentSection = null;

    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Section header
        const sectionMatch = trimmed.match(/^\[(.+)\]$/);
        if (sectionMatch) {
            currentSection = sectionMatch[1];
            if (!sections[currentSection]) {
                sections[currentSection] = {};
            }
            continue;
        }

        // Key=Value pair
        if (currentSection) {
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx !== -1) {
                const key = trimmed.substring(0, eqIdx);
                const value = trimmed.substring(eqIdx + 1);
                sections[currentSection][key] = value;
            }
        }
    }

    return sections;
}

// ──────────────────────────────────────────────
// Metadata Parser
// ──────────────────────────────────────────────

/**
 * Extract tree metadata from [Comments] section.
 */
function parseMetadata(sections) {
    const c = sections['Comments'] || {};
    return {
        location1: c['ort1'] || '',
        location2: c['ort2'] || '',
        location3: c['ort3'] || '',
        location4: c['ort4'] || '',
        treeNumber: c['Baumnr'] || '0',
        formNumber: c['Formular'] || '',
        species: c['Baumart'] || '',
        speciesLatin: c['BaumartLatein'] || '',
        date: c['Zeit'] || '',
        trunkCircumferenceHeight: parseFloat(c['StammUHoehe']) || 0,
        trunkCircumference: c['StammU'] || '',
        treeHeight: c['Baumhoehe'] || '',
        crownDiameter: c['KronenD'] || '',
        longitude: c['Longitude'] || '',
        latitude: c['Latitude'] || '',
        crownBaseHeight: c['KronenansatzHoehe'] || '',
        treeAge: c['Baumalter'] || '',
        vitalityRoloff: parseInt(c['VitalitaetRoloff']) || 0,
        leanDirection: c['Neigungsrichtung'] || '',
        leanAngle: parseFloat(c['Neigungswinkel']) || 0,
        barkThickness: parseFloat(c['Rindendicke']) || 0,
        terrain: parseInt(c['Terrain']) || 0,
        crownShape: parseInt(c['Kronenform']) || 0,
        trunkDiameter: parseFloat(c['StammD']) || 0,
        operator: c['Bearbeiter1'] || '',
        comments: c['allg_kommentare1'] || '',
        client: c['auftraggeber1'] || '',
    };
}

// ──────────────────────────────────────────────
// Main Config Parser
// ──────────────────────────────────────────────

/**
 * Extract main configuration from [Main] section.
 */
function parseMainConfig(sections) {
    const m = sections['Main'] || {};
    return {
        sensorCount: parseInt(m['Sensoranzahl']) || 12,
        miniSensorCount: parseInt(m['MiniSensorenanzahl']) || 12,
        tappingMethod: parseInt(m['KlopfMethode']) || 0,
        hammerType: parseInt(m['Hammer']) || 0,
        modulGain: parseInt(m['ModulVerstaerkung']) || 0,
        envelopeSamples: parseInt(m['SampleanzahlHuellkurve']) || 30,
        largerDiameter: parseFloat(m['gr_dm']) || 0,
        smallerDiameter: parseFloat(m['kl_dm']) || 0,
        measurePointSpacing: parseFloat(m['messPunktAbstand']) || 0,
        circumference: parseFloat(m['u']) || 0, // mm
        northSensor: parseInt(m['Norden']) || 1,
        northPosition: m['Pos1'] || 'N',
        measurementHeight: parseFloat(m['Hoehe']) || 0, // cm
        mainWindDirection: parseInt(m['Hauptwindrichtung']) || 1,
        // Diagnosis flags (-1 = not diagnosed)
        diagHomogeneous: parseInt(m['KDhomogen']) || -1,
        diagCavity: parseInt(m['KDLoch']) || -1,
        diagCrack: parseInt(m['KDRiss']) || -1,
        diagCore: parseInt(m['KDKern']) || -1,
        diagDecay: parseInt(m['KDFaul']) || -1,
        diagFungus: parseInt(m['KDPilz']) || -1,
    };
}

// ──────────────────────────────────────────────
// Sensor Position Parser
// ──────────────────────────────────────────────

/**
 * Parse sensor positions from [BPoints] and [MPoints].
 * @returns {Array<{id: number, x: number, y: number}>}
 */
function parseSensorPositions(sections, sensorCount) {
    const bpoints = sections['BPoints'] || {};
    const mpoints = sections['MPoints'] || {};
    const zbpoints = sections['ZBPoints'] || {};

    const sensors = [];
    for (let i = 1; i <= sensorCount; i++) {
        const bp = bpoints[String(i)];
        const mp = mpoints[String(i)];
        const zb = zbpoints[String(i)];

        let x = 0, y = 0, z = 0;
        if (bp) {
            const parts = bp.split('/');
            x = parseFloat(parts[0]) || 0;
            y = parseFloat(parts[1]) || 0;
        }
        if (zb) {
            z = parseFloat(zb) || 0;
        }

        sensors.push({
            id: i,
            x, y, z,
            // Also store measurement point if different
            mx: mp ? parseFloat(mp.split('/')[0]) || x : x,
            my: mp ? parseFloat(mp.split('/')[1]) || y : y,
        });
    }

    return sensors;
}

// ──────────────────────────────────────────────
// Time-of-Flight Data Parser
// ──────────────────────────────────────────────

/**
 * Parse time-of-flight data from [oLink1] through [oLinkN].
 * Each section contains transit times from sensor N to all other sensors.
 * Line 0 = number of repetitions per measurement.
 * @returns {Object} { links: Map, repetitions: number, velocityMatrix: number[][] }
 */
function parseTOFData(sections, sensorCount) {
    const links = {};
    let repetitions = 3; // default

    for (let src = 1; src <= sensorCount; src++) {
        const section = sections[`oLink${src}`];
        if (!section) continue;

        links[src] = {};

        // Line 0 = number of repetitions
        if (section['0']) {
            repetitions = parseInt(section['0']) || 3;
        }

        // Parse timing data to each target sensor
        for (let tgt = 1; tgt <= sensorCount; tgt++) {
            if (tgt === src) continue;
            const line = section[String(tgt)];
            if (!line) continue;

            const parts = line.split('/');
            const times = [];
            for (let i = 0; i < repetitions && i < parts.length; i++) {
                const t = parseFloat(parts[i]);
                if (!isNaN(t) && t > 0) {
                    times.push(t);
                }
            }
            if (times.length > 0) {
                links[src][tgt] = {
                    times, // individual measurements in μs
                    avgTime: times.reduce((a, b) => a + b, 0) / times.length,
                };
            }
        }
    }

    return { links, repetitions };
}

// ──────────────────────────────────────────────
// Tomography Grid Parser
// ──────────────────────────────────────────────

/**
 * Parse the pre-computed tomography grid from [Lines] section.
 * 
 * The [Lines] section contains grid data as numbered lines.
 * Each data line has format: lineIdx=x1/y1/color1/x2/y2/color2/...
 * where color is a negative ARGB integer.
 * 
 * The data spans multiple passes (typically 3-4) at different grid offsets.
 * Empty lines (e.g., "47=") separate passes and represent rows outside the trunk.
 * 
 * @returns {Array<{x: number, y: number, r: number, g: number, b: number, a: number, colorRaw: number}>}
 */
function parseTomoGrid(sections) {
    const linesSection = sections['Lines'] || {};
    const dataCount = parseInt(linesSection['MessDatenAnzahl']) || 0;
    const points = [];

    for (let i = 1; i <= dataCount; i++) {
        const line = linesSection[String(i)];
        if (!line || line.trim() === '') continue;

        const parts = line.split('/');
        // Parse triplets: x, y, color
        for (let j = 0; j + 2 < parts.length; j += 3) {
            const x = parseFloat(parts[j]);
            const y = parseFloat(parts[j + 1]);
            const colorRaw = parseInt(parts[j + 2]);

            if (isNaN(x) || isNaN(y) || isNaN(colorRaw)) continue;

            const { r, g, b, a } = decodeARGB(colorRaw);

            points.push({
                x, y,
                r, g, b, a,
                colorRaw,
            });
        }
    }

    return points;
}

/**
 * Compute the velocity matrix from TOF data and sensor positions.
 * velocity = distance / time
 * 
 * @param {Object} tofData - Parsed TOF data
 * @param {Array} sensors - Sensor positions
 * @returns {{ matrix: number[][], maxVelocity: number, relativeMatrix: number[][] }}
 */
export function computeVelocityMatrix(tofData, sensors) {
    const n = sensors.length;
    const matrix = Array.from({ length: n }, () => Array(n).fill(0));
    let maxVelocity = 0;

    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            if (i === j) continue;

            const srcId = sensors[i].id;
            const tgtId = sensors[j].id;

            const linkData = tofData.links[srcId]?.[tgtId];
            if (!linkData) continue;

            // Distance between sensors in cm
            const dx = sensors[j].x - sensors[i].x;
            const dy = sensors[j].y - sensors[i].y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            // Time in μs → convert to seconds for m/s, but we'll keep in cm/μs then convert
            // distance in cm, time in μs
            // velocity = distance_cm / time_μs = cm/μs
            // To convert to m/s: multiply by 10000
            const velocity = distance / linkData.avgTime; // cm/μs
            const velocityMS = velocity * 10000; // m/s

            matrix[i][j] = velocityMS;
            if (velocityMS > maxVelocity) {
                maxVelocity = velocityMS;
            }
        }
    }

    // Compute relative velocity matrix (percentage of max)
    const relativeMatrix = matrix.map(row =>
        row.map(v => maxVelocity > 0 ? (v / maxVelocity) * 100 : 0)
    );

    return { matrix, maxVelocity, relativeMatrix };
}

/**
 * Load and parse a PIT file from a File object (drag-and-drop or file input).
 * @param {File} file - The PIT file
 * @returns {Promise<Object>} Parsed PIT data
 */
export async function loadPITFile(file) {
    const text = await file.text();
    return parsePIT(text);
}
