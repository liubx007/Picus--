import os
import sys
import io
import re
import math
import glob
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as patches
import matplotlib.colors as mcolors
from scipy import interpolate

# Force stdout and stderr to use UTF-8 to prevent encoding errors in Windows terminal
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# Support Chinese characters in Matplotlib on Windows
plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei', 'Arial', 'sans-serif']
plt.rcParams['axes.unicode_minus'] = False

# Color Zone Constants
ZONE_HEALTHY = 'healthy'
ZONE_MILD = 'mild'
ZONE_MODERATE = 'moderate'
ZONE_SEVERE = 'severe'
ZONE_CAVITY = 'cavity'

ZONE_COLORS = {
    'healthy':  '#92702a',
    'mild':     '#b8900b',
    'moderate': '#34a76e',
    'severe':   '#a855f7',
    'cavity':   '#3b82f6'
}

ZONE_LABELS = {
    'healthy':  'Healthy',
    'mild':     'Mild',
    'moderate': 'Moderate',
    'severe':   'Severe',
    'cavity':   'Cavity'
}

DEFAULT_COEFFICIENTS = {
    'healthy':  1.00,
    'mild':     0.85,
    'moderate': 0.50,
    'severe':   0.20,
    'cavity':   0.05,
}

def decode_argb(value):
    """
    Decode a packed ARGB integer (stored as negative int in PIT files) to RGB.
    """
    uint_val = int(value) & 0xFFFFFFFF
    r = (uint_val >> 16) & 0xFF
    g = (uint_val >> 8) & 0xFF
    b = uint_val & 0xFF
    return r, g, b

def rgb_to_hsl(r, g, b):
    """
    Convert RGB to HSL. r, g, b in [0, 255].
    h in [0, 360], s, l in [0, 100].
    """
    r_pct = r / 255.0
    g_pct = g / 255.0
    b_pct = b / 255.0
    mx = max(r_pct, g_pct, b_pct)
    mn = min(r_pct, g_pct, b_pct)
    l = (mx + mn) / 2.0
    h = 0.0
    s = 0.0

    if mx != mn:
        d = mx - mn
        s = d / (2.0 - mx - mn) if l > 0.5 else d / (mx + mn)
        if mx == r_pct:
            h = (g_pct - b_pct) / d + (6.0 if g_pct < b_pct else 0.0)
        elif mx == g_pct:
            h = (b_pct - r_pct) / d + 2.0
        elif mx == b_pct:
            h = (r_pct - g_pct) / d + 4.0
        h /= 6.0

    return round(h * 360), round(s * 100), round(l * 100)

def classify_point(r, g, b):
    """
    Classify a grid point into a decay zone based on HSL color.
    """
    h, s, l = rgb_to_hsl(r, g, b)
    
    # Very dark = solid wood (black in Picus = max velocity)
    if l < 12:
        zone = ZONE_HEALTHY
    # Very light or near-white = cavity / void
    elif l > 82 and s < 30:
        zone = ZONE_CAVITY
    # Brown range: hue roughly 0-55°, warm tones
    elif (h <= 55 or h >= 340) and s > 12 and l < 55:
        zone = ZONE_HEALTHY if l < 35 else ZONE_MILD
    # Green range: hue 56-170°
    elif 55 < h <= 170:
        zone = ZONE_MODERATE
    # Blue range: hue 171-260°
    elif 170 < h <= 260:
        zone = ZONE_CAVITY
    # Purple/Magenta: hue 261-339°
    elif 260 < h < 340:
        zone = ZONE_SEVERE
    # Fallback: use lightness
    elif l > 65:
        zone = ZONE_CAVITY
    elif l > 45:
        zone = ZONE_MILD
    else:
        zone = ZONE_HEALTHY
        
    return zone, h, s, l

def parse_ini(text):
    """
    Parse custom INI format with line-by-line decoding.
    """
    sections = {}
    current_section = None
    for line in text.splitlines():
        trimmed = line.strip()
        if not trimmed:
            continue
        if trimmed.startswith('[') and trimmed.endswith(']'):
            current_section = trimmed[1:-1]
            if current_section not in sections:
                sections[current_section] = {}
            continue
        if current_section is not None:
            eq_idx = trimmed.find('=')
            if eq_idx != -1:
                key = trimmed[:eq_idx].strip()
                value = trimmed[eq_idx+1:].strip()
                sections[current_section][key] = value
    return sections

def parse_pit_file(filepath):
    """
    Parse a PIT file and extract metadata, sensors, and tomography grid.
    """
    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        text = f.read()
    
    sections = parse_ini(text)
    
    # Metadata
    comments = sections.get('Comments', {})
    main_cfg = sections.get('Main', {})
    
    metadata = {
        'species': comments.get('Baumart', 'Unknown'),
        'date': comments.get('Zeit', 'Unknown'),
        'sensor_count': int(main_cfg.get('Sensoranzahl', 12)),
        'north_sensor': int(main_cfg.get('Norden', 1)),
        'circumference': float(main_cfg.get('u', 0)) / 10.0,  # mm -> cm
        'measurement_height': float(main_cfg.get('Hoehe', 0)) # cm
    }
    
    # Sensor positions
    bpoints = sections.get('BPoints', {})
    sensors = []
    for i in range(1, metadata['sensor_count'] + 1):
        bp = bpoints.get(str(i), '')
        x, y = 0.0, 0.0
        if bp:
            parts = bp.split('/')
            if len(parts) >= 2:
                try:
                    x = float(parts[0])
                    y = float(parts[1])
                except ValueError:
                    pass
        sensors.append({'id': i, 'x': x, 'y': y})
        
    # Grid points
    lines_section = sections.get('Lines', {})
    data_count = 0
    try:
        data_count = int(lines_section.get('MessDatenAnzahl', '0'))
    except ValueError:
        pass
        
    grid_points = []
    for i in range(1, data_count + 1):
        line = lines_section.get(str(i), '')
        if not line:
            continue
        parts = line.split('/')
        for j in range(0, len(parts) - 2, 3):
            try:
                x = float(parts[j])
                y = float(parts[j+1])
                color_raw = int(parts[j+2])
                r, g, b = decode_argb(color_raw)
                zone, h, s, l = classify_point(r, g, b)
                grid_points.append({
                    'x': x, 'y': y,
                    'r': r, 'g': g, 'b': b,
                    'zone': zone
                })
            except ValueError:
                continue
                
    return metadata, sensors, grid_points

def point_in_polygon(x, y, poly):
    """
    Ray casting algorithm to determine if a point is inside a polygon.
    """
    inside = False
    n = len(poly)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

def polygon_area(poly):
    """
    Shoelace formula for polygon area.
    """
    n = len(poly)
    if n < 3:
        return 0.0
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += poly[i][0] * poly[j][1]
        area -= poly[j][0] * poly[i][1]
    return abs(area) / 2.0

def max_dist_to_outline(cx, cy, theta, outline):
    """
    Compute max perpendicular distance from centroid to outline along direction theta.
    """
    max_dist = 0.0
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)
    
    # Check vertices
    for pt in outline:
        dx = pt[0] - cx
        dy = pt[1] - cy
        perp_dist = abs(dx * sin_t - dy * cos_t)
        if perp_dist > max_dist:
            max_dist = perp_dist
            
    # Check intermediate points along outline edges (same as JS)
    n = len(outline)
    for i in range(n):
        j = (i + 1) % n
        p1 = outline[i]
        p2 = outline[j]
        for step in range(1, 10):
            t = step / 10.0
            px = p1[0] + t * (p2[0] - p1[0])
            py = p1[1] + t * (p2[1] - p1[1])
            dx = px - cx
            dy = py - cy
            perp_dist = abs(dx * sin_t - dy * cos_t)
            if perp_dist > max_dist:
                max_dist = perp_dist
                
    return max_dist

def compute_strength(grid_points, sensors, coefficients=DEFAULT_COEFFICIENTS):
    """
    Compute weighted residual strength based on moments of inertia.
    """
    outline = [(s['x'], s['y']) for s in sensors]
    inside_points = [pt for pt in grid_points if point_in_polygon(pt['x'], pt['y'], outline)]
    
    if len(inside_points) < 10:
        return {
            'residual_strength': 0.0,
            'equivalent_diameter': 0.0,
            'equivalent_perimeter': 0.0,
            'principal_axis_angle': 0.0,
            'weighted_centroid': {'x': 0.0, 'y': 0.0},
            'I_min': 0.0, 'I_max': 0.0,
            'W_effective': 0.0, 'W_intact': 0.0,
            'trunk_area': 0.0, 'trunk_diameter': 0.0,
            'point_count': 0,
            'assessment': 'critical',
            'zone_pcts': {'healthy': 0.0, 'mild': 0.0, 'moderate': 0.0, 'severe': 0.0, 'cavity': 0.0}
        }
        
    trunk_area = polygon_area(outline)
    dA = trunk_area / len(inside_points)
    n = len(inside_points)
    
    # 1. Compute INTACT reference numerically (same points, all alpha = 1.0)
    intact_sum_x = sum(pt['x'] for pt in inside_points)
    intact_sum_y = sum(pt['y'] for pt in inside_points)
    intact_cx = intact_sum_x / n
    intact_cy = intact_sum_y / n
    
    intact_Ix = 0.0
    intact_Iy = 0.0
    intact_Ixy = 0.0
    for pt in inside_points:
        dx = pt['x'] - intact_cx
        dy = pt['y'] - intact_cy
        intact_Ix += dy * dy * dA
        intact_Iy += dx * dx * dA
        intact_Ixy += dx * dy * dA
        
    intact_avg_I = (intact_Ix + intact_Iy) / 2.0
    intact_diff_I = math.sqrt(((intact_Ix - intact_Iy) / 2.0)**2 + intact_Ixy**2)
    intact_I_min = intact_avg_I - intact_diff_I
    intact_theta = 0.5 * math.atan2(-2 * intact_Ixy, intact_Ix - intact_Iy)
    intact_y_max = max_dist_to_outline(intact_cx, intact_cy, intact_theta, outline)
    W_intact = intact_I_min / intact_y_max if intact_y_max > 0.0 else 1.0
    
    # 2. Compute weighted centroid
    sum_alpha = 0.0
    sum_ax = 0.0
    sum_ay = 0.0
    alpha_points = []
    for pt in inside_points:
        alpha = coefficients.get(pt['zone'], 0.5)
        w = alpha * dA
        sum_alpha += w
        sum_ax += w * pt['x']
        sum_ay += w * pt['y']
        alpha_points.append({**pt, 'alpha': alpha})
        
    if sum_alpha == 0.0:
        return {'residual_strength': 0.0}
        
    cx = sum_ax / sum_alpha
    cy = sum_ay / sum_alpha
    
    # 3. Compute weighted moments of inertia
    Ix = 0.0
    Iy = 0.0
    Ixy = 0.0
    for pt in alpha_points:
        dx = pt['x'] - cx
        dy = pt['y'] - cy
        w = pt['alpha'] * dA
        Ix += w * dy * dy
        Iy += w * dx * dx
        Ixy += w * dx * dy
        
    # 4. Principal axes (weighted)
    theta = 0.5 * math.atan2(-2 * Ixy, Ix - Iy)
    avg_I = (Ix + Iy) / 2.0
    diff_I = math.sqrt(((Ix - Iy) / 2.0)**2 + Ixy**2)
    I_min = avg_I - diff_I
    I_max = avg_I + diff_I
    
    # 5. Section modulus (weighted)
    y_max = max_dist_to_outline(cx, cy, theta, outline)
    W_effective = I_min / y_max if y_max > 0.0 else 0.0
    
    # 6. Residual strength ratio
    residual_strength = (W_effective / W_intact) * 100.0 if W_intact > 0.0 else 0.0
    residual_strength = min(residual_strength, 100.0)
    
    # 7. Equivalent properties
    D_eq = math.pow((32.0 * W_effective) / math.pi, 1.0/3.0) if W_effective > 0.0 else 0.0
    equivalent_perimeter = math.pi * D_eq
    
    R_equiv = math.sqrt(trunk_area / math.pi)
    D_equiv = 2 * R_equiv
    
    # Assessment (1/3 rule)
    assessment = 'safe' if residual_strength >= 67.0 else 'critical'
    
    # Zone area percentages
    zone_counts = {'healthy': 0, 'mild': 0, 'moderate': 0, 'severe': 0, 'cavity': 0}
    for pt in inside_points:
        zone_counts[pt['zone']] += 1
        
    zone_pcts = {}
    for zone, count in zone_counts.items():
        zone_pcts[zone] = (count / n) * 100.0 if n > 0 else 0.0
        
    return {
        'residual_strength': round(residual_strength, 1),
        'equivalent_diameter': round(D_eq, 1),
        'equivalent_perimeter': round(equivalent_perimeter, 1),
        'principal_axis_angle': round((math.degrees(theta) + 360) % 180, 1),
        'weighted_centroid': {'x': round(cx, 2), 'y': round(cy, 2)},
        'I_min': round(I_min, 2),
        'I_max': round(I_max, 2),
        'W_effective': round(W_effective, 2),
        'W_intact': round(W_intact, 2),
        'trunk_area': round(trunk_area, 1),
        'trunk_diameter': round(D_equiv, 1),
        'point_count': n,
        'assessment': assessment,
        'zone_pcts': zone_pcts
    }

def parse_filename_info(filepath):
    """
    Parse metadata from the filename according to the user's rules:
    e.g., 091201 (10cm).pit -> Sample 08, 12 sensors, replicate 1, depth 10cm.
    """
    basename = os.path.basename(filepath)
    # Match XXYYZZ (Hcm) or XXYYZZ（Hcm)
    match = re.match(r"^(\d{2})(\d{2})(\d{2})\s*[（(](\d+cm)[）)]\.pit$", basename, re.IGNORECASE)
    if match:
        xx, yy, zz, height = match.groups()
        sample_no = int(xx) - 1
        sensor_count = int(yy)
        replicate = int(zz)
        return {
            'sample_no': sample_no,
            'sensor_count': sensor_count,
            'replicate': replicate,
            'height': height,
            'valid': True
        }
    return {
        'sample_no': 0,
        'sensor_count': 12,
        'replicate': 1,
        'height': 'Unknown',
        'valid': False
    }

def compute_wall_thickness(grid_points, sensors):
    """
    Compute wall thickness in all directions.
    Casts rays from trunk center outward every 10°.
    Wall thickness = distance from trunk edge inward to first damaged zone.
    """
    outline = [(s['x'], s['y']) for s in sensors]
    cx = sum(p[0] for p in outline) / len(outline)
    cy = sum(p[1] for p in outline) / len(outline)
    
    # Grid cell lookup optimization (similar to JS grid map)
    cell_size = 0.5
    point_map = {}
    for pt in grid_points:
        gx = int(round(pt['x'] / cell_size))
        gy = int(round(pt['y'] / cell_size))
        key = (gx, gy)
        if key not in point_map:
            point_map[key] = []
        point_map[key].append(pt)
        
    thickness_profile = []
    min_thickness = float('inf')
    max_thickness = 0.0
    
    damaged_zones = {'severe', 'cavity'}
    
    for angle in range(0, 360, 10):
        rad = math.radians(angle)
        dx = math.cos(rad)
        dy = math.sin(rad)
        
        # Find intersection with trunk outline (approximate: walk outward from center)
        trunk_radius = 0.0
        for r_step in np.arange(0, 100, 0.3):
            px = cx + dx * r_step
            py = cy + dy * r_step
            if not point_in_polygon(px, py, outline):
                trunk_radius = r_step
                break
                
        # Walk inward from trunk edge, find where healthy wood ends
        wall_thickness = 0.0
        for r_step in np.arange(trunk_radius, 0, -0.3):
            px = cx + dx * r_step
            py = cy + dy * r_step
            
            # Find nearest classified point
            gx = int(round(px / cell_size))
            gy = int(round(py / cell_size))
            nearest_zone = None
            nearest_dist = float('inf')
            
            # Look in 3x3 neighborhood
            for dgy in [-1, 0, 1]:
                for dgx in [-1, 0, 1]:
                    key = (gx + dgx, gy + dgy)
                    pts = point_map.get(key, [])
                    for p in pts:
                        d = (p['x'] - px) ** 2 + (p['y'] - py) ** 2
                        if d < nearest_dist:
                            nearest_dist = d
                            nearest_zone = p['zone']
                            
            if nearest_zone and nearest_zone in damaged_zones:
                wall_thickness = trunk_radius - r_step
                break
                
        if wall_thickness == 0.0:
            wall_thickness = trunk_radius
            
        thickness_profile.append({'angle': angle, 'thickness': wall_thickness, 'trunk_radius': trunk_radius})
        if wall_thickness < min_thickness:
            min_thickness = wall_thickness
        if wall_thickness > max_thickness:
            max_thickness = wall_thickness
            
    avg_thickness = sum(t['thickness'] for t in thickness_profile) / len(thickness_profile)
    return {
        'min_thickness': round(min_thickness, 1) if min_thickness != float('inf') else 0.0,
        'max_thickness': round(max_thickness, 1),
        'avg_thickness': round(avg_thickness, 1),
        'thickness_profile': thickness_profile,
        'center': {'x': cx, 'y': cy}
    }

def detect_cavities_py(grid_points, sensors, cell_size=0.5):
    """
    Detect contiguous cavity regions using flood-fill on a rasterized grid.
    Matches the JavaScript CavityDetector.detectCavities algorithm.
    """
    outline = [(s['x'], s['y']) for s in sensors]
    xs = [s['x'] for s in sensors]
    ys = [s['y'] for s in sensors]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    
    # Define grid coordinates
    grid_x = np.arange(min_x - 2, max_x + 2, cell_size)
    grid_y = np.arange(min_y - 2, max_y + 2, cell_size)
    nx, ny = len(grid_x), len(grid_y)
    
    # Create 2D array for labeling
    # 0 = not cavity, 1 = cavity/severe
    binary_grid = np.zeros((ny, nx), dtype=int)
    
    # Build spatial index of grid points
    point_map = {}
    for pt in grid_points:
        gx = int(round(pt['x'] / cell_size))
        gy = int(round(pt['y'] / cell_size))
        point_map[(gx, gy)] = pt
        
    for j, y_val in enumerate(grid_y):
        for i, x_val in enumerate(grid_x):
            if point_in_polygon(x_val, y_val, outline):
                # Find nearest grid point
                gx = int(round(x_val / cell_size))
                gy = int(round(y_val / cell_size))
                pt = point_map.get((gx, gy))
                if pt and pt['zone'] in ['severe', 'cavity']:
                    binary_grid[j, i] = 1
                    
    # Label components using basic flood fill / BFS (8-connectivity)
    visited = np.zeros_like(binary_grid, dtype=bool)
    regions = []
    region_id = 1
    
    dirs = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]
    
    for j in range(ny):
        for i in range(nx):
            if binary_grid[j, i] == 1 and not visited[j, i]:
                queue = [(j, i)]
                visited[j, i] = True
                cells = []
                
                while queue:
                    curr_j, curr_i = queue.pop(0)
                    cells.append((grid_x[curr_i], grid_y[curr_j], curr_j, curr_i))
                    for dj, di in dirs:
                        nj, ni = curr_j + dj, curr_i + di
                        if 0 <= nj < ny and 0 <= ni < nx:
                            if binary_grid[nj, ni] == 1 and not visited[nj, ni]:
                                visited[nj, ni] = True
                                queue.append((nj, ni))
                                
                # Filter out tiny regions (noise, < 5 cells)
                if len(cells) >= 5:
                    area = len(cells) * cell_size * cell_size
                    cx = sum(c[0] for c in cells) / len(cells)
                    cy = sum(c[1] for c in cells) / len(cells)
                    
                    # Boundary cells (have at least one non-cavity neighbor in 4-connectivity)
                    boundary = []
                    for cx_val, cy_val, rj, ri in cells:
                        is_bound = False
                        for dj, di in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                            nj, ni = rj + dj, ri + di
                            if 0 <= nj < ny and 0 <= ni < nx:
                                if binary_grid[nj, ni] == 0:
                                    is_bound = True
                                    break
                            else:
                                is_bound = True
                                break
                        if is_bound:
                            boundary.append({'x': cx_val, 'y': cy_val})
                            
                    regions.append({
                        'id': region_id,
                        'area': area,
                        'centroid': {'x': cx, 'y': cy},
                        'boundary': boundary
                    })
                    region_id += 1
                    
    return regions

def create_report_plot(metadata, sensors, grid_points, result, file_info, wall_result, output_path):
    """
    Create a premium light-themed dashboard plot that matches the website's clean white aesthetic.
    """
    # Create the figure with a light-gray background (matching var(--bg) = #f0f2f5)
    # The aspect ratio is widescreen (15 x 8.2 inches)
    fig = plt.figure(figsize=(15, 8.2), facecolor='#f0f2f5')
    
    # Use clean sans-serif font
    plt.rcParams['font.family'] = 'sans-serif'
    plt.rcParams['font.sans-serif'] = ['Segoe UI', 'Arial', 'Microsoft YaHei', 'sans-serif']
    
    # ---------------------------------------------
    # 1. Background / Layout Axes
    # ---------------------------------------------
    ax_bg = fig.add_axes([0, 0, 1, 1], facecolor='none')
    ax_bg.axis('off')
    
    # Draw top header bar
    # y = 0.925 to 1.0 (height 0.075)
    header_rect = patches.Rectangle((0, 0.925), 1.0, 0.075, facecolor='#ffffff', edgecolor='#e2e8f0', linewidth=0.5, zorder=2)
    ax_bg.add_patch(header_rect)
    
    # Header text
    ax_bg.text(0.015, 0.962, "Picus Tomography Analyzer", color='#1d1d1f', fontsize=14, fontweight='bold', ha='left', va='center', zorder=3)
    
    # Filename badge next to title
    filename_text = os.path.basename(output_path).replace('.png', '.pit')
    ax_bg.text(0.24, 0.962, filename_text, color='#6e6e73', fontsize=10, fontweight='normal',
              ha='left', va='center', zorder=3,
              bbox=dict(facecolor='#f0f2f5', edgecolor='#e2e8f0', boxstyle='round,pad=0.3', linewidth=0.5))
              
    # Header right: mock "2D" and "3D" toggle buttons
    toggle_bg = patches.FancyBboxPatch(
        (0.77, 0.943), 0.07, 0.038,
        boxstyle="round,pad=0.0,rounding_size=0.01",
        facecolor='#f0f2f5', edgecolor='#e2e8f0',
        linewidth=0.5, zorder=3
    )
    ax_bg.add_patch(toggle_bg)
    
    # Active 2D button
    btn_2d = patches.FancyBboxPatch(
        (0.772, 0.945), 0.033, 0.034,
        boxstyle="round,pad=0.0,rounding_size=0.008",
        facecolor='#ffffff', edgecolor='none',
        zorder=4
    )
    ax_bg.add_patch(btn_2d)
    
    ax_bg.text(0.788, 0.962, "2D", color='#1d1d1f', fontsize=9.5, fontweight='bold', ha='center', va='center', zorder=5)
    ax_bg.text(0.822, 0.962, "3D", color='#6e6e73', fontsize=9.5, fontweight='bold', ha='center', va='center', zorder=5)
    
    # Load PIT File button
    load_btn = patches.FancyBboxPatch(
        (0.86, 0.943), 0.12, 0.038,
        boxstyle="round,pad=0.0,rounding_size=0.01",
        facecolor='#007aff', edgecolor='none',
        zorder=3
    )
    ax_bg.add_patch(load_btn)
    ax_bg.text(0.92, 0.962, "Load PIT File", color='#ffffff', fontsize=10, fontweight='bold', ha='center', va='center', zorder=4)
    
    # Draw tab bar (y = 0.885 to 0.925)
    tab_rect = patches.Rectangle((0, 0.885), 1.0, 0.04, facecolor='#f7f8fa', edgecolor='#e2e8f0', linewidth=0.5, zorder=1)
    ax_bg.add_patch(tab_rect)
    
    # Draw an active tab for the file
    tab_shape = patches.FancyBboxPatch(
        (0.015, 0.885), 0.18, 0.038,
        boxstyle="round,pad=0.0,rounding_size=0.006",
        facecolor='#ffffff', edgecolor='#e2e8f0',
        linewidth=0.5, zorder=2
    )
    ax_bg.add_patch(tab_shape)
    
    # Tab filename and close icon
    ax_bg.text(0.025, 0.904, filename_text, color='#1d1d1f', fontsize=9, fontweight='semibold', ha='left', va='center', zorder=3)
    ax_bg.text(0.182, 0.904, "×", color='#aeaeb2', fontsize=12, ha='right', va='center', zorder=3)
    
    # ---------------------------------------------
    # 2. Tomogram Left Panel Card
    # ---------------------------------------------
    tomo_card = patches.FancyBboxPatch(
        (0.015, 0.02), 0.62, 0.845,
        boxstyle="round,pad=0.0,rounding_size=0.012",
        facecolor='#ffffff', edgecolor='#e2e8f0',
        linewidth=1.2, zorder=1
    )
    ax_bg.add_patch(tomo_card)
    
    # Coordinates grid inside the tomogram axes
    ax1 = fig.add_axes([0.035, 0.045, 0.58, 0.795], facecolor='#ffffff')
    
    # Plot grid points categorized by their original parsed colors (dense gradient!)
    outline_coords = [(s['x'], s['y']) for s in sensors]
    inside_pts = [pt for pt in grid_points if point_in_polygon(pt['x'], pt['y'], outline_coords)]
    
    colors_rgb = [[pt['r']/255.0, pt['g']/255.0, pt['b']/255.0] for pt in inside_pts]
    xs = [pt['x'] for pt in inside_pts]
    ys = [pt['y'] for pt in inside_pts]
    
    # Scatter using actual RGB colors and light black borders
    ax1.scatter(xs, ys, color=colors_rgb, s=26, marker='o', edgecolors=(0,0,0,0.15), linewidths=0.3, zorder=2)
    
    # Draw smooth cubic spline trunk outline
    x_coords = [s['x'] for s in sensors]
    y_coords = [s['y'] for s in sensors]
    try:
        tck, u = interpolate.splprep([x_coords, y_coords], s=0, per=True)
        unew = np.linspace(0, 1, 300)
        out = interpolate.splev(unew, tck)
        ax1.plot(out[0], out[1], color='#3b82f6', alpha=0.5, linewidth=1.8, zorder=4)
    except Exception:
        ax1.plot(x_coords + [x_coords[0]], y_coords + [y_coords[0]], color='#3b82f6', alpha=0.5, linewidth=1.8, zorder=4)
        
    # Draw sensors (blue dots with white border)
    cx_geom = np.mean(x_coords)
    cy_geom = np.mean(y_coords)
    for s in sensors:
        dx = s['x'] - cx_geom
        dy = s['y'] - cy_geom
        dist = math.sqrt(dx*dx + dy*dy) or 1.0
        # Offset radially outward by 2.3 cm for legibility
        offset_x = (dx / dist) * 2.3
        offset_y = (dy / dist) * 2.3
        
        ax1.plot(s['x'], s['y'], 'o', color='#3b82f6', markeredgecolor='white', markersize=6, markeredgewidth=1.2, zorder=5)
        ax1.text(s['x'] + offset_x, s['y'] + offset_y, str(s['id']), color='#1e40af', fontsize=9, fontweight='bold', ha='center', va='center', zorder=6)
        
    # Draw North Arrow (Compass) in green
    north_id = metadata.get('north_sensor', 1)
    north_sensor = next((s for s in sensors if s['id'] == north_id), None)
    if north_sensor:
        dx = north_sensor['x'] - cx_geom
        dy = north_sensor['y'] - cy_geom
        dist = math.sqrt(dx*dx + dy*dy) or 1.0
        nx = north_sensor['x'] + (dx / dist) * 3.5
        ny = north_sensor['y'] + (dy / dist) * 3.5
        ax1.annotate('N', xy=(north_sensor['x'] + (dx / dist) * 1.0, north_sensor['y'] + (dy / dist) * 1.0), 
                     xytext=(nx, ny),
                     arrowprops=dict(facecolor='#10b981', edgecolor='none', shrink=0.08, width=1.0, headwidth=4, headlength=4),
                     color='#10b981', fontsize=11, fontweight='bold', ha='center', va='center', zorder=6)
                     
    # Draw Weak Axis (dashed red line)
    cx_w = result['weighted_centroid']['x']
    cy_w = result['weighted_centroid']['y']
    theta_rad = math.radians(result['principal_axis_angle'])
    
    L = max(x_coords) - min(x_coords) or 40.0
    ax_dx = math.cos(theta_rad) * L * 0.45
    ax_dy = math.sin(theta_rad) * L * 0.45
    ax1.plot([cx_w - ax_dx, cx_w + ax_dx], [cy_w - ax_dy, cy_w + ax_dy], '--', color='#ff3b30', alpha=0.7, linewidth=1.5, zorder=3)
    ax1.plot(cx_w, cy_w, '+', color='#ff3b30', markersize=8, markeredgewidth=1.5, zorder=5)
    
    # Detect cavity regions
    regions = detect_cavities_py(grid_points, sensors)
    
    # Draw cavity boundaries (red dashed rings around boundary points)
    for reg in regions:
        if reg['boundary']:
            bx = [p['x'] for p in reg['boundary']]
            by = [p['y'] for p in reg['boundary']]
            ax1.scatter(bx, by, s=45, facecolors='none', edgecolors='#dc2626', linewidths=0.8, alpha=0.7, zorder=3)
            
        ccx = reg['centroid']['x']
        ccy = reg['centroid']['y']
        ax1.plot(ccx, ccy, '+', color='#dc2626', markersize=6, markeredgewidth=1.2, zorder=5)
        ax1.plot(ccx, ccy, 'o', color='#dc2626', markersize=3, zorder=5)
        
        # Label card: "#ID: Area cm²"
        label_text = f"#{reg['id']}: {round(reg['area'])}cm²"
        ax1.text(ccx, ccy + 1.8, label_text, color='#b91c1c', fontsize=7.5, fontweight='bold',
                 ha='center', va='center', zorder=6,
                 bbox=dict(facecolor='#ffffff', edgecolor='#dc2626', boxstyle='round,pad=0.2', linewidth=0.5, alpha=0.9))
                 
    # Draw wall thickness overlay
    min_entry = min(wall_result['thickness_profile'], key=lambda x: x['thickness'])
    w_rad = math.radians(min_entry['angle'])
    w_cos = math.cos(w_rad)
    w_sin = math.sin(w_rad)
    
    outer_x = wall_result['center']['x'] + w_cos * min_entry['trunk_radius']
    outer_y = wall_result['center']['y'] + w_sin * min_entry['trunk_radius']
    
    inner_x = wall_result['center']['x'] + w_cos * (min_entry['trunk_radius'] - min_entry['thickness'])
    inner_y = wall_result['center']['y'] + w_sin * (min_entry['trunk_radius'] - min_entry['thickness'])
    
    ax1.plot([inner_x, outer_x], [inner_y, outer_y], ':', color='#ff9500', linewidth=2.0, zorder=4)
    text_x = wall_result['center']['x'] + w_cos * (min_entry['trunk_radius'] - min_entry['thickness'] / 2.0) + 1.8 * (-w_sin)
    text_y = wall_result['center']['y'] + w_sin * (min_entry['trunk_radius'] - min_entry['thickness'] / 2.0) + 1.8 * (w_cos)
    ax1.text(text_x, text_y, f"t={min_entry['thickness']:.1f}cm", color='#ff9500', fontsize=8, weight='bold', ha='center', va='center', zorder=6)
    
    # Legend bar in top left of ax1
    cmap_colors = ['#5D3A0A', '#8B6914', '#2E8B57', '#9932CC', '#4169E1', '#87CEEB']
    cmap = mcolors.LinearSegmentedColormap.from_list('picus_grad', cmap_colors)
    
    # Legend card pill
    legend_bg = patches.FancyBboxPatch(
        (0.02, 0.86), 0.30, 0.11,
        boxstyle="round,pad=0.0,rounding_size=0.01",
        facecolor='#ffffff', edgecolor='#e2e8f0',
        linewidth=0.5, transform=ax1.transAxes, zorder=10, alpha=0.9
    )
    ax1.add_patch(legend_bg)
    
    # 100 gradient segments
    x_start = 0.04
    y_start = 0.91
    width = 0.26
    height = 0.03
    for i in range(100):
        t = i / 100.0
        color = cmap(t)
        rect = patches.Rectangle(
            (x_start + t * width, y_start), width / 100.0, height,
            facecolor=color, edgecolor='none', transform=ax1.transAxes, zorder=11
        )
        ax1.add_patch(rect)
        
    ax1.text(x_start, y_start - 0.025, 'v:100%', color='#6e6e73', fontsize=7, transform=ax1.transAxes, ha='left', va='top', zorder=12)
    ax1.text(x_start + width, y_start - 0.025, 'v:0%', color='#6e6e73', fontsize=7, transform=ax1.transAxes, ha='right', va='top', zorder=12)
    
    # Style left axis
    ax1.grid(True, color='#e2e8f0', linestyle='-', linewidth=0.5)
    ax1.tick_params(colors='#94a3b8', labelsize=8.5)
    for spine in ax1.spines.values():
        spine.set_edgecolor('#cbd5e1')
        spine.set_linewidth(0.5)
    ax1.set_aspect('equal', adjustable='datalim')
    
    # ---------------------------------------------
    # 3. Sidebar (Right Panel Cards)
    # ---------------------------------------------
    # Card 1: Tree Info
    c1 = patches.FancyBboxPatch(
        (0.655, 0.77), 0.33, 0.11,
        boxstyle="round,pad=0.0,rounding_size=0.012",
        facecolor='#ffffff', edgecolor='#e2e8f0', linewidth=1.0, zorder=1
    )
    ax_bg.add_patch(c1)
    
    ax_bg.text(0.67, 0.857, "TREE INFO", color='#6e6e73', fontsize=8.5, fontweight='bold', ha='left', va='center', zorder=2)
    
    # Column 1 at 0.675, Column 2 at 0.82
    info_cols = [
        # Column 1
        ('SPECIES', metadata.get('species', 'Unknown'), 0.675, 0.825),
        ('CIRCUMFERENCE', f"{metadata.get('circumference', 0.0):.1f} cm", 0.675, 0.785),
        # Column 2
        ('TREE NO.', f"Sample {file_info['sample_no']:02d}", 0.82, 0.825),
        ('MEAS. HEIGHT', file_info['height'], 0.82, 0.785)
    ]
    for label, val, lx, ly in info_cols:
        ax_bg.text(lx, ly, label, color='#aeaeb2', fontsize=7.5, fontweight='normal', ha='left', va='center', zorder=2)
        ax_bg.text(lx, ly - 0.015, val, color='#1d1d1f', fontsize=9.5, fontweight='bold', ha='left', va='center', zorder=2)
        
    # Card 2: Residual Strength Assessment
    c2 = patches.FancyBboxPatch(
        (0.655, 0.50), 0.33, 0.255,
        boxstyle="round,pad=0.0,rounding_size=0.012",
        facecolor='#ffffff', edgecolor='#e2e8f0', linewidth=1.0, zorder=1
    )
    ax_bg.add_patch(c2)
    
    ax_bg.text(0.67, 0.732, "RESIDUAL STRENGTH", color='#6e6e73', fontsize=8.5, fontweight='bold', ha='left', va='center', zorder=2)
    
    # Strength display
    strength = result['residual_strength']
    is_safe = result['assessment'] == 'safe'
    str_color = '#34c759' if is_safe else '#ff3b30'
    badge_bg = '#34c75914' if is_safe else '#ff3b3014'
    badge_text = " SAFE " if is_safe else " CRITICAL "
    
    ax_bg.text(0.675, 0.678, f"{strength}%", color=str_color, fontsize=30, fontweight='bold', ha='left', va='center', zorder=2)
    ax_bg.text(0.675, 0.638, "Residual Bending Strength", color='#aeaeb2', fontsize=8, ha='left', va='center', zorder=2)
    
    # Badge
    ax_bg.text(0.82, 0.678, badge_text, color=str_color, fontsize=8.5, fontweight='bold', ha='left', va='center', zorder=3,
              bbox=dict(facecolor=badge_bg, edgecolor=str_color, boxstyle='round,pad=0.3', linewidth=0.8))
              
    # Statistics Grid
    stats = [
        ('EQUIV. DIAMETER', f"{result['equivalent_diameter']:.1f} cm", 0.675, 0.59),
        ('EQUIV. PERIMETER', f"{result['equivalent_perimeter']:.1f} cm", 0.82, 0.59),
        ('WEAK AXIS', f"{result['principal_axis_angle']:.1f}°", 0.675, 0.535),
        ('MIN WALL', f"{min_entry['thickness']:.1f} cm", 0.82, 0.535)
    ]
    for label, val, lx, ly in stats:
        ax_bg.text(lx, ly, label, color='#aeaeb2', fontsize=7.5, fontweight='normal', ha='left', va='center', zorder=2)
        ax_bg.text(lx, ly - 0.015, val, color='#1d1d1f', fontsize=9.5, fontweight='bold', ha='left', va='center', zorder=2)
        
    # Card 3: Decay Coefficients
    c3 = patches.FancyBboxPatch(
        (0.655, 0.24), 0.33, 0.245,
        boxstyle="round,pad=0.0,rounding_size=0.012",
        facecolor='#ffffff', edgecolor='#e2e8f0', linewidth=1.0, zorder=1
    )
    ax_bg.add_patch(c3)
    
    ax_bg.text(0.67, 0.462, "DECAY COEFFICIENTS", color='#6e6e73', fontsize=8.5, fontweight='bold', ha='left', va='center', zorder=2)
    
    # Draw slider rows
    coef_rows = [
        ('healthy', 1.00, 0.425),
        ('mild', 0.85, 0.385),
        ('moderate', 0.50, 0.345),
        ('severe', 0.20, 0.305),
        ('cavity', 0.05, 0.265)
    ]
    for zone, val, ly in coef_rows:
        # Colored dot
        ax_bg.plot(0.678, ly, 'o', color=ZONE_COLORS[zone], markersize=4.5, zorder=2)
        # Label
        ax_bg.text(0.695, ly, ZONE_LABELS[zone], color='#6e6e73', fontsize=9.5, fontweight='medium', ha='left', va='center', zorder=2)
        # Value
        ax_bg.text(0.965, ly, f"{val:.2f}", color='#1d1d1f', fontsize=9.5, fontweight='bold', ha='right', va='center', zorder=2)
        
        # Track line
        y_track = ly - 0.013
        ax_bg.plot([0.678, 0.965], [y_track, y_track], color='#e2e8f0', linewidth=2.5, solid_capstyle='round', zorder=1)
        # Fill line
        x_thumb = 0.678 + (0.965 - 0.678) * val
        ax_bg.plot([0.678, x_thumb], [y_track, y_track], color=ZONE_COLORS[zone], linewidth=2.5, solid_capstyle='round', zorder=2)
        # Thumb
        ax_bg.plot(x_thumb, y_track, 'o', color='#ffffff', markeredgecolor='#cbd5e1', markersize=7.5, markeredgewidth=0.8, zorder=3)
        
    # Card 4: Area Distribution
    c4 = patches.FancyBboxPatch(
        (0.655, 0.02), 0.33, 0.205,
        boxstyle="round,pad=0.0,rounding_size=0.012",
        facecolor='#ffffff', edgecolor='#e2e8f0', linewidth=1.0, zorder=1
    )
    ax_bg.add_patch(c4)
    
    ax_bg.text(0.67, 0.205, "AREA DISTRIBUTION", color='#6e6e73', fontsize=8.5, fontweight='bold', ha='left', va='center', zorder=2)
    
    # Stacked bar axes inside Card 4
    ax_bar = fig.add_axes([0.675, 0.155, 0.29, 0.025], facecolor='none')
    left = 0.0
    for zone in [ZONE_HEALTHY, ZONE_MILD, ZONE_MODERATE, ZONE_SEVERE, ZONE_CAVITY]:
        pct = result['zone_pcts'][zone]
        if pct > 0:
            ax_bar.barh([0], [pct], left=[left], color=ZONE_COLORS[zone], height=0.6, edgecolor='#ffffff', linewidth=0.8)
            left += pct
    ax_bar.set_xlim(0, 100)
    ax_bar.set_ylim(-0.5, 0.5)
    ax_bar.axis('off')
    
    # Legend rows
    leg_items = [
        ('healthy', 0.675, 0.125),
        ('mild', 0.77, 0.125),
        ('moderate', 0.865, 0.125),
        ('severe', 0.675, 0.095),
        ('cavity', 0.77, 0.095)
    ]
    for zone, lx, ly in leg_items:
        # Colored dot
        ax_bg.plot(lx, ly, 's', color=ZONE_COLORS[zone], markersize=3.5, zorder=2)
        # Label + Pct
        ax_bg.text(lx + 0.012, ly, f"{ZONE_LABELS[zone]}: {result['zone_pcts'][zone]:.1f}%", color='#6e6e73', fontsize=7.5, ha='left', va='center', zorder=2)
        
    # Area metrics bottom row
    ax_bg.text(0.675, 0.065, "CROSS-SECTION AREA", color='#aeaeb2', fontsize=7.5, fontweight='normal', ha='left', va='center', zorder=2)
    ax_bg.text(0.675, 0.05, f"{result['trunk_area']:.1f} cm²", color='#1d1d1f', fontsize=9.5, fontweight='bold', ha='left', va='center', zorder=2)
    
    ax_bg.text(0.82, 0.065, "EFFECTIVE RATIO", color='#aeaeb2', fontsize=7.5, fontweight='normal', ha='left', va='center', zorder=2)
    ax_bg.text(0.82, 0.05, f"{result['residual_strength']:.1f}%", color='#1d1d1f', fontsize=9.5, fontweight='bold', ha='left', va='center', zorder=2)
    
    # Save the beautiful plot
    plt.savefig(output_path, dpi=180, facecolor=fig.get_facecolor(), edgecolor='none', bbox_inches='tight')
    plt.close(fig)

def main():
    input_dir = r"C:\Users\cecil\Documents\PiT\2026-5-15"
    output_dir = r"C:\Users\cecil\iCloudDrive\DAL Master\Picus 自动识别"
    
    os.makedirs(output_dir, exist_ok=True)
    
    pit_files = glob.glob(os.path.join(input_dir, "*.pit"))
    print(f"Found {len(pit_files)} .pit files to process...")
    
    summary_data = []
    
    for filepath in pit_files:
        filename = os.path.basename(filepath)
        print(f"Processing: {filename}")
        
        # Parse filename
        file_info = parse_filename_info(filepath)
        
        # Parse PIT file data
        metadata, sensors, grid_points = parse_pit_file(filepath)
        
        # Compute strength properties
        result = compute_strength(grid_points, sensors)
        # Compute wall thickness
        wall_result = compute_wall_thickness(grid_points, sensors)
        
        # Generate plot image
        output_filename = filename.replace('.pit', '.png').replace('.PIT', '.png')
        output_path = os.path.join(output_dir, output_filename)
        
        create_report_plot(metadata, sensors, grid_points, result, file_info, wall_result, output_path)
        
        # Save summary statistics for weekly report
        summary_data.append({
            'filename': filename,
            'sample_no': file_info['sample_no'],
            'height': file_info['height'],
            'replicate': file_info['replicate'],
            'strength': result['residual_strength'],
            'area': result['trunk_area'],
            'd_eq': result['equivalent_diameter'],
            'p_eq': result['equivalent_perimeter'],
            'theta': result['principal_axis_angle'],
            'assessment': result['assessment'].upper(),
            'healthy_pct': result['zone_pcts']['healthy'],
            'mild_pct': result['zone_pcts']['mild'],
            'moderate_pct': result['zone_pcts']['moderate'],
            'severe_pct': result['zone_pcts']['severe'],
            'cavity_pct': result['zone_pcts']['cavity'],
            'min_wall': wall_result['min_thickness']
        })
        
    # Sort data by Sample No, then Height, then Replicate
    def get_sort_key(row):
        h_str = row['height']
        h_val = 0
        try:
            h_val = int(re.search(r'\d+', h_str).group())
        except Exception:
            pass
        return (row['sample_no'], h_val, row['replicate'])
        
    summary_data.sort(key=get_sort_key)
    
    # Save statistics table as CSV in the workspace for convenience
    import pandas as pd
    df = pd.DataFrame(summary_data)
    df.to_csv(os.path.join(output_dir, 'pit_analysis_summary.csv'), index=False, encoding='utf-8-sig')
    print("\nAll files processed successfully! Summary saved to pit_analysis_summary.csv")
    
    # Print the Markdown formatted weekly report table
    print("\n--- Weekly Report Table ---")
    markdown_table = [
        "| Specimen ID | Height | Replicate | Area (cm²) | P_eq (cm) | Weak Axis Angle (°) | Min Wall (cm) | Strength | Status | Cavity% | Severe% |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for row in summary_data:
        markdown_table.append(
            f"| Sample {row['sample_no']:02d} | {row['height']} | #{row['replicate']:02d} | {row['area']} | {row['p_eq']} | {row['theta']}° | {row['min_wall']:.1f} cm | **{row['strength']}%** | {row['assessment']} | {row['cavity_pct']:.1f}% | {row['severe_pct']:.1f}% |"
        )
    print("\n".join(markdown_table))

if __name__ == '__main__':
    main()

