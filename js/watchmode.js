// watchmode.js —— 盯盘段核心算法（从桌面版 drawing.js 移植，纯计算 + 决策 + 缓存）
// 与桌面版差异：bars 时间统一为 Unix 秒（无需归一化）；不直接操作 drawings/存储；
// 由 app.js 负责数据变更、持久化与重渲染。
// 语义约定：
//   - 选点：滑窗 N(10→7) 相对极值 × 长档[9,27]优先/短档[3,9)兜底 × 取最显著极值
//   - _reason: 'already_done'(avail<9，已画完/行情不足) / 'rule_not_found'(行情充足但按规则找不到)
//   - 盯盘段终点 = 跨数≤27 内最显著极值，非最新 K 线极值

export const DEFAULT_CANDIDATE_SPAN_MIN = 3;
export const DEFAULT_CANDIDATE_SPAN_MAX = 27;
export const WATCH_CONFIRM_BARS = 10;      // 极值身份确认所需真 K 线数（滑窗半径 N 最大 10）
export const AUTO_CONTINUE_FIX_GAP = 10;   // 两次死胡同自修之间至少间隔的新 K 线数（闸2）
// 死胡同兜底：下一段试算的滑窗半径由 6 逐级下调到 2（2 为兜底下限，收到第一个能通过验收的即停）
export const DEAD_END_FALLBACK_WINDOW_MAX = 6;
export const DEAD_END_FALLBACK_WINDOW_MIN = 2;
// 强缺口兜底：c 终点取「缺口后第一个显著极值」时所用的滑窗半径区间（10→7，同常规选点）
export const STRONG_GAP_WINDOW_MAX = 10;
export const STRONG_GAP_WINDOW_MIN = 7;

// ========== 段基础工具（移动端段对象 { start:{time,price}, end:{time,price}, direction }） ==========

export function segLeft(seg) {
  return seg && seg.start ? { time: seg.start.time, price: seg.start.price } : null;
}
export function segRight(seg) {
  return seg && seg.end ? { time: seg.end.time, price: seg.end.price } : null;
}
export function segDirection(seg) {
  if (!seg || !seg.start || !seg.end) return 'up';
  return seg.end.price >= seg.start.price ? 'up' : 'down';
}
export function oppositeDir(dir) {
  return dir === 'up' ? 'down' : 'up';
}

// 秒级精确匹配 bars 索引（移动端 bars[i].time 为 Unix 秒）
export function findBarIdxByTime(bars, secTime) {
  if (!bars || !bars.length || secTime == null) return -1;
  const t = Math.floor(secTime);
  for (let i = 0; i < bars.length; i++) {
    if (Math.floor(bars[i].time) === t) return i;
  }
  return -1;
}

// 形状级校验：seg 的右端点必须为所有段中最晚，且右端点(time+price)未被其他段占用。
// 移动端无「多级别线段」，所有段（含盯盘段）同级，故直接全量比较。
export function isRightmostAndUnoccupied(seg, segs) {
  if (!seg || !segs) return false;
  const right = segRight(seg);
  if (!right) return false;
  const rpTime = Math.floor(right.time);
  let latestTime = rpTime;
  let latestIsSelf = true;
  for (const s of segs) {
    if (s === seg || !s || !s.end) continue;
    const t = Math.floor(s.end.time);
    if (t > latestTime) return false;
    const sLeft = segLeft(s);
    if (sLeft && Math.floor(sLeft.time) === rpTime && sLeft.price === right.price) return false;
    if (t === rpTime && s.end.price === right.price && t > -Infinity) {
      // 右端点同刻同价被占用：仅当该段不是自身且右端点重合时视为占用
      if (s !== seg) latestIsSelf = false;
    }
  }
  if (!latestIsSelf) return false;
  // 右端点被其他段占用（起点/终点与之重合）
  for (const s of segs) {
    if (s === seg || !s) continue;
    const l = segLeft(s), r = segRight(s);
    if (l && Math.floor(l.time) === rpTime && l.price === right.price) return false;
    if (r && Math.floor(r.time) === rpTime && r.price === right.price) return false;
  }
  return true;
}

// ========== 极值识别 ==========

// 相同价格连续平台合并：1~2根取第1根；3~10根取中间（偶数取中间偏左）；11根及以上取首/中/尾
export function mergeCandidatePlatforms(candidates) {
  if (!candidates || candidates.length < 2) return candidates || [];
  const result = [];
  let i = 0;
  while (i < candidates.length) {
    let j = i + 1;
    while (j < candidates.length && candidates[j].price === candidates[i].price) j++;
    const platform = candidates.slice(i, j);
    const n = platform.length;
    if (n <= 2) {
      result.push(platform[0]);
    } else if (n <= 10) {
      const mid = n % 2 === 1 ? Math.floor(n / 2) : (n / 2 - 1);
      result.push(platform[mid]);
    } else {
      const mid = n % 2 === 1 ? Math.floor(n / 2) : (n / 2 - 1);
      result.push(platform[0]);
      result.push(platform[mid]);
      result.push(platform[n - 1]);
    }
    i = j;
  }
  return result;
}

// 滑窗相对极值：direction='up' 取相对高点，'down' 取相对低点；
// 方向约束：向下段候选终点不能高于起点，向上段候选终点不能低于起点
export function findExtremes(bars, startIdx, direction, N, maxCount, startPrice, minBars) {
  const raw = [];
  const win = Math.max(1, N | 0);
  const minTotal = (minBars != null ? minBars : 2);
  const startPx = startPrice != null ? startPrice : bars[startIdx].close;
  for (let i = startIdx + 1; i < bars.length; i++) {
    if (i - startIdx + 1 < minTotal) continue;
    const lo = Math.max(0, i - win);
    const hi = Math.min(bars.length - 1, i + win);
    let isHigh = true, isLow = true;
    for (let j = lo; j <= hi; j++) {
      if (j === i) continue;
      if (bars[j].high == null || bars[j].low == null) continue;
      if (bars[j].high > bars[i].high) isHigh = false;
      if (bars[j].low < bars[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    const hit = direction === 'up' ? isHigh : isLow;
    if (!hit) continue;
    const candPrice = direction === 'up' ? bars[i].high : bars[i].low;
    if (direction === 'up' && candPrice < startPx) continue;
    if (direction === 'down' && candPrice > startPx) continue;
    raw.push({
      time: Math.floor(bars[i].time),
      price: candPrice,
      barIdx: i,
    });
  }
  const merged = mergeCandidatePlatforms(raw);
  return merged.slice(0, maxCount);
}

// 最大重叠跨数（O(N²)，盯盘选点的主要开销）
export function calcMaxOverlapSpan(bars, startIdx, endIdx) {
  if (!bars || startIdx < 0 || endIdx < startIdx) return 0;
  let maxSpan = 0;
  for (let i = startIdx; i <= endIdx; i++) {
    let farthest = i;
    const lowI = bars[i].low;
    const highI = bars[i].high;
    if (lowI == null || highI == null) continue;
    for (let j = i + 1; j <= endIdx; j++) {
      const lowJ = bars[j].low;
      const highJ = bars[j].high;
      if (lowJ == null || highJ == null) continue;
      if (highI >= lowJ && lowI <= highJ) farthest = j;
    }
    const span = farthest - i + 1;
    if (span > maxSpan) maxSpan = span;
  }
  return maxSpan;
}

// ========== 盯盘段选点核心 ==========

// 由起点(idx) + 价格 + 方向，在跨数档（长档[9,27]优先、短档[3,9)兜底）× 滑窗半径 N(默认10→7)
// 中查找最显著极值终点。返回 { endInfo, N, matchedTier, hitExtremes, hitSpanOut, _reason }；
// endInfo 含 { time, price, barIdx, _span }。
// maxSpanOverride：回溯重算时临时把跨数上限从 27 缩到「前一段跨数-1」；
// longTierOnly：窄胡同收紧前段时仅用长档（[9,maxSpan]），不进入短档兜底。
// windowMax/windowMin：滑窗半径试算区间，默认 10→7（常规选点一律用默认值）。
//   仅「死胡同兜底 deadEndFallbackResult」在下一段试算时逐级下调（6→…→2）时传入，
//   用于把「不够显著的拐点」重新纳入候选；不影响任何常规调用点的选点质量。
export function calcNaturalDuanEndFull(bars, startIdx, startPrice, direction, maxSpanOverride, longTierOnly, windowMax, windowMin) {
  if (!bars || !bars.length) return { endInfo: null, N: 0, matchedTier: null, hitExtremes: [], hitSpanOut: [], _reason: 'no_data' };
  if (startIdx < 0 || startIdx >= bars.length - 1) return { endInfo: null, N: 0, matchedTier: null, hitExtremes: [], hitSpanOut: [], _reason: 'already_done' };
  const maxSpan = (maxSpanOverride != null && maxSpanOverride >= DEFAULT_CANDIDATE_SPAN_MIN)
    ? maxSpanOverride : DEFAULT_CANDIDATE_SPAN_MAX;
  const minSpan = 3;
  const tierBound = 9;
  const tiers = longTierOnly
    ? [{ name: '长档[' + tierBound + ',' + maxSpan + ']', min: tierBound, max: maxSpan }]
    : [
        { name: '长档[' + tierBound + ',' + maxSpan + ']', min: tierBound, max: maxSpan },
        { name: '短档[3,' + tierBound + ')', min: minSpan, max: tierBound - 1 },
      ];
  // 滑窗半径试算区间：默认 10→7；仅死胡同兜底会逐级下调下限（最低 2）
  const wMax = (typeof windowMax === 'number' && windowMax >= 1) ? Math.floor(windowMax) : 10;
  const wMin = (typeof windowMin === 'number' && windowMin >= 1) ? Math.floor(windowMin) : 7;
  let endInfo = null, N = 0, matchedTier = null, hitExtremes = [], hitSpanOut = [];
  const spanCache = new Map(); // 同一个「起点→barIdx」的跨数只算一次
  for (let ti = 0; ti < tiers.length && !endInfo; ti++) {
    const tier = tiers[ti];
    for (let n = wMax; n >= wMin && !endInfo; n--) {
      const extremes = findExtremes(bars, startIdx, direction, n, 200, startPrice);
      const inTier = [];
      const outTier = [];
      for (let ei = 0; ei < extremes.length; ei++) {
        const p = extremes[ei];
        if (p.barIdx <= startIdx) continue;
        // 不允许水平段：终点价格与起点相同会破坏上下交替，直接排除
        if (Math.abs(p.price - startPrice) < 1e-9) continue;
        let span = spanCache.get(p.barIdx);
        if (span === undefined) {
          span = calcMaxOverlapSpan(bars, startIdx, p.barIdx);
          spanCache.set(p.barIdx, span);
        }
        p._span = span;
        // 早停：候选按 barIdx 递增、跨数对 endIdx 单调不减，跨数超上限后必不可能达标
        if (span > tier.max) break;
        if (span >= tier.min) inTier.push(p);
        else outTier.push(p);
      }
      if (inTier.length) {
        // 该档内最显著极值：向上取最高相对高点，向下取最低相对低点
        endInfo = inTier[0];
        for (let k = 1; k < inTier.length; k++) {
          const c = inTier[k];
          if (direction === 'up') { if (c.price > endInfo.price) endInfo = c; }
          else if (c.price < endInfo.price) endInfo = c;
        }
        N = n;
        matchedTier = tier.name;
        hitExtremes = inTier;
        hitSpanOut = outTier;
      }
    }
  }
  if (!endInfo) {
    const avail = bars.length - startIdx;
    const reason = avail < 9 ? 'already_done' : 'rule_not_found';
    return { endInfo: null, N: 0, matchedTier: null, hitExtremes: [], hitSpanOut: [], _reason: reason };
  }
  return { endInfo: endInfo, N: N, matchedTier: matchedTier, hitExtremes: hitExtremes, hitSpanOut: hitSpanOut, _reason: 'found' };
}

// 纯选点入口（剥离决策字段，供常规创建/更新复用）
export function calcNaturalDuanEnd(bars, startIdx, startPrice, direction) {
  const r = calcNaturalDuanEndFull(bars, startIdx, startPrice, direction);
  if (!r || !r.endInfo) return null;
  return { endInfo: r.endInfo, N: r.N, matchedTier: r.matchedTier, hitExtremes: r.hitExtremes, hitSpanOut: r.hitSpanOut };
}

// ========== 决策辅助（不修改段，仅计算/判定） ==========

// 从 seg 右端点反向试算，判断其后是否还能续接生成下一段盯盘段。
// 返回 { can, reason, matchedTier }；reason 区分 'already_done'（已画完/行情不足）与 'rule_not_found'（死胡同）
export function canContinueFromSeg(segs, seg, bars) {
  if (!seg) return { can: false, reason: 'no_active' };
  if (!bars || !bars.length) return { can: false, reason: 'no_data' };
  const right = segRight(seg);
  if (!right) return { can: false, reason: 'no_active' };
  const startIdx = findBarIdxByTime(bars, right.time);
  if (startIdx < 0 || startIdx >= bars.length - 1) return { can: false, reason: 'already_done' };
  const watchDir = seg.direction || segDirection(seg);
  const direction = oppositeDir(watchDir);
  const found = calcNaturalDuanEndFull(bars, startIdx, right.price, direction);
  const can = !!(found && found.endInfo && found.endInfo.barIdx > startIdx);
  const reason = (found && found._reason) || (can ? 'found' : 'rule_not_found');
  return { can: can, reason: reason, matchedTier: (found && found.matchedTier) || null };
}

// 窄胡同回溯（纯计算）：从源段 a 画 b 时 b 长档失败但行情充足(avail>=9)，
// 把 a 按「临时上限=a当前跨数-1、仅用长档」收紧。成功返回 { ok:true, newEnd, tempMax }。
// 不修改 sourceSeg；由调用方提交。
export function narrowAlleyResult(sourceSeg, segs, bars) {
  if (!sourceSeg || !bars || !bars.length) return { ok: false, reason: 'invalid' };
  const left = segLeft(sourceSeg), right = segRight(sourceSeg);
  if (!left || !right) return { ok: false, reason: 'invalid' };
  const aStartIdx = findBarIdxByTime(bars, left.time);
  if (aStartIdx < 0 || aStartIdx >= bars.length - 1) return { ok: false, reason: 'no_start' };
  const aRightIdx = findBarIdxByTime(bars, right.time);
  if (aRightIdx <= aStartIdx) return { ok: false, reason: 'invalid' };
  const aSpan = calcMaxOverlapSpan(bars, aStartIdx, aRightIdx);
  const tempMax = aSpan - 1;
  if (tempMax < DEFAULT_CANDIDATE_SPAN_MIN) return { ok: false, reason: 'too_small', tempMax: tempMax };
  const aDir = sourceSeg.direction || segDirection(sourceSeg);
  const found = calcNaturalDuanEndFull(bars, aStartIdx, left.price, aDir, tempMax, true);
  if (!found || !found.endInfo || found.endInfo.barIdx <= aStartIdx) {
    return { ok: false, reason: (found && found._reason) || 'fail', tempMax: tempMax };
  }
  // 注：本函数不会出现「零改动」，也无需另设闸——a 按「所属跨数」计算 tempMax = aSpan - 1，
  // 而候选跨数 = calcMaxOverlapSpan(bars, aStartIdx, p.barIdx) 对 barIdx 单调不减，
  // 故 a 自身终点（barIdx = aRightIdx，跨数 = aSpan = tempMax + 1）必然超本档上限被排除。
  // 长档为空时本函数返回 rule_not_found，由调用方回退到 b 的原选点结果（短档）——这就是「承认窄胡同」。
  return { ok: true, newEnd: found.endInfo, tempMax: tempMax };
}

// 死胡同回溯（纯计算）：盯盘段 b 已无法继续续接，找到其前一段 a（a 右端点 == b 左端点），
// 用「临时上限 = a 跨数 - 1」重算 a 终点。成功返回 { ok:true, prevSeg:a, newEnd, tempMax }。
// 验收标准（C 档）：仅仅「a 能收紧出新终点」不算成功——必须证明收紧后的 a′ 还能重新接出 b′，
// 且 b′ 之后还能接出 c′，即回溯后段链仍然成立；否则回缩只会白白丢掉 b，判失败（a、b 原样不动）。
// 预演只调用纯计算 calcNaturalDuanEndFull，不改动任何数据。
// c′ 若因右侧K线不足（avail<9，_reason='already_done'）算不出，属「无法验证」而非失败，降级为只验 b′。
export function rollbackResult(segs, watchSeg, bars) {
  if (!watchSeg || !bars || !bars.length) return { ok: false, reason: 'no_active' };
  const bLeft = segLeft(watchSeg);
  if (!bLeft) return { ok: false, reason: 'no_prev' };
  const bLeftSec = Math.floor(bLeft.time);
  let a = null;
  for (const s of segs) {
    if (s === watchSeg || !s || !s.end) continue;
    const r = segRight(s);
    if (!r) continue;
    if (Math.floor(r.time) === bLeftSec && r.price === bLeft.price) { a = s; break; }
  }
  if (!a) return { ok: false, reason: 'no_prev' };
  const aLeft = segLeft(a), aRight = segRight(a);
  if (!aLeft || !aRight) return { ok: false, reason: 'no_prev' };
  const aStartSec = Math.floor(aLeft.time);
  const aStartIdx = findBarIdxByTime(bars, aStartSec);
  if (aStartIdx < 0 || aStartIdx >= bars.length - 1) return { ok: false, reason: 'no_prev' };
  const aRightIdx = findBarIdxByTime(bars, aRight.time);
  if (aRightIdx <= aStartIdx) return { ok: false, reason: 'invalid' };
  const aSpan = calcMaxOverlapSpan(bars, aStartIdx, aRightIdx);
  const tempMax = aSpan - 1;
  if (tempMax < DEFAULT_CANDIDATE_SPAN_MIN) return { ok: false, reason: 'too_small' };
  const aDir = a.direction || segDirection(a);
  const found = calcNaturalDuanEndFull(bars, aStartIdx, aLeft.price, aDir, tempMax);
  if (!found || !found.endInfo || found.endInfo.barIdx <= aStartIdx) {
    return { ok: false, reason: (found && found._reason) || 'fail' };
  }
  const newEnd = found.endInfo;
  // 零改动判定（与 tightenCurrentResult 同源）：收紧后 a′ 与 a 仍是同一根K线、同一价位，说明这次回溯
  // 一根没缩动——它对「b 之后能否接上 c」毫无改变，却要付出删掉 b 的代价（纯破坏、零收益）。
  // 若不判，回溯会「成功」删掉 b 并把 a 重新激活为盯盘段，自动续接随即又重建出与 b 几何完全相同的段，
  // 下一帧再被窄胡同收紧、再回溯删除……形成逐帧「删段→原样重画」的死循环（下一段盯盘段不断闪烁跳动）。
  if (newEnd.barIdx === aRightIdx && Math.abs(newEnd.price - aRight.price) < 1e-9) {
    return { ok: false, reason: 'no_change' };
  }
  // —— 验收预演（零改动）——
  // 上面只证明「a 能收紧出 a′」。真正要验收的是：回溯后段链还立得住吗？
  // ① 从 a′ 新终点按 b 原方向试算 b′  ② 从 b′ 终点按 c 方向（与 b 反向）试算 c′
  const bDir = watchSeg.direction || segDirection(watchSeg);
  const cDir = bDir === 'up' ? 'down' : 'up';
  const bPrime = calcNaturalDuanEndFull(bars, newEnd.barIdx, newEnd.price, bDir);
  if (!bPrime || !bPrime.endInfo || bPrime.endInfo.barIdx <= newEnd.barIdx) {
    return { ok: false, reason: 'fail' };
  }
  const cPrime = calcNaturalDuanEndFull(bars, bPrime.endInfo.barIdx, bPrime.endInfo.price, cDir);
  const cOk = !!(cPrime && cPrime.endInfo && cPrime.endInfo.barIdx > bPrime.endInfo.barIdx);
  if (!cOk && !(cPrime && cPrime._reason === 'already_done')) {
    return { ok: false, reason: 'fail' };
  }
  return { ok: true, prevSeg: a, newEnd: newEnd, tempMax: tempMax };
}

// 收紧当前盯盘段（纯计算）：临时上限 = 当前跨数 - 1，标准规则重算终点。
// 返回 { ok, newEnd, tempMax, curSpan } 或 { ok:false, reason, curSpan, tempMax }
export function tightenCurrentResult(seg, bars, startIdx) {
  const left = segLeft(seg), right = segRight(seg);
  if (!left || !right) return { ok: false, reason: 'invalid' };
  const endIdx = findBarIdxByTime(bars, right.time);
  if (startIdx < 0 || endIdx <= startIdx) return { ok: false, reason: 'invalid' };
  const curSpan = calcMaxOverlapSpan(bars, startIdx, endIdx);
  const tempMax = curSpan - 1;
  if (tempMax < DEFAULT_CANDIDATE_SPAN_MIN) {
    return { ok: false, reason: 'too_small', curSpan: curSpan, tempMax: tempMax };
  }
  const dir = seg.direction || segDirection(seg);
  // 标准规则（长档优先、短档兜底）：当前段可能是短档段，收紧后上限不足 9，不能只认长档
  const found = calcNaturalDuanEndFull(bars, startIdx, left.price, dir, tempMax);
  if (!found || !found.endInfo || found.endInfo.barIdx <= startIdx) {
    return { ok: false, reason: (found && found._reason) || 'fail', curSpan: curSpan, tempMax: tempMax };
  }
  // 零改动判定：收紧后终点与当前右端点仍是同一根K线、同一价位 ⇒ 本段实际一根没动。
  // 短档硬选出来的段（跨数贴近短档上界）收紧上限后只剩短档 [3,8]，必然重选出同一终点，
  // 若在此报成功，修复链会误判「已修好」而截断，第三层死胡同兜底永远执行不到，
  // 表现为每次行情刷新原地打转、段链再也接不下去。故如实报失败，让修复链继续下落。
  if (found.endInfo.barIdx === endIdx && Math.abs(found.endInfo.price - right.price) < 1e-9) {
    return { ok: false, reason: 'no_change', curSpan: curSpan, tempMax: tempMax };
  }
  return { ok: true, newEnd: found.endInfo, tempMax: tempMax, curSpan: curSpan };
}

// 死胡同兜底（纯计算，修复链第三层）：
// 病因：盯盘段 b「之后的下一段」按标准滑窗半径 N(10→7) 找不到终点，段链因此接不上。
// 做法：只把「下一段试算」的滑窗下限逐级下调（6→5→4→3→2，2 为兜底下限），
//   收到第一个能通过验收的窗口即停。窗口只在本函数内下调，其余调用一律保持默认 10→7。
// 验收口径与 rollbackResult 一致（C 档）：c′ 之后还要能接出 d′；
//   d′ 因右侧K线不足（_reason='already_done'）算不出时视为「无法验证」，降级为只验 c′。
// 不修改 seg；由调用方提交（冻结 b、用 newEnd 落下一段）。
// 返回 { ok:true, newEnd, window } / { ok:false, reason }。
export function deadEndFallbackResult(seg, bars) {
  if (!seg || !bars || !bars.length) return { ok: false, reason: 'invalid' };
  const right = segRight(seg);
  if (!right) return { ok: false, reason: 'invalid' };
  const endIdx = findBarIdxByTime(bars, right.time);
  if (endIdx < 0 || endIdx >= bars.length - 1) return { ok: false, reason: 'already_done' };
  const bDir = seg.direction || segDirection(seg);
  const cDir = oppositeDir(bDir);
  for (let w = DEAD_END_FALLBACK_WINDOW_MAX; w >= DEAD_END_FALLBACK_WINDOW_MIN; w--) {
    // 只试该窗口本身：更宽的窗口在进入兜底前已确定失败，不重复试算
    const cPrime = calcNaturalDuanEndFull(bars, endIdx, right.price, cDir, undefined, false, w, w);
    if (!cPrime || !cPrime.endInfo || cPrime.endInfo.barIdx <= endIdx) continue;
    // C 档验收：c′ 之后还要能接出 d′（按标准窗口试算；already_done 视为无法验证而降级）
    const dPrime = calcNaturalDuanEndFull(bars, cPrime.endInfo.barIdx, cPrime.endInfo.price, bDir);
    const dOk = !!(dPrime && dPrime.endInfo && dPrime.endInfo.barIdx > cPrime.endInfo.barIdx);
    if (!dOk && !(dPrime && dPrime._reason === 'already_done')) continue;
    return { ok: true, newEnd: cPrime.endInfo, window: w };
  }
  return { ok: false, reason: 'no_window' };
}

// 交易日 key（A 股 UTC+8）：同一交易日的秒级时间戳映射到同一个整数。
// 用于强缺口兜底判定「缺口是否跨交易日」，不引入任何交易日历依赖。
function tradingDayKey(t) {
  return Math.floor((Math.floor(t) + 28800) / 86400);
}

// 缺口后第一个显著极值：滑窗半径由 10 逐级收紧到 7，取首个命中的相对极值。
// 与常规选点刻意不同：忽略跨数下限与早停——缺口后的单边行情常使跨数冲到 27 以外，
// 若按常规规则会被下限与早停排除（跨数空白带），恰是本层要救的场景。
// 跨数上限 27 不在此处把关，由 strongGapFallbackResult 的硬上限闸负责。
function firstExtremeAfterGap(bars, gapIdx, direction) {
  for (let n = STRONG_GAP_WINDOW_MAX; n >= STRONG_GAP_WINDOW_MIN; n--) {
    const ex = findExtremes(bars, gapIdx, direction, n, 1, null);
    if (ex && ex.length) return ex[0];
  }
  return null;
}

// 强缺口兜底（纯计算，修复链第四层，2026-09-22）：
// 病因：b 之后要画的 c 按标准规则找不到终点，且 ①回溯、②自修、③死胡同兜底 均已失败。
// 此时若行情在 b 右端点之后出现「强反向缺口」——跨交易日 + 相邻K线区间不重叠 + 方向与 c 一致
// （c 向下→向下缺口 bars[i+1].high < bars[i].low；c 向上→向上缺口 bars[i+1].low > bars[i].high）——
// 则把缺口本身视作 c 的核心动能：c 终点直接取「缺口后第一个显著极值」（滑窗 10→7，
// 忽略跨数下限与早停），并以「c 终点突破 b 起点价」作力度校验
// （c 向下→终点低于 b 起点价；c 向上→终点高于 b 起点价），以此表示 c 足够强有力。
// 本层不依赖 a 段（判据参照是 b 的起点价，不是 a 的起点价），也不做 d 验收，校验通过即落段。
// 注意：豁免的只是「跨数下限 3」与早停，**跨数上限 27 仍必须满足**——缺口常在段尾而非段首，
// 若不设上限会落出横跨整日、跨数远超 27 的巨段（实例：比亚迪 09-21 09:31 → 09-22 09:41，跨数 177）。
// 不修改 seg；由调用方提交（冻结 b、用 newEnd 落下一段）。
// 返回 { ok:true, newEnd, gapIdx } / { ok:false, reason }。
export function strongGapFallbackResult(seg, bars) {
  if (!seg || !bars || !bars.length) return { ok: false, reason: 'invalid' };
  const left = segLeft(seg), right = segRight(seg);
  if (!left || !right) return { ok: false, reason: 'invalid' };
  const endIdx = findBarIdxByTime(bars, right.time);
  if (endIdx < 0 || endIdx >= bars.length - 1) return { ok: false, reason: 'already_done' };
  const bDir = seg.direction || segDirection(seg);
  const cDir = oppositeDir(bDir);
  // 从 b 右端点起逐根找第一个「跨交易日 + 区间不重叠 + 方向与 c 一致」的缺口
  let gapIdx = -1;
  for (let i = Math.max(0, endIdx); i < bars.length - 1; i++) {
    const cur = bars[i], nxt = bars[i + 1];
    if (!cur || !nxt) continue;
    if (cur.high == null || cur.low == null || nxt.high == null || nxt.low == null) continue;
    if (tradingDayKey(cur.time) === tradingDayKey(nxt.time)) continue; // 必须跨交易日
    const isGap = cDir === 'down' ? (nxt.high < cur.low) : (nxt.low > cur.high);
    if (isGap) { gapIdx = i; break; }
  }
  if (gapIdx < 0) return { ok: false, reason: 'no_gap' };
  // 缺口后第一个显著极值（忽略跨数下限与早停，滑窗 10→7；跨数上限 27 仍由下方硬上限闸把关）
  const cand = firstExtremeAfterGap(bars, gapIdx, cDir);
  if (!cand || cand.barIdx <= endIdx) return { ok: false, reason: 'no_extreme' };
  // 硬上限闸：无论缺口多强，落出来的 c 仍必须是一根合法段（跨数 ≤ 段上限 27）。
  // 本层只豁免「跨数下限 3」与早停，不豁免上限——否则会落出横跨整日、跨数远超 27 的巨段
  // （实例：比亚迪 09-21 09:31 → 09-22 09:41，缺口仅在段尾，跨数 177）。
  if (calcMaxOverlapSpan(bars, endIdx, cand.barIdx) > DEFAULT_CANDIDATE_SPAN_MAX) {
    return { ok: false, reason: 'too_long' };
  }
  // 力度校验：c 终点必须突破 b 的起点价（c 向下取更低，c 向上取更高）
  const broke = cDir === 'down' ? (cand.price < left.price) : (cand.price > left.price);
  if (!broke) return { ok: false, reason: 'weak' };
  return { ok: true, newEnd: cand, gapIdx: gapIdx };
}

// ========== 自动续接/死胡同自修 三判定（含跨数缓存） ==========

let _watchSpanCache = null;    // 跨数计算缓存（O(N²)，仅行情变化时重算）
let _watchCappedKeys = Object.create(null); // 跨数封顶记忆（单调不减 ⇒ 一旦超限永久超限）
let _watchAutoState = null;    // 供展示的进度 { segId, phase, nextSpan, maxSpan, fixCount }

export function resetWatchCaches() {
  _watchSpanCache = null;
  _watchCappedKeys = Object.create(null);
  _watchAutoState = null;
}

export function getWatchAutoState() {
  return _watchAutoState;
}

function _watchSpanCacheKey(seg, startIdx, endIdx, bars) {
  const lastBar = bars[bars.length - 1];
  return seg.id + '|s' + startIdx + '|e' + endIdx + '|' + bars.length + '|' +
    Math.floor(lastBar.time) + '|' + lastBar.high + '|' + lastBar.low;
}
function _watchSpanCacheRead(key) {
  return (_watchSpanCache && _watchSpanCache.key === key) ? _watchSpanCache : null;
}
function _watchSpanCacheWrite(key, field, val) {
  const c = _watchSpanCacheRead(key);
  if (c) { c[field] = val; return; }
  const n = { key: key, startSpan: null, nextSpan: null };
  n[field] = val;
  _watchSpanCache = n;
}

// 判定1：当前盯盘段是否「百分百画完」。
// ① 顶到头：起点→最新K线跨数 > 上限（默认27，被回修过的段用其收紧上限）
// ② 线头定死：线头那根K线右侧已有 >= WATCH_CONFIRM_BARS 根真K线
export function evalWatchSegmentDone(seg, bars, startIdx, maxSpanOverride) {
  const lastIdx = bars.length - 1;
  const right = segRight(seg);
  const endIdx = right ? findBarIdxByTime(bars, right.time) : -1;
  const rawMax = (maxSpanOverride != null && maxSpanOverride >= DEFAULT_CANDIDATE_SPAN_MIN)
    ? maxSpanOverride : DEFAULT_CANDIDATE_SPAN_MAX;
  const maxSpan = Math.max(8, rawMax);
  if (startIdx < 0 || endIdx < 0 || endIdx >= lastIdx) {
    return { done: false, startIdx: startIdx, endIdx: endIdx, lastIdx: lastIdx, maxSpan: maxSpan, startSpan: 0 };
  }
  const key = _watchSpanCacheKey(seg, startIdx, endIdx, bars);
  const cappedKey = seg.id + '|' + startIdx;
  let condCapped;
  let startSpan = -1;
  if (_watchCappedKeys[cappedKey]) {
    condCapped = true;
  } else {
    const c = _watchSpanCacheRead(key);
    if (c && c.startSpan != null) {
      startSpan = c.startSpan;
    } else {
      startSpan = calcMaxOverlapSpan(bars, startIdx, lastIdx);
      _watchSpanCacheWrite(key, 'startSpan', startSpan);
    }
    condCapped = startSpan > maxSpan;
    if (condCapped) _watchCappedKeys[cappedKey] = true;
  }
  const condConfirmed = (lastIdx - endIdx) >= WATCH_CONFIRM_BARS;
  return {
    done: !!(condCapped && condConfirmed),
    startIdx: startIdx, endIdx: endIdx, lastIdx: lastIdx,
    maxSpan: maxSpan, startSpan: startSpan,
    capped: condCapped, confirmed: condConfirmed,
  };
}

// 判定3：下一段是否已「充分发展」（给了整整 27 跨的成长空间仍长不出来）。
// 返回 { exhausted, nextSpan, probeIdx }
export function evalNextSegmentExhausted(seg, bars, startIdx, endIdx) {
  const lastIdx = bars.length - 1;
  const probeIdx = lastIdx - (WATCH_CONFIRM_BARS - 1);
  if (probeIdx <= endIdx) {
    return { exhausted: false, nextSpan: 0, probeIdx: probeIdx };
  }
  const key = _watchSpanCacheKey(seg, startIdx, endIdx, bars);
  const c = _watchSpanCacheRead(key);
  let nextSpan;
  if (c && c.nextSpan != null) {
    nextSpan = c.nextSpan;
  } else {
    nextSpan = calcMaxOverlapSpan(bars, endIdx, probeIdx);
    _watchSpanCacheWrite(key, 'nextSpan', nextSpan);
  }
  return { exhausted: nextSpan > DEFAULT_CANDIDATE_SPAN_MAX, nextSpan: nextSpan, probeIdx: probeIdx };
}

// 自动续接主判定：返回 'continue' / 'fix' / 'wait' / null
//   'continue' = 当前段 100% 画完且下一段可接 → 冻结并续接
//   'fix'      = 当前段画完但下一段已充分发展仍接不上 → 回修当前段（收紧一格）
//   'wait'     = 画完但下一段还在长 → 继续等
//   null       = 当前段还在长，什么都不做
export function evalAutoContinue(segs, seg, bars, startIdx, maxSpanOverride) {
  const done = evalWatchSegmentDone(seg, bars, startIdx, maxSpanOverride);
  if (!done.done) {
    _watchAutoState = {
      segId: seg.id,
      phase: done.capped ? 'confirming' : 'growing',
      nextSpan: 0, maxSpan: done.maxSpan, fixCount: seg._watchFixCount || 0,
    };
    return null;
  }
  const con = canContinueFromSeg(segs, seg, bars);
  if (con.can) {
    _watchAutoState = {
      segId: seg.id, phase: 'continue',
      nextSpan: 0, maxSpan: done.maxSpan, fixCount: seg._watchFixCount || 0,
    };
    return 'continue';
  }
  const exh = evalNextSegmentExhausted(seg, bars, done.startIdx, done.endIdx);
  if (exh.exhausted) {
    _watchAutoState = {
      segId: seg.id, phase: 'exhausted',
      nextSpan: exh.nextSpan, nextMax: DEFAULT_CANDIDATE_SPAN_MAX, maxSpan: done.maxSpan,
      fixCount: seg._watchFixCount || 0,
    };
    return 'fix';
  }
  _watchAutoState = {
    segId: seg.id, phase: 'waiting',
    nextSpan: exh.nextSpan, nextMax: DEFAULT_CANDIDATE_SPAN_MAX, maxSpan: done.maxSpan,
    fixCount: seg._watchFixCount || 0,
  };
  return 'wait';
}
