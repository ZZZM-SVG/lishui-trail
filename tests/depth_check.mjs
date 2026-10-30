// depth_check.mjs —— 校验三种游览深度偏好对行程节奏的影响
import { planTrip } from '../packages/lishui-trail-plugin/lib/engine.mjs';

const base = {
  persona: 'slow',
  interestText: '想走慢城水乡，看古村和老街，顺便体验非遗和乡野采摘',
  fitness: 'normal',
  durationMin: 300,
  startTime: '08:30',
  date: '2026-10-18',
  seed: 20261010,
};

for (const visitDepth of ['deep', 'balanced', 'wide']) {
  const res = planTrip({ profile: { ...base, visitDepth }, doVerify: true });
  if (!res.ok) { console.log(visitDepth, '不可行'); continue; }
  const M = res.route.metrics;
  console.log(
    `${visitDepth.padEnd(9)} 偏好=${M.depthPreferenceLabel.padEnd(7)} ` +
    `站数=${String(M.stopCount).padStart(2)} 深度=${M.depthStops} 打卡=${M.quickStops} ` +
    `目标深度占比≥${M.depthTargetPct}% 用时=${String(M.totalMin).padStart(3)}/${M.budgetMin}min ` +
    `收益=${M.totalProfit} 校验=${res.verification.summary}`
  );
}
