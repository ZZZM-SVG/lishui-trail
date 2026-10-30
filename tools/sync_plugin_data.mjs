// sync_plugin_data.mjs —— 把烘焙好的离线数据同步进插件包，使 packages/lishui-trail-plugin
// 成为可直接安装的自包含快照（AGH 安装插件时不保证能读到包外的文件）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'data');
const DST = path.join(ROOT, 'packages', 'lishui-trail-plugin', 'data');

const KEEP = ['pois.json', 'pois.mjs', 'water.json', 'dem.bin', 'dem.json', 'osm.json', 'checksums.json'];

fs.mkdirSync(DST, { recursive: true });
let total = 0;
const copied = [];
for (const f of KEEP) {
  const s = path.join(SRC, f);
  if (!fs.existsSync(s)) { console.log(`跳过（不存在）：${f}`); continue; }
  fs.copyFileSync(s, path.join(DST, f));
  const sz = fs.statSync(s).size;
  total += sz;
  copied.push(`${f} (${(sz / 1024).toFixed(0)} KB)`);
}
// 记录同步时间与内容校验，便于溯源
const manifest = {
  syncedAt: new Date().toISOString(),
  from: 'lishui-trail/data',
  to: 'packages/lishui-trail-plugin/data',
  files: copied,
  totalBytes: total,
};
fs.writeFileSync(path.join(DST, 'bundle_manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`已同步 ${copied.length} 个文件，共 ${(total / 1024 / 1024).toFixed(2)} MB → ${DST}`);
console.log(copied.join('\n'));
