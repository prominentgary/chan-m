// hide.js —— 级别联立隐藏规则（唯一实现）
//
// 为什么需要它：移动版的「级别」由**周期**承载（一张周期图 = 该周期的走势级别），
// 没有桌面的虚线/实线多线型。所以桌面上那条「作用域 = 最后一条虚线终点之后」在
// 移动版的等价物，就是这套隐藏规则：
//
//   用**紧邻的上一级周期最后一段**把本级的早期段截掉，屏幕上剩下的那些线，
//   就是本级「当前还在走」的部分。
//
// 这个等价关系不是近似：桌面「最后一条虚线」＝本级别走势已经画出来的部分，它的
// 终点之后才是次级别还在走的部分；移动版把「本级别走势」放在上一档周期图上画，
// 于是「上一级最后一段的终点」与桌面「虚线终点」指的是同一件事。
//
// 硬边界：
//   1. 只做**相邻一级**，不递归。每一级各自被它的上一级截断，链式嵌套天然成立。
//   2. 对齐锚**排除**盯盘段/追踪段/递归段：盯盘段终点是当前最新价、随行情延伸，
//      拿它当锚会把低级别段几乎全部隐藏（例：5m 盯盘导致 1m 只剩盯盘段之后）。
//   3. 安全回退：若高周期数据比当前周期段更新（对齐点越过当前周期最后一段起点），
//      退回用高周期所有段的 max(start) 对齐，宁可多留历史，也不把图清空。
//      **回退必须披露**（见 scopeHint）：此时作用域偏早，不是「当前这一段」的真实起点。
//   4. 纯函数、不读全局、不改入参，node 可直接跑（供对拍与样本导出）。

// 周期序列（低 → 高）。移动版的「级别链」就是这个顺序：跳过辅助周期后，相邻两项
// 就是相邻级别 —— 联立的作用域与跨级对账都以此为唯一依据。
export const PERIOD_SEQ = ['1m', '5m', '15m', '30m', '60m', 'day', 'week', 'month', 'quarter', 'year'];

// 辅助周期：画线复刻主周期（15m→5m、60m→30m），不是独立级别。
// 既不能作为更高周期去隐藏低级别段，也不参与级别联立。
export const AUX_PERIODS = new Set(['15m', '60m']);

/**
 * 当前周期的**紧邻上一级**（跳过辅助周期，且必须在证券可用周期列表里）。
 * 返回 null 表示已是最顶级。
 */
export function getHigherPeriod(period, availablePeriods) {
  const idx = PERIOD_SEQ.indexOf(period);
  if (idx < 0) return null;
  const list = availablePeriods || [];
  for (let i = idx + 1; i < PERIOD_SEQ.length; i++) {
    const p = PERIOD_SEQ[i];
    if (AUX_PERIODS.has(p)) continue;
    if (list.includes(p)) return p;
  }
  return null;
}

// 把当日内某个交易时间换算成距 9:30 的分钟数（已扣除午休）
export function marketMinutesFrom930(t) {
  const dt = new Date(t * 1000);
  const hm = dt.getHours() * 60 + dt.getMinutes();
  if (hm < 13 * 60) return hm - (9 * 60 + 30);
  return (hm - 13 * 60) + 120;
}

// 给定目标时间 t（通常对应某根高周期 K 线的结束时间），返回该 K 线的开始时间
export function periodBarStart(t, period) {
  if (period === 'day' || period === 'week' || period === 'month') {
    const dt = new Date(t * 1000);
    dt.setHours(0, 0, 0, 0);
    return Math.floor(dt.getTime() / 1000);
  }
  const minutes = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60 }[period];
  if (!minutes) return t;
  const mm = marketMinutesFrom930(t);
  if (mm <= 0) {
    const dt = new Date(t * 1000);
    dt.setHours(9, 30, 0, 0);
    return Math.floor(dt.getTime() / 1000);
  }
  const startMm = Math.floor((mm - 1) / minutes) * minutes;
  const startHm = startMm < 120
    ? (9 * 60 + 30) + startMm
    : 13 * 60 + (startMm - 120);
  const dt = new Date(t * 1000);
  dt.setHours(Math.floor(startHm / 60), startHm % 60, 0, 0);
  return Math.floor(dt.getTime() / 1000);
}

function startOf(seg) {
  return seg?.start?.time ?? seg?.end?.time ?? 0;
}

function endOf(seg) {
  return seg?.end?.time ?? seg?.start?.time ?? 0;
}

/**
 * 计算低级别周期的 hideBefore：优先用更高周期中时间上最新的一段（end 最大），
 * 以其终点对齐到更高周期 K 线起点，使低周期图聚焦到「最新一段覆盖的交易日」。
 *
 * 返回 null 表示「不截断」（该周期是最顶级，或上级只有盯盘/追踪/递归段）。
 *
 * @param {Array} higherSegments 上一级周期的全部段
 * @param {string} higherPeriod  上一级周期键
 * @param {Array} curSegments    本周期全部段（用于判断安全回退）
 * @returns {{hideBefore: number, how: string, anchor: object|null}|null}
 */
export function computeHideBeforeDetail(higherSegments, higherPeriod, curSegments) {
  if (!higherPeriod || !higherSegments || !higherSegments.length) return null;
  const realHigher = higherSegments.filter((s) => !s._isWatch && !s._isTrack && !s._isRecursive);
  if (!realHigher.length) return null;
  let lastEnd = 0, maxStart = 0, anchor = null;
  for (const s of realHigher) {
    const e = endOf(s), st = startOf(s);
    if (e > lastEnd) { lastEnd = e; anchor = s; }
    if (st > maxStart) maxStart = st;
  }
  const hbEnd = lastEnd ? periodBarStart(lastEnd, higherPeriod) : null;
  if (hbEnd == null) return null;
  if (curSegments && curSegments.length) {
    let curLastStart = 0;
    for (const s of curSegments) {
      const st = startOf(s);
      if (st > curLastStart) curLastStart = st;
    }
    if (hbEnd > curLastStart) {
      const fallback = maxStart ? periodBarStart(maxStart, higherPeriod) : hbEnd;
      return { hideBefore: fallback, how: 'fallback', anchor };
    }
  }
  return { hideBefore: hbEnd, how: 'aligned', anchor };
}

/**
 * 只取时间戳（老调用点用）。需要知道是否走了安全回退时用 computeHideBeforeDetail。
 */
export function computeHideBefore(higherSegments, higherPeriod, curSegments) {
  const r = computeHideBeforeDetail(higherSegments, higherPeriod, curSegments);
  return r ? r.hideBefore : null;
}

/**
 * 可见段 = 作用域内的段，按终点时间升序。
 * hideBefore 为 null（不截断）时返回全量副本。
 */
export function visibleSegsOf(segments, hideBefore) {
  const list = Array.isArray(segments) ? segments : [];
  const visible = hideBefore == null
    ? [...list]
    : list.filter((s) => startOf(s) >= hideBefore);
  return visible.sort((a, b) => endOf(a) - endOf(b));
}

/**
 * 可见中枢 = 至少有一个构成段可见的中枢。
 * 与段不同，中枢不能按时间硬切：一个跨过分界的中枢只要还有构成段在屏幕上，它就在屏幕上。
 */
export function visibleZsOf(zhongshus, visibleSegs) {
  const ids = new Set((visibleSegs || []).map((s) => s.id));
  return (zhongshus || []).filter((z) => (z.segmentIds || []).some((id) => ids.has(id)));
}
