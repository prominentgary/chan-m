// model.js —— 段 / 中枢 数据模型与序列化
// 与桌面端 drawings JSON 兼容：端点以 time(Unix秒) + price 锚定

let _seq = 0;
function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${(_seq++).toString(36)}`;
}

// 桌面端周期 -> Chan-M 周期
const PERIOD_MAP = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '60m': '60m',
  '1d': 'day', 'day': 'day',
  '1w': 'week', 'week': 'week',
  '1M': 'month', 'month': 'month',
  '1Q': 'quarter', 'quarter': 'quarter',
  '1y': 'year', 'year': 'year',
};

export function normPeriod(p) {
  return PERIOD_MAP[p] || p || '';
}

// 统一把桌面端 time（可能是秒数或 "2025-03-18" 字符串）转成 Unix 秒
export function normTime(t) {
  if (typeof t === 'number') return Math.floor(t);
  if (typeof t === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
      return Math.floor(new Date(`${t.replace(/-/g, '/')} 00:00:00`).getTime() / 1000);
    }
    if (/^\d{8}$/.test(t)) { // 如 "20260623"
      const y = +t.slice(0, 4), mo = +t.slice(4, 6), d = +t.slice(6, 8);
      return Math.floor(new Date(y, mo - 1, d, 0, 0).getTime() / 1000);
    }
  }
  return Math.floor(new Date(t).getTime() / 1000);
}

export function makeSegment({ startSec, endSec, period, bars }) {
  const s = barAtOrBefore(bars, startSec);
  const e = barAtOrAfter(bars, endSec);
  // 先按收盘价判断趋势方向，再按涨跌方向取对应端点高低价：
  //   上涨段：起点=最低价(low)，终点=最高价(high)
  //   下跌段：起点=最高价(high)，终点=最低价(low)
  const direction = (e && s && e.close >= s.close) ? 'up' : 'down';
  const start = { time: startSec, price: s ? (direction === 'up' ? s.low : s.high) : 0 };
  const end = { time: endSec, price: e ? (direction === 'up' ? e.high : e.low) : 0 };
  return {
    id: uid('seg'),
    kind: 'segment',
    period,
    direction,
    start, end,
  };
}

export function makeZhongshu(segmentIds) {
  return { id: uid('zs'), kind: 'zhongshu', segmentIds: [...segmentIds] };
}

// 从桌面端 drawings JSON 导入为段/中枢
export function fromDrawings(drawings) {
  const segments = [];
  const zhongshus = [];
  for (const d of drawings || []) {
    if (d._isZhongshu) {
      zhongshus.push({
        id: d.id || uid('zs'),
        kind: 'zhongshu',
        segmentIds: d._zhongshuLines || [],
      });
    } else if (d.type === 'line' && d.points?.length >= 2) {
      const [a, b] = [d.points[0], d.points[d.points.length - 1]];
      const start = { time: normTime(a.time), price: a.price };
      const end = { time: normTime(b.time), price: b.price };
      segments.push({
        id: d.id || uid('seg'),
        kind: 'segment',
        period: normPeriod(d.createdPeriod) || '',
        direction: end.price >= start.price ? 'up' : 'down',
        start, end,
      });
    }
  }
  return { segments, zhongshus };
}

// 导出为桌面端兼容的 drawings 结构
export function toDrawings(segments, zhongshus) {
  const out = [];
  for (const s of segments) {
    out.push({
      id: s.id, type: 'line', variant: 'dotted',
      createdPeriod: s.period,
      style: { color: s.direction === 'up' ? '#ef4444' : '#22c55e', lineType: 'solid', width: 2 },
      points: [{ time: s.start.time, price: s.start.price }, { time: s.end.time, price: s.end.price }],
    });
  }
  for (const z of zhongshus) {
    out.push({
      id: z.id, type: 'rect', variant: 'dashed',
      style: { color: '#f0b429', lineType: 'dotted', width: 2 },
      points: [], _isZhongshu: true, _zhongshuLines: z.segmentIds,
    });
  }
  return out;
}

function barAtOrBefore(bars, sec) {
  let r = null;
  for (const b of bars) { if (b.time <= sec) r = b; else break; }
  return r;
}
function barAtOrAfter(bars, sec) {
  for (const b of bars) if (b.time >= sec) return b;
  return bars[bars.length - 1] || null;
}
