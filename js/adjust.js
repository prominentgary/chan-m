// adjust.js —— 前复权（forward adjustment），与后端 backend/adjust.py 算法一致
//
// 背景：腾讯 kline/mkline 接口返回"不复权"行情，证券发生 除权除息 /
// ETF 份额折算 时（如 588110 于 2026-07-20 份额折算，价格 ~2.5 → ~0.63），
// 价格会在跨交易日边界出现断层。
//
// 方案（两级）：
//   1. 优先用腾讯官方前复权日线推导"精确因子"：
//        factor(date) = qfq日线收盘(date) / 不复权日线收盘(date)
//      该因子已含该日之后所有除权事件的累积效应，乘到断层前的 K 线上
//      即与官方前复权曲线完全一致（用于分钟线，腾讯无 qfq 分钟接口）。
//   2. 网络失败时回退估算：断层处 开盘/昨收 比例链式累乘。
//
// 只调整价格（OHLC），成交量不变；输入不被修改。

// 断层判定阈值：ratio = 除权后开盘价 / 前一交易日收盘价
// 刻意避开 A 股 ±20% 涨跌停（ratio 0.8~1.2），降低正常波动误判。
const GAP_DOWN = 0.75;
const GAP_UP = 1.34;

const DAILY_PERIODS = new Set(['day', 'week', 'month', 'quarter', 'year']);

function pad(n) { return String(n).padStart(2, '0'); }

// K 线所属交易日 "YYYY-MM-DD"
function barDay(bar) {
  const d = new Date(bar.time * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 检测除权/折算断层点，返回 [{index, ratio}]：
// index 为断层后第一根 K 线下标，ratio = 该根 open / 前一交易日 close
export function detectAdjustPoints(bars, period) {
  const points = [];
  const isDaily = DAILY_PERIODS.has(period);
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1], cur = bars[i];
    // 分钟线只在跨交易日边界检测（除权只发生在交易日之间）
    if (!isDaily && barDay(prev) === barDay(cur)) continue;
    const prevClose = +prev.close, curOpen = +cur.open;
    if (!(prevClose > 0) || !(curOpen > 0)) continue;
    const ratio = curOpen / prevClose;
    if (ratio <= GAP_DOWN || ratio >= GAP_UP) points.push({ index: i, ratio });
  }
  return points;
}

// ---- 腾讯官方精确因子 ----
// 内存缓存：apiCode -> { ts, qmap, rmap }（date -> close）
const _mapCache = new Map();
const _MAP_TTL = 10 * 60 * 1000; // 10 分钟

async function fetchCloseMaps(apiCode) {
  const hit = _mapCache.get(apiCode);
  if (hit && Date.now() - hit.ts < _MAP_TTL) return hit;
  const qfqUrl = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${apiCode},day,,,800,qfq`;
  const rawUrl = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${apiCode},day,,,800`;
  const [qj, rj] = await Promise.all([
    fetch(qfqUrl).then((r) => r.json()),
    fetch(rawUrl).then((r) => r.json()),
  ]);
  const qarr = qj?.data?.[apiCode]?.qfqday || [];
  const rarr = rj?.data?.[apiCode]?.day || [];
  const qmap = new Map(qarr.map((k) => [String(k[0]), +k[2]]));
  const rmap = new Map(rarr.map((k) => [String(k[0]), +k[2]]));
  const entry = { ts: Date.now(), qmap, rmap };
  if (qmap.size && rmap.size) _mapCache.set(apiCode, entry);
  return entry;
}

// 取 map 中 key <= date 的最近一条（周线的 prev 日期可能非交易日）
function lookupLE(map, date) {
  if (map.has(date)) return map.get(date);
  let best = null;
  for (const k of map.keys()) if (k <= date && (best === null || k > best)) best = k;
  return best === null ? null : map.get(best);
}

// 每个断层点的精确累积因子；任一缺失返回 null（回退估算）
async function preciseSegFactors(apiCode, bars, points) {
  const { qmap, rmap } = await fetchCloseMaps(apiCode);
  if (!qmap.size || !rmap.size) return null;
  const out = [];
  for (const p of points) {
    const prevDate = barDay(bars[p.index - 1]);
    const qc = lookupLE(qmap, prevDate);
    const rc = lookupLE(rmap, prevDate);
    if (!(qc > 0) || !(rc > 0)) return null;
    out.push(qc / rc);
  }
  return out;
}

// ---- 应用 ----
function applySeg(bars, points, segFactors) {
  const n = points.length;
  let k = 0;
  return bars.map((b, j) => {
    while (k < n && points[k].index <= j) k++;
    const f = k < n ? segFactors[k] : 1.0;
    if (f === 1.0) return b;
    return {
      ...b,
      open: round3(b.open * f),
      high: round3(b.high * f),
      low: round3(b.low * f),
      close: round3(b.close * f),
    };
  });
}

function estimatedSegFactors(points) {
  const out = new Array(points.length);
  let cum = 1.0;
  for (let k = points.length - 1; k >= 0; k--) {
    cum *= points[k].ratio;
    out[k] = cum;
  }
  return out;
}

// 前复权（异步，优先官方精确因子）：无断层时原样返回同一引用
export async function applyForwardAdjustAsync(bars, period, apiCode) {
  if (!bars || bars.length < 2) return bars;
  const points = detectAdjustPoints(bars, period);
  if (!points.length) return bars;
  points.sort((a, b) => a.index - b.index);
  let segFactors = null;
  if (apiCode) {
    try { segFactors = await preciseSegFactors(apiCode, bars, points); } catch (e) {}
  }
  if (!segFactors) segFactors = estimatedSegFactors(points);
  return applySeg(bars, points, segFactors);
}

// 前复权（同步，仅估算因子），供无法异步的场景使用
export function applyForwardAdjust(bars, period) {
  if (!bars || bars.length < 2) return bars;
  const points = detectAdjustPoints(bars, period);
  if (!points.length) return bars;
  points.sort((a, b) => a.index - b.index);
  return applySeg(bars, points, estimatedSegFactors(points));
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}
