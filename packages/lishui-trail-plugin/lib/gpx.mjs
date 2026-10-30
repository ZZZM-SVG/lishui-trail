// gpx.mjs —— 导出 GPX 1.1（含航点、轨迹、风险与画像扩展）
// 用途：把规划结果落到户外设备/手机离线地图，是"设备/外部系统对接"的最小可验证出口。
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function toGpx({ P, route, risk, meta }) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<gpx version="1.1" creator="lishui-trail (AGH plugin, offline)"');
  L.push('     xmlns="http://www.topografix.com/GPX/1/1"');
  L.push('     xmlns:lt="https://lishui-trail.local/gpx/1"');
  L.push('     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
  L.push('     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">');
  L.push('  <metadata>');
  L.push(`    <name>${esc(`诗画溧水·水韵慢城 · ${route.itinerary.length - 1} 个停靠点`)}</name>`);
  L.push(`    <desc>${esc(`个性化画像：${P.interestLabels.slice(0, 4).map((x) => x.label).join('/')}；体能 ${P.fitnessLabel}；时间预算 ${P.durationMin} 分钟`)}</desc>`);
  L.push(`    <time>${now}</time>`);
  L.push('    <extensions>');
  L.push(`      <lt:dataSource>${esc(meta.dataset)} / ${esc(meta.source)}</lt:dataSource>`);
  L.push(`      <lt:dataSha256>${esc(meta.sourceSha256)}</lt:dataSha256>`);
  L.push(`      <lt:riskScore>${risk ? risk.score : ''}</lt:riskScore>`);
  L.push(`      <lt:riskLevel>${esc(risk ? risk.level : '')}</lt:riskLevel>`);
  L.push(`      <lt:totalDistanceM>${route.metrics.totalDistanceM}</lt:totalDistanceM>`);
  L.push(`      <lt:totalAscentM>${route.metrics.totalAscentM}</lt:totalAscentM>`);
  L.push(`      <lt:totalMin>${route.metrics.totalMin}</lt:totalMin>`);
  L.push(`      <lt:solverSeed>${P.seed}</lt:solverSeed>`);
  L.push('    </extensions>');
  L.push('  </metadata>');

  for (const s of route.itinerary) {
    L.push(`  <wpt lat="${s.lat}" lon="${s.lon}">`);
    L.push(`    <name>${esc(s.name)}</name>`);
    L.push(`    <desc>${esc(`${s.type}｜${s.town}｜${s.arriveMin}—${s.departMin} 分钟｜收益 ${s.profit}${s.seasonalMismatch ? '｜季节性需确认' : ''}`)}</desc>`);
    L.push(`    <extensions>`);
    L.push(`      <lt:poiId>${esc(s.poiId)}</lt:poiId>`);
    L.push(`      <lt:dwellMin>${s.dwellMin}</lt:dwellMin>`);
    L.push(`      <lt:profit>${s.profit}</lt:profit>`);
    L.push(`      <lt:elevationM>${s.elevationM}</lt:elevationM>`);
    L.push(`    </extensions>`);
    L.push('  </wpt>');
  }

  L.push('  <trk>');
  L.push('    <name>规划轨迹</name>');
  L.push('    <trkseg>');
  for (const c of route.coords) {
    const e = c.e ?? null;
    L.push(`      <trkpt lat="${c.lat.toFixed(6)}" lon="${c.lon.toFixed(6)}">${e != null ? `<ele>${e}</ele>` : ''}</trkpt>`);
  }
  L.push('    </trkseg>');
  L.push('  </trk>');
  L.push('</gpx>');
  return L.join('\n');
}

/** CSV 行程单（便于打印/表格核对） */
export function toItineraryCsv({ P, route, risk }) {
  const rows = [['序号', '停靠点', '类型', '镇/街道', '经度', '纬度', '抵达(分钟)', '离开(分钟)', '停留(分钟)', '收益', '匹配兴趣', '高程(m)']];
  route.itinerary.forEach((s, i) => {
    rows.push([i, s.name, s.type, s.town, s.lon, s.lat, s.arriveMin, s.departMin, s.dwellMin,
               s.profit, (s.matched || []).join('/'), s.elevationM]);
  });
  rows.push([]);
  rows.push(['合计', `${route.metrics.stopCount} 个停靠点`, '', '', '', '',
             '', '', route.metrics.totalDwellMin, route.metrics.totalProfit, '', '']);
  rows.push(['步行', `${route.metrics.totalWalkMin} 分钟`, `${route.metrics.totalDistanceM} m`,
             `爬升 ${route.metrics.totalAscentM} m`, `下降 ${route.metrics.totalDescentM} m`,
             `最大坡度 ${route.metrics.maxSlopeDeg}°`, '', '', '', '', '', '']);
  if (risk) rows.push(['风险', `${risk.score}/100（${risk.level}）`, risk.advice, '', '', '', '', '', '', '', '', '']);
  return rows.map((r) => r.map((x) => {
    const s = String(x ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
}
