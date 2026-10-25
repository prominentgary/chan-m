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

// 交给模型「怎么写」的规范。口径来自桌面走势报告（gen_quad_report 的 action_html /
// analysis_html 与「了如指掌」技能），只保留能在纯文本里成立的部分：
//   · 越靠前的级别越管方向，最低一级只管抠买点位置 —— 这条最容易写反
//   · 主操作级的方向决定「等什么」，四种组合各有说法，不能一律写「等背驰」
//   · 未完成段的力度比例是当前进度，永远不能当定案
// 不写「次级别/本级别/高级别」：那是线型映射的内部说法，跨图就错。
const ANSWER_GUIDE = [
  '【请你这样回答】',
  '',
  '默认请给出一份「手机版多级别走势报告」，按下面七节写。'
  + '如果我只是问一个小问题（例如「现在能不能进」），就直接答那个，不必铺开。',
  '',
  '一、开头三行（先给结论，不要先讲结构）',
  '  ※ 全文说的「方向」一律是**未完成段**的方向，不是最后一条已画线的方向。',
  '  1. 现在是什么局面：一句话，把最高一级和主操作级的方向合起来说。',
  '  2. 现在该做什么：等 / 不追高 / 找买点 / 不动手，并写清触发条件（价位 + 哪一级的什么变化）。',
  '  3. 这个判断怕什么：一句话，哪一级走到哪里，这份结论就作废。',
  '',
  '二、逐级一段（自上而下，一级一段，不要合并成一段）',
  '  每级固定四行，顺序不许换：',
  '  · 这一级在做什么：先说**正在走的这一段**（未完成段：方向 + 已经走到的极值），'
  + '再提上一段已画的线。**不要拿最后一条已画线当「当前这一段」** —— 画线通常滞后于行情，'
  + '日线最后一条画出来的线是向上、而价格早就跌破它的终点，这种情况很常见。',
  '  · 关键价位：中枢上下沿、当前段的起点与极值、上一段的起点（观察点用它），照抄数字。',
  '  · 力度怎么说：本段 vs 参照段，只在本级内部比；未完成段必须说明还会累加。',
  '  · 这一级的一句话结论，要带一个观察点：「能否跌破 X」（这一段向下时）'
  + '或「能否收回 X」（这一段向上时）。动词跟着这一段自己的方向走。',
  '',
  '三、级别分工（一行一级，手机窄屏不要用表格）',
  '  只列这次实际有的级别，按下面的分工，不要按级别高低想当然'
  + '（「它还在向下／已转向上」说的是未完成段的方向）：',
  '  · 最高一级＝大方向：写「价格在中枢哪一侧、差百分之几 ⇒ 只做反弹 / 等回调再买 / 不押方向」。',
  '  · 第二级＝主操作级别：',
  '      - 它还在向下 ⇒ 等这一段走完、比力度，出背驰才买；',
  '      - 它已经转向上 ⇒ 不追高，等回调（交给下一级）找买点；',
  '      - 它在中枢里震荡 ⇒ 先等它选方向。',
  '  · 第三级＝接力：必须写明**启用条件**（主操作级转向上之后，才等这里回调的背驰）；'
  + '主操作级还没转向上时，这一级暂不启用。',
  '  · 最低一级＝精确入场：只用来把买点位置抠细，**不单独定方向**。',
  '  （只有两级时：最高一级＝大方向＋主操作，较低一级＝精确入场；'
  + '三级时第三级既是接力也是精确入场；只有一级时不写分工。）',
  '',
  '四、操作计划',
  '  1. 现在做什么（具体到动作：空仓等 / 持有不动 / 分批 / 减）。',
  '  2. 什么情况下改主意：价位一条、哪一级的结构变化一条，分开写。',
  '  3. 不要做什么：一句话。',
  '',
  '五、交付形式：对话里三行 + 一份 HTML 文件',
  '  1. 先在对话里给**三行结论**（局面 / 该做什么 / 怕什么），一屏看完；再给 HTML。',
  '  2. HTML 必须是**单个自包含文件**（DOCTYPE + viewport + 全部 CSS 内联），'
  + '不要外链任何 CSS / JS / 图片 / 字体。要存成 .html 文件给我，不要只在对话里贴代码。',
  '  3. 手机优先：左右留白 14px、正文 15px、行高 1.65、最大宽 680px；不要横向滚动。',
  '  4. **每级都要画一张结构图**：用该级「图数据」给的坐标画 SVG —— 段折线、中枢矩形、'
  + '未完成段虚线。**不要画蜡烛 K 线**：材料里没有每根 K 线的 OHLC，画蜡烛必然是编的。',
  '     坐标已经是 0-100 的最终值，直接 x/100×宽、y/100×高，**不要再自己换算价格**。模板照抄、只换坐标：',
  '     <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:150px;background:#fafafa">',
  '       <rect x="左" y="上" width="宽" height="高" fill="#fdf3e3" stroke="#b45309" stroke-width="0.4"/>',
  '       <polyline points="x0,y0 x1,y1" fill="none" stroke="#14924b" stroke-width="0.9"/>',
  '     </svg>',
  '     段颜色：U（向上）#d92b2b、D（向下）#14924b；未完成段一律 #b45309 且加 stroke-dasharray="2 1.5"',
  '     （虚线本身就表示「还没走完」，所以不必再用颜色区分方向）。',
  '     图形会被拉伸（preserveAspectRatio="none"），线宽加 vector-effect="non-scaling-stroke" 保持均匀。',
  '     **图下面必须标一行纵向价格范围**（用「图数据」里 y=0 与 y=100 那两个价），'
  + '否则 1 分钟那种 0.481~0.486 的小尺度图会被误读成暴跌。',
  '  5. **不要画 K 线图或别的示意图**：除了上面这张结构图，不要再自创图形；'
  + '不要画成交量、不要画均线、不要画箭头预测。',
  '  6. HTML 结构照这个顺序，不要自创：',
  '     头部（名称 · N级联立 · 生成时刻 · 最新价）→ 结论卡（三行结论，换底色区分）→',
  '     逐级卡（一级一张，卡头「① 日线 · 日线级别走势」，**卡内先放结构图，再放第二节那四行**）→',
  '     级别分工（一行一级，写「级别 ｜ 角色 ｜ 一句话」，不要用表格）→',
  '     操作计划（现在做 / 改主意 / 不要做）→ 页脚（边界声明 + 数据时刻）。',
  '  7. 配色只用三色：涨 #d92b2b、跌 #14924b、未完成与风险 #b45309；背景白、正文 #222。'
  + '不要渐变、不要阴影、不要大圆角。',
  '',
  '六、文字写法（对话里那三行结论、卡片内的短句都照这个来）',
  '  · 每个自然段不超过三行，一行别超过三十字。',
  '  · 数字照抄，不要改量级、不要四舍五入改写。',
  '  · 级别一律写「日线 / 30分钟 / 5分钟 / 1分钟」，不写「次级别 / 本级别 / 高级别」。',
  '  · 先说结论再说依据，不要复述上面已经给过的原文。',
  '',
  '七、内容红线（违反即错）',
  '  · 只讲作用域内那一段，不要引全图统计（「全图共 N 个中枢」这类不要写）。',
  '  · 力度强弱只在本级内部成立，**不许跨级比大小**。',
  '  · 背驰只能用给出的力度数字判断，不许自己另算、不许用价格幅度冒充力度。',
  '  · 未完成段的力度比例只是当前进度，不能当定案。',
  '  · 图上没有买卖点标记 ≠ 不成立，只能写「按当前画线还没成立」。',
  '  · 提到买卖点必须带级别（「5分钟三卖」「1分钟三买」），'
  + '几级同时有标记时不要混成一句不带级别的「出现三卖」。',
  '  · 只有 1 个中枢时，那里的背驰只能叫「盘整背驰」，不能叫「第一类买点」。',
  '  · 方向词跟着段自己的方向写，不要靠「反向」推 —— 上一段向上不等于这一段向下。',
  '  · 某个力度拿不到（段内 K 线不足）就直说拿不到，不要说成「没有中枢」。',
  '  · 拿不准就写「不确定」，不要编。以上结构事实是代码算定的，不要推翻。',
];

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
 * 未完成段：最后一条已画段段的终点 → 这一段**已经走到的最远点**。
 *
 * 为什么必须有它：画线永远滞后于行情。日线最后一条画出来的线可能是「向上 0.591→0.672」，
 * 而价格早就从 0.672 跌到 0.483 —— 那一段下跌还在走、软件里还没画成段。只读已画段会
 * 把「正在下跌」讲成「向上」，整份分析方向就反了。
 *
 * 口径与桌面 `gen_quad_report.tail_segment()` 完全一致：
 *   · 方向看最后收盘相对段终点：跌破→向下，升破→向上，相等则取与上一段相反
 *   · 终点不是最后收盘，而是**已经走到的极值**（向下取最低、向上取最高）；
 *     同价位取**最晚**那一根（极值之后的反抽属于还没成形的下一段）
 *   · 力度与 segmentStrength 同口径：段内同向柱累加 ×10000；段内 K 线 < 2 根 → null（不可比，不是 0）
 *
 * @returns {null|{index,t0,p0,t1,p1,direction,strength,strengthBars,unfinished}}
 */
export function tailSegment(bars, lastSeg, seqNo) {
  if (!lastSeg || !Array.isArray(bars) || !bars.length) return null;
  const t0 = toSec(lastSeg.end?.time);
  const p0 = lastSeg.end?.price;
  if (t0 == null || !Number.isFinite(p0)) return null;

  const tb = bars[bars.length - 1];
  const tLast = toSec(tb.time);
  const pLast = Number(tb.close);
  if (tLast == null || tLast <= t0 || !Number.isFinite(pLast)) return null;

  let direction;
  if (pLast < p0) direction = 'down';
  else if (pLast > p0) direction = 'up';
  else direction = lastSeg.direction === 'up' ? 'down' : 'up';

  // 极值窗口：(t0, tLast]
  let ext = null;
  for (const b of bars) {
    const t = toSec(b.time);
    if (t == null || t <= t0 || t > tLast) continue;
    if (ext === null) { ext = b; continue; }
    if (direction === 'down') {
      if (b.low < ext.low || (b.low === ext.low && t > toSec(ext.time))) ext = b;
    } else if (b.high > ext.high || (b.high === ext.high && t > toSec(ext.time))) {
      ext = b;
    }
  }
  if (ext === null) ext = tb;
  const t1 = toSec(ext.time);
  const p1 = direction === 'down' ? ext.low : ext.high;

  // 力度：窗口 [t0, t1] 内的同向柱
  let n = 0;
  let area = 0;
  for (const b of bars) {
    const t = toSec(b.time);
    if (t == null || t < t0 || t > t1) continue;
    n++;
    if (direction === 'down') {
      if (b.macd < 0) area += b.macd;
    } else if (b.macd > 0) area += b.macd;
  }

  return {
    index: seqNo, t0, p0, t1, p1, direction,
    strength: n >= 2 ? +(area * 10000).toFixed(4) : null,
    strengthBars: n,
    unfinished: true,
  };
}

/**
 * 把一级的结构压成 0-100 画图坐标（y 向下，SVG 习惯）。
 *
 * 为什么要它：手机上看一大段文字很难对应到底长什么样。但**不能画蜡烛** ——
 * 材料里没有每根 K 线的 OHLC，画出来必然是编的。能画的只有结构骨架：
 * 段折线、中枢矩形、未完成段、买卖点。这些坐标由上面已有的真实端点算出，不是猜的。
 *
 * 归一化：横轴按时间线性拉伸，纵轴按价格线性拉伸；模型拿到的就是最终值，
 * 只做 x/100*宽、y/100*高，不要再自己换算价格 —— 那一步最容易错。
 */
export function chartData(segs, tail, zsList, maxSegs = 12, maxZs = 2) {
  const all = Array.isArray(segs) ? segs : [];
  const use = all.length > maxSegs ? all.slice(-maxSegs) : all;
  const clipped = all.length > use.length;
  const pts = [];
  const push = (t, p) => {
    if (t != null && Number.isFinite(p)) pts.push([t, p]);
  };
  for (const s of use) {
    push(toSec(s.start?.time), s.start?.price);
    push(toSec(s.end?.time), s.end?.price);
  }
  if (tail) { push(tail.t0, tail.p0); push(tail.t1, tail.p1); }
  const zss = (zsList || []).slice(-maxZs);
  for (const z of zss) {
    const lo = Number.isFinite(z.low) ? z.low : null;
    const hi = Number.isFinite(z.high) ? z.high : null;
    const zt0 = toSec(z.startTime);
    const zt1 = toSec(z.endTime);
    if (lo != null) push(zt0, lo);
    if (hi != null) push(zt0, hi);
    if (lo != null) push(zt1, lo);
    if (hi != null) push(zt1, hi);
  }
  if (!pts.length) return null;

  const ts = pts.map((q) => q[0]);
  const ps = pts.map((q) => q[1]);
  const tMin = Math.min(...ts), tMax = Math.max(...ts);
  const pMin = Math.min(...ps), pMax = Math.max(...ps);
  const sx = (t) => (tMax > tMin ? ((t - tMin) / (tMax - tMin)) * 100 : 50);
  const sy = (p) => (pMax > pMin ? ((pMax - p) / (pMax - pMin)) * 100 : 50);
  const r1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

  const segLines = use.map((s) => ({
    dir: s.direction,
    x0: sx(toSec(s.start?.time)), y0: sy(s.start?.price),
    x1: sx(toSec(s.end?.time)), y1: sy(s.end?.price),
  })).filter((l) => Number.isFinite(l.x0) && Number.isFinite(l.x1));

  const tailLine = tail
    ? { dir: tail.direction, x0: sx(tail.t0), y0: sy(tail.p0), x1: sx(tail.t1), y1: sy(tail.p1) }
    : null;

  const zsRects = zss.map((z) => {
    const lo = Number.isFinite(z.low) ? z.low : null;
    const hi = Number.isFinite(z.high) ? z.high : null;
    const zt0 = toSec(z.startTime);
    const zt1 = toSec(z.endTime);
    if (lo == null || hi == null || zt0 == null || zt1 == null) return null;
    const x0 = sx(zt0), x1 = sx(zt1);
    const ya = sy(hi), yb = sy(lo);
    return { x: Math.min(x0, x1), y: Math.min(ya, yb), w: Math.abs(x1 - x0), h: Math.abs(yb - ya) };
  }).filter(Boolean);

  return {
    clipped, segLines, tailLine, zsRects,
    pMin, pMax,
    // 给模型直接用的字符串（它只需照抄，不必换算）
    segStr: segLines.map((l) => `${l.dir === 'up' ? 'U' : 'D'} ${r1(l.x0)},${r1(l.y0)}>${r1(l.x1)},${r1(l.y1)}`).join(' ｜ '),
    tailStr: tailLine
      ? `${tailLine.dir === 'up' ? 'U' : 'D'} ${r1(tailLine.x0)},${r1(tailLine.y0)}>${r1(tailLine.x1)},${r1(tailLine.y1)}`
      : '',
    zsStr: zsRects.map((z) => `x${r1(z.x)}~${r1(z.x + z.w)} y${r1(z.y)}~${r1(z.y + z.h)}`).join(' ｜ '),
    priceStr: `y=0 → ${fixed(pMax, 3)}，y=100 → ${fixed(pMin, 3)}`,
  };
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
  // 正在走的这一段：画线之后到最新行情的未完成段（没有延伸时为 null）
  const tail = cur ? tailSegment(bars, cur, segs.length + 1) : null;

  return {
    period, higher, idx,
    allSegs, allZs, segs, zss, bars, lastBarTime, cur, tail,
    chart: chartData(segs, tail, zss),
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

    // 当前这一段：优先用**未完成段**（画线之后走到最新的那一段）。
    // 画线永远滞后于行情：日线最后一条画出来的线可能是「向上」，而价格早就跌破了它的终点。
    // 只讲已画段会把「正在下跌」讲成「向上」，整份分析的方向就反了 —— 这是最容易错的一处。
    const cur = lv.cur;
    if (!cur) {
      out.push('  作用域内还没有线段 —— 本级走势停在分界处，还没长出下一段。');
      continue;
    }
    const tail = lv.tail;
    const moving = tail || cur;
    const movingDir = moving.direction === 'down' ? '向下'
      : (moving.direction === 'up' ? '向上' : '横向');
    const lastArea = cur._strength?.macdArea;
    const lastDirCn = cur.direction === 'down' ? '向下' : (cur.direction === 'up' ? '向上' : '横向');
    const lastSt = toSec(cur.start?.time);
    const lastEt = toSec(cur.end?.time);
    const lastP0 = cur.start?.price;
    const lastP1 = cur.end?.price;

    if (tail) {
      let line = `  当前这一段（**未完成**）：${movingDir} `
        + `${tf(tail.t0)}（${fixed(tail.p0, 3)}）→ ${tf(tail.t1)}（${fixed(tail.p1, 3)}）`;
      if (tail.p0) line += `，幅度 ${signed((tail.p1 - tail.p0) / tail.p0 * 100, 2)}%`;
      out.push(line + '。');
      out.push('    └ 画线只画到上面那个起点，之后这段还没成段。终点取它已经走到的'
        + (tail.direction === 'down' ? '**最低**点' : '**最高**点')
        + '，不是最新收盘（极值之后的反抽属于还没成形的下一段）。');

      // 上一段（最后一条已画段）—— 观察点要用它的起点
      let prev = `  上一段（已画）：${lastDirCn} ${tf(lastSt)}（${fixed(lastP0, 3)}）`
        + `→ ${tf(lastEt)}（${fixed(lastP1, 3)}）`;
      if (lastP0) prev += `，幅度 ${signed((lastP1 - lastP0) / lastP0 * 100, 2)}%`;
      if (Number.isFinite(lastArea)) prev += `，力度 ${fixed(Math.abs(lastArea), 1)}`;
      out.push(prev + '。');

      // 力度：当前进度 vs 上一段（只能本级内部比）
      if (tail.strength == null) {
        out.push(`  力度（当前进度）：不可比 —— 这一段只覆盖 ${tail.strengthBars} 根 K 线（不是 0）。`);
      } else if (tail.strengthBars < 3) {
        out.push(`  力度（当前进度）没有参考意义：这一段只有 ${tail.strengthBars} 根 K 线，`
          + '算出来只代表这一两根柱子，别拿它比强弱。');
      } else if (tail.strength === 0) {
        out.push(`  力度（当前进度）暂时是 0：这一段里没有一根${movingDir === '向下' ? '下跌' : '上涨'}方向的 `
          + 'MACD 柱 —— 价格动了、动能还没跟上，不代表「力气小」。');
      } else if (Number.isFinite(lastArea) && Math.abs(lastArea) > 0) {
        const pct = Math.abs(tail.strength) / Math.abs(lastArea) * 100;
        out.push(`  力度（当前进度）${fixed(Math.abs(tail.strength), 1)}，上一段 ${fixed(Math.abs(lastArea), 1)}`
          + ` → 目前是 **${pct.toFixed(0)}%**。段还没走完，继续走还会累加，`
          + '这个百分比只是当前进度，不是定案。');
      } else {
        out.push(`  力度（当前进度）${fixed(Math.abs(tail.strength), 1)}`
          + '（上一段没有可比力度，暂不给比例）。');
      }

      // 观察点：动词跟着未完成段自己的方向走。三种情形要分开写，混用会自相矛盾：
      //   ① 同向 → 这是上一段的延续，看能否回到延续起点
      //   ② 反向且已越过上一段起点 → 不能再问「能否跌破」，改问能否收回／守住
      //   ③ 反向但还没越过 → 才能问「能否跌破／收回」
      const trendCn = cur.direction === 'up' ? '上涨' : (cur.direction === 'down' ? '下跌' : '横向');
      const sameDir = tail.direction === cur.direction;
      const crossed = tail.direction === 'down' ? tail.p1 < lastP0 : tail.p1 > lastP0;
      if (sameDir) {
        out.push(`  观察点：这一段是上一段${trendCn}的延续。能否回到 `
          + `**${fixed(tail.p0, 3)}**（这段延续的起点）附近 —— 回到这里，这一段就走完了，等下一段再说。`);
      } else if (crossed) {
        if (tail.direction === 'down') {
          out.push(`  观察点：**已经跌破**上一段${trendCn}的起点 ${fixed(lastP0, 3)}`
            + `（现在 ${fixed(tail.p1, 3)}）。接下来看能否收回 ${fixed(lastP0, 3)} 之上 —— `
            + '收不回去，就说明这一段下跌还没结束。');
        } else {
          out.push(`  观察点：**已经升破**上一段${trendCn}的起点 ${fixed(lastP0, 3)}`
            + `（现在 ${fixed(tail.p1, 3)}）。接下来看能否守住 ${fixed(lastP0, 3)} 之上 —— `
            + `跌回 ${fixed(lastP0, 3)} 之下，就说明这一段上涨到头了。`);
        }
      } else {
        const verb = tail.direction === 'down' ? '跌破' : '收回';
        const fail = tail.direction === 'down' ? '跌不破' : '收不回去';
        out.push(`  观察点：能否${verb} **${fixed(lastP0, 3)}**（上一段${trendCn}的起点）。`
          + `${fail}，就仍是同一段${trendCn}的延续。`);
      }
    } else {
      // 没有延伸：最后一条已画段的终点就在最新价上
      if (!lv.bars.length) {
        out.push('  ※ 没有取到 K 线，**未完成段算不出来** —— 下面这段是最后的画线，'
          + '不代表行情停在这里。');
        warnings.push(`${levelCn(lv.period)}没有 K 线，未完成段未计算`);
      }
      let line = `  当前这一段：${lastDirCn} ${tf(lastSt)}（${fixed(lastP0, 3)}）`
        + `→ ${tf(lastEt)}（${fixed(lastP1, 3)}）`;
      if (lastP0) line += `，幅度 ${signed((lastP1 - lastP0) / lastP0 * 100, 2)}%`;
      out.push(line + '。');

      const curBars = cur._strength?.barCount;
      const refSeg = cur._strengthRefId
        ? lv.allSegs.find((s2) => s2.id === cur._strengthRefId) : null;
      const refArea = refSeg?._strength?.macdArea;
      const refBars = refSeg?._strength?.barCount;
      const refHidden = refSeg && !lv.segs.includes(refSeg);
      if (Number.isFinite(curBars) && curBars < 2) {
        out.push('  力度：算不出来（这一段底下没有对应的 K 线，画线时间和 K 线对不上）。');
      } else if (Number.isFinite(lastArea) && Number.isFinite(refArea)) {
        let line2 = `  力度 ${fixed(Math.abs(lastArea), 1)}，`
          + `参照段（${cur._strengthRefBasis || '参考段'}）${fixed(Math.abs(refArea), 1)}`
          + ` → **${cur._strengthIndicator || '—'}**`;
        if (refHidden) line2 += '［参照段在作用域之外，属已递归上去的历史段］';
        if (Number.isFinite(refBars) && refBars < 3) {
          line2 += `；但参照段只含 ${refBars} 根 K 线，这个强弱结论基本没有参考价值，别据此判断背驰`;
        }
        out.push(line2 + '。');
      } else if (Number.isFinite(lastArea)) {
        out.push(`  力度 ${fixed(Math.abs(lastArea), 1)}（本级没有可比的参照段，暂不判强弱）。`);
      } else {
        out.push('  力度：不可比（这一段覆盖的 K 线不足 2 根，不是 0）。');
      }

      const isLive = lv.lastBarTime != null && lastEt != null && lastEt >= lv.lastBarTime;
      if (isLive) {
        out.push('  这一段**还没走完**：终点就是最后一根 K 线，会随行情继续延伸。'
          + '力度只是当前进度，继续走还会累加，走完才定案。');
      } else if (lv.lastBarTime != null && lastEt != null) {
        out.push(`  这一段停在 ${tf(lastEt)}，而最后一根 K 线是 ${tf(lv.lastBarTime)}。`);
      }
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

    // 图数据：只给结构骨架坐标，模型照抄即可画 SVG（不必换算价格）
    const ch = lv.chart;
    if (ch) {
      out.push('  图数据（画图用，0-100 坐标，y 向下；x_px=x/100*宽，y_px=y/100*高）：');
      out.push(`    ${ch.priceStr}`);
      if (ch.segStr) {
        out.push(`    已画段：${ch.segStr}` + (ch.clipped ? '（只列了最近的若干段）' : ''));
      }
      if (ch.tailStr) out.push(`    未完成段（虚线）：${ch.tailStr}`);
      if (ch.zsStr) out.push(`    中枢矩形：${ch.zsStr}`);
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
    const movingLv = lv.tail || lv.cur;
    if (movingLv) {
      const d = movingLv.direction === 'down' ? '向下'
        : (movingLv.direction === 'up' ? '向上' : '横向');
      parts.push(`当前段${d}${lv.tail ? '（未完成）' : ''}`);
      if (lv.tail) {
        if (lv.tail.strength == null || lv.tail.strengthBars < 3) {
          parts.push('力度暂不可比');
        } else if (lv.tail.strength === 0) {
          parts.push('力度暂为0');
        } else {
          parts.push(`力度${fixed(Math.abs(lv.tail.strength), 1)}（进度）`);
        }
      } else if (lv.cur._strengthIndicator) {
        parts.push(`力度${lv.cur._strengthIndicator}`);
      }
    } else {
      parts.push('作用域内无段');
    }
    out.push(`  ${levelCn(lv.period)}：` + parts.join(' ｜ '));
  }

  // ---- 边界声明 ----
  out.push('');
  out.push('【本视图边界（读之前先认下这几条）】');
  const bounds = [
    '「当前这一段」取的是**未完成段**（最后一条画线的终点 → 行情已经走到的极值），'
    + '不是最后一条已画线；未完成段还没成段，不计入段数与中枢判定。',
    '作用域＝被紧邻上一级最后一段截断之后仍然显示的段，也就是你手机上看得见的那部分；不是全图统计。',
    '各级力度只能在本级内部比（本段 vs 参照段），**不能跨级比大小** —— 每级用的 K 线周期不同，量纲也不同。',
    '未完成段的力度是动态的：段没走完，继续走还会累加，走完才定案。',
    '15 分钟 / 60 分钟是辅助周期（画线复刻 5 分钟 / 30 分钟），不参与联立。',
    '图上没有买卖点标记 ≠ 不成立，只是按当前画线还没长出来。',
    '某一级没画线时该级不出现 —— 不出现不等于不存在，是没画。',
  ];
  bounds.forEach((b, i) => out.push(`  ${i + 1}. ${b}`));

  out.push('');
  out.push(...ANSWER_GUIDE);

  return {
    title: `${name || code} ${parsed.length}级联立结构简报`,
    text: out.join('\n') + '\n',
    warnings,
  };
}
