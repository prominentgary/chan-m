// minichart.js —— 段走势简图（SVG）：折线连接各段端点，叠加中枢框
// 不依赖任何图表库，纯内联 SVG，适配移动端黑白/彩色主题。

// 中枢配色：统一黑色
const ZS_COLOR = 'var(--wx-txt)';

// 由中枢计算其震荡区间与时间范围。
//   - 中枢区间（高低价）= 前 3 段（基础段）的重叠区域，与 algo.js 的 getZhongshuRange 一致。
//   - 时间宽度 = 全部成员段（含延伸段）的跨度，体现中枢延伸。
function computeZsBox(zs, segMap) {
  // 价格区间：基于基础 3 段
  const baseIds = (zs.baseSegmentIds && zs.baseSegmentIds.length >= 3)
    ? zs.baseSegmentIds
    : (zs.segmentIds || []).slice(0, 3);
  const baseSegs = baseIds.map((id) => segMap[id]).filter(Boolean);
  if (baseSegs.length < 3) return null;
  baseSegs.sort((a, b) => (a.start?.time ?? 0) - (b.start?.time ?? 0));
  // 前 3 段的重叠区域：低点取各段低点最大值，高点取各段高点最小值
  const lows = baseSegs.map((s) => Math.min(s.start.price, s.end.price));
  const highs = baseSegs.map((s) => Math.max(s.start.price, s.end.price));
  const low = Math.max(...lows);
  const high = Math.min(...highs);
  if (!(high > low)) return null; // 无重叠区间，不成中枢

  // 时间宽度：基于全部成员段（含延伸段），取首段起点到末段终点
  const memberSegs = (zs.segmentIds || [])
    .map((id) => segMap[id])
    .filter(Boolean)
    .sort((a, b) => (a.start?.time ?? 0) - (b.start?.time ?? 0));
  const spanSegs = memberSegs.length ? memberSegs : baseSegs;
  const tStart = spanSegs[0].start.time;
  const tEnd = spanSegs[spanSegs.length - 1].end.time;

  return { tStart, tEnd, low, high, color: ZS_COLOR };
}

// 把时间戳换算成「交易时间坐标」：只累计交易时段的分钟数，剔除午休/隔夜/周末/节假日。
// 这样横轴按真实交易时长展开，非交易空白被压缩，避免段被拉得忽宽忽窄。
//   - 每个工作日计 240 个交易分钟：上午 9:30–11:30、下午 13:00–15:00
//   - 午休(11:30–13:00)、收盘后、周末均不计
//   注：A 股法定节假日无法仅凭日期判断，会被压缩成 1 个交易日宽度（无难看空白），属可接受近似。
//   日期/周几用 UTC 计算以保证跨时区一致；日内时分用本地时间（交易时段按本地计）。
function tradingTimeCoord(t) {
  const dt = new Date(t * 1000);
  // 自 1970-01-01(周四) 起经过的完整工作日数（UTC 日期，避免时区导致跨日错位）
  const baseUtc = Date.UTC(1970, 0, 1);
  const todayUtc = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
  const diffDays = Math.round((todayUtc - baseUtc) / 86400000);
  const fullWeeks = Math.floor(diffDays / 7);
  let weekdays = fullWeeks * 5;
  const rem = diffDays - fullWeeks * 7;
  let wd = (4 + fullWeeks * 7) % 7; // 1970-01-01 为周四
  for (let i = 0; i < rem; i++) {
    if (wd !== 0 && wd !== 6) weekdays++;
    wd = (wd + 1) % 7;
  }
  // 日内交易分钟：按北京时间(UTC+8)计算，不依赖设备本地时区，避免非 CST 环境算错
  const cst = new Date(t * 1000 + 8 * 3600 * 1000);
  const hm = cst.getUTCHours() * 60 + cst.getUTCMinutes();
  let mins;
  if (hm <= 570) mins = 0;            // 9:30 前 → 当日开盘
  else if (hm <= 690) mins = hm - 570; // 9:30–11:30
  else if (hm < 780) mins = 120;       // 11:30–13:00 午休 → 夹到上午收盘
  else if (hm <= 900) mins = 120 + (hm - 780); // 13:00–15:00
  else mins = 240;                     // 15:00 后 → 当日收盘
  return weekdays * 240 + mins;
}

// 在 container 内绘制段简图
//   segments : 已按 hideBefore 过滤后的可见段
//   zhongshus: 引用了可见段的 中枢（未引用可见段的会被过滤掉）
//   opts: { width, height }
export function renderMiniChart(container, segments, zhongshus, opts = {}) {
  if (!container) return;
  const H = opts.height || 200;
  const W = opts.width || Math.max(160, Math.floor(container.clientWidth || (window.innerWidth - 32)));
  const pad = { l: 6, r: 6, t: 12, b: 18 };

  if (!segments || !segments.length) {
    container.innerHTML = '<div class="empty">暂无段</div>';
    return;
  }

  const segs = [...segments].sort((a, b) => (a.start?.time ?? 0) - (b.start?.time ?? 0));
  const segMap = {};
  segs.forEach((s) => { segMap[s.id] = s; });

  const zsList = (zhongshus || [])
    .map((z) => computeZsBox(z, segMap))
    .filter(Boolean);

  // 时间域：用「交易时间坐标」替代原始时间戳，剔除午休/隔夜/周末等非交易时段，
  // 使横轴按真实交易时长展开，避免非交易空白把段拉得忽宽忽窄。
  const coords = [];
  segs.forEach((s) => { coords.push(tradingTimeCoord(s.start.time), tradingTimeCoord(s.end.time)); });
  zsList.forEach((z) => { coords.push(tradingTimeCoord(z.tStart), tradingTimeCoord(z.tEnd)); });
  const cMin = Math.min(...coords);
  const cMax = Math.max(...coords);

  // 价格域：含段端点与中枢区间
  const prices = [];
  segs.forEach((s) => { prices.push(s.start.price, s.end.price); });
  zsList.forEach((z) => { prices.push(z.low, z.high); });
  let pMin = Math.min(...prices);
  let pMax = Math.max(...prices);
  const pPad = (pMax - pMin) * 0.1 || 1;
  pMin -= pPad;
  pMax += pPad;

  const xOf = (t) => {
    const c = tradingTimeCoord(t);
    return pad.l + (cMax === cMin ? (W - pad.l - pad.r) / 2 : ((c - cMin) / (cMax - cMin)) * (W - pad.l - pad.r));
  };
  const yOf = (p) => pad.t + (pMax === pMin ? (H - pad.t - pad.b) / 2 : ((pMax - p) / (pMax - pMin)) * (H - pad.t - pad.b));

  let svg = `<svg class="mini-chart-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="段走势简图">`;

  // 中枢区间（置于最底层）：轻量填充作为分组背景，四周用与段一致的线型绘制成完整方框
  zsList.forEach((z) => {
    const x1 = xOf(z.tStart);
    const x2 = xOf(z.tEnd);
    const yHigh = yOf(z.high);
    const yLow = yOf(z.low);
    const x = Math.min(x1, x2);
    const w = Math.max(2, Math.abs(x2 - x1));
    const y = Math.min(yHigh, yLow);
    const h = Math.max(2, Math.abs(yLow - yHigh));
    // 背景填充（中枢色，低透明度）
    svg += `<rect class="mini-zs" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${z.color}" fill-opacity="0.10" />`;
    // 中枢方框四边：圆头实线、宽度 2，与段主线线型一致，颜色统一为中枢强调色
    svg += `<line class="mini-zs-edge" x1="${x1.toFixed(1)}" y1="${yHigh.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${yHigh.toFixed(1)}" stroke="${z.color}" stroke-width="2" stroke-linecap="round" />`;
    svg += `<line class="mini-zs-edge" x1="${x1.toFixed(1)}" y1="${yLow.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${yLow.toFixed(1)}" stroke="${z.color}" stroke-width="2" stroke-linecap="round" />`;
    svg += `<line class="mini-zs-edge" x1="${x1.toFixed(1)}" y1="${yHigh.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${yLow.toFixed(1)}" stroke="${z.color}" stroke-width="2" stroke-linecap="round" />`;
    svg += `<line class="mini-zs-edge" x1="${x2.toFixed(1)}" y1="${yHigh.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${yLow.toFixed(1)}" stroke="${z.color}" stroke-width="2" stroke-linecap="round" />`;
  });

  // 相邻段之间的连接线（中性灰，体现段与段的衔接）
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1];
    const b = segs[i];
    svg += `<line class="mini-link" x1="${xOf(a.end.time).toFixed(1)}" y1="${yOf(a.end.price).toFixed(1)}" x2="${xOf(b.start.time).toFixed(1)}" y2="${yOf(b.start.price).toFixed(1)}" />`;
  }

  // 段主线（统一黑色，不区分涨跌方向，无端点圆点）
  segs.forEach((s) => {
    const color = 'var(--wx-txt)';
    svg += `<line x1="${xOf(s.start.time).toFixed(1)}" y1="${yOf(s.start.price).toFixed(1)}" x2="${xOf(s.end.time).toFixed(1)}" y2="${yOf(s.end.price).toFixed(1)}" stroke="${color}" stroke-width="2" stroke-linecap="round" />`;
  });

  svg += '</svg>';
  container.innerHTML = svg;
}
