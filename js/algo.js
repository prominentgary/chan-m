// algo.js —— 段的力度、中枢对比、背驰与买卖点（1B/1S）计算
// 与桌面端 drawing.js 算法对齐，输入归一化 bars + 段/中枢结构

// 取 [startSec, endSec] 区间内的 bars
function sliceBars(bars, startSec, endSec) {
  return bars.filter((b) => b.time >= startSec && b.time <= endSec);
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

// 背驰检测：相邻同方向段比较
// 上涨段：价格更高但 macdArea 更小 -> 顶背驰（卖点）
// 下跌段：价格更低但 macdArea 更小 -> 底背驰（买点）
export function detectDivergence(prev, cur) {
  if (!prev || prev.direction !== cur.direction) return null;
  const prevStr = prev._strength || { macdArea: 0 };
  const curStr = cur._strength || { macdArea: 0 };
  const strongerPrice = cur.direction === 'up'
    ? cur.end.price > prev.end.price
    : cur.end.price < prev.end.price;
  const weakerMacd = Math.abs(curStr.macdArea) < Math.abs(prevStr.macdArea);
  if (strongerPrice && weakerMacd) {
    return cur.direction === 'up' ? '顶背驰·卖点' : '底背驰·买点';
  }
  return null;
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
  segments.forEach((s) => { segMap[s.id] = s; });

  // 按时间排序所有中枢
  const sorted = [...zhongshus].sort((a, b) => {
    const aSegs = (a.segmentIds || []).map((id) => segMap[id]).filter(Boolean);
    const bSegs = (b.segmentIds || []).map((id) => segMap[id]).filter(Boolean);
    if (!aSegs.length || !bSegs.length) return 0;
    return aSegs[0].start.time - bSegs[0].start.time;
  });

  sorted.forEach((zs, idx) => {
    const ids = zs.segmentIds || [];
    const zsSegs = ids.map((id) => segMap[id]).filter(Boolean);
    if (zsSegs.length < 3) return;

    zsSegs.sort((a, b) => a.start.time - b.start.time);
    const zsStart = zsSegs[0].start.time;
    const zsEnd = zsSegs[zsSegs.length - 1].end.time;
    const zsIds = new Set(ids);

    // 检查是否与上一个中枢重叠（重叠则非趋势末中枢）
    if (idx > 0) {
      const prevZs = sorted[idx - 1];
      const prevIds = prevZs.segmentIds || [];
      const prevZsSegs = prevIds.map((id) => segMap[id]).filter(Boolean);
      if (prevZsSegs.length) {
        prevZsSegs.sort((a, b) => a.start.time - b.start.time);
        const prevEnd = prevZsSegs[prevZsSegs.length - 1].end.time;
        if (prevEnd >= zsStart) return; // 重叠，不是最后一个趋势中枢
      }
    }

    // 找出离开段（中枢后第一个非中枢段）
    const sortedAll = [...segments].sort((a, b) => a.start.time - b.start.time);
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

    // 比较力度
    const enterStr = enterSeg._strength || { macdArea: 0 };
    const leaveStr = leaveSeg._strength || { macdArea: 0 };
    const weakerLeave = Math.abs(leaveStr.macdArea) < Math.abs(enterStr.macdArea);

    if (weakerLeave) {
      if (leaveSeg.direction === 'down') {
        leaveSeg._buySell = '1B';
        leaveSeg._bsLabel = '一类买点';
        leaveSeg._bsColor = '#07c160';
        leaveSeg._bsZsId = zs.id;
      } else if (leaveSeg.direction === 'up') {
        leaveSeg._buySell = '1S';
        leaveSeg._bsLabel = '一类卖点';
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
    '1B': '一类买点', '1S': '一类卖点',
    '2B': '二类买点', '2S': '二类卖点',
    '3B': '三类买点', '3S': '三类卖点',
    '2B/3B': '二类+三类买点', '2S/3S': '二类+三类卖点',
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

// 中枢延伸：在基础 3 段之外，把后续仍与中枢区间重叠的段并入。
// 缠论中「中枢」由至少 3 段重叠构成，并可在右侧继续延伸（离开段不再重叠时停止）。
// 桌面端把延伸段只存在视觉层（extendedLineIds），导出时未携带，故移动端自行补全。
export function extendZhongshus(segments, zhongshus) {
  if (!zhongshus || !zhongshus.length) return;
  const segMap = {};
  segments.forEach((s) => { segMap[s.id] = s; });
  // 线段链（按时间升序），用于沿「后续段」顺序向右延伸
  const chain = [...segments].sort((a, b) => (a.start?.time ?? 0) - (b.start?.time ?? 0));

  zhongshus.forEach((zs) => {
    const ids = zs.segmentIds || [];
    if (ids.length < 3) return;
    const base = ids.map((id) => segMap[id]).filter(Boolean);
    if (base.length < 3) return;
    base.sort((a, b) => (a.start?.time ?? 0) - (b.start?.time ?? 0));
    const lows = base.map((s) => Math.min(s.start.price, s.end.price));
    const highs = base.map((s) => Math.max(s.start.price, s.end.price));
    const zLow = Math.max(...lows);
    const zHigh = Math.min(...highs);
    if (!(zHigh > zLow)) return; // 基础 3 段无重叠区间，无法延伸

    const startIdx = chain.findIndex((s) => s.id === base[0].id);
    if (startIdx < 0) return;

    const extended = ids.slice();
    const MAX_EXTEND = 9; // 安全上限，避免异常数据导致无限延伸
    for (let k = startIdx + 3; k < chain.length && extended.length < 3 + MAX_EXTEND; k++) {
      const seg = chain[k];
      if (extended.includes(seg.id)) continue;
      // 延伸段终点必须落在中枢震荡区间内；一旦离开即停止
      const endPrice = seg.end?.price;
      if (endPrice == null) break;
      if (endPrice < zLow || endPrice > zHigh) break;
      extended.push(seg.id);
    }
    zs.segmentIds = extended;
  });
}