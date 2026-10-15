// algo.js —— 段的力度、中枢对比、背驰与买卖点（1B/1S）计算
// 与桌面端 drawing.js 算法对齐，输入归一化 bars + 段/中枢结构

// 取 [startSec, endSec] 区间内的 bars
function sliceBars(bars, startSec, endSec) {
  return bars.filter((b) => b.time >= startSec && b.time <= endSec);
}

function isSegConnected(a, b) {
  if (!a || !b) return false;
  return a.end.time === b.start.time && Math.abs(a.end.price - b.start.price) < 1e-3;
}

// 段内 K 线区间（段的时间范围内所有 K 线的最高/最低价）
function getSegmentBarsRange(bars, seg) {
  const sub = sliceBars(bars, seg.start.time, seg.end.time);
  if (!sub.length) return null;
  return {
    low: Math.min(...sub.map((b) => b.low)),
    high: Math.max(...sub.map((b) => b.high)),
  };
}

// ===== 中枢识别：与桌面端 drawing.js 的 _detectZhongshu 完全对齐 =====
// 判定链（与桌面一致）：
//   1) 从目标段出发，沿「同周期首尾相连」找后两段（共 3 段）；
//   2) 重叠区间只用「段内 K 线」的最高/最低（桌面正式条款，不再回退端点价格），
//      取不到段内 K 线时视为不可识别（与桌面一致）；
//   3) 方向约束（_isZhongshuDirectionAllowed 的移植）：以「本级别线段」（更高一级
//      周期的段，即桌面图上的虚线）为参照容器——
//        · 首段两端点都落在某条本级别线段时间范围内 → 方向必须与该线段相反；
//        · 首段至少一个端点落在所有本级别线段之外 → 与最近的本级别线段方向相同；
//        · 图中没有本级别线段 → 方向必须与最左同周期段相反。
// 返回 { segmentIds, baseSegmentIds, overlapLow, overlapHigh, isKlineZhongshu, startTime, endTime }
export function detectZhongshu(segments, startIdx, bars = null, opts = {}) {
  if (!segments || startIdx < 0) return null;
  const sorted = [...segments].sort((a, b) => a.start.time - b.start.time);
  if (startIdx + 2 >= sorted.length) return null;
  const line1 = sorted[startIdx];
  const line2 = findNextConnectedSeg(sorted, line1);
  if (!line2) return null;
  const line3 = findNextConnectedSeg(sorted, line2);
  if (!line3) return null;

  const r1 = getSegmentBarsRange(bars, line1);
  const r2 = getSegmentBarsRange(bars, line2);
  const r3 = getSegmentBarsRange(bars, line3);
  if (!r1 || !r2 || !r3) return null;
  const overlapLow = Math.max(r1.low, r2.low, r3.low);
  const overlapHigh = Math.min(r1.high, r2.high, r3.high);
  if (overlapLow > overlapHigh) return null;

  if (!zhongshuDirectionAllowed(sorted, opts.containers || [], line1)) return null;

  const o1 = segOrderedEnds(line1);
  const o3 = segOrderedEnds(line3);
  return {
    segmentIds: [line1.id, line2.id, line3.id],
    baseSegmentIds: [line1.id, line2.id, line3.id],
    overlapLow,
    overlapHigh,
    isKlineZhongshu: true,
    startTime: o1.start.time,
    endTime: o3.end.time,
  };
}

// 沿「首尾相连」找其后一段（口径同桌面 _findNextConnectedLine，按传入池的顺序取首个命中）
function findNextConnectedSeg(pool, seg) {
  const e = segOrderedEnds(seg);
  if (!e) return null;
  for (const s of pool || []) {
    if (s === seg || !s.start || !s.end) continue;
    const se = segOrderedEnds(s);
    if (se && samePoint(se.start.time, se.start.price, e.end.time, e.end.price)) return s;
  }
  return null;
}

// 中枢方向约束（桌面 _isZhongshuDirectionAllowed 的移植）
function zhongshuDirectionAllowed(peers, containers, lineA) {
  const selfDir = segDirSign(lineA);
  const a = segOrderedEnds(lineA);
  if (!a) return false;
  const aLeft = a.start.time, aRight = a.end.time;
  const cs = containers || [];

  // 规则3：图中无本级别线段 → 与最左同周期段方向相反
  if (!cs.length) {
    let leftmost = null;
    for (const p of peers) {
      const o = segOrderedEnds(p);
      if (!o) continue;
      if (!leftmost || o.start.time < segOrderedEnds(leftmost).start.time) leftmost = p;
    }
    if (!leftmost) return true;
    return segDirSign(leftmost) !== selfDir;
  }

  // 规则1：首段两端点都在某条本级别线段内（含与端点重合）→ 方向相反
  for (const c of cs) {
    const o = segOrderedEnds(c);
    if (!o) continue;
    if (aLeft >= o.start.time && aRight <= o.end.time) return segDirSign(c) !== selfDir;
  }

  // 规则2：首段有端点落在所有本级别线段之外 → 与最近的本级别线段方向相同
  let nearest = null;
  let nearestGap = Infinity;
  for (const c of cs) {
    const o = segOrderedEnds(c);
    if (!o) continue;
    let gap = 0;
    if (aRight < o.start.time) gap = o.start.time - aRight;
    else if (aLeft > o.end.time) gap = aLeft - o.end.time;
    if (gap < nearestGap) { nearestGap = gap; nearest = c; }
  }
  if (nearest) return segDirSign(nearest) === selfDir;
  return true;
}

// ===== 中枢延伸：与桌面端「一步延伸到上限」对齐（右键「延伸」/Tab）=====
// 上限规则（_computeZhongshuUpperLimitOnChain 的普通中枢分支，基础段数 3）：
//   区间取基础 3 段的 [lower, upper]，方向 = 首段方向；从第 3 段起顺链扫描
//   「首个干净的第 3 类买卖点」——突破段 P（终点越出区间）之后，下一段 C 的终点也在
//   区间外且同侧（回抽确认）：
//     同向（首段向上∩向上突破=3买；首段向下∩向下突破=3卖）→ 上限段 = P（允许包含）；
//     反向（首段向上∩向下突破=3卖；首段向下∩向上突破=3买）→ 上限段 = C 的前一段。
//   8 段内找不到干净 3 类点（自由震荡）→ 上限 = 基础段起第 8 段（相对 +5 段，绝对封顶）。
// 中间档位（_computeZhongshuExtendStopIndex 的移植）：
//   中枢整体落在某条本级别线段时间范围内时，先停到「以该线段终点为终点的本周期线段的
//   起点」所在段；存在多个档位时取最近的一个。
// 返回 { chain, base0, currentIdx, limitIdx, stopIdx, toStop, targetIdx, segmentIds }；
// 不可延伸（已到上限 / 链不完整）返回 null
const EXTEND_MAX_SEGMENTS = 5; // 与桌面 ZHONGSHU_EXTEND_MAX_SEGMENTS 一致

export function computeZhongshuExtend(segments, zs, opts = {}) {
  const all = (segments || []).filter((s) => s && s.start && s.end);
  if (!zs || all.length < 3) return null;
  const byId = {};
  all.forEach((s) => { byId[s.id] = s; });

  const zsSegs = (zs.segmentIds || [])
    .map((id) => byId[id])
    .filter(Boolean)
    .sort((a, b) => a.start.time - b.start.time);
  if (zsSegs.length < 3) return null;
  // 基础段 = 原始 3 段（baseSegmentIds 优先；兼容旧数据按时间取前 3 段）
  let base3 = (zs.baseSegmentIds || []).map((id) => byId[id]).filter(Boolean);
  if (base3.length !== 3) base3 = zsSegs.slice(0, 3);
  base3.sort((a, b) => a.start.time - b.start.time);

  const baseFirst = base3[0];
  const lastSeg = zsSegs[zsSegs.length - 1];
  const chain = buildConnectedChain(all, baseFirst);
  const base0 = chain.findIndex((s) => s.id === baseFirst.id);
  const currentIdx = chain.findIndex((s) => s.id === lastSeg.id);
  if (base0 < 0 || currentIdx < 0) return null;

  const range = zhongshuBaseRange(base3, opts.bars);
  if (!range) return null;

  const limitIdx = computeExtendLimitIdx(all, chain, base0, 3, range.low, range.high);
  if (limitIdx <= currentIdx) return null; // 已达延伸上限

  const leftSec = Math.min(segOrderedEnds(zsSegs[0]).start.time, segOrderedEnds(zsSegs[0]).end.time);
  const rightSec = Math.max(segOrderedEnds(lastSeg).start.time, segOrderedEnds(lastSeg).end.time);
  const stopIdx = computeExtendStopIdx(all, chain, currentIdx, leftSec, rightSec, opts.containers || []);
  const toStop = stopIdx > currentIdx && stopIdx < limitIdx;
  const targetIdx = toStop ? stopIdx : limitIdx;
  return {
    chain,
    base0,
    currentIdx,
    limitIdx,
    stopIdx,
    toStop,
    targetIdx,
    segmentIds: chain.slice(base0, targetIdx + 1).map((s) => s.id),
  };
}

// 中枢基础区间的 [low, high]：与识别口径一致用段内 K 线；取不到时退回端点价
function zhongshuBaseRange(base3, bars) {
  const rs = base3.map((s) => getSegmentBarsRange(bars, s));
  if (rs.every(Boolean)) {
    return {
      low: Math.max(...rs.map((r) => r.low)),
      high: Math.min(...rs.map((r) => r.high)),
    };
  }
  const lows = base3.map((s) => Math.min(s.start.price, s.end.price));
  const highs = base3.map((s) => Math.max(s.start.price, s.end.price));
  const low = Math.max(...lows);
  const high = Math.min(...highs);
  if (low > high) return null;
  return { low, high };
}

// 上限段索引（桌面 _computeZhongshuUpperLimitOnChain 的移植）
function computeExtendLimitIdx(all, chain, base0, baseSegCount, lower, upper) {
  const first = segOrderedEnds(chain[base0]);
  if (!first) return -1;
  const dirUp = first.end.price > first.start.price;

  // 绝对上限：最后一个基础段再向右 EXTEND_MAX_SEGMENTS 段
  const absCap = base0 + (baseSegCount - 1) + EXTEND_MAX_SEGMENTS;
  const maxSegNo = baseSegCount + EXTEND_MAX_SEGMENTS;

  // 顺链补齐后续段（连通链通常已到末段，此处防御性补齐）
  while (chain.length < absCap + 2) {
    const nx = findNextConnectedSeg(all, chain[chain.length - 1]);
    if (!nx || chain.indexOf(nx) !== -1) break;
    chain.push(nx);
  }

  let limitIdx = absCap;
  for (let idx = base0 + baseSegCount - 1; idx + 1 < chain.length; idx++) {
    if ((idx - base0 + 1) > maxSegNo) break; // 超过封顶段号再出现的3类点也回落封顶
    const p = segOrderedEnds(chain[idx]);
    const c = segOrderedEnds(chain[idx + 1]);
    if (!p || !c) break;
    const breakUp = p.end.price > upper && c.end.price > upper;
    const breakDown = p.end.price < lower && c.end.price < lower;
    if (!breakUp && !breakDown) continue;
    const tSeg = (idx - base0) + 1; // 突破段号
    const n = tSeg + 1;             // 回抽确认段号
    const same = (dirUp && breakUp) || (!dirUp && breakDown);
    const limitSeg = same ? (n - 1) : (n - 2);
    limitIdx = Math.min(base0 + (limitSeg - 1), absCap);
    break;
  }
  // 防御：上限索引不能越过链实际长度（右侧段不足时封顶到链末段）
  if (limitIdx >= chain.length) limitIdx = chain.length - 1;
  return limitIdx;
}

// 中间档位段索引：中枢整体落在某条本级别线段内时，取其终点处本周期线段的起点所在段
function computeExtendStopIdx(all, chain, currentIdx, zsLeft, zsRight, containers) {
  if (!containers.length) return -1;
  let best = -1;
  for (const c of containers) {
    const o = segOrderedEnds(c);
    if (!o) continue;
    // 中枢整体落在该本级别线段内：左边在起点之后、右边在终点之前
    if (!(zsLeft > o.start.time && zsRight < o.end.time)) continue;
    // 以该线段终点为终点的本周期线段（1 秒容差，共享顶点防浮点误差）
    let endSeg = null;
    let bestDiff = Infinity;
    for (const s of all) {
      const so = segOrderedEnds(s);
      if (!so) continue;
      const diff = Math.abs(so.end.time - o.end.time);
      if (diff < bestDiff) { bestDiff = diff; endSeg = s; }
    }
    if (!endSeg || bestDiff > 1) continue;
    const stopSec = segOrderedEnds(endSeg).start.time;
    const idx = findChainIndexByEndTime(chain, stopSec);
    if (idx < 0 || idx <= currentIdx) continue;
    if (best < 0 || idx < best) best = idx;
  }
  return best;
}

// 链中「终点时间等于 sec」的段索引（1 秒容差）；找不到返回 -1
function findChainIndexByEndTime(chain, sec) {
  for (let i = 0; i < chain.length; i++) {
    const o = segOrderedEnds(chain[i]);
    if (o && Math.abs(o.end.time - sec) <= 1) return i;
  }
  return -1;
}

// 计算单段力度（与桌面端对齐：按段方向累加 MACD 柱，上涨累加正值，下跌累加负值，最后放大 10000 倍）
export function segmentStrength(bars, seg, prevDir = null) {
  const sub = sliceBars(bars, seg.start.time, seg.end.time);
  if (sub.length < 2) return { macdArea: 0, priceChangePct: 0, slope: 0, barCount: sub.length };

  const dir = seg.direction;
  let macdArea = 0;
  if (dir === 'up') {
    macdArea = sub.reduce((a, b) => a + (b.macd > 0 ? b.macd : 0), 0);
  } else if (dir === 'down') {
    macdArea = sub.reduce((a, b) => a + (b.macd < 0 ? b.macd : 0), 0);
  } else {
    // 水平段参考前一段方向：前一段上涨则累加负柱，前一段下跌则累加正柱
    if (prevDir === 'up') {
      macdArea = sub.reduce((a, b) => a + (b.macd < 0 ? b.macd : 0), 0);
    } else if (prevDir === 'down') {
      macdArea = sub.reduce((a, b) => a + (b.macd > 0 ? b.macd : 0), 0);
    }
  }
  macdArea *= 10000;

  const priceChangePct = ((seg.end.price - seg.start.price) / seg.start.price) * 100;
  const slope = (seg.end.price - seg.start.price) / sub.length;
  return {
    macdArea: +macdArea.toFixed(4),
    priceChangePct: +priceChangePct.toFixed(2),
    slope: +slope.toFixed(4),
    barCount: sub.length,
  };
}

// 普通 strength indicator（与 PC 端 drawing.js 判断逻辑对齐，展示形式按移动端要求）
// 仅对时间最新的“当前段”计算：
//   - 当前段 b 起点连接中枢右边界：参考段 a = 该中枢之前的进入段
//   - 否则：a = b 的上上段
// b 力度 < a 力度 → 力度减弱，否则力度增强
export function detectStrengthIndicators(segments, zhongshus) {
  if (!segments || !segments.length) return;
  const segMap = {};
  segments.forEach((s) => {
    segMap[s.id] = s;
    delete s._strengthIndicator;
  });

  // 只给时间最新的当前段计算
  const sorted = [...segments].sort((a, b) => (a.start?.time ?? 0) - (b.start?.time ?? 0));
  const current = sorted[sorted.length - 1];
  if (!current) return;

  const chains = buildLineChains(segments);
  const zsList = zhongshus || [];

  let chain = null;
  let idx = -1;
  for (const c of chains) {
    const i = c.findIndex((l) => l.id === current.id);
    if (i >= 0) {
      chain = c;
      idx = i;
      break;
    }
  }
  if (!chain || idx < 0) return;

  const b = current;
  const bStr = b._strength || { macdArea: 0 };
  let a = null;

  // 当前段起点是否连接某个中枢的右边界
  if (idx > 0) {
    for (const zs of zsList) {
      const ids = zs.segmentIds || [];
      if (ids.length < 3) continue;
      const lastSeg = segMap[ids[ids.length - 1]];
      if (!lastSeg || lastSeg.end.time !== b.start.time) continue;
      // 参考段取该中枢之前的进入段
      const firstSeg = segMap[ids[0]];
      if (!firstSeg) continue;
      const firstIdx = chain.findIndex((l) => l.id === firstSeg.id);
      if (firstIdx > 0) a = chain[firstIdx - 1];
      break;
    }
  }

  // 未连中枢，使用上上段
  if (!a && idx >= 2) {
    a = chain[idx - 2];
  }

  if (!a) return;

  const aStr = a._strength || { macdArea: 0 };
  const isWeaker = Math.abs(bStr.macdArea) < Math.abs(aStr.macdArea);
  b._strengthIndicator = isWeaker ? '减弱' : '增强';
}

// 中枢进出段力度比较
// 与 PC 端对齐：如果当前段起点连接中枢，则与中枢前一段比较
export function computeZhongshuStrength(bars, segments, zhongshus) {
  if (!zhongshus || !zhongshus.length) return;
  // 按时间排序
  const sorted = [...segments].sort((a, b) => a.start.time - b.start.time);
  const segMap = {};
  segments.forEach((s) => { segMap[s.id] = s; });

  zhongshus.forEach((zs) => {
    const ids = zs.segmentIds || [];
    // 找到中枢内的段和中枢外的段
    const zsSegs = ids.map((id) => segMap[id]).filter(Boolean);
    if (zsSegs.length < 3) return;

    zsSegs.sort((a, b) => a.start.time - b.start.time);
    const zsStart = zsSegs[0].start.time;
    // 中枢右边界用自带 endTime（= 矩形右边界），兼容中枢向右延伸
    const zsEnd = zhongshuRightTime(zs, segMap) ?? zsSegs[zsSegs.length - 1].end.time;
    const zsIds = new Set(ids);

    // 找到中枢前一段（进入段）和中枢后一段（离开段）
    const nonZs = sorted.filter((s) => !zsIds.has(s.id));
    let enterSeg = null;  // 进入中枢的段（中枢前最后一段）
    let leaveSeg = null;  // 离开中枢的段（中枢后第一段）

    for (const s of nonZs) {
      if (s.end.time <= zsStart) {
        if (!enterSeg || s.end.time > enterSeg.end.time) enterSeg = s;
      }
      // 离开段：起点时间精确等于中枢右边界（首尾相连），与 detectOneBuySell 口径一致
      if (s.start.time === zsEnd && !leaveSeg) {
        leaveSeg = s;
      }
    }

    if (enterSeg && leaveSeg) {
      const enterStr = enterSeg._strength || { macdArea: 0 };
      const leaveStr = leaveSeg._strength || { macdArea: 0 };
      zs._enterStrength = enterStr;
      zs._leaveStrength = leaveStr;
      zs._strengthCompare = Math.abs(leaveStr.macdArea) < Math.abs(enterStr.macdArea)
        ? '力度减弱'
        : '力度增强';
    }
  });
}

// 一类买卖点（1B/1S）检测
// 与 PC 端对齐：
//   1B：中枢是趋势中最后一个（不与前中枢重叠），离开段力度 < 进入段力度，离开段方向向下
//   1S：中枢是趋势中最后一个（不与前中枢重叠），离开段力度 < 进入段力度，离开段方向向上
// 三类点的**回试段**定位（与 L1 `chan_semantics._detect_third_point` 及桌面版
// `_findThirdClassPoints` 同口径）：沿同线型段链从「末构成段之后」逐段扫描，
// 取**首个**「离开段越过边界 + 紧随回试不重回中枢区间」的配对，返回回试段。
// `dir` ＝ 离开方向（-1 向下＝三卖，1 向上＝三买）。不成立返回 null。
// 抽成公共函数：`detectOneBuySell`（需要三类点来定位一类点的第二个候选）与
// `detectTwoAndThreeBuySell`（标 3B/3S）共用同一判定，避免两份实现漂移。
function thirdRetestSeg(chain, range, baseIds, dir) {
  if (!range || !Array.isArray(baseIds) || !baseIds.length) return null;
  const lastBaseIdx = chain.findIndex((s) => s.id === baseIds[baseIds.length - 1]);
  if (lastBaseIdx < 0) return null;
  for (let k = lastBaseIdx + 1; k + 1 < chain.length; k++) {
    const p = chain[k];
    const pd = segDirSign(p);
    if (pd !== dir) continue;
    const pe = segOrderedEnds(p);
    if (!pe) continue;
    if (dir < 0 ? !(pe.end.price < range.low) : !(pe.end.price > range.high)) continue;
    const c = chain[k + 1];
    const cd = segDirSign(c);
    if (cd === 0 || cd === pd) continue;
    const ce = segOrderedEnds(c);
    if (!ce) continue;
    const cLow = Math.min(ce.start.price, ce.end.price);
    const cHigh = Math.max(ce.start.price, ce.end.price);
    if (dir < 0 ? (cHigh <= range.low) : (cLow >= range.high)) return c;
  }
  return null;
}

export function detectOneBuySell(segments, zhongshus) {
  if (!zhongshus || !zhongshus.length) return;
  const segMap = {};
  segments.forEach((s) => {
    segMap[s.id] = s;
    // 清除旧买卖点标记，避免缓存/历史数据残留
    delete s._buySell;
    delete s._bsLabel;
    delete s._bsColor;
    delete s._bsZsId;
  });

  // 一类买卖点：**与 L1 `chan_semantics` 及桌面版 `_findAllTradingPoints` 同口径**
  // （2026-10-14 裁决「让前端对齐 L1」）。
  //   ① 参与判定的中枢：构成段齐 3 根、且**区间不退化**（ZG > ZD）。退化矩形不是中枢。
  //   ② 趋势前提：中枢按**矩形左边界时间**升序，**相邻两两区间互不重叠**且**方向一致**
  //      （后中枢 low > 前中枢 high ⇒ up；后中枢 high < 前中枢 low ⇒ down）；
  //      任一对重叠 / 方向不一致 ⇒ 非趋势。中枢数 < 2 ⇒ 盘整，不构成趋势。
  //   ③ 一类点只标在**最后一个中枢**上（L1 只在最后一个中枢上渲染一类/二类点）。
  //   ④ 离开段 = 该中枢**矩形右边界之后**（起点时间 ≥ 右边界）、同向、且终点越过 ZG/ZD 的段中
  //      **时间最早**的一段。**不要求「起点时间精确等于右边界」** —— 中枢向右延伸、
  //      或段链存在时间缺口时，精确锚定会找不到离开段而漏标（旧实现即因此漏标）。
  //   ⑤ 进入段 = 该中枢**构成首段起点之前**的最后一段（= L1 的 entry_index）。
  //   ⑥ 背驰：进入段与离开段**方向一致**，且 |离开段力度| < |进入段力度|。
  const zsList = [];
  for (const zs of zhongshus || []) {
    const range = zhongshuRangeLowHigh(zs, segMap);
    if (!range || !(range.high > range.low)) continue;   // 区间退化 / 无法取值 → 不是中枢
    const t0 = Number.isFinite(zs.startTime) ? zs.startTime : null;
    if (t0 === null) continue;
    zsList.push({ zs, t0, range });
  }
  if (zsList.length < 2) return;                          // 盘整，不构成趋势
  zsList.sort((a, b) => a.t0 - b.t0);

  // ② 趋势前提
  let trendDir = null;
  for (let i = 1; i < zsList.length; i++) {
    const r1 = zsList[i - 1].range, r2 = zsList[i].range;
    let d = null;
    if (r2.low > r1.high) d = 'up';
    else if (r2.high < r1.low) d = 'down';
    if (!d || (trendDir && trendDir !== d)) return;        // 重叠或方向不一致 → 非趋势，整体不标
    trendDir = d;
  }

  // ③ 只判最后一个中枢
  const lastEntry = zsList[zsList.length - 1];
  const last = lastEntry.zs;
  const lastRange = lastEntry.range;
  const right = zhongshuRightTime(last, segMap);
  if (right === null) return;
  const base = (Array.isArray(last.baseSegmentIds) && last.baseSegmentIds.length === 3)
    ? last.baseSegmentIds : null;
  if (!base) return;                                      // 构成段不可知 → 无锚点，不判
  const lastSegs = new Set(last.segmentIds || []);

  // ④ 离开段：右边界之后、同向、越过边界者中时间最早的一段
  const pickLeave = (dir, bound, above) => {
    let best = null, bestKey = null;
    for (const s of segments) {
      if (lastSegs.has(s.id)) continue;
      const d = segDirSign(s);
      if (d !== dir) continue;
      const so = segOrderedEnds(s);
      if (!so) continue;
      if (so.start.time < right) continue;
      if (above ? !(so.end.price > bound) : !(so.end.price < bound)) continue;
      const key = [so.start.time, so.end.time];
      if (best === null || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
        best = s; bestKey = key;
      }
    }
    return best;
  };

  // ⑤ 进入段：构成首段起点之前、时间上最后的一段
  const firstSeg = segMap[base[0]];
  if (!firstSeg) return;
  const firstStart = Math.min(firstSeg.start.time, firstSeg.end.time);
  let enterSeg = null, enterEnd = -Infinity;
  for (const s of segments) {
    const so = segOrderedEnds(s);
    if (!so) continue;
    if (so.end.time > firstStart) continue;
    if (so.end.time > enterEnd) { enterSeg = s; enterEnd = so.end.time; }
  }
  if (!enterSeg) return;
  const enterStr = enterSeg._strength && enterSeg._strength.macdArea;
  if (!Number.isFinite(enterStr)) return;

  // ⑥ 背驰判定
  const tryLeave = (code, label, color, leave) => {
    if (!leave) return;
    if (segDirSign(enterSeg) !== segDirSign(leave)) return;
    const s = leave._strength && leave._strength.macdArea;
    if (!Number.isFinite(s) || Math.abs(s) >= Math.abs(enterStr)) return;
    leave._buySell = code;
    leave._bsLabel = label;
    leave._bsColor = color;
    leave._bsZsId = last.id;
  };

  // ⑦ 候选位置：一类点有**两个**候选（原文 buy-sell-points.md §三）
  //    · 候选一＝最后一个中枢之后**首个**越过边界的同向段
  //      （直接离开中枢即背驰 → 形态「普通」）；
  //    · 候选二＝该中枢**三类点之后**再次别次同向的那段
  //      （原文链条「三卖 → 再次别次向下 → 底背驰 = 标准一买」）。
  //    候选二越过候选一（买点更低 / 卖点更高）⇒ 候选一被证伪，以候选二为准。
  //    两候选的力度基准相同（都是进入段），故判定统一走 tryLeave。
  //    与 L1 `_pick_follow_leave` / `_first_conclusion`、桌面版 `decideLeave` 同口径。
  const chainAll = [...segments].sort((a, b) =>
    (a.start.time - b.start.time) || (a.end.time - b.end.time));
  const pickFollowLeave = (dir) => {
    const retest = thirdRetestSeg(chainAll, lastRange, base, dir);
    if (!retest) return null;
    const idx = chainAll.indexOf(retest);
    if (idx < 0) return null;
    for (let i = idx + 1; i < chainAll.length; i++) {
      if (segDirSign(chainAll[i]) === dir) return chainAll[i];
    }
    return null;
  };
  const decideLeave = (dir, cand1, cand2) => {
    if (!cand2) return cand1;
    if (!cand1) return cand2;
    const e1 = segOrderedEnds(cand1), e2 = segOrderedEnds(cand2);
    if (!e1 || !e2) return cand1;
    return (dir < 0 ? (e2.end.price < e1.end.price) : (e2.end.price > e1.end.price))
      ? cand2 : cand1;
  };

  if (trendDir === 'down') {
    tryLeave('1B', '一买', '#07c160', decideLeave(-1,
      pickLeave(-1, lastRange.low, false), pickFollowLeave(-1)));
  }
  if (trendDir === 'up') {
    tryLeave('1S', '一卖', '#fa5151', decideLeave(1,
      pickLeave(1, lastRange.high, true), pickFollowLeave(1)));
  }
}

// 中枢区间取值 —— 全项目唯一实现（买卖点判定 / 矩形绘制 / 表格 / 迷你图 / 边界拖拽共用）。
// 优先级：直读中枢自带 low/high（导出端由矩形 points 写入）
//       → overlapLow/overlapHigh（手工新建中枢）
//       → 回退「构成段端点求交集」。
// 端点重算与矩形区间实测约 21% 不相等，故仅在自带字段缺失时才走回退。
// 返回 { low, high }；无法判定时返回 null。
export function zhongshuRangeLowHigh(zs, segMap) {
  if (!zs) return null;
  const lo = Number.isFinite(zs.low) ? zs.low : (Number.isFinite(zs.overlapLow) ? zs.overlapLow : null);
  const hi = Number.isFinite(zs.high) ? zs.high : (Number.isFinite(zs.overlapHigh) ? zs.overlapHigh : null);
  if (lo !== null && hi !== null) return { low: lo, high: hi };

  const ids = (Array.isArray(zs.baseSegmentIds) && zs.baseSegmentIds.length === 3)
    ? zs.baseSegmentIds
    : (zs.segmentIds || []);
  const segs = ids.map((id) => segMap && segMap[id]).filter(Boolean);
  if (segs.length < 3) return null;
  const lows = segs.map((s) => Math.min(s.start.price, s.end.price));
  const highs = segs.map((s) => Math.max(s.start.price, s.end.price));
  const low = Math.max(...lows);
  const high = Math.min(...highs);
  if (low > high) return null;
  return { low, high };
}

// 中枢右边界时间：优先用中枢自带 endTime（= 矩形右边界，兼容中枢向右延伸），
// 缺失时退回「末段终点」。与桌面版「用矩形右边界而非第 3 段终点」口径一致。
function zhongshuRightTime(zs, segMap) {
  if (zs && Number.isFinite(zs.endTime)) return zs.endTime;
  const segs = ((zs && zs.segmentIds) || []).map((id) => segMap && segMap[id]).filter(Boolean);
  let t = null;
  for (const s of segs) {
    const o = segOrderedEnds(s);
    if (o && (t === null || o.end.time > t)) t = o.end.time;
  }
  return t;
}

// 将点线段按时间顺序分组为连通链（相邻段首尾相接）
function buildLineChains(segments) {
  const sorted = [...segments].sort((a, b) => (a.start?.time ?? 0) - (b.start?.time ?? 0));
  const visited = new Set();
  const chains = [];
  for (const s of sorted) {
    if (visited.has(s.id)) continue;
    const chain = [s];
    visited.add(s.id);
    // 向前连接
    let cur = s;
    while (true) {
      const next = sorted.find((x) => !visited.has(x.id) && x.start.time === cur.end.time);
      if (!next) break;
      chain.push(next);
      visited.add(next.id);
      cur = next;
    }
    // 向后连接
    cur = s;
    while (true) {
      const prev = sorted.find((x) => !visited.has(x.id) && x.end.time === cur.start.time);
      if (!prev) break;
      chain.unshift(prev);
      visited.add(prev.id);
      cur = prev;
    }
    chain.sort((a, b) => a.start.time - b.start.time);
    chains.push(chain);
  }
  return chains;
}

// ===== 单根段「递归」：把当前周期若干根相连段递归为更高一级周期的一根新段 =====
// 移植自桌面端 drawing.js 的「单根点线递归」（点线→虚线；右键菜单「递归」，见 _validateComboSelection）：
// 桌面版产物是本画布上的高一档线型；移动端没有线型级别概念，产物写入更高一级周期（如 1m 段递归 → 5m 段）。
// 三个入口（与桌面版同序，先命中先用）：
//   B ：目标段起点悬空（链首段），且自目标段起相连段数 ≥3（入口 B）→ 产物 = 目标段起点 → 第 3 段终点；
//   C ：更高周期左侧存在「整体位于目标段之前、时间上最近」的段，且两者方向相反、
//       目标段起点不粘连任何高周期段右端点 → 产物 = 该高段右端点 → 目标段终点（入口 C）；
//   C'：更高周期左侧不存在任何段（无高段可续接）时，目标段在其连通链中索引 ≥2 且与链首同向
//       （链首→目标段为奇数段完整折返）→ 产物 = 链首起点 → 目标段终点（入口 C 补充）。
// 返回 { ok:true, entrance, start, end, sourceIds }（start/end 已按时间有序）
//   或 { ok:false, reason }。

// 段的时间有序端点：start=时间靠前，end=时间靠后
function segOrderedEnds(seg) {
  if (!seg || !seg.start || !seg.end) return null;
  return seg.start.time <= seg.end.time
    ? { start: seg.start, end: seg.end }
    : { start: seg.end, end: seg.start };
}

function samePoint(t1, p1, t2, p2) {
  return t1 === t2 && Math.abs(p1 - p2) < 1e-3;
}

// 段方向：按价格差符号（与桌面版一致）；水平（差为 0）时回落 direction 字段
function segDirSign(seg) {
  const e = segOrderedEnds(seg);
  if (!e) return 0;
  const s = Math.sign(e.end.price - e.start.price);
  if (s !== 0) return s;
  if (seg.direction === 'up') return 1;
  if (seg.direction === 'down') return -1;
  return 0;
}

// 以 target 为核心构建连通链（前段终点 = 后段起点），时间有序；与桌面版 _buildLineChainFromLine 一致
function buildConnectedChain(segments, target) {
  const usable = (segments || []).filter((s) => s && s !== target && s.start && s.end);
  const chain = [target];
  let cur = target;
  for (;;) {
    const ce = segOrderedEnds(cur);
    const prev = usable.find((s) => {
      if (chain.includes(s)) return false;
      const se = segOrderedEnds(s);
      return se && samePoint(se.end.time, se.end.price, ce.start.time, ce.start.price);
    });
    if (!prev) break;
    chain.unshift(prev);
    cur = prev;
  }
  cur = target;
  for (;;) {
    const ce = segOrderedEnds(cur);
    const next = usable.find((s) => {
      if (chain.includes(s)) return false;
      const se = segOrderedEnds(s);
      return se && samePoint(se.start.time, se.start.price, ce.end.time, ce.end.price);
    });
    if (!next) break;
    chain.push(next);
    cur = next;
  }
  return chain;
}

// 某点是否已是同周期其他段（含盯盘/追踪段）的端点（桌面版 _hasOtherLineEndpointAt）
function hasOtherEndpointAt(segments, pt, exclude) {
  for (const s of segments || []) {
    if (!s || s === exclude) continue;
    const se = segOrderedEnds(s);
    if (!se) continue;
    if (samePoint(se.start.time, se.start.price, pt.time, pt.price)) return true;
    if (samePoint(se.end.time, se.end.price, pt.time, pt.price)) return true;
  }
  return false;
}

// 更高周期中「整体位于目标段之前（右端点不晚于目标段左端点）、时间上最近」的段（桌面版 _findPrevHigherLine）
function findPrevHigherSeg(higherSegments, target) {
  const te = segOrderedEnds(target);
  if (!te) return null;
  let best = null;
  let bestEnd = -Infinity;
  for (const s of higherSegments || []) {
    const se = segOrderedEnds(s);
    if (!se) continue;
    if (se.end.time > te.start.time) continue;
    if (se.end.time > bestEnd) { bestEnd = se.end.time; best = s; }
  }
  return best;
}

// 是否已有高周期段的右端点与给定点重合（桌面版入口 C 的 headConnected 检查）
function hasHigherEndAt(higherSegments, pt) {
  for (const s of higherSegments || []) {
    const se = segOrderedEnds(s);
    if (se && samePoint(se.end.time, se.end.price, pt.time, pt.price)) return true;
  }
  return false;
}

export function computeRecursiveSegment(segments, higherSegments, targetId) {
  const target = (segments || []).find((s) => s && s.id === targetId);
  if (!target || !segOrderedEnds(target)) return { ok: false, reason: 'no_target' };
  if (target._isWatch || target._isTrack) return { ok: false, reason: 'not_plain' };
  const te = segOrderedEnds(target);

  // 入口 B：目标段起点悬空（链首），且其后（含自己）不少于 3 根相连段
  if (!hasOtherEndpointAt(segments, te.start, target)) {
    const chainB = buildConnectedChain(segments, target);
    const idxB = chainB.indexOf(target);
    if (idxB >= 0 && chainB.length > idxB + 2) {
      const ee = segOrderedEnds(chainB[idxB + 2]);
      return {
        ok: true,
        entrance: 'B',
        start: { time: te.start.time, price: te.start.price },
        end: { time: ee.end.time, price: ee.end.price },
        sourceIds: chainB.slice(idxB, idxB + 3).map((s) => s.id),
      };
    }
  }

  // 入口 C：更高周期左侧最近段方向相反，且目标段起点不粘连高段右端点
  const prevHigher = findPrevHigherSeg(higherSegments, target);
  if (prevHigher) {
    const pe = segOrderedEnds(prevHigher);
    const hDir = segDirSign(prevHigher);
    const sDir = segDirSign(target);
    if (hDir !== 0 && sDir !== 0 && hDir !== sDir && !hasHigherEndAt(higherSegments, te.start)) {
      return {
        ok: true,
        entrance: 'C',
        start: { time: pe.end.time, price: pe.end.price },
        end: { time: te.end.time, price: te.end.price },
        sourceIds: [prevHigher.id, target.id],
      };
    }
  } else {
    // 入口 C'：无高段可续接时的兜底（链首→目标段为奇数段完整折返）
    const chainC = buildConnectedChain(segments, target);
    const idxC = chainC.indexOf(target);
    if (idxC >= 2) {
      const he = segOrderedEnds(chainC[0]);
      const hDir = segDirSign(chainC[0]);
      const sDir = segDirSign(target);
      if (hDir !== 0 && sDir !== 0 && hDir === sDir) {
        return {
          ok: true,
          entrance: 'C2',
          start: { time: he.start.time, price: he.start.price },
          end: { time: te.end.time, price: te.end.price },
          sourceIds: chainC.slice(0, idxC + 1).map((s) => s.id),
        };
      }
    }
  }

  return { ok: false, reason: 'not_eligible' };
}

// 二买/二卖 与 三买/三卖 检测
// 口径（原文；与 chan_semantics.py（L1 唯一事实来源）及桌面版 _findEffectiveTradingPoints 对齐）：
//   二类点：一类点之后“同向隔一段”的段终点为候选（第 101 课定义）。
//     落点未跌破（升破）一类点 → 一般形态（或最强形态：与三类点合一）；
//     落点跌破（升破）一类点 → 最弱形态，需“落点段 vs 一类点所在段”同向且力度衰减（盘整背驰）。
//     ⚠ 旧实现把“跌破一类点”折叠为“一类点位移”（第 86 课的操作简化），
//       原文第 21 课明确“这是完全可以的”，故最弱形态永远标不出来；此处不再位移一类点。
//   三类点：自中枢最后一根基础段起沿连通链扫描首个干净的（离开段, 回试段）配对——
//     离开段越界 + 回试段反向且不重回中枢区间 → 回试段终点即三类点。
//     “首个干净配对即定”隐含“必须是第一次回试”。
//   一类点：按“该趋势最后一个中枢是否已出现同类第三类点”区分标准 / 普通。
// 前置条件：detectOneBuySell 已执行（段上已标记 1B/1S，且 _strength 已就绪）。
export function detectTwoAndThreeBuySell(segments, zhongshus) {
  if (!segments || !segments.length) return;
  const segMap = {};
  segments.forEach((s) => { segMap[s.id] = s; });
  const zsMap = {};
  (zhongshus || []).forEach((z) => { zsMap[z.id] = z; });

  // 收集初始 1B/1S 标记
  const markers = new Map();
  segments.forEach((s) => {
    if (s._buySell === '1B' || s._buySell === '1S') {
      markers.set(s.id, { segId: s.id, label: s._buySell, zsId: s._bsZsId || null, originalId: null, weak: false });
    }
  });

  // ---- 二类买卖点 ----
  // 落点段 = 一类点所在段之后**同向隔一段**的那一段（第 101 课定义）。
  // 取段落链口径：**全段按起点时间排序的单一链**（= L1 `chain_all`），
  // 而不是连通链 —— 段链存在时间缺口时，连通链会把 `i-2` 数到另一段上，
  // 与 L1 的 `chain_all[k+2]` 不一致（见 reports/BSP-ALGORITHM-REVIEW.md §15）。
  const chainAll = [...segments].sort((a, b) =>
    (a.start.time - b.start.time) || (a.end.time - b.end.time));
  for (let i = 2; i < chainAll.length; i++) {
    const z = chainAll[i];
    const x = chainAll[i - 2];
    const marker = markers.get(x.id);
    if (!marker) continue;
    if (markers.has(z.id)) continue;                   // 不覆盖已有标记
    if (marker.label !== '1B' && marker.label !== '1S') continue;

    const isBuy = marker.label === '1B';
    const xe = segOrderedEnds(x);
    const ze = segOrderedEnds(z);
    if (!xe || !ze) continue;
    const broke = isBuy ? (ze.end.price < xe.end.price) : (ze.end.price > xe.end.price);
    const label = isBuy ? '2B' : '2S';

    if (!broke) {
      // 一般形态（或最强形态：与三类点合一）
      markers.set(z.id, { segId: z.id, label, zsId: marker.zsId, originalId: null, weak: false });
      continue;
    }
    // 最弱形态：需盘整背驰（落点段 vs 一类点所在段，同向且力度衰减）
    const dz = segDirSign(z);
    const dx = segDirSign(x);
    const sz = z._strength && z._strength.macdArea;
    const sx = x._strength && x._strength.macdArea;
    if (dz !== 0 && dz === dx && Number.isFinite(sz) && Number.isFinite(sx) &&
        Math.abs(sz) < Math.abs(sx)) {
      markers.set(z.id, { segId: z.id, label, zsId: marker.zsId, originalId: null, weak: true });
    }
  }

  // 2B/2S 价格升级：2B 突破中枢上沿 -> 2B/3B；2S 跌破中枢下沿 -> 2S/3S
  for (const m of markers.values()) {
    if (m.label !== '2B' && m.label !== '2S') continue;
    if (!m.zsId) continue;
    const zs = zsMap[m.zsId];
    if (!zs) continue;
    const range = zhongshuRangeLowHigh(zs, segMap);
    if (!range) continue;
    const seg = segMap[m.segId];
    const oe = seg ? segOrderedEnds(seg) : null;
    if (!oe) continue;
    if (m.label === '2B' && oe.end.price > range.high) m.label = '2B/3B';
    else if (m.label === '2S' && oe.end.price < range.low) m.label = '2S/3S';
  }

  // ---- 三类买卖点（3B/3S）----
  // 定义（**与 L1 `chan_semantics._detect_third_point` 及桌面版 `_findThirdClassPoints` 同口径**；
  // buy-sell-points.md §1.3）：
  //   1) 沿**同周期段链**从「末构成段**之后**那一段」起逐段扫描，取**首个干净配对**：
  //      · 离开段 p：向上离开 → p 终点 > 上沿（range.high）；
  //                  向下离开 → p 终点 < 下沿（range.low）；
  //      · 回试段 c：链上紧随 p 的下一段，且与 p 反向、整段不重回中枢区间
  //        （3B：c 低点 ≥ 上沿，含恰好触及；3S：c 高点 ≤ 下沿）；
  //      则 c 的终点即为该中枢的三类点。「首个干净配对即定」＝「必须是第一次回试」。
  //   2) 买、卖**各自独立**取首个配对（同一个中枢可以同时给出 3B 与 3S）。
  // 口径变更记录（2026-10-14，依据 reports/BSP-ALGORITHM-REVIEW.md §14）：
  //   旧版只试**两个候选**（① 末构成段；② 起点时间 == 中枢右边界时间的段），命中即止，
  //   与 L1 不一致（实测 20 个样本 35 处标记差异，两方向都有）。L1 的口径是：
  //   离开段＝末构成段之后**第一个**能离开中枢、且紧随的回试不重回中枢的配对，
  //   故**不把「末构成段自身越界」当离开段**，也**不受中枢右边界限制**（中枢延伸区照扫）。
  //   旧版注释里担心的「无界向后扫会漂移到后续中枢」，实为「不断赋值、最后一个配对胜出」
  //   所致的假象；用 `buyDone/sellDone` 守住命中即定，即不会漂移。
  const chain = [...segments].sort((a, b) => (a.start?.time ?? 0) - (b.start?.time ?? 0));
  for (const zs of zhongshus || []) {
    // 构成段（= 桌面版 _zhongshuLines）必须齐 3 根，否则本中枢不参与三类点判定。
    // 与 L1（chan_semantics._detect_third_point 的「中枢构成段缺失」分支）及桌面版口径一致：
    // 中枢的定义是「连续 3 个次级别走势的重叠」，构成段不可知即无法确认其为**本级别**中枢。
    // 典型情形：由更低级别自动升级投影而来的中枢（_autoUpFrom / _isExtendedZhongshu），
    // 其构成段属于更低级别、不在本图段集合内 —— 本级别（点线）的离开/回试无从在其上判定。
    const base = (Array.isArray(zs.baseSegmentIds) && zs.baseSegmentIds.length === 3)
      ? zs.baseSegmentIds
      : null;
    if (!base) continue;
    const range = zhongshuRangeLowHigh(zs, segMap);
    if (!range) continue;
    // 区间退化（ZG ≤ ZD）的矩形**不是中枢**：中枢＝连续三段走势的重叠区间，
    // 重叠宽度为零时无从判定「离开 / 重回」。与 L1 `chan_semantics._collect_zhongshus`
    // 的 `if zg <= zd: 跳过并告警` 及桌面版 `_findThirdClassPoints` 同口径
    // （实测 sh588110_1m 有 2 个这类矩形，旧版会在其上判出假的第三类卖点）。
    if (!(range.high > range.low)) continue;

    // 三类点：买、卖**各自独立**取首个合格配对（同一中枢可同时给出 3B 与 3S），
    // 由 `thirdRetestSeg` 统一实现（与 detectOneBuySell 的候选二定位共用同一份判定）。
    for (const pair of [[1, '3B'], [-1, '3S']]) {
      const c = thirdRetestSeg(chain, range, base, pair[0]);
      if (!c) continue;
      const label = pair[1];
      const existing = markers.get(c.id);
      if (existing) {
        if (existing.label === '2B' && label === '3B') existing.label = '2B/3B';
        else if (existing.label === '2S' && label === '3S') existing.label = '2S/3S';
      } else {
        markers.set(c.id, { segId: c.id, label, zsId: zs.id, originalId: null, weak: false });
      }
    }
  }

  // 把最终标记写回段对象（先清空旧买卖点，再写入）
  segments.forEach((s) => {
    if (s._buySell && /^[12]B|[12]S|3B|3S/.test(s._buySell)) {
      delete s._buySell;
      delete s._bsLabel;
      delete s._bsColor;
      delete s._bsZsId;
    }
  });

  // 中枢自身是否已出现同类第三类点：用于区分“标准 / 普通”第一类买卖点
  //   一买 → 需该中枢已出现第三类卖点（向下有效离开）；一卖 → 需第三类买点。
  //   **且该三类点必须早于本类点位置**（原文链条：三卖 → 再次级别向下 → 底背驰 =
  //   标准一买；顺序颠倒时等于用后续走势追认前面的低点）。与 L1 chan_semantics
  //   的 `_form_ok()` 同口径。三类点标记落在**回试段**上，其终点即该三类点位置。
  const ownThird = new Map();   // 中枢 id -> { label, atTime }
  for (const m of markers.values()) {
    if ((m.label !== '3B' && m.label !== '3S') || !m.zsId) continue;
    const t3 = segMap[m.segId];
    const t3e = t3 ? segOrderedEnds(t3) : null;
    ownThird.set(m.zsId, { label: m.label, atTime: t3e ? t3e.end.time : null });
  }

  const labelMap = {
    '1B': '一买', '1S': '一卖',
    '2B': '二买', '2S': '二卖',
    '3B': '三买', '3S': '三卖',
    '2B/3B': '二买+三买', '2S/3S': '二卖+三卖',
  };
  for (const m of markers.values()) {
    const seg = segMap[m.segId];
    if (!seg) continue;
    const isBuy = m.label.includes('B');
    let disp = labelMap[m.label] || m.label;
    if (m.label === '1B' || m.label === '1S') {
      const need = m.label === '1B' ? '3S' : '3B';
      const third = m.zsId ? ownThird.get(m.zsId) : null;
      // 一类点位置 = 其所在段（离开段）的终点；三类点必须早于它
      const le = segOrderedEnds(seg);
      const isStd = !!(third && third.label === need && third.atTime != null
                       && le && third.atTime < le.end.time);
      disp = (isStd ? '标准' : '普通') + disp;
    } else if (m.weak) {
      disp += '（弱）';
    }
    seg._buySell = m.label;
    seg._bsLabel = disp;
    seg._bsColor = isBuy ? '#07c160' : '#fa5151';
    seg._bsZsId = m.zsId;
  }
}

// 段末端简单买卖点提示（基于方向）
export function endpointHint(seg) {
  return seg.direction === 'up' ? '上涨段' : '下跌段';
}

