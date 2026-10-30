// sun.mjs —— 太阳位置与日出日落（NOAA 简化算法，离线、零依赖）
// 精度：日出/日落约 ±1 分钟量级，用于游览时段与日照风险判定足够。
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export function dayOfYear(d) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / 86400000) + 1;
}

/** 儒略日 */
function julianDay(d) { return d.getTime() / 86400000 + 2440587.5; }

/** NOAA：均时差（分钟）与太阳赤纬（度） */
export function solarTerms(d) {
  const jd = julianDay(d);
  const n = jd - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * D2R;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  // 均时差 = 平太阳时 - 真太阳时
  let eqTime = 4 * R2D * ((L * D2R) - ra);
  eqTime = ((eqTime + 720 + 360) % 720) - 360; // 归一到 [-360,360) 分钟? 实际取 ±20 分钟
  return { eqTime, declination: dec, lambda };
}

/** 真太阳时 → UTC 分钟数 */
function trueSolarMinutes(dec, lat, lonDeg, eqTimeMin) {
  // 太阳时角（日出/日落，含 -0.833° 大气折射与日面半径）
  const cosH = (Math.sin(-0.833 * D2R) - Math.sin(lat * D2R) * Math.sin(dec)) /
               (Math.cos(lat * D2R) * Math.cos(dec));
  if (cosH > 1) return { polarNight: true, H: NaN };
  if (cosH < -1) return { polarDay: true, H: NaN };
  const H = Math.acos(cosH) * R2D;         // 度
  const solarNoonUTCmin = 720 - 4 * lonDeg - eqTimeMin; // 分钟（UTC）
  const halfDay = 4 * H;
  return { H, solarNoonUTCmin, sunriseUTCmin: solarNoonUTCmin - halfDay, sunsetUTCmin: solarNoonUTCmin + halfDay };
}

/** 返回该日、该地点的日出/日落（毫秒时间戳，UTC 基准，调用方自行时区换算） */
export function sunTimes(date, lon, lat) {
  const { eqTime, declination } = solarTerms(date);
  const base = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const r = trueSolarMinutes(declination, lat, lon, eqTime);
  if (r.polarNight || r.polarDay) return { polar: true, ...r };
  return {
    sunrise: base + r.sunriseUTCmin * 60000,
    sunset: base + r.sunsetUTCmin * 60000,
    solarNoon: base + r.solarNoonUTCmin * 60000,
    dayLengthMin: 8 * r.H,
    declination: declination * R2D,
    eqTime,
  };
}

/** 太阳高度角（度）与方位角（度，自北顺时针） */
export function sunPosition(date, lon, lat) {
  const { declination } = solarTerms(date);
  const jd = julianDay(date);
  const n = jd - 2451545.0;
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = (gmst * 15 + lon) * D2R;
  const { lambda } = solarTerms(date);
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const H = lst - ra;
  const la = lat * D2R;
  const alt = Math.asin(Math.sin(la) * Math.sin(declination) + Math.cos(la) * Math.cos(declination) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(declination) * Math.cos(la) - Math.sin(la) * Math.cos(H));
  return { altitude: alt * R2D, azimuth: (az * R2D + 360) % 360 };
}

/** 把 UTC 毫秒转成中国标准时间 HH:MM */
export function toCST(ms, offsetHours = 8) {
  const d = new Date(ms + offsetHours * 3600000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
