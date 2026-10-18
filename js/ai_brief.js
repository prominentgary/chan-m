// ai_brief.js —— 手机端「问 AI」简报生成器
//
// 职责：把**手机上已经算好的**结果（线段/中枢/力度/买卖点/行情）写成一段人话，
//       供用户复制到 WorkBuddy 云端提问。
//
// 硬边界：
//   1. **只读不判**。段、中枢、力度、买卖点全部由 algo.js 算过并挂在对象上
//      （`_strength` / `_strengthIndicator` / `_strengthRefId` / `_bsLabel` / `_bsColor`），
//      本文件不得重新判定任何东西，也不得自己从 K 线数段。
//   2. **不写相对级别提法**（次级别/本级别/高级别）：同一句「本级别」在 5 分钟图
//      与 30 分钟图指不同级别。只说「本图周期」和「图上只有一种线型」。
//   3. **必须写生成时刻**。这段话是快照，行情一动手机会重算，但贴到 WorkBuddy 里
//      的文本不会跟着变，不写时间就会被当成「现在」。
//   4. **画线价格与 K 线价格量级明显不符时必须报警**。同号不同市场（000001 =
//      上证指数 / 平安银行）会让力度静默算错，只说数字不报警，AI 会照着一堆
//      错数给出自信的结论。
//   5. 纯函数、无 DOM 依赖、**不修改入参**，可在 node 里直接跑（供样本导出/对拍）。

const WEEKS = ['日', '一', '二', '三', '四', '五', '六'];
const DAILY_PERIODS = ['day', 'week', 'month', 'quarter', 'year'];

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// 时间字段在 app 里是 Unix 秒（fetcher 归一过），但静态 data/*.json 里
// 日线级别的 bars 存的是 'YYYY-MM-DD' 字符串。这里统一读成秒，读不出返回 null。
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

function fixed(v, n) {
  return Number.isFinite(v) ? v.toFixed(n) : '—';
}

function signed(v, n) {
  if (!Number.isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(n);
}

const PERIOD_CN = {
  '1m': '1 分钟', '5m': '5 分钟', '15m': '15 分钟', '30m': '30 分钟', '60m': '60 分钟',
  day: '日', week: '周', month: '月', quarter: '季', year: '年',
};

function periodCn(p) {
  return PERIOD_CN[p] || p || '—';
}

function zhongshuRange(zs) {
  const lo = Number.isFinite(zs.low) ? zs.low : null;
  const hi = Number.isFinite(zs.high) ? zs.high : null;
  if (lo !== null && hi !== null) return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
  const pts = zs.points || [];
  if (pts.length >= 2) {
    const a = pts[0].price, b = pts[1].price;
    return { lo: Math.min(a, b), hi: Math.max(a, b) };
  }
  return null;
}

// 中枢相对位置：返回「上方/内部/下方」+ 距离百分比
function positionVs(price, range) {
  if (!range || !Number.isFinite(price) || !(range.hi > range.lo)) return null;
  if (price > range.hi) return { where: '中枢上方', gap: (price - range.hi) / range.hi * 100 };
  if (price < range.lo) return { where: '中枢下方', gap: (price - range.lo) / range.lo * 100 };
  return { where: '中枢内部', gap: 0 };
}

/**
 * 生成手机端 AI 简报。
 *
 * @param {object} ctx
 *   code, name, period          标的与周期（period 用 Chan-M 口径：5m/day/...）
 *   bars                        本周期 K 线（time 为秒或日期字符串均可；已跑过 MACD）
 *   segments, zhongshus         当前画布（已跑过 algo 全套，字段齐全）
 *   quote                       {price, prevClose, name} 实时行情，可缺
 *   a0Period                    该标的 A0 级别，可缺
 *   presetName                  当前方案名，可缺
 *   nowSec                      生成时刻（Unix 秒），缺省取当前时间
 *   maxPoints                   最多列几个买卖点（默认 4）
 * @returns {{title: string, text: string, warnings: string[]}}
 */
export function buildBrief(ctx) {
  const c = ctx || {};
  const code = c.code || '';
  const name = c.name || '';
  const period = c.period || '';
  const bars = Array.isArray(c.bars) ? c.bars : [];
  const segs = Array.isArray(c.segments) ? [...c.segments] : [];
  const zss = Array.isArray(c.zhongshus) ? [...c.zhongshus] : [];
  const quote = c.quote || null;
  const nowSec = Number.isFinite(c.nowSec) ? c.nowSec : Math.floor(Date.now() / 1000);
  const maxPoints = Number.isFinite(c.maxPoints) ? c.maxPoints : 4;
  const isDaily = DAILY_PERIODS.includes(period);
  const tf = (sec) => (isDaily ? fmtDay(sec) : fmtClock(sec));

  segs.sort((a, b) => (toSec(a.start?.time) ?? 0) - (toSec(b.start?.time) ?? 0));
  zss.sort((a, b) => (toSec(a.startTime) ?? 0) - (toSec(b.startTime) ?? 0));

  const warnings = [];
  const lastBar = bars.length ? bars[bars.length - 1] : null;
  const lastTime = lastBar ? toSec(lastBar.time) : null;
  const cur = segs.length ? segs[segs.length - 1] : null;
  const price = Number.isFinite(quote?.price) ? quote.price
    : (lastBar && Number.isFinite(lastBar.close) ? lastBar.close : (cur ? cur.end.price : null));

  // 画线价格 vs K 线价格：量级差太大就不是同一个标的（同号不同市场最典型）。
  // 这时力度、最新价、中枢距离全部不可信，必须先说破，而不是照样输出一堆数字。
  const segPrices = [];
  segs.forEach((s) => {
    if (Number.isFinite(s.start?.price)) segPrices.push(s.start.price);
    if (Number.isFinite(s.end?.price)) segPrices.push(s.end.price);
  });
  const barCloses = bars.map((b) => b.close).filter(Number.isFinite);
  let mismatch = null;
  if (segPrices.length && barCloses.length) {
    const segMax = Math.max(...segPrices);
    const barMax = Math.max(...barCloses);
    if (segMax > 0 && barMax > 0) {
      const ratio = segMax / barMax;
      if (ratio > 5 || ratio < 0.2) {
        mismatch = {
          segLo: Math.min(...segPrices), segHi: segMax,
          barLo: Math.min(...barCloses), barHi: barMax,
          ratio,
        };
        warnings.push('画线价格与 K 线价格量级不符，疑似不是同一个标的');
      }
    }
  }

  const out = [];
  out.push(`【${name || code} ${periodCn(period)}图 · 手机端结构简报】`);
  out.push('');
  out.push('【这段话怎么来的】');
  out.push(`生成时刻：${fmtFull(nowSec)}。`);
  // 辅助周期（15m/60m）的画线刻度是主周期（5m/30m）的，不说破会被当成两套线。
  if (typeof c.periodNote === 'string' && c.periodNote) out.push(c.periodNote);
  out.push(`用的是你手机上**此刻的这张图**：画线 ${segs.length} 段、中枢 ${zss.length} 个，`
    + `行情取到 ${lastTime !== null ? tf(lastTime) : '（无）'} 那根 K 线为止。`
    + '下面所有数字都是手机按这套画线算好的现成结论，**请直接引用，不要自己从 K 线重新数段、'
    + '重新算力度或重新判买卖点**。');
  out.push('「力度」= 这一段里同方向 MACD 柱子累加，数字越大说明这一波推得越猛；'
    + '它跟涨跌幅是两回事，不要用价格幅度代替力度。');

  if (mismatch) {
    out.push('');
    out.push(`⚠ **先看这条**：图上画线的价格是 ${fixed(mismatch.segLo, 3)} ~ ${fixed(mismatch.segHi, 3)}，`
      + `而 K 线的价格是 ${fixed(mismatch.barLo, 3)} ~ ${fixed(mismatch.barHi, 3)}，`
      + `相差约 ${Math.round(mismatch.ratio >= 1 ? mismatch.ratio : 1 / mismatch.ratio)} 倍。`
      + '这两者几乎肯定不是同一个标的（最典型的是同号不同市场：000001 既是上证指数、也是平安银行）。'
      + '**这种情况下力度、最新价、离开中枢的距离全部不可信**，请先把标的和 K 线对齐再问，'
      + '下面的数字只能当画线本身的形状参考。');
  }

  if (lastBar) {
    if (lastTime === null) {
      out.push('注意：这份 K 线没有可识别的时间字段，行情的「新鲜度」无法判断。');
    } else {
      const lagSec = nowSec - lastTime;
      if (lagSec > 1800) {
        const lagDesc = lagSec >= 86400 ? `${(lagSec / 86400).toFixed(1)} 天`
          : (lagSec >= 3600 ? `${Math.round(lagSec / 3600)} 小时` : `${Math.round(lagSec / 60)} 分钟`);
        out.push(`注意：最后一根 K 线是 ${fmtFull(lastTime)}，距生成时刻 ${lagDesc}`
          + '（非交易时段，或行情没取到更新的）。之后的行情不在这份结构里。');
      }
    }
  }

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

  out.push('');
  out.push('【图上是什么】');
  const a0 = c.a0Period ? `；该标的 A0（最低分析级别）是 ${periodCn(c.a0Period)}` : '';
  out.push(`本图周期 ${periodCn(period)}，图上只有一种线型（点线），即本图最细一级走势${a0}。`
    + (c.presetName ? `当前方案「${c.presetName}」。` : ''));

  if (!segs.length) {
    out.push('');
    out.push('【结论】这张图目前没有任何线段，无法给出结构判断。');
    return { title: `${name || code} ${periodCn(period)}结构简报`, text: out.join('\n') + '\n', warnings };
  }

  out.push('');
  out.push('【正在走的这一段】');
  if (cur) {
    const dirCn = cur.direction === 'down' ? '向下' : (cur.direction === 'up' ? '向上' : '横向');
    const amp = cur.start.price ? (cur.end.price - cur.start.price) / cur.start.price * 100 : null;
    const st = toSec(cur.start.time);
    const et = toSec(cur.end.time);
    let s = `${dirCn}：${tf(st)}（${fixed(cur.start.price, 3)}）`
      + ` → ${tf(et)}（${fixed(cur.end.price, 3)}）`;
    if (Number.isFinite(amp)) s += `，幅度 ${signed(amp, 2)}%`;
    out.push(s + '。');

    const si = cur._strengthIndicator;
    const curArea = cur._strength?.macdArea;
    const curBars = cur._strength?.barCount;
    // 参照段由 algo.detectStrengthIndicators 唯一指定（_strengthRefId / _strengthRefBasis）；
    // 这里**只读**，绝不自己再挑一段来比，否则会出现「数字比参照小、结论却写增强」的矛盾。
    const refSeg = cur._strengthRefId ? segs.find((s2) => s2.id === cur._strengthRefId) : null;
    const refArea = refSeg?._strength?.macdArea;
    const refBars = refSeg?._strength?.barCount;
    if (Number.isFinite(curBars) && curBars < 2) {
      out.push('力度算不出来：这一段底下没有对应的 K 线（画线时间和 K 线对不上）。');
    } else if (Number.isFinite(curArea) && Number.isFinite(refArea)) {
      let line = `本段力度 ${fixed(Math.abs(curArea), 1)}，`
        + `参照段（${cur._strengthRefBasis || '参考段'}）${fixed(Math.abs(refArea), 1)}`
        + ` → 力度**${si || '—'}**（数值越大越强）`;
      if (Number.isFinite(refBars) && refBars < 3) {
        line += `。但参照段只含 ${refBars} 根 K 线，这个强弱结论基本没有参考价值，别据此判断背驰`;
      }
      out.push(line + '。');
    } else if (Number.isFinite(curArea)) {
      out.push(`本段力度 ${fixed(Math.abs(curArea), 1)}（没有可比的参照段，暂不判强弱）。`);
    } else {
      out.push('力度不可比：这一段覆盖的 K 线不足 2 根。');
    }

    const isLive = lastTime !== null && et !== null && et >= lastTime;
    const liveTxt = isLive
      ? '这一段**还没走完**：终点就是最后一根 K 线，会随行情继续延伸。'
      : (lastTime !== null
        ? `这一段停在 ${tf(et)}，而最后一根 K 线是 ${tf(lastTime)}——中间这段时间图上没有再延伸出新段。`
        : '这段的终点与最后一根 K 线对不上，可能画线还没延伸到最新。');
    out.push(liveTxt);
  }

  if (zss.length) {
    out.push('');
    out.push('【最近的中枢】');
    zss.slice(-2).reverse().forEach((zs, i) => {
      const r = zhongshuRange(zs);
      if (!r) return;
      const idx = zss.indexOf(zs) + 1;
      let line = `${i + 1}. 第 ${idx} 个：${tf(toSec(zs.startTime))} ~ ${tf(toSec(zs.endTime))}，`
        + `区间 ${fixed(r.lo, 3)} ~ ${fixed(r.hi, 3)}（高度 ${fixed((r.hi - r.lo) / r.lo * 100, 2)}%）`;
      const pos = positionVs(price, r);
      if (pos) {
        line += pos.where === '中枢内部'
          ? '。当前价**就在中枢里**'
          : `。当前价在${pos.where}，距边沿 ${Math.abs(pos.gap).toFixed(2)}%`;
      }
      out.push(line);
    });
  } else {
    out.push('');
    out.push('【最近的中枢】图上还没有中枢。');
  }

  const marked = [];
  segs.forEach((s, i) => {
    if (!s._bsLabel) return;
    const endTime = Math.max(toSec(s.start.time) ?? 0, toSec(s.end.time) ?? 0);
    marked.push({ i: i + 1, label: s._bsLabel, time: endTime, price: s.end.price });
  });
  out.push('');
  out.push('【图上标出的买卖点】');
  if (!marked.length) {
    out.push('当前这张图上一个买卖点都没有标出来（不代表没有，只是按当前画线还没成立）。');
  } else {
    marked.slice(-maxPoints).forEach((m) => {
      out.push(`· ${tf(m.time)} @${fixed(m.price, 3)} — **${m.label}**（第 ${m.i} 段终点）`);
    });
    if (marked.length > maxPoints) {
      out.push(`（更早还有 ${marked.length - maxPoints} 个，未列出。）`);
    }
  }

  out.push('');
  out.push('【关键价位】');
  const keys = [];
  const lastZs = zss.length ? zhongshuRange(zss[zss.length - 1]) : null;
  if (lastZs) keys.push(`${fixed(lastZs.hi, 3)} / ${fixed(lastZs.lo, 3)}（最近中枢上沿/下沿）`);
  if (cur) keys.push(`${fixed(cur.start.price, 3)}（当前段起点）`);
  if (Number.isFinite(price)) keys.push(`${fixed(price, 3)}（最新价）`);
  out.push(keys.length ? keys.join('；') : '（无）');

  out.push('');
  out.push('【请你这样回答】按上面这份结构回答我的问题。以上是代码算定的结论，'
    + '不要推翻、不要另行推算背驰、也不要用价格幅度冒充力度；'
    + '只说图上确实成立的东西，拿不准的地方直接说不确定。');

  return {
    title: `${name || code} ${periodCn(period)}结构简报`,
    text: out.join('\n') + '\n',
    warnings,
  };
}
