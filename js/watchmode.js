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
export const AUTO_CONTINUE_FIX_GAP = 10;   // 两次自回修之间至少间隔的新 K 线数（闸2）

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

// 由起点(idx) + 价格 + 方向，在跨数档（长档[9,27]优先、短档[3,9)兜底）× 滑窗半径 N(10→7)
// 中查找最显著极值终点。返回 { endInfo, N, matchedTier, hitExtremes, hitSpanOut, _reason }；
// endInfo 含 { time, price, barIdx, _span }。
// maxSpanOverride：回溯重算时临时把跨数上限从 27 缩到「前一段跨数-1」；
// longTierOnly：窄胡同收紧前段时仅用长档（[9,maxSpan]），不进入短档兜底。
export function calcNaturalDuanEndFull(bars, startIdx, startPrice, direction, maxSpanOverride, longTierOnly) {
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
  let endInfo = null, N = 0, matchedTier = null, hitExtremes = [], hitSpanOut = [];
  const spanCache = new Map(); // 同一个「起点→barIdx」的跨数只算一次
  for (let ti = 0; ti < tiers.length && !endInfo; ti++) {
    const tier = tiers[ti];
    for (let n = 10; n >= 7 && !endInfo; n--) {
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
  return { ok: true, newEnd: found.endInfo, tempMax: tempMax };
}

// 死胡同回溯（纯计算）：盯盘段 b 已无法继续续接，找到其前一段 a（a 右端点 == b 左端点），
// 用「临时上限 = a 跨数 - 1」重算 a 终点。成功返回 { ok:true, prevSeg:a, newEnd, tempMax }。
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
  return { ok: true, prevSeg: a, newEnd: found.endInfo, tempMax: tempMax };
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
  return { ok: true, newEnd: found.endInfo, tempMax: tempMax, curSpan: curSpan };
}

// ========== 自动续接/自回修 三判定（含跨数缓存） ==========

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
