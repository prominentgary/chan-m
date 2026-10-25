// 生成手机端「多级别联立」简报样本（用真实 data/*.json，跑真实 algo 链路）
// 用法：node frontend/chan-m/_quad_sample.mjs sh588110
//
// 与线上唯一差异：data/*.json 里日线的 bars.time 是 'YYYY-MM-DD' 字符串，
// 而线上 fetchBars 返回的是 Unix 秒。algo.segmentStrength 用 `b.time >= seg.start.time`
// 取段内 K 线，字符串与数字比大小恒为 false ⇒ 日线力度会算成 0。
// 这不是线上 bug，是导出格式与运行时格式不同，所以脚本里先归一化再跑。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMACD } from './js/macd.js';
import {
  segmentStrength, computeZhongshuStrength, detectOneBuySell,
  detectTwoAndThreeBuySell, detectStrengthIndicators,
} from './js/algo.js';
import { computeHideBeforeDetail, getHigherPeriod } from './js/hide.js';
import { buildQuadBrief, pickQuadLevels } from './js/quad_brief.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const PERIODS = ['1m', '5m', '15m', '30m', '60m', 'day', 'week'];

function normBarTime(bars) {
  return (bars || []).map((b) => {
    if (typeof b.time === 'number') return b;
    const s = String(b.time).trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return { ...b, time: Math.floor(new Date(+m[1], +m[2] - 1, +m[3]).getTime() / 1000) };
    m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
    if (m) {
      return {
        ...b,
        time: Math.floor(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() / 1000),
      };
    }
    return b;
  });
}

const code = process.argv[2] || 'sh588110';
// 名称从 manifest 读（数据文件里没有 name 字段）
let secName = code;
try {
  const mf = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
  const hit = (mf.securities || []).find((x) => x.code === code);
  if (hit && hit.name) secName = hit.name;
} catch (e) { /* 读不到就退回代码 */ }
const avail = PERIODS.filter((p) => fs.existsSync(path.join(DATA, `${code}_${p}.json`)));
const drawings = {};
const barsByPeriod = {};
let a0Period = null;
let presetName = null;

for (const p of avail) {
  const j = JSON.parse(fs.readFileSync(path.join(DATA, `${code}_${p}.json`), 'utf8'));
  const bars = normBarTime(j.bars);
  computeMACD(bars);
  barsByPeriod[p] = bars;
  const pr = (j.presets || []).find((x) => x.id === (j.activePreset || 'default'));
  drawings[p] = {
    segments: pr ? (pr.segments || []) : (j.segments || []),
    zhongshus: pr ? (pr.zhongshus || []) : (j.zhongshus || []),
  };
  a0Period = a0Period || j.a0Period || null;
  presetName = presetName || j.presetName || null;
}

function computeStrengths(bars, segments, zhongshus) {
  const sorted = [...segments].sort((a, b) => a.start.time - b.start.time);
  let prevDir = null;
  sorted.forEach((s) => {
    s._strength = segmentStrength(bars, s, prevDir);
    if (s.direction !== 'horizontal') prevDir = s.direction;
  });
  computeZhongshuStrength(bars, segments, zhongshus);
  detectOneBuySell(segments, zhongshus);
  detectTwoAndThreeBuySell(segments, zhongshus);
  detectStrengthIndicators(segments, zhongshus);
}

const levelsWanted = pickQuadLevels(avail, drawings);
const levels = [];
for (const p of levelsWanted) {
  const bars = barsByPeriod[p] || [];
  const segs = JSON.parse(JSON.stringify(drawings[p].segments));
  const zss = JSON.parse(JSON.stringify(drawings[p].zhongshus));
  if (segs.length && bars.length) computeStrengths(bars, segs, zss);
  const hideBy = getHigherPeriod(p, avail);
  const higherSegs = (hideBy && drawings[hideBy] ? drawings[hideBy].segments : []) || [];
  const hb = computeHideBeforeDetail(higherSegs, hideBy, segs);
  levels.push({
    period: p,
    bars,
    segments: segs,
    zhongshus: zss,
    higherPeriod: hideBy || null,
    hideBefore: hb ? hb.hideBefore : null,
    hideHow: hb ? hb.how : null,
    anchorSeg: hb ? hb.anchor : null,
  });
  console.error(`[level] ${p}: 全图 ${segs.length} 段 / ${zss.length} 中枢`
    + ` | hideBy=${hideBy || '—'} hideBefore=${hb ? new Date(hb.hideBefore * 1000).toISOString().slice(0, 16) : '—'}`
    + ` (${hb ? hb.how : 'none'}) | bars=${bars.length}`);
}

const lastLv = levels[levels.length - 1];
const quote = lastLv && lastLv.bars.length
  ? { price: lastLv.bars[lastLv.bars.length - 1].close }
  : null;

const { title, text, warnings } = buildQuadBrief({
  code, name: secName, levels, a0Period, presetName, quote,
});

console.error(`\n[out] ${title} · ${text.length} 字符 / ${text.split('\n').length} 行`
  + (warnings.length ? ` · warnings=${warnings.join('；')}` : ''));
process.stdout.write(text);
