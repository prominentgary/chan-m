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
    const zsEnd = zsSegs[zsSegs.length - 1].end.time;
    const zsIds = new Set(ids);

    // 找到中枢前一段（进入段）和中枢后一段（离开段）
    const nonZs = sorted.filter((s) => !zsIds.has(s.id));
    let enterSeg = null;  // 进入中枢的段（中枢前最后一段）
    let leaveSeg = null;  // 离开中枢的段（中枢后第一段）

    for (const s of nonZs) {
      if (s.end.time <= zsStart) {
        if (!enterSeg || s.end.time > enterSeg.end.time) enterSeg = s;
      }
      if (s.start.time >= zsEnd) {
        if (!leaveSeg || s.start.time < leaveSeg.start.time) leaveSeg = s;
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

  const sortedAll = [...segments].sort((a, b) => a.start.time - b.start.time);

  zhongshus.forEach((zs) => {
    const ids = zs.segmentIds || [];
    const zsSegs = ids.map((id) => segMap[id]).filter(Boolean);
    if (zsSegs.length < 3) return;

    zsSegs.sort((a, b) => a.start.time - b.start.time);
    const zsStart = zsSegs[0].start.time;
    const zsEnd = zsSegs[zsSegs.length - 1].end.time;
    const zsIds = new Set(ids);

    // 找出离开段（中枢后第一个非中枢段）
    let leaveSeg = null;
    for (const s of sortedAll) {
      if (!zsIds.has(s.id) && s.start.time >= zsEnd) {
        leaveSeg = s;
        break;
      }
    }
    if (!leaveSeg) return;

    // 找出进入段（中枢前最后一个非中枢段）
    let enterSeg = null;
    for (const s of sortedAll) {
      if (!zsIds.has(s.id) && s.end.time <= zsStart) {
        if (!enterSeg || s.end.time > enterSeg.end.time) enterSeg = s;
      }
    }
    if (!enterSeg) return;

    // 进入段与离开段方向必须一致才参与背驰比较
    if (enterSeg.direction !== leaveSeg.direction) return;

    // 找前一个中枢：其右边界时间等于进入段起点（与 PC 端对齐）
    let prevZs = null;
    for (const z of zhongshus) {
      if (z.id === zs.id) continue;
      const zIds = z.segmentIds || [];
      const zSegs = zIds.map((id) => segMap[id]).filter(Boolean);
      if (zSegs.length < 3) continue;
      zSegs.sort((a, b) => a.start.time - b.start.time);
      const zEnd = zSegs[zSegs.length - 1].end.time;
      if (zEnd === enterSeg.start.time) {
        prevZs = z;
        break;
      }
    }

    // 没有前中枢，不是趋势中的中枢，不标一类买卖点
    if (!prevZs) return;

    // 检查当前中枢是否为趋势中最后一个中枢（与前中枢震荡区间无重叠）
    const r1 = getZhongshuRange(zs, segMap);
    const r2 = getZhongshuRange(prevZs, segMap);
    if (r1 && r2) {
      // 无重叠：本中枢最低 > 前中枢最高，或本中枢最高 < 前中枢最低
      const noOverlap = r1.minLow > r2.maxHigh || r1.maxHigh < r2.minLow;
      if (!noOverlap) return; // 震荡区间重叠，不是最后一个趋势中枢
    }

    // 比较力度
    const enterStr = enterSeg._strength || { macdArea: 0 };
    const leaveStr = leaveSeg._strength || { macdArea: 0 };
    const weakerLeave = Math.abs(leaveStr.macdArea) < Math.abs(enterStr.macdArea);

    if (weakerLeave) {
      if (leaveSeg.direction === 'down') {
        leaveSeg._buySell = '1B';
        leaveSeg._bsLabel = '一买';
        leaveSeg._bsColor = '#07c160';
        leaveSeg._bsZsId = zs.id;
      } else if (leaveSeg.direction === 'up') {
        leaveSeg._buySell = '1S';
        leaveSeg._bsLabel = '一卖';
        leaveSeg._bsColor = '#fa5151';
        leaveSeg._bsZsId = zs.id;
      }
    }
  });
}

// 中枢震荡区间：max(lows) <= min(highs)
function getZhongshuRange(zs, segMap) {
  const segs = (zs.segmentIds || []).map((id) => segMap[id]).filter(Boolean);
  if (segs.length < 3) return null;
  const lows = segs.map((s) => Math.min(s.start.price, s.end.price));
  const highs = segs.map((s) => Math.max(s.start.price, s.end.price));
  return { minLow: Math.max(...lows), maxHigh: Math.min(...highs) };
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

// 二买/二卖 与 三买/三卖 检测（与 PC 端 _findEffectiveTradingPoints 对齐）
// 前置条件：detectOneBuySell 已执行，段上已标记 1B/1S
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
      markers.set(s.id, { segId: s.id, label: s._buySell, zsId: s._bsZsId || null, originalId: null });
    }
  });

  // 按连通链应用 1B/1S 移动规则并产生 2B/2S
  const chains = buildLineChains(segments);
  for (const chain of chains) {
    for (let i = 2; i < chain.length; i++) {
      const z = chain[i];
      const x = chain[i - 2];
      const marker = markers.get(x.id);
      if (!marker) continue;
      if (markers.has(z.id)) continue; // 不覆盖已有标记

      const xPrice = x.end.price;
      const zPrice = z.end.price;
      if (marker.label === '1B') {
        if (zPrice < xPrice) {
          // 创新低：一买移动到新终点
          markers.delete(x.id);
          markers.set(z.id, { segId: z.id, label: '1B', zsId: marker.zsId, originalId: x.id });
        } else {
          markers.set(z.id, { segId: z.id, label: '2B', zsId: marker.zsId, originalId: null });
        }
      } else if (marker.label === '1S') {
        if (zPrice > xPrice) {
          markers.delete(x.id);
          markers.set(z.id, { segId: z.id, label: '1S', zsId: marker.zsId, originalId: x.id });
        } else {
          markers.set(z.id, { segId: z.id, label: '2S', zsId: marker.zsId, originalId: null });
        }
      }
    }
  }

  // 2B/2S 价格升级：2B 突破中枢上沿 -> 2B/3B；2S 跌破中枢下沿 -> 2S/3S
  for (const m of markers.values()) {
    if (m.label !== '2B' && m.label !== '2S') continue;
    if (!m.zsId) continue;
    const zs = zsMap[m.zsId];
    if (!zs) continue;
    const range = getZhongshuRange(zs, segMap);
    if (!range) continue;
    const seg = segMap[m.segId];
    const endPrice = seg?.end?.price;
    if (endPrice == null) continue;
    if (m.label === '2B' && endPrice > range.maxHigh) {
      m.label = '2B/3B';
    } else if (m.label === '2S' && endPrice < range.minLow) {
      m.label = '2S/3S';
    }
  }

  // 独立检测第三类买卖点 3B/3S
  const sorted = [...segments].sort((a, b) => (a.start?.time ?? 0) - (b.start?.time ?? 0));
  const rightTimeToZs = new Map();
  (zhongshus || []).forEach((zs) => {
    const segs = (zs.segmentIds || []).map((id) => segMap[id]).filter(Boolean);
    if (!segs.length) return;
    segs.sort((a, b) => a.start.time - b.start.time);
    const rightTime = segs[segs.length - 1].end.time;
    rightTimeToZs.set(rightTime, zs);
  });

  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i];
    const p = sorted[i - 1];
    if (p.end.time !== c.start.time) continue;
    const zs = rightTimeToZs.get(p.start.time);
    if (!zs) continue;
    const range = getZhongshuRange(zs, segMap);
    if (!range) continue;

    const pEnd = p.end.price;
    const cEnd = c.end.price;
    let label = null;
    if (pEnd > range.maxHigh && cEnd > range.maxHigh) label = '3B';
    else if (pEnd < range.minLow && cEnd < range.minLow) label = '3S';
    if (!label) continue;

    const existing = markers.get(c.id);
    if (existing) {
      if (existing.label === '2B' && label === '3B') existing.label = '2B/3B';
      else if (existing.label === '2S' && label === '3S') existing.label = '2S/3S';
      continue;
    }
    markers.set(c.id, { segId: c.id, label, zsId: zs.id, originalId: null });
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
    seg._buySell = m.label;
    seg._bsLabel = labelMap[m.label] || m.label;
    seg._bsColor = isBuy ? '#07c160' : '#fa5151';
    seg._bsZsId = m.zsId;
  }
}

// 段末端简单买卖点提示（基于方向）
export function endpointHint(seg) {
  return seg.direction === 'up' ? '上涨段' : '下跌段';
}

