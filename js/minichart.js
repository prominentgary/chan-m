// minichart.js —— 段走势简图（SVG）：折线连接各段端点，叠加中枢框
// 不依赖任何图表库，纯内联 SVG，适配移动端黑白/彩色主题。

// 由中枢成员段计算其震荡区间（高/低价重叠区）与时间范围，与 algo.js 的 getZhongshuRange 一致
function computeZsBox(zs, segMap) {
  const zsSegs = (zs.segmentIds || []).map((id) => segMap[id]).filter(Boolean);
  if (zsSegs.length < 3) return null;
  zsSegs.sort((a, b) => (a.start?.time ?? 0) - (b.start?.time ?? 0));
  const lows = zsSegs.map((s) => Math.min(s.start.price, s.end.price));
  const highs = zsSegs.map((s) => Math.max(s.start.price, s.end.price));
  const low = Math.max(...lows);
  const high = Math.min(...highs);
  if (!(high > low)) return null; // 无重叠区间，不成中枢
  return {
    tStart: zsSegs[0].start.time,
    tEnd: zsSegs[zsSegs.length - 1].end.time,
    low,
    high,
  };
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

  // 中枢框（半透明蓝，置于最底层）
  zsList.forEach((z) => {
    const x1 = xOf(z.tStart);
    const x2 = xOf(z.tEnd);
    const y1 = yOf(z.high);
    const y2 = yOf(z.low);
    const x = Math.min(x1, x2);
    const w = Math.max(2, Math.abs(x2 - x1));
    const y = Math.min(y1, y2);
    const h = Math.max(2, Math.abs(y2 - y1));
    svg += `<rect class="mini-zs" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" />`;
  });

  // 相邻段之间的连接线（中性灰，体现段与段的衔接）
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1];
    const b = segs[i];
    svg += `<line class="mini-link" x1="${xOf(a.end.time).toFixed(1)}" y1="${yOf(a.end.price).toFixed(1)}" x2="${xOf(b.start.time).toFixed(1)}" y2="${yOf(b.start.price).toFixed(1)}" />`;
  }

  // 段主线 + 端点圆点（按涨/跌方向配色，跟随主题）
  segs.forEach((s) => {
    const color = s.direction === 'up'
      ? 'var(--wx-red)'
      : s.direction === 'down'
        ? 'var(--wx-green)'
        : 'var(--wx-muted)';
    svg += `<line x1="${xOf(s.start.time).toFixed(1)}" y1="${yOf(s.start.price).toFixed(1)}" x2="${xOf(s.end.time).toFixed(1)}" y2="${yOf(s.end.price).toFixed(1)}" stroke="${color}" stroke-width="2" stroke-linecap="round" />`;
    svg += `<circle cx="${xOf(s.start.time).toFixed(1)}" cy="${yOf(s.start.price).toFixed(1)}" r="2" fill="${color}" />`;
    svg += `<circle cx="${xOf(s.end.time).toFixed(1)}" cy="${yOf(s.end.price).toFixed(1)}" r="2.6" fill="${color}" />`;
  });

  svg += '</svg>';
  container.innerHTML = svg;
}
