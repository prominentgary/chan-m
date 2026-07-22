// klinechart.js —— 纯 Canvas 蜡烛图渲染器（零图表库依赖）
// 主图：K 线；副图：MACD（默认）/ 成交量，由 app.js 控制切换

function resolveColors() {
  const cs = getComputedStyle(document.body);
  const v = (n, f) => (cs.getPropertyValue(n).trim() || f);
  return {
    red: v('--wx-red', '#fa5151'),
    green: v('--wx-green', '#07c160'),
    txt: v('--wx-txt', '#111'),
    muted: v('--wx-muted', '#999'),
    line: v('--wx-line', '#e6e6e6'),
    accent: v('--wx-accent', '#f0b429'),
    blue: v('--wx-blue', '#576b95'),
    card: v('--wx-card', '#fff'),
    bg: v('--wx-bg', '#f5f5f5'),
  };
}

// 按设备像素比设置 canvas 物理像素，保证高清不糊
function setupCanvas(canvas, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || (canvas.parentElement ? canvas.parentElement.clientWidth : 320);
  canvas.style.height = cssH + 'px';
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: cssH };
}

function fmtVol(v) {
  if (!v) return '0';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(Math.round(v));
}

function fmtAxis(t, period) {
  if (!t) return '';
  const d = new Date(t * 1000);
  const p2 = (x) => String(x).padStart(2, '0');
  if (period === 'day' || period === 'week' || period === 'month') {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function drawLine(ctx, bars, get, xOf, yOf, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  bars.forEach((b, i) => {
    const x = xOf(i), y = yOf(get(b));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 段起点→终点 点线段连接（点线 + 端点圆点）
function drawSegConnector(ctx, meta, seg, colors) {
  const { bars, xOf, yOf } = meta;
  if (!bars || !bars.length) return;
  const si = bars.findIndex((b) => b.time === seg.start.time);
  const ei = bars.findIndex((b) => b.time === seg.end.time);
  if (si < 0 || ei < 0) return;
  const x1 = xOf(si), y1 = yOf(seg.start.price);
  const x2 = xOf(ei), y2 = yOf(seg.end.price);
  const col = seg.direction === 'up' ? colors.red : colors.green;
  ctx.save();
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.4;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(x1, y1, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x2, y2, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

let _view = null;

export function sliceSegmentBars(bars, seg) {
  if (!bars || !bars.length || !seg || !seg.start || !seg.end) return [];
  const s = seg.start.time;
  // 盯盘段：终点之后到当前 K 线（剩余未分段部分）一并纳入，便于实时观察
  const e = seg._isWatch ? bars[bars.length - 1].time : seg.end.time;
  return bars.filter((b) => b.time >= s && b.time <= e);
}

export function renderKlineChart(main, sub, bars, opts = {}) {
  const colors = resolveColors();
  const period = opts.period || '1m';
  _view = {
    main,
    sub,
    bars: bars || [],
    seg: opts.seg || null,
    subType: opts.sub === 'vol' ? 'vol' : 'macd',
    period,
    colors,
    digits: opts.digits || 2,
    subH: opts.subH || 96,
    crossActive: false, // 触摸长按后进入的十字态
  };
  repaintMain();
  repaintSub();
  bindCrosshair();
}

function repaintMain(cross) {
  if (!_view) return;
  const { main, bars, seg, colors, period, digits } = _view;
  _view.mainMeta = drawMainCanvas(main, bars, seg, colors, period, digits);
  if (cross) drawMainCross(_view.mainMeta, cross);
}

function repaintSub() {
  if (!_view) return;
  const { sub, bars, subType, colors, period, subH } = _view;
  _view.subMeta = drawSubCanvas(sub, bars, subType, colors, period, subH);
}

function drawMainCanvas(canvas, bars, seg, colors, period, digits) {
  const { ctx, w, h } = setupCanvas(canvas, 220);
  ctx.clearRect(0, 0, w, h);
  if (!bars.length) {
    ctx.fillStyle = colors.muted;
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('该段超出已加载 K 线范围', w / 2, h / 2);
    return { n: 0 };
  }

  let min = Infinity, max = -Infinity;
  for (const b of bars) {
    if (b.low < min) min = b.low;
    if (b.high > max) max = b.high;
  }
  if (seg?.start) { min = Math.min(min, seg.start.price); max = Math.max(max, seg.start.price); }
  if (seg?.end) { min = Math.min(min, seg.end.price); max = Math.max(max, seg.end.price); }
  const pad = (max - min) * 0.08 || 1;
  min -= pad; max += pad;

  const padR = 46, padL = 8;
  const plotW = w - padR - padL;
  const plotH = h - 16;
  const n = bars.length;
  const step = plotW / n;
  const cw = Math.max(1, step * 0.62);
  const xOf = (i) => padL + (i + 0.5) * step;
  const yOf = (p) => plotH - (p - min) / (max - min) * plotH;

  // 横向网格 + 右端价格轴
  ctx.font = '10px sans-serif';
  ctx.textBaseline = 'middle';
  const rows = 4;
  for (let r = 0; r <= rows; r++) {
    const y = (r * plotH) / rows;
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    const price = max - (r / rows) * (max - min);
    ctx.fillStyle = colors.muted;
    ctx.textAlign = 'left';
    ctx.fillText(price.toFixed(digits), padL + plotW + 4, y);
  }
  // 底部稀疏时间轴
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const i = Math.min(n - 1, Math.round((t / ticks) * (n - 1)));
    ctx.fillStyle = colors.muted;
    ctx.fillText(fmtAxis(bars[i].time, period), xOf(i), plotH + 2);
  }
  // 蜡烛：阳线空心（实体填背景色 + 描边），阴线实心
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const x = xOf(i);
    const up = b.close >= b.open;
    const col = up ? colors.red : colors.green;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yOf(b.high));
    ctx.lineTo(x, yOf(b.low));
    ctx.stroke();
    const yo = yOf(b.open), yc = yOf(b.close);
    const top = Math.min(yo, yc);
    const bh = Math.max(1, Math.abs(yo - yc));
    if (up) {
      ctx.fillStyle = colors.card;
      ctx.fillRect(x - cw / 2, top, cw, bh);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - cw / 2, top, cw, bh);
    } else {
      ctx.fillStyle = col;
      ctx.fillRect(x - cw / 2, top, cw, bh);
    }
  }
  // 段起点→终点 点线段连接
  if (seg?.start && seg?.end) drawSegConnector(ctx, { bars, xOf, yOf }, seg, colors);

  return { w, h, n, min, max, plotW, plotH, padL, xOf, yOf, seg, bars, colors };
}

function drawSubCanvas(canvas, bars, subType, colors, period, subH) {
  const { ctx, w, h } = setupCanvas(canvas, subH);
  ctx.clearRect(0, 0, w, h);
  if (!bars.length) return { n: 0 };

  const padR = 46, padL = 8;
  const plotW = w - padR - padL;
  const plotH = h - 10;
  const n = bars.length;
  const step = plotW / n;
  const cw = Math.max(1, step * 0.62);
  const xOf = (i) => padL + (i + 0.5) * step;

  if (subType === 'macd') {
    let mn = 0, mx = 0;
    for (const b of bars) {
      mn = Math.min(mn, b.macd, b.dif, b.dea);
      mx = Math.max(mx, b.macd, b.dif, b.dea);
    }
    const pad = (mx - mn) * 0.12 || 1;
    mn -= pad; mx += pad;
    const yOf = (v) => plotH - (v - mn) / (mx - mn) * plotH;
    // 0 轴
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, yOf(0));
    ctx.lineTo(padL + plotW, yOf(0));
    ctx.stroke();
    // 柱
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const y0 = yOf(0), y1 = yOf(b.macd);
      ctx.fillStyle = b.macd >= 0 ? colors.red : colors.green;
      ctx.fillRect(xOf(i) - cw / 2, Math.min(y0, y1), cw, Math.max(1, Math.abs(y0 - y1)));
    }
    drawLine(ctx, bars, (b) => b.dif, xOf, yOf, colors.accent);
    drawLine(ctx, bars, (b) => b.dea, xOf, yOf, colors.blue);
    // 右端刻度 + 图例
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colors.muted;
    ctx.fillText(mx.toFixed(2), padL + plotW + 4, yOf(mx));
    ctx.fillText('0', padL + plotW + 4, yOf(0));
    ctx.fillText(mn.toFixed(2), padL + plotW + 4, yOf(mn));
    ctx.fillStyle = colors.accent;
    ctx.fillText('DIF', padL + 2, 8);
    ctx.fillStyle = colors.blue;
    ctx.fillText('DEA', padL + 34, 8);
  } else {
    let maxV = 0;
    for (const b of bars) maxV = Math.max(maxV, b.volume || 0);
    if (maxV <= 0) maxV = 1;
    const yOf = (v) => plotH - (v / maxV) * plotH;
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const up = b.close >= b.open;
      ctx.fillStyle = up ? colors.red : colors.green;
      const y = yOf(b.volume || 0);
      ctx.fillRect(xOf(i) - cw / 2, y, cw, plotH - y);
    }
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colors.muted;
    ctx.fillText(fmtVol(maxV), padL + plotW + 4, yOf(maxV));
  }
  return { n };
}

// 主图十字光标 + OHLC 读数
// 交互：鼠标悬停实时跟随；触摸长按图形区域(>350ms)显示十字并实时展示坐标，
// 触摸横向滑动(非边缘)切换上/下段，边缘滑动交给全局手势退出弹窗。
function bindCrosshair() {
  const main = _view.main;
  if (main._klBound) return;
  main._klBound = true;

  const EDGE = 28;        // 与全局边缘手势一致：边缘滑动用于退出弹窗
  const LONG_MS = 350;    // 长按阈值
  const SWIPE_PX = 46;    // 切换段所需的最小水平位移
  let sx = 0, sy = 0;     // pointerdown 起点
  let lpTimer = null;     // 长按定时器
  let lpFired = false;    // 是否已进入十字态
  let swiping = false;    // 是否已判定为滑动(未达长按)

  const crossPos = (e) => {
    const rect = main.getBoundingClientRect();
    let x = e.clientX - rect.left;
    let y = e.clientY - rect.top;
    x = Math.max(0, Math.min(rect.width, x));
    y = Math.max(0, Math.min(rect.height, y));
    return { x, y };
  };
  const showAt = (e) => {
    if (!_view || !_view.mainMeta) return;
    const { x, y } = crossPos(e);
    const meta = _view.mainMeta;
    if (!meta || !meta.n) return;
    let idx = Math.round((x - meta.padL) / (meta.plotW / meta.n) - 0.5);
    idx = Math.max(0, Math.min(meta.n - 1, idx));
    const b = _view.bars[idx];
    if (!b) return;
    repaintMain({ x, y, idx, bar: b });
  };
  const clearLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  const hideCross = () => { if (_view && _view.crossActive) { _view.crossActive = false; repaintMain(); } };

  main.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return; // 鼠标走悬停
    const EDGE = 28; // 与全局边缘手势一致：边缘区域留给「退出弹窗」手势
    if (e.clientX <= EDGE || e.clientX >= window.innerWidth - EDGE) return;
    sx = e.clientX; sy = e.clientY;
    lpFired = false; swiping = false;
    clearLp();
    lpTimer = setTimeout(() => {
      lpFired = true;
      _view.crossActive = true;
      showAt(e);
    }, LONG_MS);
  });

  main.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') { showAt(e); return; } // 鼠标悬停实时跟随
    if (_view.crossActive) { // 已进入十字态：跟随手指并阻止页面滚动
      if (e.cancelable) e.preventDefault();
      showAt(e);
      return;
    }
    // 长按未触发前出现明显位移 → 视为滑动，取消长按，交由 pointerup 判定切换
    if (!swiping && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) {
      swiping = true;
      clearLp();
    }
  });

  main.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;
    clearLp();
    if (_view.crossActive) { hideCross(); return; } // 长按态结束
    if (swiping) {
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      // 仅处理横向滑动；边缘发起的滑动交给全局手势退出弹窗
      if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
        const atEdge = sx <= EDGE || sx >= window.innerWidth - EDGE;
        if (!atEdge && window.switchKlineSegment) {
          window.switchKlineSegment(dx < 0 ? 'next' : 'prev');
        }
      }
    }
  });
  main.addEventListener('pointercancel', () => { clearLp(); hideCross(); });
  main.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') repaintMain(); });
}

function drawMainCross(meta, cross) {
  const colors = _view.colors;
  const { ctx, padL, plotW, plotH, min, max } = meta;
  const b = cross.bar;
  const cx = cross.x;
  const cy = Math.min(plotH, Math.max(0, cross.y));
  ctx.save();
  ctx.strokeStyle = colors.muted;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, plotH);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(padL, cy);
  ctx.lineTo(padL + plotW, cy);
  ctx.stroke();
  ctx.setLineDash([]);
  // 右端价格标签（光标处价格）
  const price = max - (cy / plotH) * (max - min);
  const digits = _view.digits;
  ctx.fillStyle = colors.accent;
  ctx.font = '10px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(price.toFixed(digits), padL + plotW + 4, cy);
  // OHLC 读数
  const up = b.close >= b.open;
  const col = up ? colors.red : colors.green;
  const txt =
    `${fmtAxis(b.time, _view.period)}  开${b.open.toFixed(digits)} 高${b.high.toFixed(digits)} ` +
    `低${b.low.toFixed(digits)} 收${b.close.toFixed(digits)} 量${fmtVol(b.volume || 0)}`;
  ctx.font = '10px sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const tw = ctx.measureText(txt).width;
  const bx = padL + 2, by = 2, bw = Math.min(plotW - 4, tw + 8), bh = 14;
  ctx.fillStyle = colors.card;
  ctx.globalAlpha = 0.88;
  roundRect(ctx, bx, by, bw, bh, 3);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = col;
  ctx.fillText(txt, bx + 4, by + 2);
  ctx.restore();
}
