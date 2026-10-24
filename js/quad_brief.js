// quad_brief.js —— 手机端「多级别联立」简报生成器
//
// 职责：把**手机上已经算好的**多张周期图（段/中枢/力度/买卖点）写成一段人话，
//       供用户复制到 WorkBuddy 提问。它是 ai_brief.js（单图简报）的联立版。
//
// 为什么需要它：单图简报的输入是「一张图」，联立分析的输入是「一条级别链」。
// 把单图接口循环调用四次不会得到联立 —— 只会得到四份互不知道对方存在的自述：
// 四级都说「当前这段下跌力度减弱」，却没有一处说「30分钟这一段，正是日线那一段
// 的内部结构」。本文件补的就是这层跨级编排。
//
// 硬边界（与 ai_brief.js 一致，逐条照守）：
//   1. **只读不判**。段、中枢、力度、买卖点全部由 algo.js 算过并挂在对象上
//      （`_strength` / `_strengthIndicator` / `_strengthRefId` / `_bsLabel`），
//      本文件不得重新判定任何东西，也不得自己从 K 线数段。
//   2. **作用域只取 hide.js 的可见段**。即「被紧邻上一级最后一段截断之后仍然显示的
//      那些线」—— 就是用户屏幕上看得见的部分。本文件不另定口径、不重算分界。
//   3. **不写相对级别提法**：移动版用周期承载级别（日线图上的段＝日线级别走势），
//      一律写「日线 / 30分钟 / 5分钟」，不写「次级别 / 本级别 / 高级别」。
//   4. **各级力度不可跨级比较**。每级用的是自己周期的 K 线，量纲不同；只能在本级
//      内部比（本段 vs 参照段）。这条必须在文本里说破，否则模型一定会横向比大小。
//   5. **15 分钟 / 60 分钟不纳入**。它们是辅助周期，画线复刻主周期（5m / 30m），
//      纳入会平白多两级，且跨级对账必然对不上。
//   6. **必须写生成时刻**。这段话是快照，行情一动手机会重算，但贴进 WorkBuddy 的
//      文本不会跟着变，不写时间就会被当成「现在」。
//   7. 纯函数、无 DOM 依赖、**不修改入参**，可在 node 里直接跑（供样本导出/对拍）。

import { visibleSegsOf, visibleZsOf, PERIOD_SEQ, AUX_PERIODS } from './hide.js';

const LEVEL_CN = {
  '1m': '1分钟', '5m': '5分钟', '15m': '15分钟', '30m': '30分钟', '60m': '60分钟',
  day: '日线', week: '周线', month: '月线', quarter: '季线', year: '年线',
};

const DAILY_PERIODS = new Set(['day', 'week', 'month', 'quarter', 'year']);

// 名义周期长度（秒）：用于判断「两级看到的当前是不是同一时刻」的容差
const NOMINAL_SECS = {
  '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '60m': 3600,
  day: 86400, week: 86400 * 7, month: 86400 * 30, quarter: 86400 * 91, year: 86400 * 365,
};

const NUMERALS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const WEEKS = ['日', '一', '二', '三', '四', '五', '六'];

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// 时间字段可能是 Unix 秒，也可能是 'YYYY-MM-DD' / 'YYYY-MM-DD HH:MM' 字符串
function toSec(t) {
  if (Number.isFinite(t)) return t;
  if (typeof t !== 'string') return null;
  const s = t.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return Math.floor(new Date(+m[1], +m[2] - 1, +m[3]).getTime() / 1000);
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
  if (m) return Math.floor(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() / 1000);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return Math.floor(new Date(+m[1], +m[2] - 1, +m[3]).getTime() / 1000);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

function fmtClock(sec) {
  const d = new Date(sec * 1000);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtDay(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtFull(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())} 周${WEEKS[d.getDay()]}`;
}

function levelCn(p) {
  return LEVEL_CN[p] || p || '—';
}

function fixed(v, n) {
  return Number.isFinite(v) ? v.toFixed(n) : '—';
}

function signed(v, n) {
  if (!Number.isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(n);
}

function timeFmt(period) {
  return DAILY_PERIODS.has(period) ? fmtDay : fmtClock;
}

function numeral(n) {
  return NUMERALS[n - 1] || `(${n})`;
}

/**
 * 挑出参与联立的周期（自上而下）。
 *
 * 三条判据，缺一不纳入：
 *   1. 不是辅助周期（15m/60m 画线复刻主周期，不是独立级别）
 *   2. 该周期画过线（至少一条线段；只有中枢不算）
 *   3. 在证券的可用周期列表里
 *
 * @param {string[]} periods  证券可用周期（sec.periods）
 * @param {object} drawings   { [period]: { segments, zhongshus } }
 * @returns {string[]} 高 → 低
 */
export function pickQuadLevels(periods, drawings) {
  const out = [];
  for (const p of (periods || [])) {
    if (AUX_PERIODS.has(p)) continue;
    const segs = drawings && drawings[p] ? drawings[p].segments : null;
    if (!Array.isArray(segs) || !segs.length) continue;
    out.push(p);
  }
  return out.sort((a, b) => PERIOD_SEQ.indexOf(b) - PERIOD_SEQ.indexOf(a));
}

/**
 * 单级摘要（纯读取）。所有判定都引用已挂在段上的字段，不重算。
 */
function summarizeLevel(lv, higher, idx) {
  const period = lv.period;
  const allSegs = Array.isArray(lv.segments) ? lv.segments : [];
  const allZs = Array.isArray(lv.zhongshus) ? lv.zhongshus : [];
  const segs = visibleSegsOf(allSegs, lv.hideBefore);
  const zss = visibleZsOf(allZs, segs);
  const bars = Array.isArray(lv.bars) ? lv.bars : [];
  const lastBar = bars.length ? bars[bars.length - 1] : null;
  const lastBarTime = lastBar ? toSec(lastBar.time) : null;
  const cur = segs.length ? segs[segs.length - 1] : null;

  return {
    period, higher, idx,
    allSegs, allZs, segs, zss, bars, lastBarTime, cur,
    hideBefore: lv.hideBefore ?? null,
    hideHow: lv.hideHow || null,
    // 用来锚定的那一段（上一级「最后一段」，由 computeHideBeforeDetail 一并返回）：
    // 它才是分界的来源，不能拿上一级「作用域内最后一段」顶替 —— 后者可能是一条
    // 盯盘段（终点是当前最新价），锚定用的却是排除盯盘段之后的那一条。
    anchorSeg: lv.anchorSeg || null,
    segTotal: allSegs.length,
    zsTotal: allZs.length,
  };
}

/**
 * 生成多级别联立简报。
 *
 * @param {object} ctx
 *   code, name                 标的
 *   levels                     自上而下的级别数组，每项：
 *                              { period, bars, segments, zhongshus, hideBefore, hideHow }
 *                              hideBefore 由调用方用 hide.js 的 computeHideBeforeDetail 算好
 *   a0Period                   A0 级别，可缺
 *   presetName                 当前方案名，可缺
 *   quote                      { price, prevClose } 实时行情，可缺
 *   nowSec                     生成时刻（Unix 秒），缺省取当前时间
 *   maxPoints                  每级最多列几个买卖点（默认 3）
 * @returns {{title: string, text: string, warnings: string[]}}
 */
export function buildQuadBrief(ctx) {
  const c = ctx || {};
  const code = c.code || '';
  const name = c.name || '';
  const nowSec = Number.isFinite(c.nowSec) ? c.nowSec : Math.floor(Date.now() / 1000);
  const quote = c.quote || null;
  const maxPoints = Number.isFinite(c.maxPoints) ? c.maxPoints : 3;

  const rawLevels = Array.isArray(c.levels) ? c.levels : [];
  const src = rawLevels.filter((lv) => lv && lv.period);
  // higher 取「屏幕实际用的那一级」（紧邻上一级，已跳辅助周期），不是「联立链里的上一级」：
  // 链上可能缺一级没画线，但屏幕的隐藏仍按紧邻那级算，混用会让叙述与眼睛看到的不一致。
  const parsed = src.map((lv, i) => summarizeLevel(
    lv, lv.higherPeriod || (i > 0 ? src[i - 1].period : null), i));

  const warnings = [];
  const out = [];
  const chainCn = parsed.map((p) => levelCn(p.period)).join(' → ');

  out.push(`【${name || code} ${parsed.length}级联立 · 手机端结构简报】`);
  out.push('');
  out.push('【这段话怎么来的】');
  out.push(`生成时刻：${fmtFull(nowSec)}。`);
  if (parsed.length) {
    out.push(`联立 ${parsed.length} 级（自上而下）：${chainCn}。用的是你手机上**此刻这几张图**的画线，`
      + '下面所有数字都是手机按这套画线算好的现成结论，**请直接引用，不要自己从 K 线重新数段、'
      + '重新算力度或重新判买卖点**。');
    out.push('每一级的「作用域」＝被紧邻上一级最后一段截断之后、图上**仍然显示**的那些线。'
      + '所以下面每一级讲的都是你屏幕上看得见的那部分，不是全图统计。');
    out.push('读法：移动版用周期承载级别 —— 每张周期图上的线段，就是该周期的走势级别'
      + `（日线图上的段＝日线级别走势，以此类推）${c.a0Period ? `；该标的 A0 是 ${levelCn(c.a0Period)}` : ''}。`);
  } else {
    out.push('没有任何周期画过线，无法做联立分析。');
    return { title: `${name || code} 联立简报`, text: out.join('\n') + '\n', warnings };
  }
  out.push('「力度」= 这一段里同方向 MACD 柱子累加，数字越大说明这一波推得越猛；'
    + '它跟涨跌幅是两回事，不要用价格幅度代替力度。');
  if (c.presetName) out.push(`当前方案「${c.presetName}」。`);

  // ---- 当前行情 ----
  // 兜底取**最低一级**（周期最短、最新）的末根收盘，不能取最高级的：
  // 日线的最后一根是今天收盘，和「最新价」可能差一整个交易日。
  const lowLv = parsed[parsed.length - 1];
  const price = Number.isFinite(quote?.price) ? quote.price
    : (lowLv && lowLv.bars.length
      ? Number(lowLv.bars[lowLv.bars.length - 1].close)
      : null);
  out.push('');
  out.push('【当前行情】');
  if (Number.isFinite(price)) {
    let line = `最新价 ${fixed(price, 3)}`;
    if (Number.isFinite(quote?.prevClose) && quote.prevClose > 0) {
      const chg = (price - quote.prevClose) / quote.prevClose * 100;
      line += `，${chg >= 0 ? '涨' : '跌'} ${Math.abs(chg).toFixed(2)}%`;
    }
    out.push(line + '。');
  } else {
    out.push('（没有取到行情，只有画线结构。）');
  }

  // ---- 逐级 ----
  for (const lv of parsed) {
    const tf = timeFmt(lv.period);
    out.push('');
    out.push(`【${numeral(lv.idx + 1)} ${levelCn(lv.period)} —— ${levelCn(lv.period)}级别走势】`);

    if (!lv.allSegs.length) {
      out.push('  这一级图上没有任何线段，无结构可讲。');
      continue;
    }

    // 作用域
    if (lv.hideBefore == null) {
      if (lv.higher) {
        out.push(`  作用域：整图 —— ${levelCn(lv.higher)}图上的段全是盯盘/追踪/递归段，`
          + '没有可用来定分界的完成段，本图按全图处理。');
      } else {
        out.push('  作用域：整图 —— 这是最高一级，没有更高周期可以截断它，按全图算。');
      }
    } else {
      const anchorSeg = lv.anchorSeg;
      const from = tf(lv.hideBefore);
      let line = `  作用域：被${levelCn(lv.higher)}图最后一段截断，起点 ${from}`;
      // 只有「对齐」分支的 anchor 才是这个起点的来源；走了安全回退时 anchor 已被换成
      // 「上一级所有段的起点」，写出来会与实际起点自相矛盾，所以只在 aligned 时展开。
      if (anchorSeg && lv.hideHow === 'aligned') {
        const at0 = toSec(anchorSeg.start?.time);
        const at1 = toSec(anchorSeg.end?.time);
        const htf = timeFmt(lv.higher);
        if (at0 != null && at1 != null) {
          line += `（那一级最后一段：${htf(at0)} → ${htf(at1)}）`;
        }
      }
      line += ` —— 图上可见 ${lv.segs.length} 段`
        + (lv.segs.length === lv.segTotal ? '' : `／全图 ${lv.segTotal} 段`);
      out.push(line + '。');
      if (lv.hideHow === 'fallback') {
        out.push(`  ※ 这里走了安全回退：${levelCn(lv.higher)}图的数据比本图段更新，`
          + '对齐点会越过本图最后一段，于是退回用「上一级所有段的起点」对齐。'
          + '所以这个起点偏早，含了额外的历史段，不是你屏幕上「当前这一段」的真实分界。');
        warnings.push(`${levelCn(lv.period)}的作用域取了安全回退（起点偏早）`);
      }
    }

    // 中枢
    const lastZs = lv.zss.length ? lv.zss[lv.zss.length - 1] : null;
    if (lastZs) {
      const lo = Number.isFinite(lastZs.low) ? lastZs.low : null;
      const hi = Number.isFinite(lastZs.high) ? lastZs.high : null;
      let line = `  中枢：作用域内 ${lv.zss.length} 个（全图 ${lv.zsTotal} 个）`;
      if (lo != null && hi != null) {
        const h = hi > lo ? ((hi - lo) / lo * 100) : null;
        line += `｜最近一个 ${fixed(lo, 3)} ~ ${fixed(hi, 3)}`
          + (h != null ? `（高 ${h.toFixed(2)}%）` : '');
        if (Number.isFinite(price) && hi > lo) {
          if (price > hi) line += `，当前价在中枢上方 ${((price - hi) / hi * 100).toFixed(2)}%`;
          else if (price < lo) line += `，当前价在中枢下方 ${((lo - price) / lo * 100).toFixed(2)}%`;
          else line += '，当前价**就在中枢里**';
        }
      }
      out.push(line + '。');
    } else {
      out.push(lv.zsTotal
        ? `  中枢：作用域内一个都没有（全图 ${lv.zsTotal} 个都早于这个分界）。`
        : '  中枢：图上还没有中枢。');
    }

    // 当前这一段
    const cur = lv.cur;
    if (!cur) {
      out.push('  作用域内还没有线段 —— 本级走势停在分界处，还没长出下一段。');
      continue;
    }
    const dirCn = cur.direction === 'down' ? '向下' : (cur.direction === 'up' ? '向上' : '横向');
    const st = toSec(cur.start?.time);
    const et = toSec(cur.end?.time);
    const p0 = cur.start?.price;
    const p1 = cur.end?.price;
    let segLine = `  当前这一段：${dirCn} ${tf(st)}（${fixed(p0, 3)}）→ ${tf(et)}（${fixed(p1, 3)}）`;
    if (p0) segLine += `，幅度 ${signed((p1 - p0) / p0 * 100, 2)}%`;
    out.push(segLine + '。');

    // 力度（引用 algo 已算定的结果，不自己挑参照段）
    const curArea = cur._strength?.macdArea;
    const curBars = cur._strength?.barCount;
    const refSeg = cur._strengthRefId
      ? lv.allSegs.find((s2) => s2.id === cur._strengthRefId) : null;
    const refArea = refSeg?._strength?.macdArea;
    const refBars = refSeg?._strength?.barCount;
    const refHidden = refSeg && !lv.segs.includes(refSeg);
    if (Number.isFinite(curBars) && curBars < 2) {
      out.push('  力度：算不出来（这一段底下没有对应的 K 线，画线时间和 K 线对不上）。');
    } else if (Number.isFinite(curArea) && Number.isFinite(refArea)) {
      let line = `  力度 ${fixed(Math.abs(curArea), 1)}，`
        + `参照段（${cur._strengthRefBasis || '参考段'}）${fixed(Math.abs(refArea), 1)}`
        + ` → **${cur._strengthIndicator || '—'}**`;
      if (refHidden) line += `［参照段在作用域之外，属已递归上去的历史段］`;
      if (Number.isFinite(refBars) && refBars < 3) {
        line += '；但参照段只含 ' + refBars + ' 根 K 线，这个强弱结论基本没有参考价值，别据此判断背驰';
      }
      out.push(line + '。');
    } else if (Number.isFinite(curArea)) {
      out.push(`  力度 ${fixed(Math.abs(curArea), 1)}（本级没有可比的参照段，暂不判强弱）。`);
    } else {
      out.push('  力度：不可比（这一段覆盖的 K 线不足 2 根，不是 0）。');
    }

    // 未完成判定
    const isLive = lv.lastBarTime != null && et != null && et >= lv.lastBarTime;
    if (isLive) {
      out.push('  这一段**还没走完**：终点就是最后一根 K 线，会随行情继续延伸。'
        + '力度只是当前进度，继续走还会累加，走完才定案。');
    } else if (lv.lastBarTime != null && et != null) {
      out.push(`  这一段停在 ${tf(et)}，而最后一根 K 线是 ${tf(lv.lastBarTime)}`
        + '——中间没有再延伸出新段（画线还没跟上最新行情，或这段时间没有符合条件的段）。');
    }

    // 买卖点
    const marked = [];
    lv.segs.forEach((s, i) => {
      if (!s._bsLabel) return;
      const t = Math.max(toSec(s.start?.time) ?? 0, toSec(s.end?.time) ?? 0);
      marked.push({ i: i + 1, label: s._bsLabel, time: t, price: s.end?.price });
    });
    if (marked.length) {
      const picked = marked.slice(-maxPoints);
      const txt = picked.map((m) => `${tf(m.time)} @${fixed(m.price, 3)} **${m.label}**（第 ${m.i} 段终点）`);
      out.push('  买卖点：' + txt.join('；')
        + (marked.length > maxPoints ? `（更早还有 ${marked.length - maxPoints} 个，未列出）` : ''));
    } else {
      out.push('  买卖点：作用域内一个都没标（不代表没有，只是按当前画线还没成立）。');
    }
  }

  // ---- 跨级对账 ----
  out.push('');
  out.push('【级别链对账】');
  if (parsed.length < 2) {
    out.push('  （只有一级，无跨级可对照。想联立就把相邻的上一档周期也画上线。）');
  } else {
    const rows = [];
    for (let i = 0; i < parsed.length - 1; i++) {
      const lo = parsed[i + 1];
      const hi = parsed[i];
      const hiTf = timeFmt(hi.period);
      const loTf = timeFmt(lo.period);
      const tol = NOMINAL_SECS[hi.period] || 0;

      // ① 锚点：低级的分界应落在高级最后一段的区间内
      if (lo.hideBefore != null) {
        const hiSeg = hi.segs.length ? hi.segs[hi.segs.length - 1] : null;
        if (!hiSeg) {
          rows.push(`  ※${levelCn(hi.period)}图作用域内没有线段 ⇒ 无法用它锚定`
            + `${levelCn(lo.period)}图的分界（${loTf(lo.hideBefore)}）；`
            + `${levelCn(hi.period)}走势在这一段还没画出来`);
        } else {
          const t0 = toSec(hiSeg.start?.time);
          const t1 = toSec(hiSeg.end?.time);
          const ok = t0 != null && t1 != null
            && lo.hideBefore >= (t0 - tol) && lo.hideBefore <= (t1 + tol);
          const span = `${hiTf(t0)} ～ ${hiTf(t1)}`;
          if (ok) {
            rows.push(`  · 锚点对得上：${levelCn(lo.period)}图分界 ${loTf(lo.hideBefore)} 落在`
              + `${levelCn(hi.period)}图最后一段（${span}）之内`);
          } else {
            rows.push(`  ※ 锚点对不上：${levelCn(lo.period)}图分界 ${loTf(lo.hideBefore)} 不在`
              + `${levelCn(hi.period)}图最后一段（${span}）之内 —— 可能的解释（未验证）：`
              + '其中一图的画线改动过、或两图的数据不同步');
          }
        }
      } else if (hi.segs.length) {
        rows.push(`  ※${levelCn(hi.period)}图有 ${hi.segs.length} 段，但没能为`
          + `${levelCn(lo.period)}图定出分界（上一级只有盯盘/追踪/递归段）⇒ 两级之间没有锚定关系`);
      }

      // ② 游标：两级的末根 K 线是否同一时刻
      if (hi.lastBarTime != null && lo.lastBarTime != null
        && hi.lastBarTime !== lo.lastBarTime) {
        const gap = Math.abs(hi.lastBarTime - lo.lastBarTime);
        if (gap > tol) {
          const desc = gap >= 86400 ? `${(gap / 86400).toFixed(1)} 天`
            : (gap >= 3600 ? `${Math.round(gap / 3600)} 小时` : `${Math.round(gap / 60)} 分钟`);
          rows.push(`  ※ 游标不同步：${levelCn(hi.period)}图末根 K 线 ${hiTf(hi.lastBarTime)} ／ `
            + `${levelCn(lo.period)}图 ${loTf(lo.lastBarTime)}（差 ${desc}）`
            + ' ⇒ 两级看到的「当前」不是同一时刻');
        }
      }
    }
    if (!rows.length) {
      out.push('  · 相邻各级的分界锚点与末根 K 线时刻都对得上，没有发现跨级矛盾。');
    } else {
      out.push(...rows);
    }
  }

  // ---- 各级结论要点 ----
  out.push('');
  out.push('【各级结论要点（计数均为结构事实，可直接引用）】');
  for (const lv of parsed) {
    const parts = [
      `作用域内 ${lv.segs.length} 段`,
      `中枢 ${lv.zss.length} 个／全图 ${lv.zsTotal} 个`,
    ];
    if (lv.cur) {
      const dirCn = lv.cur.direction === 'down' ? '向下' : (lv.cur.direction === 'up' ? '向上' : '横向');
      parts.push(`当前段${dirCn}`);
      if (lv.cur._strengthIndicator) parts.push(`力度${lv.cur._strengthIndicator}`);
      const et = toSec(lv.cur.end?.time);
      if (lv.lastBarTime != null && et != null && et >= lv.lastBarTime) parts.push('未完成');
    } else {
      parts.push('作用域内无段');
    }
    out.push(`  ${levelCn(lv.period)}：` + parts.join(' ｜ '));
  }

  // ---- 边界声明 ----
  out.push('');
  out.push('【本视图边界（读之前先认下这几条）】');
  const bounds = [
    '作用域＝被紧邻上一级最后一段截断之后仍然显示的段，也就是你手机上看得见的那部分；不是全图统计。',
    '各级力度只能在本级内部比（本段 vs 参照段），**不能跨级比大小** —— 每级用的 K 线周期不同，量纲也不同。',
    '未完成段的力度是动态的：段没走完，继续走还会累加，走完才定案。',
    '15 分钟 / 60 分钟是辅助周期（画线复刻 5 分钟 / 30 分钟），不参与联立。',
    '图上没有买卖点标记 ≠ 不成立，只是按当前画线还没长出来。',
    '某一级没画线时该级不出现 —— 不出现不等于不存在，是没画。',
  ];
  bounds.forEach((b, i) => out.push(`  ${i + 1}. ${b}`));

  out.push('');
  out.push('【请你这样回答】按上面这份多级别结构回答我的问题。回答时请：'
    + '①先说高一级在做什么，再说低一级这一段的内部结构，最后给当下的操作判断；'
    + '②引用数字就照抄，不要另行推算背驰、也不要用价格幅度冒充力度；'
    + '③拿不准的地方直接说不确定。以上是代码算定的结论，不要推翻。');

  return {
    title: `${name || code} ${parsed.length}级联立结构简报`,
    text: out.join('\n') + '\n',
    warnings,
  };
}
