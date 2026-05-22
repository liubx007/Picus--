/**
 * Report Generator - HTML report export for Picus Tomography analysis.
 */

export class ReportGenerator {
    /**
     * Generate a printable HTML report.
     */
    generate(pitData, strengthResult, cavityResult, zoneAreas, wallThickness, coefficients, tomoImageDataUrl) {
        const meta = pitData.metadata;
        const now = new Date().toLocaleString();

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Tomography Analysis Report</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;600;700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Noto Sans SC', sans-serif; color: #222; padding: 30px; max-width: 800px; margin: 0 auto; font-size: 13px; }
  h1 { font-size: 20px; text-align: center; margin-bottom: 5px; color: #1a5276; }
  .subtitle { text-align: center; color: #666; margin-bottom: 20px; font-size: 12px; }
  h2 { font-size: 15px; color: #1a5276; border-bottom: 2px solid #1a5276; padding-bottom: 4px; margin: 20px 0 10px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 15px; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; font-size: 12px; }
  th { background: #eaf2f8; font-weight: 600; }
  .center { text-align: center; }
  .tomo-img { width: 100%; max-width: 500px; display: block; margin: 10px auto; border: 1px solid #ccc; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; color: #fff; }
  .badge-safe { background: #00b894; }
  .badge-warning { background: #fdcb6e; color: #333; }
  .badge-critical { background: #e74c3c; }
  .footer { margin-top: 30px; text-align: center; color: #999; font-size: 10px; border-top: 1px solid #ddd; padding-top: 10px; }
  .area-bar { display: flex; height: 20px; border-radius: 4px; overflow: hidden; margin: 5px 0; }
  .area-bar div { height: 100%; display: flex; align-items: center; justify-content: center; font-size: 9px; color: #fff; font-weight: 600; }
  @media print { body { padding: 15px; } h1 { font-size: 18px; } }
</style>
</head>
<body>

<h1>🌳 Picus Tomography Analysis Report</h1>
<p class="subtitle">声波断层成像分析报告 / Acoustic Tomography Analysis Report</p>

<h2>1. 树木信息 / Tree Information</h2>
<table>
  <tr><th>项目</th><th>数值</th></tr>
  <tr><td>树种 / Species</td><td>${meta.species || meta.speciesLatin || 'N/A'}</td></tr>
  <tr><td>树编号 / Tree No.</td><td>${meta.treeNumber || 'N/A'}</td></tr>
  <tr><td>测量日期 / Date</td><td>${meta.date || 'N/A'}</td></tr>
  <tr><td>围度 / Circumference</td><td>${meta.circumference ? meta.circumference + ' mm' : 'N/A'}</td></tr>
  <tr><td>测量高度 / Measurement Height</td><td>${meta.measurementHeight ? meta.measurementHeight + ' cm' : 'N/A'}</td></tr>
  <tr><td>传感器数量 / Sensors</td><td>${meta.sensorCount || 12}</td></tr>
  <tr><td>操作员 / Operator</td><td>${meta.operator || 'N/A'}</td></tr>
</table>

<h2>2. 断层图 / Tomogram</h2>
${tomoImageDataUrl ? `<img src="${tomoImageDataUrl}" class="tomo-img" alt="Tomogram">` : '<p>No image available</p>'}

<h2>3. 衰减系数 / Decay Coefficients</h2>
<table>
  <tr><th>区域</th><th>颜色</th><th>系数 α</th></tr>
  <tr><td>健康 Healthy</td><td style="background:#8B6914;width:30px"></td><td>${coefficients.healthy}</td></tr>
  <tr><td>轻微 Mild</td><td style="background:#B8860B;width:30px"></td><td>${coefficients.mild}</td></tr>
  <tr><td>中度 Moderate</td><td style="background:#2E8B57;width:30px"></td><td>${coefficients.moderate}</td></tr>
  <tr><td>重度 Severe</td><td style="background:#9932CC;width:30px"></td><td>${coefficients.severe}</td></tr>
  <tr><td>空洞 Cavity</td><td style="background:#4169E1;width:30px"></td><td>${coefficients.cavity}</td></tr>
</table>

<h2>4. 截面强度分析 / Cross-Section Strength Analysis</h2>
<table>
  <tr><th>指标</th><th>数值</th></tr>
  <tr><td>剩余强度 / Residual Strength</td><td><strong>${strengthResult.residualStrength}%</strong> 
    <span class="badge badge-${strengthResult.assessment}">${strengthResult.assessment.toUpperCase()}</span></td></tr>
  <tr><td>等效直径 / Equiv. Diameter</td><td>${strengthResult.equivalentDiameter} cm</td></tr>
  <tr><td>等效周长 / Equiv. Perimeter</td><td>${strengthResult.equivalentPerimeter} cm</td></tr>
  <tr><td>最不利轴 / Principal Axis</td><td>${strengthResult.principalAxisAngle}°</td></tr>
  <tr><td>截面面积 / Cross-Section Area</td><td>${strengthResult.trunkArea} cm²</td></tr>
  <tr><td>等效面积比 / Eff. Area Ratio</td><td>${strengthResult.effectiveAreaRatio}%</td></tr>
  <tr><td>评估 / Assessment</td><td>${strengthResult.assessmentDetails}</td></tr>
</table>

<h2>5. 面积分布 / Area Distribution</h2>
${zoneAreas ? `
<div class="area-bar">
  <div style="width:${zoneAreas.healthy || 0}%;background:#8B6914">${(zoneAreas.healthy||0).toFixed(0)}%</div>
  <div style="width:${zoneAreas.mild || 0}%;background:#B8860B">${(zoneAreas.mild||0).toFixed(0)}%</div>
  <div style="width:${zoneAreas.moderate || 0}%;background:#2E8B57">${(zoneAreas.moderate||0).toFixed(0)}%</div>
  <div style="width:${zoneAreas.severe || 0}%;background:#9932CC">${(zoneAreas.severe||0).toFixed(0)}%</div>
  <div style="width:${zoneAreas.cavity || 0}%;background:#4169E1">${(zoneAreas.cavity||0).toFixed(0)}%</div>
</div>
<table>
  <tr><th>区域</th><th>占比 %</th></tr>
  <tr><td>健康</td><td>${(zoneAreas.healthy||0).toFixed(1)}%</td></tr>
  <tr><td>轻微</td><td>${(zoneAreas.mild||0).toFixed(1)}%</td></tr>
  <tr><td>中度</td><td>${(zoneAreas.moderate||0).toFixed(1)}%</td></tr>
  <tr><td>重度</td><td>${(zoneAreas.severe||0).toFixed(1)}%</td></tr>
  <tr><td>空洞</td><td>${(zoneAreas.cavity||0).toFixed(1)}%</td></tr>
</table>` : ''}

<h2>6. 壁厚分析 / Wall Thickness</h2>
${wallThickness ? `
<table>
  <tr><th>指标</th><th>数值</th></tr>
  <tr><td>最小壁厚 / Min</td><td>${wallThickness.minThickness.toFixed(1)} cm</td></tr>
  <tr><td>最大壁厚 / Max</td><td>${wallThickness.maxThickness.toFixed(1)} cm</td></tr>
  <tr><td>平均壁厚 / Avg</td><td>${wallThickness.avgThickness.toFixed(1)} cm</td></tr>
</table>` : ''}

${cavityResult && cavityResult.regions.length > 0 ? `
<h2>7. 空洞检测 / Cavity Detection</h2>
<table>
  <tr><th>#</th><th>面积 cm²</th><th>等效直径 cm</th><th>质心位置</th></tr>
  ${cavityResult.regions.map(r => `
  <tr><td>${r.id}</td><td>${r.area.toFixed(1)}</td><td>${r.equivalentDiameter.toFixed(1)}</td>
  <td>(${r.centroid.x.toFixed(1)}, ${r.centroid.y.toFixed(1)})</td></tr>`).join('')}
</table>
<p>总空洞面积: ${cavityResult.totalCavityArea.toFixed(1)} cm² (${cavityResult.cavityRatio.toFixed(1)}%)</p>
` : ''}

<div class="footer">
  <p>Generated by Picus Tomography Analyzer | ${now}</p>
  <p>This report is for reference only. Professional arborist assessment is recommended.</p>
</div>

</body></html>`;
    }

    /** Open report in new window */
    openInNewWindow(html) {
        const win = window.open('', '_blank');
        win.document.write(html);
        win.document.close();
    }

    /** Export coefficients as JSON */
    exportCoefficients(coefficients) {
        const blob = new Blob([JSON.stringify(coefficients, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'decay_coefficients.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    /** Import coefficients from JSON file */
    async importCoefficients(file) {
        const text = await file.text();
        return JSON.parse(text);
    }
}
