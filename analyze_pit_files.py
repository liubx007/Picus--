import os
import sys
import io
import re
import math
import glob
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as patches
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
    'healthy':  '#8B6914',  # Brown
    'mild':     '#B8860B',  # Dark Goldenrod
    'moderate': '#2E8B57',  # Sea Green
    'severe':   '#9932CC',  # Dark Orchid (Purple)
    'cavity':   '#4169E1'   # Royal Blue
}

ZONE_LABELS_CN = {
    'healthy':  '健康 (Healthy)',
    'mild':     '轻微 (Mild)',
    'moderate': '中度 (Moderate)',
    'severe':   '重度 (Severe)',
    'cavity':   '空洞 (Cavity)'
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

def create_report_plot(metadata, sensors, grid_points, result, file_info, output_path):
    """
    Create a premium dark-themed dashboard plot combining the tomogram and statistical indicators.
    """
    # Create the figure with a premium dark background
    fig = plt.figure(figsize=(13, 7.5), facecolor='#0f1419')
    
    # 2D Tomogram Axes (left side)
    ax1 = fig.add_axes([0.06, 0.08, 0.45, 0.84], facecolor='#0f1419')
    
    # 1. Grid Points Plot (inside Outline first for perfect aesthetics)
    # Extract coordinates
    outline_coords = [(s['x'], s['y']) for s in sensors]
    inside_pts = [pt for pt in grid_points if point_in_polygon(pt['x'], pt['y'], outline_coords)]
    
    # Plot grid points categorized by zone to control layout and legend
    for zone in [ZONE_HEALTHY, ZONE_MILD, ZONE_MODERATE, ZONE_SEVERE, ZONE_CAVITY]:
        zone_pts = [pt for pt in inside_pts if pt['zone'] == zone]
        if zone_pts:
            xs = [pt['x'] for pt in zone_pts]
            ys = [pt['y'] for pt in zone_pts]
            ax1.scatter(xs, ys, color=ZONE_COLORS[zone], s=20, marker='o', edgecolors='black', linewidths=0.3, zorder=2)
            
    # 2. Draw Spline Outline
    x_coords = [s['x'] for s in sensors]
    y_coords = [s['y'] for s in sensors]
    try:
        # Periodic cubic spline
        tck, u = interpolate.splprep([x_coords, y_coords], s=0, per=True)
        unew = np.linspace(0, 1, 300)
        out = interpolate.splev(unew, tck)
        ax1.plot(out[0], out[1], color='#2196F3', linewidth=2.5, zorder=4, label='Trunk Outline')
    except Exception:
        # Fallback to linear if spline fails
        ax1.plot(x_coords + [x_coords[0]], y_coords + [y_coords[0]], color='#2196F3', linewidth=2.5, zorder=4)
        
    # 3. Draw Sensors and Offset Labels
    cx_geom = np.mean(x_coords)
    cy_geom = np.mean(y_coords)
    for s in sensors:
        dx = s['x'] - cx_geom
        dy = s['y'] - cy_geom
        dist = math.sqrt(dx*dx + dy*dy) or 1.0
        # Offset radially outward by 2.2 cm for legibility
        offset_x = (dx / dist) * 2.3
        offset_y = (dy / dist) * 2.3
        
        ax1.plot(s['x'], s['y'], 'o', color='#3b82f6', markeredgecolor='white', markersize=8, markeredgewidth=1.2, zorder=5)
        ax1.text(s['x'] + offset_x, s['y'] + offset_y, str(s['id']), color='#e4e6eb', fontsize=8.5, fontweight='bold', ha='center', va='center', zorder=6)
        
    # 4. Draw North Arrow (Compass)
    north_id = metadata.get('north_sensor', 1)
    north_sensor = next((s for s in sensors if s['id'] == north_id), None)
    if north_sensor:
        dx = north_sensor['x'] - cx_geom
        dy = north_sensor['y'] - cy_geom
        dist = math.sqrt(dx*dx + dy*dy) or 1.0
        nx = north_sensor['x'] + (dx / dist) * 4.5
        ny = north_sensor['y'] + (dy / dist) * 4.5
        ax1.annotate('N', xy=(north_sensor['x'] + (dx / dist) * 1.5, north_sensor['y'] + (dy / dist) * 1.5), 
                     xytext=(nx, ny),
                     arrowprops=dict(facecolor='#10b981', edgecolor='#10b981', shrink=0.05, width=1.0, headwidth=5, headlength=5),
                     color='#10b981', fontsize=11, fontweight='bold', ha='center', va='center', zorder=6)
        
    # 5. Draw Weak Bending Axis (dashed red line through weighted centroid)
    cx_w = result['weighted_centroid']['x']
    cy_w = result['weighted_centroid']['y']
    theta_rad = math.radians(result['principal_axis_angle'])
    
    L = max(x_coords) - min(x_coords) or 40.0
    ax_dx = math.cos(theta_rad) * L * 0.45
    ax_dy = math.sin(theta_rad) * L * 0.45
    ax1.plot([cx_w - ax_dx, cx_w + ax_dx], [cy_w - ax_dy, cy_w + ax_dy], '--', color='#ff4757', alpha=0.8, linewidth=1.5, zorder=3, label='Weak Axis')
    
    # Subtle centroid marker
    ax1.plot(cx_w, cy_w, '+', color='#ff4757', markersize=10, markeredgewidth=2, zorder=5)

    # Style Left Axes
    ax1.grid(True, color='#1e2530', linestyle='--', linewidth=0.5)
    ax1.tick_params(colors='#8b8fa3', labelsize=8)
    for spine in ax1.spines.values():
        spine.set_color('#1e2530')
    ax1.set_aspect('equal', adjustable='datalim')
    
    # Title Left Tomogram
    ax1.text(0.02, 0.98, '2D Acoustic Tomogram (2D声波断层图)', color='#e4e6eb', fontsize=12, fontweight='bold', transform=ax1.transAxes, ha='left', va='top')
    
    # ---------------------------------------------
    # Right Dashboard Layout (using a card overlay)
    # ---------------------------------------------
    # Create the axes for the card (holds both the backdrop and text)
    ax2 = fig.add_axes([0.55, 0.05, 0.41, 0.90], facecolor='none')
    ax2.axis('off')
    
    # Add a glassmorphic-style card backdrop inside ax2 with zorder=-1 to stay behind text
    card = patches.FancyBboxPatch(
        (0.0, 0.0), 1.0, 1.0,
        boxstyle="round,pad=0.01",
        facecolor='#1a1f2e', edgecolor='#2c3545',
        linewidth=1.2, transform=ax2.transAxes,
        zorder=-1
    )
    ax2.add_patch(card)
    
    # Title
    ax2.text(0.05, 0.96, f"Picus 树干抗弯能力分析报告", color='#00d4aa', fontsize=15, fontweight='bold', ha='left', va='center')
    ax2.text(0.05, 0.92, f"文件: {os.path.basename(output_path).replace('.png', '.pit')}", color='#8b8fa3', fontsize=9.5, ha='left', va='center')
    
    # Metadata block
    y_ptr = 0.84
    ax2.text(0.05, y_ptr, "【测试基本信息】", color='#e4e6eb', fontsize=10.5, fontweight='bold', ha='left')
    metadata_lines = [
        f"树木编号: {file_info['sample_no']:02d}号样品",
        f"传感器数量: {file_info['sensor_count']} 个",
        f"重复实验次数: 第 {file_info['replicate']:02d} 次重复",
        f"检测高度: 自树顶向下 {file_info['height']}",
        f"测试日期: {metadata['date']}"
    ]
    for line in metadata_lines:
        y_ptr -= 0.035
        ax2.text(0.07, y_ptr, line, color='#b8bcc9', fontsize=9.5, ha='left')
        
    # Analysis results block
    y_ptr -= 0.06
    ax2.text(0.05, y_ptr, "【抗弯学特性评估】", color='#e4e6eb', fontsize=10.5, fontweight='bold', ha='left')
    
    # Residual strength highlighted box
    y_ptr -= 0.075
    strength = result['residual_strength']
    is_safe = result['assessment'] == 'safe'
    
    # Draw status badge
    badge_color = '#00d4aa' if is_safe else '#ff4757'
    badge_text = " 安全 SAFE (力学无明显退化) " if is_safe else " 警告 CRITICAL (退化超1/3阈值) "
    
    ax2.text(0.07, y_ptr + 0.02, "截面残余抗弯强度 (Residual Bending Strength):", color='#b8bcc9', fontsize=9.5, ha='left')
    ax2.text(0.07, y_ptr - 0.015, f"{strength}%", color=badge_color, fontsize=28, fontweight='bold', ha='left', va='center')
    
    # Add status label
    ax2.text(0.44, y_ptr - 0.015, badge_text, color=badge_color, weight='bold', fontsize=9,
             bbox=dict(facecolor=badge_color + '22', edgecolor=badge_color, boxstyle='round,pad=0.2'),
             ha='left', va='center')
             
    # Section statistics
    y_ptr -= 0.08
    stats_data = [
        f"原木截面面积: {result['trunk_area']} cm²",
        f"等效抗弯直径 (D_eq): {result['equivalent_diameter']} cm",
        f"等效抗弯周长 (P_eq): {result['equivalent_perimeter']} cm",
        f"主弯曲弱轴方向: {result['principal_axis_angle']}° (红虚线)",
        f"加权质心坐标: ({result['weighted_centroid']['x']}, {result['weighted_centroid']['y']}) cm"
    ]
    for line in stats_data:
        y_ptr -= 0.035
        ax2.text(0.07, y_ptr, line, color='#b8bcc9', fontsize=9.5, ha='left')
        
    # Area Distribution stacked bar block
    y_ptr -= 0.06
    ax2.text(0.05, y_ptr, "【各检测区域面积分布 (Area Distribution)】", color='#e4e6eb', fontsize=10.5, fontweight='bold', ha='left')
    
    # Stacked bar axes inside the card
    # Coordinates relative to figure: [left, bottom, width, height]
    ax_bar = fig.add_axes([0.58, 0.14, 0.35, 0.05], facecolor='none')
    left = 0.0
    for zone in [ZONE_HEALTHY, ZONE_MILD, ZONE_MODERATE, ZONE_SEVERE, ZONE_CAVITY]:
        pct = result['zone_pcts'][zone]
        if pct > 0:
            ax_bar.barh([0], [pct], left=[left], color=ZONE_COLORS[zone], height=0.6, edgecolor='#1a1f2e', linewidth=0.5)
            left += pct
            
    ax_bar.set_xlim(0, 100)
    ax_bar.set_ylim(-0.5, 0.5)
    ax_bar.axis('off')
    
    # Legend labels table
    y_ptr = 0.08
    legend_cols = [
        ('healthy', ZONE_LABELS_CN['healthy']),
        ('mild', ZONE_LABELS_CN['mild']),
        ('moderate', ZONE_LABELS_CN['moderate']),
        ('severe', ZONE_LABELS_CN['severe']),
        ('cavity', ZONE_LABELS_CN['cavity'])
    ]
    
    # Render mini-colored blocks and text labels
    x_pos = [0.07, 0.54]
    y_offset = 0
    for idx, (zone, label) in enumerate(legend_cols):
        col = idx % 2
        row = idx // 2
        lx = x_pos[col]
        ly = y_ptr - (row * 0.035)
        
        # Color indicator block
        rect_color = patches.Rectangle((lx, ly - 0.007), 0.025, 0.015, facecolor=ZONE_COLORS[zone], edgecolor='none', transform=ax2.transAxes)
        ax2.add_patch(rect_color)
        
        # Label & Pct
        pct_val = result['zone_pcts'][zone]
        ax2.text(lx + 0.035, ly, f"{label}: {pct_val:.1f}%", color='#b8bcc9', fontsize=8.5, ha='left', va='center')
        
    plt.savefig(output_path, dpi=180, facecolor=fig.get_facecolor(), edgecolor='none', bbox_inches='tight')
    plt.close(fig)

def main():
    input_dir = r"C:\Users\cecil\Documents\PiT\2026-5-15"
    output_dir = r"C:\Users\cecil\iCloudDrive\DAL Master\Picus 自动识别"
    
    os.makedirs(output_dir, exist_ok=True)
    
    pit_files = glob.glob(os.path.join(input_dir, "*.pit"))
    print(f"找到 {len(pit_files)} 个 .pit 文件进行处理...")
    
    summary_data = []
    
    for filepath in pit_files:
        filename = os.path.basename(filepath)
        print(f"正在处理: {filename}")
        
        # Parse filename
        file_info = parse_filename_info(filepath)
        
        # Parse PIT file data
        metadata, sensors, grid_points = parse_pit_file(filepath)
        
        # Compute strength properties
        result = compute_strength(grid_points, sensors)
        
        # Generate plot image
        output_filename = filename.replace('.pit', '.png').replace('.PIT', '.png')
        output_path = os.path.join(output_dir, output_filename)
        
        create_report_plot(metadata, sensors, grid_points, result, file_info, output_path)
        
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
        })
        
    # Sort data by Sample No, then Height, then Replicate
    # Convert height string (e.g. '10cm', '5cm') to numeric for sorting
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
    print("\n所有文件处理完成！汇总数据已保存至 pit_analysis_summary.csv")
    
    # Print the Markdown formatted weekly report table
    print("\n--- Weekly Report Table ---")
    markdown_table = [
        "| 样品号 (Sample) | 测试高度 (Height) | 重复次数 (Rep) | 截面面积 (Area/cm²) | 等效抗弯周长 (P_eq/cm) | 主弯曲弱轴 (Angle/°) | 残余强度 (Strength) | 评估状态 (Status) | 空洞占比 (Cavity%) | 重度占比 (Severe%) |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for row in summary_data:
        markdown_table.append(
            f"| 样品 {row['sample_no']:02d} | {row['height']} | #{row['replicate']:02d} | {row['area']} | {row['p_eq']} | {row['theta']}° | **{row['strength']}%** | {row['assessment']} | {row['cavity_pct']:.1f}% | {row['severe_pct']:.1f}% |"
        )
    print("\n".join(markdown_table))

if __name__ == '__main__':
    main()
