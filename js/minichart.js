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

  // 时间域：含段端点与中枢时间范围
  const times = [];
  segs.forEach((s) => { times.push(s.start.time, s.end.time); });
  const zsList = (zhongshus || [])
    .map((z) => computeZsBox(z, segMap))
    .filter(Boolean);
  zsList.forEach((z) => { times.push(z.tStart, z.tEnd); });
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);

  // 价格域：含段端点与中枢区间
  const prices = [];
  segs.forEach((s) => { prices.push(s.start.price, s.end.price); });
  zsList.forEach((z) => { prices.push(z.low, z.high); });
  let pMin = Math.min(...prices);
  let pMax = Math.max(...prices);
  const pPad = (pMax - pMin) * 0.1 || 1;
  pMin -= pPad;
  pMax += pPad;

  const xOf = (t) => pad.l + (tMax === tMin ? (W - pad.l - pad.r) / 2 : ((t - tMin) / (tMax - tMin)) * (W - pad.l - pad.r));
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
