// climate.mjs —— 离线气候常态与气象风险指数
// 数据来源：南京市气象数据（平均数据统计区间 1991—2020，极端数据 1951 年至今），
//           经中国气象局公开常年值整理（维基百科"南京市"气候表）。
// 说明：本文件只做"由公开常年值推导的风险指数"，不含任何实时天气；实时天气需联网，
//       离线系统的定位是"常年风险基线 + 当日日照/时段风险"，这一点在使用说明中已注明。

export const CLIMATE_SOURCE = {
  name: '南京市气候常年值（1991—2020）',
  publisher: '中国气象局公开常年值 / 维基百科气候表',
  note: '月平均最高/最低气温、月降水量、平均降水日数（≥0.1mm）、平均相对湿度',
};

/** 月度常年值：tmax/tmean/tmin(°C)、precip(mm)、rainDays(日)、rh(%) */
export const MONTHLY = [
  { m: 1,  tmax: 7.4,  tmean: 3.1,  tmin: 0.0,  precip: 50.2,  rainDays: 9.2,  rh: 73 },
  { m: 2,  tmax: 10.1, tmean: 5.6,  tmin: 2.0,  precip: 53.5,  rainDays: 8.9,  rh: 71 },
  { m: 3,  tmax: 15.1, tmean: 10.1, tmin: 6.0,  precip: 79.7,  rainDays: 10.9, rh: 69 },
  { m: 4,  tmax: 21.4, tmean: 16.2, tmin: 11.6, precip: 82.4,  rainDays: 9.6,  rh: 68 },
  { m: 5,  tmax: 26.6, tmean: 21.5, tmin: 17.1, precip: 83.8,  rainDays: 9.9,  rh: 69 },
  { m: 6,  tmax: 29.2, tmean: 25.0, tmin: 21.4, precip: 193.4, rainDays: 10.6, rh: 76 },
  { m: 7,  tmax: 32.4, tmean: 28.4, tmin: 25.1, precip: 226.8, rainDays: 11.7, rh: 78 },
  { m: 8,  tmax: 31.9, tmean: 27.9, tmin: 24.8, precip: 158.5, rainDays: 12.1, rh: 79 },
  { m: 9,  tmax: 27.9, tmean: 23.7, tmin: 20.3, precip: 72.9,  rainDays: 7.8,  rh: 76 },
  { m: 10, tmax: 22.8, tmean: 18.0, tmin: 14.2, precip: 55.5,  rainDays: 7.3,  rh: 73 },
  { m: 11, tmax: 16.6, tmean: 11.5, tmin: 7.7,  precip: 52.3,  rainDays: 7.7,  rh: 74 },
  { m: 12, tmax: 10.0, tmean: 5.4,  tmin: 1.9,  precip: 35.0,  rainDays: 7.2,  rh: 71 },
];

export const EXTREMES = { maxTemp: 40.7, maxTempMonth: 8, minTemp: -14.0, minTempMonth: 1 };

const daysInMonth = (m, y = 2026) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const lin = (x, x0, x1) => Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));

/**
 * 由常年值推导气象风险分量（0~1，越大越不利）
 * - heat：中暑风险，按月平均最高气温
 * - cold：失温/结冰风险，按月平均最低气温
 * - rain：当日遇雨先验概率（降水日数占该月天数）
 * - convective：强对流潜势（降水强度 × 高温能量，6—8 月梅雨/台风季偏高）
 */
export function monthlyClimateRisk(month) {
  const row = MONTHLY[(month - 1 + 12) % 12];
  const pRain = row.rainDays / daysInMonth(row.m);
  const intensity = row.precip / Math.max(row.rainDays, 1);       // mm/雨日
  const heat = lin(row.tmax, 28, 37);
  const cold = lin(-row.tmin, -2, -8);
  const convective = Math.max(lin(intensity, 7, 20) * 0.7, 0) + lin(row.tmax, 27, 33) * 0.4;
  return {
    month: row.m,
    normals: row,
    rainProbability: Math.round(pRain * 100) / 100,
    heat: Math.round(heat * 100) / 100,
    cold: Math.round(cold * 100) / 100,
    convective: Math.round(Math.min(1, convective) * 100) / 100,
    uvStrong: row.m >= 5 && row.m <= 9,
    photoHours: Math.round((12 + Math.abs(row.tmax - 20) * 0.0) * 10) / 10,
  };
}

/** 某地点当月的出行气象提示（中文，供 Agent 与前端直接使用） */
export function climateAdvice(month) {
  const r = monthlyClimateRisk(month);
  const tips = [];
  if (r.heat > 0.5) tips.push(`月平均最高气温 ${r.normals.tmax}℃，午后需避热、备足饮水，建议 15:30 后减少爬升段`);
  if (r.heat > 0) tips.push(`历史极端最高 ${EXTREMES.maxTemp}℃（${EXTREMES.maxTempMonth}月）`);
  if (r.cold > 0.3) tips.push(`月平均最低气温 ${r.normals.tmin}℃，需防结冰路面与失温`);
  if (r.rainProbability > 0.3) tips.push(`平均降水日 ${r.normals.rainDays} 天/月，遇雨概率约 ${Math.round(r.rainProbability * 100)}%，建议携带雨具并预留机动时间`);
  if (r.convective > 0.5) tips.push('强对流潜势偏高（梅雨/台风季），避免山脊与空旷水岸长时间停留');
  if (r.uvStrong) tips.push('紫外线较强，注意防晒');
  return { ...r, tips };
}
