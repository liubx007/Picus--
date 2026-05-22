# Picus Tomography Analyzer

Acoustic tomography analysis tool for Picus 3 PIT files.  
Evaluate cavity size, position, cross-section residual strength, and 3D visualization.

## Features

- **PIT File Parsing** — Load Picus 3 `.pit` files with full metadata extraction
- **2D Tomography Rendering** — Color-coded cross-section visualization with sensor overlay
- **Cavity Detection** — Automatic classification of decay zones (healthy/mild/moderate/severe/cavity)
- **Residual Strength Calculation** — Weighted moment of inertia approach with configurable decay coefficients
- **1/3 Rule Assessment** — Industry-standard threshold (≥67% = safe, <67% = critical)
- **3D Stacking** — Stack multiple heights with continuous interpolation and pie-slice clipping
- **Multi-Document Tabs** — Open and compare multiple PIT files simultaneously
- **Report Export** — Generate printable HTML reports with full analysis data

## Usage

Serve the `src/` directory with any HTTP server:

```bash
cd src
python -m http.server 8080
```

Open `http://localhost:8080` and drag-drop `.pit` files.

## Tech Stack

- Vanilla HTML/CSS/JS (ES modules)
- Three.js (CDN) for 3D rendering
- Apple-inspired frosted glass UI
