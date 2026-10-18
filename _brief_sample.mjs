// 生成手机端 AI 简报样本（用真实 data/*.json，跑真实 algo 链路）
// 用法：node frontend/chan-m/_brief_sample.mjs sh588110_5m sh588110_day ...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMACD } from './js/macd.js';
import {
  segmentStrength, computeZhongshuStrength, detectOneBuySell,
  detectTwoAndThreeBuySell, detectStrengthIndicators,
} from './js/algo.js';
import { buildBrief } from './js/ai_brief.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');

function load(key) {
  const p = path.join(DATA, `${key}.json`);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return j;
}

function prepare(j) {
  const bars = Array.isArray(j.bars) ? j.bars : [];
  computeMACD(bars);
  const segments = (j.presets?.find((p) => p.id === (j.activePreset || 'default'))?.segments)
    || j.segments || [];
  const zhongshus = (j.presets?.find((p) => p.id === (j.activePreset || 'default'))?.zhongshus)
    || j.zhongshus || [];
  const segs = JSON.parse(JSON.stringify(segments));
  const zss = JSON.parse(JSON.stringify(zhongshus));

  // 与 app.js::computeStrengths 完全同序
  const sorted = [...segs].sort((a, b) => a.start.time - b.start.time);
  let prevDir = null;
  sorted.forEach((s) => {
    s._strength = segmentStrength(bars, s, prevDir);
    if (s.direction !== 'horizontal') prevDir = s.direction;
  });
  computeZhongshuStrength(bars, segs, zss);
  detectOneBuySell(segs, zss);
  detectTwoAndThreeBuySell(segs, zss);
  detectStrengthIndicators(segs, zss);

  return { bars, segments: segs, zhongshus: zss };
}

const keys = process.argv.slice(2);
const stamp = Math.floor(Date.now() / 1000);
const chunks = [];
for (const key of keys) {
  const j = load(key);
  const { bars, segments, zhongshus } = prepare(j);
  const { text } = buildBrief({
    code: j.code, name: j.name || j.code, period: j.period,
    bars, segments, zhongshus,
    quote: bars.length ? { price: bars[bars.length - 1].close } : null,
    a0Period: j.a0Period, presetName: j.presetName, nowSec: stamp,
  });
  chunks.push(text);
  console.error(`${key}: ${text.length} 字符 / ${text.split('\n').length} 行`);
}
process.stdout.write(chunks.join('\n\n---\n\n'));
