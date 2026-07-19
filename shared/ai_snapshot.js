// ai_snapshot.js —— 共享的「缠论盘面快照」生成器（桌面端 / 移动端 Chan-M 共用）
//
// 设计要点：
//  - 力度默认用「涨跌幅%」作为几何代理；若提供 K 线 bars，则用「MACD 柱(12,26,9)累计面积」
//    作精确力度（统一在共享模块内计算，确保桌面/移动端一致），并直接复用 chan-m 的买卖点算法。
//  - 支持「时间对齐」：小级别段只取「自大级别最近一段终点之后」的部分，聚焦当下走势。
//  - 输出一段【自带缠论系统指令】的可复制文本：粘贴到任意大模型 App 即可解读。
//
// 位置说明：本文件位于 chan-m/shared/，随 chan-m 一起发布到移动端；桌面端通过
// 后端 /static 挂载（frontend 根）以 /static/chan-m/shared/ai_snapshot.js 加载。
// algo.js 与本文件同属 chan-m，故相对路径为 ../js/algo.js。

import {
  detectStrengthIndicators,
  computeZhongshuStrength,
  detectOneBuySell,
  detectTwoAndThreeBuySell,
  segmentStrength,
} from '../js/algo.js';

// 周期中文名（覆盖桌面端与移动端两套周期编码）
export const PERIOD_LABEL = {
  '1m': '1分钟', '5m': '5分钟', '15m': '15分钟', '30m': '30分钟', '60m': '60分钟',
  '1d': '日线', '1w': '周线', '1M': '月线', '1Q': '季线', '1y': '年线',
  'day': '日线', 'week': '周线', 'month': '月线', 'quarter': '季线', 'year': '年线',
};

// 级别排序（大→小），用于时间对齐与展示顺序
export const LEVEL_ORDER = [
  '1y', '1Q', '1M', '1w', '1d', '60m', '30m', '15m', '5m', '1m',
  'year', 'quarter', 'month', 'week', 'day',
];

// 时间归一化：数字原样；'YYYY-MM-DD' / 'YYYYMMDD' 字符串解析为 Unix 秒
function normTime(t) {
  if (typeof t === 'number') return t;
  if (typeof t === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return Math.floor(new Date(t + 'T00:00:00').getTime() / 1000);
    if (/^\d{8}$/.test(t)) {
      const s = t.slice(0, 4) + '-' + t.slice(4, 6) + '-' + t.slice(6, 8);
      return Math.floor(new Date(s + 'T00:00:00').getTime() / 1000);
    }
    const n = Date.parse(t);
    return Number.isNaN(n) ? Math.floor(Date.now() / 1000) : Math.floor(n / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

// ---- MACD 计算（EMA12/26，信号9，hist = DIF-DEA）；返回带 macd 的 bars ----
function emaSeries(arr, period) {
  const k = 2 / (period + 1);
  const out = new Array(arr.length);
  out[0] = arr[0];
  for (let i = 1; i < arr.length; i++) out[i] = arr[i] * k + out[i - 1] * (1 - k);
  return out;
}

function computeMacd(bars) {
  if (!bars || bars.length < 2) return [];
  const sorted = [...bars].sort((a, b) => normTime(a.time) - normTime(b.time));
  const closes = sorted.map((b) => Number(b.close));
  if (closes.some((c) => Number.isNaN(c))) return [];
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const dif = closes.map((_, i) => ema12[i] - ema26[i]);
  const dea = emaSeries(dif, 9);
  const hist = dif.map((d, i) => d - dea[i]);
  return sorted.map((b, i) => ({
    ...b,
    time: normTime(b.time),
    close: closes[i],
    high: b.high != null ? Number(b.high) : closes[i],
    low: b.low != null ? Number(b.low) : closes[i],
    macd: hist[i],
  }));
}

// 桌面端原始画线 -> { segments, zhongshus }（模型段结构）
// 与 chan-m 导出逻辑一致：只取主级别点线（lineType='dotted'）。
export function fromDrawings(drawings) {
  const segs = [];
  for (const d of drawings || []) {
    const lineType = (d.style && d.style.lineType) || d.variant || 'dotted';
    if (d.type === 'line' && (d.points || []).length >= 2) {
      if (lineType !== 'dotted') continue;
      const a = d.points[0];
      const b = d.points[d.points.length - 1];
      segs.push({
        id: d.id,
        direction: b.price >= a.price ? 'up' : 'down',
        start: { time: normTime(a.time), price: a.price },
        end: { time: normTime(b.time), price: b.price },
      });
    }
  }
  segs.sort((x, y) => x.start.time - y.start.time);
  const zhongshus = [];
  for (const d of drawings || []) {
    // 仅取「点线中枢」：_isZhongshu 且矩形线型为 dotted；组合中枢（dashed/solid）排除。
    if (!d._isZhongshu || d.type === 'line') continue;
    const lt = (d.style && d.style.lineType) || d.variant || 'dotted';
    if (lt !== 'dotted') continue;
    zhongshus.push({ id: d.id, segmentIds: (d._zhongshuLines || []).slice() });
  }
  return { segments: segs, zhongshus };
}

// 力度 + 买卖点（bars-free 几何代理 或 MACD 精确）
function enrich(segments, zhongshus, bars) {
  const aug = bars && bars.length ? computeMacd(bars) : null;
  segments.sort((a, b) => (a.start?.time ?? 0) - (b.start?.time ?? 0));
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const prevDir = i > 0 ? segments[i - 1].direction : undefined;
    if (aug) {
      const st = segmentStrength(aug, s, prevDir);
      if (st && st.barCount >= 2) {
        s._strength = st;
        s._hasMacd = true;
      } else {
        // bars 未覆盖该段（如大级别远端段）：退化为几何代理
        const sp = s.start?.price, ep = s.end?.price;
        const pc = sp && ep ? (ep - sp) / sp * 100 : 0;
        s._strength = { macdArea: Math.abs(pc || 0), priceChangePct: +(pc || 0).toFixed(2) };
        s._hasMacd = false;
      }
    } else {
      const sp = s.start?.price, ep = s.end?.price;
      const pc = sp && ep ? (ep - sp) / sp * 100 : 0;
      s._strength = { macdArea: Math.abs(pc || 0), priceChangePct: +(pc || 0).toFixed(2) };
      s._hasMacd = false;
    }
  }
  detectStrengthIndicators(segments, zhongshus);
  computeZhongshuStrength(aug, segments, zhongshus);
  detectOneBuySell(segments, zhongshus);
  detectTwoAndThreeBuySell(segments, zhongshus);
  return { segments, zhongshus };
}

// 桌面端：原始画线 -> 单周期快照数据（bars 可选，提供则 MACD 精确力度）
export function buildFromDrawings(drawings, periodKey, bars, periodLabelOverride) {
  const { segments, zhongshus } = fromDrawings(drawings);
  enrich(segments, zhongshus, bars);
  return {
    period: periodKey,
    label: periodLabelOverride || PERIOD_LABEL[periodKey] || periodKey,
    segments,
    zhongshus,
    bars: bars || null,
  };
}

// 移动端：预转换的 segments/zhongshus -> 单周期快照数据
// 克隆输入，避免污染 Chan-M 本地存储中的原始数据。
export function buildFromStruct(segments, zhongshus, periodKey, bars, periodLabelOverride) {
  const segs = JSON.parse(JSON.stringify(segments || []));
  const zss = JSON.parse(JSON.stringify(zhongshus || []));
  enrich(segs, zss, bars);
  return {
    period: periodKey,
    label: periodLabelOverride || PERIOD_LABEL[periodKey] || periodKey,
    segments: segs,
    zhongshus: zss,
    bars: bars || null,
  };
}

// 周期级别的「下一级别」映射（符合缠论多级别联立：大级别图上的点线段对应低一级别）。
// 例如 30m 图上的点线段 = 5m 级别；点线中枢 = 30m 本级别。
const NEXT_LEVEL_KEY = {
  '1y': '1Q', '1Q': '1M', '1M': '1w', '1w': '1d', '1d': '60m', '60m': '30m',
  '30m': '5m', '15m': '1m', '5m': '1m', '1m': '1m',
  'year': 'quarter', 'quarter': 'month', 'month': 'week', 'week': 'day', 'day': '60m',
};
export function nextLevelLabel(period) {
  const k = NEXT_LEVEL_KEY[period];
  if (!k) return (PERIOD_LABEL[period] || period) + '级';
  if (k === period) return (PERIOD_LABEL[period] || period) + '次级别';
  return PERIOD_LABEL[k] + '级';
}

// 计算单个中枢的明细：左右区间、重叠上下沿（ZG/ZD）、震荡高低点。
// segments 为时间对齐后该周期的段集合；bars 为本周期 K 线（用于震荡高低点的精确极值）。
function zhongshuMeta(zs, segments, bars) {
  const segMap = {};
  (segments || []).forEach((s) => { segMap[s.id] = s; });
  const segs = (zs.segmentIds || []).map((id) => segMap[id]).filter(Boolean);
  const meta = {
    segCount: segs.length,
    leftTime: null, rightTime: null,
    zg: null, zd: null,          // 重叠上下沿
    oscHigh: null, oscLow: null, // 震荡高低点
    valid: segs.length >= 3,
  };
  if (segs.length === 0) return meta;
  const sortedSegs = [...segs].sort(
    (a, b) => (a.start?.time ?? 0) - (b.start?.time ?? 0)
  );
  meta.leftTime = sortedSegs[0].start?.time ?? null;
  meta.rightTime = sortedSegs[sortedSegs.length - 1].end?.time ?? null;
  const lows = sortedSegs.map((s) => Math.min(s.start.price, s.end.price));
  const highs = sortedSegs.map((s) => Math.max(s.start.price, s.end.price));
  if (segs.length >= 3) {
    meta.zg = Math.min(...highs); // 上沿 ZG：三段高点最小值
    meta.zd = Math.max(...lows);  // 下沿 ZD：三段低点最大值
  } else {
    meta.zg = Math.max(...highs);
    meta.zd = Math.min(...lows);
  }
  // 震荡高低点：优先取区间内的 K 线极值；无 bars 则退化为段极值
  if (bars && bars.length && meta.leftTime != null && meta.rightTime != null) {
    let oH = -Infinity, oL = Infinity;
    for (const b of bars) {
      const t = normTime(b.time);
      if (t >= meta.leftTime && t <= meta.rightTime) {
        const h = Number(b.high != null ? b.high : b.close);
        const l = Number(b.low != null ? b.low : b.close);
        if (h > oH) oH = h;
        if (l < oL) oL = l;
      }
    }
    if (oH > -Infinity && oL < Infinity) { meta.oscHigh = oH; meta.oscLow = oL; }
  }
  if (meta.oscHigh == null) meta.oscHigh = Math.max(...highs);
  if (meta.oscLow == null) meta.oscLow = Math.min(...lows);
  return meta;
}

// 时间对齐：小级别段只保留「自更大级别最近一段终点之后」的部分，聚焦当下走势。
// 例如 30m 全段 + 5m（自 30m 终点起）+ 1m（自 5m 终点起）。
// 每个周期在段裁剪后，基于段集 + 本周期 bars 重算中枢的区间/上下沿/震荡高低点，并剔除失效中枢。
export function alignPeriods(periods) {
  const sorted = [...periods].sort(
    (a, b) => LEVEL_ORDER.indexOf(a.period) - LEVEL_ORDER.indexOf(b.period)
  );
  let anchor = null;
  for (const pd of sorted) {
    if (anchor != null) {
      pd.segments = pd.segments.filter((s) => (s.end?.time ?? 0) >= anchor);
    }
    const ids = new Set(pd.segments.map((s) => s.id));
    pd.zhongshus = (pd.zhongshus || []).filter((z) =>
      (z.segmentIds || []).some((id) => ids.has(id))
    );
    pd.zhongshus = pd.zhongshus
      .map((z) => Object.assign(z, { _meta: zhongshuMeta(z, pd.segments, pd.bars) }))
      .filter((z) => z._meta.valid);
    anchor = lastEnd(pd.segments);
  }
  return periods;
}

function lastEnd(segs) {
  const s = [...(segs || [])].sort((a, b) => (a.start?.time ?? 0) - (b.start?.time ?? 0));
  return s.length ? (s[s.length - 1].end?.time ?? 0) : null;
}

// 缠论系统指令：粘贴到任意大模型 App 后，据此解读下方数据
export const CHAN_SYSTEM_PROMPT = `你是一位资深缠论（缠中说禅）交易者。下面是一份按「大级别→小级别」排列的多周期缠论结构数据，每张级别图仅包含两类要素：

- 【点线段】：即该图的主线段，其级别为「本级别的下一个更小级别」。例如 30 分钟图上的点线段 = 5 分钟级别，5 分钟图上的点线段 = 1 分钟级别。每段给出：方向、起止时间、起止价格、涨跌幅%、力度变化（增强/减弱）、MACD 累计力度（MACD积，基于 MACD 柱 12/26/9 的面积）。
- 【点线中枢】：即该图的本级别中枢（由本级别线段重合构成），其级别 = 本级别。每个中枢给出：
  · 左右区间（时间）：中枢第一段起点 → 最后一段终点；
  · 上下沿：上沿 ZG（三段高点的最小值）、下沿 ZD（三段低点的最大值）；
  · 震荡高低点：该时间区间内触及的最高价 / 最低价；
  · 含段数、进入段与离开段的 MACD 力度对比（减弱/增强）；
  · 已标注一 / 二 / 三类买卖点。

小级别段与中枢均已做「时间对齐」：仅保留自更大级别最近一段终点之后的部分，便于聚焦当下走势。

请严格遵循缠论框架进行解读：
1. 由大级别（周 / 日 / 月）定方向与整体结构（趋势 / 盘整、当前处于中枢震荡还是离开）；
2. 从小级别（30m / 5m / 1m）找当下走势与关键买卖点；
3. 中枢是分析重点：结合上下沿（ZG / ZD）与震荡高低点判断支撑阻力、中枢破坏与三类买卖点有效性（配合 MACD 力度对比与背驰）；
4. 给出风险提示与可关注的关键价位。

请用 Markdown 分节输出：① 走势综述 ② 大级别定位 ③ 小级别当下 ④ 关键买卖点 ⑤ 风险提示。`;

function fmtTime(sec) {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return (d.getHours() === 0 && d.getMinutes() === 0) ? date : `${date} ${hm}`;
}

function dirText(d) {
  return d === 'up' ? '↑上涨' : d === 'down' ? '↓下跌' : '→横盘';
}

function clip(arr, n) { return arr.slice(-n); }

// 价格格式化：保留合理小数并去尾零
function fmtPrice(p) {
  if (p == null) return '—';
  const s = Number(p).toFixed(4).replace(/\.?0+$/, '');
  return s === '' ? '0' : s;
}

// 生成最终可复制文本
export function formatChanSnapshot({ code, name, periods, currentPrice, question }) {
  const parts = [];
  parts.push('# 缠论盘面快照（供 AI 解读）');
  parts.push(`标的：${code}${name ? ' · ' + name : ''}`);
  parts.push(`生成时间：${fmtTime(Math.floor(Date.now() / 1000))}`);
  if (currentPrice != null && !Number.isNaN(Number(currentPrice))) {
    parts.push(`最新价：${currentPrice}`);
  }
  parts.push('');
  parts.push('>>> 系统指令（粘贴到任意大模型 App 后，据此解读下方数据）');
  parts.push(CHAN_SYSTEM_PROMPT);
  parts.push('');
  parts.push('>>> 多周期结构数据（小级别已做时间对齐；每级别图仅含「点线段」与「点线中枢」）');

  const sortedPeriods = [...periods].sort(
    (a, b) => LEVEL_ORDER.indexOf(a.period) - LEVEL_ORDER.indexOf(b.period)
  );

  for (const pd of sortedPeriods) {
    const hasMacd = pd.segments.some((s) => s._hasMacd);
    const nextLv = nextLevelLabel(pd.period);
    parts.push('');
    parts.push(`## ${pd.label}（${pd.period}）· 力度:${hasMacd ? 'MACD精确' : '几何代理'}`);
    parts.push(`点线段级别 = 下一级别(${nextLv})；点线中枢级别 = 本级别(${pd.label})`);

    const segs = clip(pd.segments || [], 30);
    parts.push(`点线段（共 ${pd.segments.length} 段，显示最近 ${segs.length} 段）：`);
    segs.forEach((s, i) => {
      const pc = s._strength ? s._strength.priceChangePct : null;
      const ind = s._strengthIndicator ? ` 力度:${s._strengthIndicator}` : '';
      const macd = (s._hasMacd && s._strength && s._strength.macdArea != null)
        ? ` MACD积:${s._strength.macdArea.toFixed(2)}` : '';
      const bs = s._buySell ? ` 【${s._bsLabel}】` : '';
      parts.push(
        `  ${i + 1}. [点线段·${nextLv}] ${dirText(s.direction)} `
        + `${fmtTime(s.start.time)} ${fmtPrice(s.start.price)} → `
        + `${fmtTime(s.end.time)} ${fmtPrice(s.end.price)}`
        + (pc != null ? ` (${pc > 0 ? '+' : ''}${pc}%)` : '')
        + ind + macd + bs
      );
    });

    const zss = (pd.zhongshus || []).slice().sort(
      (a, b) => (a._meta?.leftTime || 0) - (b._meta?.leftTime || 0)
    );
    if (zss.length) {
      parts.push(`点线中枢（${zss.length} 个）：`);
      zss.forEach((z, i) => {
        const m = z._meta || {};
        const segTxt = `含${m.segCount != null ? m.segCount : (z.segmentIds || []).length}段`;
        const rangeTxt = (m.leftTime != null)
          ? ` | 区间 ${fmtTime(m.leftTime)} → ${fmtTime(m.rightTime)}` : '';
        const edgeTxt = (m.zg != null)
          ? ` | 上沿ZG ${fmtPrice(m.zg)} / 下沿ZD ${fmtPrice(m.zd)}` : '';
        const oscTxt = (m.oscHigh != null)
          ? ` | 震荡高 ${fmtPrice(m.oscHigh)} / 震荡低 ${fmtPrice(m.oscLow)}` : '';
        const cmp = z._strengthCompare ? ` | 力度对比:${z._strengthCompare}` : '';
        const bs = z._bsLabel ? ` | 【${z._bsLabel}】` : '';
        parts.push(`  ${i + 1}. [点线中枢·${pd.label}级] ${segTxt}${rangeTxt}${edgeTxt}${oscTxt}${cmp}${bs}`);
      });
    }
  }

  parts.push('');
  parts.push('>>> 我的问题');
  parts.push(question || '请从缠论角度，由大级别到小级别解读当前走势，指出关键买卖点与风险。');
  return parts.join('\n');
}

// 暴露给桌面端（IIFE 全局脚本通过 window.AISnapshot 调用）
if (typeof window !== 'undefined') {
  window.AISnapshot = {
    buildFromDrawings,
    buildFromStruct,
    alignPeriods,
    formatChanSnapshot,
    fromDrawings,
    computeMacd,
    CHAN_SYSTEM_PROMPT,
    PERIOD_LABEL,
    LEVEL_ORDER,
  };
}
