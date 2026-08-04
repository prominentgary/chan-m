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

// 中枢矩形（点线/实线由 themeLines 决定，位于 K 线之上、段连线之下）
function drawZhongshuRect(ctx, meta, zs, colors) {
  const { bars, xOf, yOf, themeLines } = meta;
  if (!bars || !bars.length) return;
  const si = bars.findIndex((b) => b.time === zs.startTime);
  const ei = bars.findIndex((b) => b.time === zs.endTime);
  if (si < 0 || ei < 0) return;
  const x1 = xOf(si);
  const y1 = yOf(zs.high);
  const x2 = xOf(ei);
  const y2 = yOf(zs.low);
  ctx.save();
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1.4;
  if (!themeLines) ctx.setLineDash([3, 3]);
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
  ctx.restore();
}

// 段起点→终点连线（点线/实线由 themeLines 决定，端点圆点同理），no 为可选段号
function drawSegConnector(ctx, meta, seg, colors, no) {
  const { bars, xOf, yOf, themeLines } = meta;
  if (!bars || !bars.length) return;
  const si = bars.findIndex((b) => b.time === seg.start.time);
  const ei = bars.findIndex((b) => b.time === seg.end.time);
  if (si < 0 || ei < 0) return;
  const x1 = xOf(si), y1 = yOf(seg.start.price);
  const x2 = xOf(ei), y2 = yOf(seg.end.price);
  const col = themeLines ? colors.accent : (seg.direction === 'up' ? colors.red : colors.green);
  ctx.save();
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.4;
  if (!themeLines) ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  if (!themeLines) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x1, y1, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x2, y2, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  // 段号标签：中点上方，方向色底 + 白字
  if (no) {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const label = String(no);
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lw = ctx.measureText(label).width;
    const lh = 12;
    const lx = mx;
    const ly = my - 10;
    ctx.fillStyle = col;
    roundRect(ctx, lx - lw / 2 - 3, ly - lh / 2, lw + 6, lh, 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(label, lx, ly);
  }
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
  // 先构建完整视图快照（局部变量），再赋值全局 _view，避免并发覆盖导致 bindCrosshair 拿到错误的 main
  const view = {
    main,
    sub,
    bars: bars || [],
    seg: opts.seg || null,
    segs: opts.segs || (opts.seg ? [{ seg: opts.seg, no: opts.segNo || '' }] : []),
    zhongshus: opts.zhongshus || [],
    subType: opts.sub === 'vol' ? 'vol' : 'macd',
    themeLines: !!opts.themeLines,
    solidMacd: !!opts.solidMacd,
    period,
    colors,
    digits: opts.digits || 2,
    subH: opts.subH || 96,
    crossActive: false, // 触摸长按后进入的十字态
    onCrossChange: opts.onCrossChange || null,
  };
  _view = view;
  repaintMain();
  repaintSub();
  if (opts.subToggle) bindSubToggle(sub);
  if (!opts.noSwipe) {
    bindCrosshair(view, main, {});
    bindSubSwipe(sub, window.switchKlineSegment);
  } else if (opts.crosshairOnly) {
    bindCrosshair(view, main, { noSwitch: true, onSwipe: opts.onSwipe });
    // 仅当显式要求副图横滑切换时才绑定（周期弹窗切页需要）。
    // 段卡片 K 线弹层(noSwipe)本就锁定显示该段，禁止任何横滑切换，否则长按出十字后
    // 手指在副图微动会误触发 switchKlineSegment，把 K 线换成相邻段（如 2、3、4 段）。
    if (opts.subSwipe) bindSubSwipe(sub, opts.onSwipe);
  }
}

function bindSubToggle(sub) {
  if (!sub || sub._chanmSubToggleBound) return;
  sub._chanmSubToggleBound = true;
  sub.addEventListener('click', () => {
    if (!_view) return;
    _view.subType = _view.subType === 'macd' ? 'vol' : 'macd';
    repaintSub();
  });
}

function repaintMain(cross) {
  if (!_view) return;
  console.log('[repaintMain]', { period: _view.period, nBars: _view.bars?.length, nSegs: _view.segs?.length, cross: !!cross });
  const { main, bars, segs, zhongshus, colors, period, digits, themeLines } = _view;
  _view.mainMeta = drawMainCanvas(main, bars, segs, zhongshus, colors, period, digits, themeLines);
  if (cross) drawMainCross(_view.mainMeta, cross, colors, digits, period);
}

function repaintSub() {
  if (!_view) return;
  const { sub, bars, subType, colors, period, subH, solidMacd } = _view;
  _view.subMeta = drawSubCanvas(sub, bars, subType, colors, period, subH, solidMacd);
}

function drawMainCanvas(canvas, bars, segs, zhongshus, colors, period, digits, themeLines) {
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
  // 兼容单个 seg 的传入
  const segList = Array.isArray(segs) ? segs : (segs ? [{ seg: segs, no: '' }] : []);

  let min = Infinity, max = -Infinity;
  for (const b of bars) {
    if (b.low < min) min = b.low;
    if (b.high > max) max = b.high;
  }
  for (const { seg: s } of segList) {
    if (s?.start) { min = Math.min(min, s.start.price); max = Math.max(max, s.start.price); }
    if (s?.end) { min = Math.min(min, s.end.price); max = Math.max(max, s.end.price); }
  }
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
    // 顶部/底部标签避免被画布边缘截断
    const labelY = Math.max(6, Math.min(plotH - 6, y));
    ctx.fillText(price.toFixed(digits), padL + plotW + 4, labelY);
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
  // 中枢矩形 + 段连线：使用局部参数 themeLines（不再依赖全局 _view），
  // 避免多页周期弹窗并发渲染覆盖 _view 时，画线读取到错误的主题配置。
  const meta = { bars, xOf, yOf, themeLines };
  // 中枢点线矩形
  if (zhongshus && zhongshus.length) {
    for (const zs of zhongshus) {
      drawZhongshuRect(ctx, meta, zs, colors);
    }
  }
  // 段起点→终点 点线段连接
  for (const { seg: s, no } of segList) {
    if (s?.start && s?.end) drawSegConnector(ctx, meta, s, colors, no);
  }

  return { ctx, w, h, n, min, max, plotW, plotH, padL, xOf, yOf, seg: segList.map((x) => x.seg), bars, colors, zhongshus };
}

function drawSubCanvas(canvas, bars, subType, colors, period, subH, solidMacd) {
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
    // 柱：红柱镂空（背景色填充 + 描边），绿柱实心
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const y0 = yOf(0), y1 = yOf(b.macd);
      const x = xOf(i) - cw / 2;
      const y = Math.min(y0, y1);
      const bh = Math.max(1, Math.abs(y0 - y1));
      if (b.macd >= 0) {
        ctx.fillStyle = solidMacd ? colors.red : colors.card;
        ctx.fillRect(x, y, cw, bh);
        ctx.strokeStyle = colors.red;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, cw, bh);
      } else {
        ctx.fillStyle = colors.green;
        ctx.fillRect(x, y, cw, bh);
      }
    }
    drawLine(ctx, bars, (b) => b.dif, xOf, yOf, colors.accent);
    drawLine(ctx, bars, (b) => b.dea, xOf, yOf, colors.blue);
    // 右端刻度 + 图例
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colors.muted;
    ctx.fillText(mx.toFixed(2), padL + plotW + 4, Math.max(5, yOf(mx)));
    ctx.fillText('0', padL + plotW + 4, Math.max(5, Math.min(plotH - 5, yOf(0))));
    ctx.fillText(mn.toFixed(2), padL + plotW + 4, Math.min(plotH - 5, yOf(mn)));
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
    ctx.fillText(fmtVol(maxV), padL + plotW + 4, Math.max(5, yOf(maxV)));
  }
  return { n };
}

// 主图十字光标 + OHLC 读数 + 左右滑切换段
// 交互：鼠标悬停实时跟随；触摸长按图形区域(>350ms)显示十字并实时展示坐标；
//       未进入十字态时主图左右滑切换上/下段。
// 重要：bindCrosshair 接收 view + main 参数（而非从全局 _view 读取），
//       避免多页周期弹窗中并发 renderKlineChart 覆盖全局 _view 导致拿到错误的 canvas。
function bindCrosshair(view, main, opts = {}) {
  if (!view || !main) { console.warn('[十字] bindCrosshair skip: no view or main'); return; }
  if (main._klBound) return;
  main._klBound = true;
  const noSwitch = opts.noSwitch;
  // noSwitch 为真（如段卡片 K 线弹层）时禁用横滑切段/切页，否则长按出十字后手指微动会误触发切段
  const swipeFn = noSwitch ? null : (opts.onSwipe || window.switchKlineSegment);
  // noSwitch 场景：同一 canvas 会被多次 renderKlineChart 复用，闭包捕获的 view 会变陈旧，
  // 因此必须实时读取模块级 _view（每次 renderKlineChart 都会更新它）。
  // 非 noSwitch 场景（周期弹窗多页）：每页独立 canvas，使用闭包捕获的 view 避免被其他页覆盖。
  const getView = noSwitch ? () => _view : () => view;

  const EDGE = 28;
  const LONG_MS = 350;
  const SWIPE_PX = 46;
  const MOVE_THRESHOLD = 20;  // 移动端手指抖动容差，避免轻微抖动误判为滑动
  let sx = 0, sy = 0;
  let lpTimer = null;
  let lpFired = false;
  let moved = false;
  let swiping = false;
  let hideTimer = null;
  let downT = 0;       // pointerdown 时间戳，用于区分「长按触发」与「十字线态下的轻点」

  // 使用 getView() 获取当前视图（noSwitch 时实时读取 _view，否则用闭包 view）
  const repaintLocal = (cross) => {
    const v = getView();
    if (!v) return;
    const { bars, segs, zhongshus, colors, period, digits, themeLines } = v;
    if (!bars || !bars.length) return;
    if (!main.isConnected) return;
    if (!main.clientWidth || !main.clientHeight) return;
    const newMeta = drawMainCanvas(main, bars, segs, zhongshus, colors, period, digits, themeLines);
    if (!newMeta || !newMeta.n) return;
    v.mainMeta = newMeta;
    if (cross) drawMainCrossLocal(cross);
  };
  const drawMainCrossLocal = (cross) => {
    const v = getView();
    if (!v) return;
    const meta = v.mainMeta;
    if (!meta) return;
    const colors = v.colors;
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
    const digits = v.digits;
    const price = max - (cy / plotH) * (max - min);
    const priceTxt = price.toFixed(digits);
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const pw = ctx.measureText(priceTxt).width;
    const px = padL + plotW + 24, py = cy;
    ctx.fillStyle = colors.accent;
    roundRect(ctx, px - pw / 2 - 4, py - 8, pw + 8, 16, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(priceTxt, px, py);
    const timeTxt = fmtAxis(b.time, v.period);
    ctx.textAlign = 'center';
    const timeW = ctx.measureText(timeTxt).width;
    const tx = Math.max(padL + 4 + timeW / 2, Math.min(padL + plotW - 4 - timeW / 2, cx));
    const ty = plotH + 9;
    ctx.fillStyle = colors.accent;
    roundRect(ctx, tx - timeW / 2 - 4, ty - 7, timeW + 8, 14, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(timeTxt, tx, ty);
    const up = b.close >= b.open;
    const col = up ? colors.red : colors.green;
    const txt =
      `${fmtAxis(b.time, v.period)}  开${b.open.toFixed(digits)} 高${b.high.toFixed(digits)} ` +
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
  };
  const crossPos = (e) => {
    const rect = main.getBoundingClientRect();
    let x = e.clientX - rect.left;
    let y = e.clientY - rect.top;
    x = Math.max(0, Math.min(rect.width, x));
    y = Math.max(0, Math.min(rect.height, y));
    return { x, y };
  };
  const showAt = (e) => {
    const v = getView();
    if (!v || !v.mainMeta) return;
    const { x, y } = crossPos(e);
    const meta = v.mainMeta;
    if (!meta || !meta.n) return;
    let idx = Math.round((x - meta.padL) / (meta.plotW / meta.n) - 0.5);
    idx = Math.max(0, Math.min(meta.n - 1, idx));
    const b = v.bars[idx];
    if (!b) return;
    repaintLocal({ x, y, idx, bar: b });
  };
  const clearLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  const clearHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
  const setCrossActive = (active) => {
    const v = getView();
    if (!v) return;
    v.crossActive = active;
    if (v.onCrossChange) {
      try { v.onCrossChange(active); } catch {}
    }
  };
  const hideCross = () => { const v = getView(); if (v && v.crossActive) { setCrossActive(false); repaintLocal(); } };
  const scheduleHide = () => {
    clearHide();
    hideTimer = setTimeout(() => { hideTimer = null; hideCross(); }, 5000);
  };

  main.addEventListener('pointerdown', (e) => {
    if (e.clientX <= EDGE || e.clientX >= window.innerWidth - EDGE) return;
    // canvas 已有 touch-action:none CSS，不额外 preventDefault
    sx = e.clientX; sy = e.clientY;
    lpFired = false; moved = false; swiping = false;
    downT = Date.now();
    clearLp();
    clearHide();
    if (e.pointerType === 'mouse') {
      try { main.setPointerCapture(e.pointerId); } catch {}
      setCrossActive(true);
      showAt(e);
    } else {
      // 触摸：延迟到长按确认后再 capture，避免过早 capture 干扰浏览器事件分发
      lpTimer = setTimeout(() => {
        lpFired = true;
        try { main.setPointerCapture(e.pointerId); } catch {}
        setCrossActive(true);
        showAt(e);
      }, LONG_MS);
    }
  });

  main.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') { showAt(e); return; }
    const v = getView();
    if (v && v.crossActive) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      showAt(e);
      return;
    }
    if (!moved && (Math.abs(e.clientX - sx) > MOVE_THRESHOLD || Math.abs(e.clientY - sy) > MOVE_THRESHOLD)) {
      moved = true;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (swipeFn && Math.abs(dx) > Math.abs(dy)) {
        clearLp();
        swiping = true;
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
      }
    }
  });

  main.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') { hideCross(); return; }
    clearLp();
    try { main.releasePointerCapture(e.pointerId); } catch {}
    const v = getView();
    if (swiping && swipeFn && !(v && v.crossActive)) {
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      const atEdge = sx <= EDGE || sx >= window.innerWidth - EDGE;
      if (!atEdge && Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
        swipeFn(dx < 0 ? 'next' : 'prev');
      }
      return;
    }
    if (v && v.crossActive) {
      // 十字线已激活时：若为一次「轻点」（非长按触发、几乎未移动、间隔很短），
      // 视为点击空白区域，立即退出十字线；若是长按触发后松手则保留 5s 自动隐藏。
      const isTap = !lpFired && !moved && (Date.now() - downT) < LONG_MS;
      if (isTap) hideCross();
      else scheduleHide();
    }
  });
  main.addEventListener('pointercancel', (e) => { try { main.releasePointerCapture(e.pointerId); } catch {} clearLp(); if (!swiping) scheduleHide(); });
  main.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') repaintLocal(); });
  main.addEventListener('contextmenu', (e) => e.preventDefault());
}

// 副图左右滑切换（左滑→下一项，右滑→上一项）；边缘滑动交给全局手势退出弹窗。
// swipeFn 由调用方传入：周期卡片弹窗传 switchPeriodPage，段卡片弹窗传 switchKlineSegment。
// 注意：副图横滑切换不受主图十字线状态影响，任何时刻都生效，方便在十字线显示时也能切页/切段。
function bindSubSwipe(sub, swipeFn) {
  if (sub._klBound) return;
  sub._klBound = true;
  const fn = swipeFn || window.switchKlineSegment;

  const EDGE = 28;        // 与全局边缘手势一致：边缘滑动用于退出弹窗
  const SWIPE_PX = 46;    // 切换所需的最小水平位移
  const MOVE_PX = 12;     // 判定为有效位移的阈值
  let sx = 0, sy = 0;     // pointerdown 起点
  let swiping = false;    // 是否已判定为横向滑动
  let moved = false;      // 是否发生明显位移

  sub.addEventListener('pointerdown', (e) => {
    if (e.clientX <= EDGE || e.clientX >= window.innerWidth - EDGE) return; // 边缘区交给退出弹窗手势
    sx = e.clientX; sy = e.clientY;
    swiping = false; moved = false;
  });

  sub.addEventListener('pointermove', (e) => {
    if (moved) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > MOVE_PX || Math.abs(dy) > MOVE_PX) {
      moved = true;
      // 判定为横向滑动后阻止页面滚动，保证切换顺滑；纵向位移不拦截
      if (Math.abs(dx) > Math.abs(dy)) {
        swiping = true;
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
      }
    }
  });

  sub.addEventListener('pointerup', (e) => {
    if (swiping) {
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      // 仅处理横向滑动；边缘发起的滑动交给全局手势退出弹窗
      if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
        const atEdge = sx <= EDGE || sx >= window.innerWidth - EDGE;
        if (!atEdge && fn) fn(dx < 0 ? 'next' : 'prev');
      }
    }
  });
  sub.addEventListener('pointercancel', () => { swiping = false; moved = false; });
  sub.addEventListener('contextmenu', (e) => e.preventDefault());
}

function drawMainCross(meta, cross, colors, digits, period) {
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

  // 右端价格标签（主题色底 + 白字）
  const price = max - (cy / plotH) * (max - min);
  const priceTxt = price.toFixed(digits);
  ctx.font = '10px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const pw = ctx.measureText(priceTxt).width;
  const px = padL + plotW + 24, py = cy;
  ctx.fillStyle = colors.accent;
  roundRect(ctx, px - pw / 2 - 4, py - 8, pw + 8, 16, 3);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(priceTxt, px, py);

  // 底部时间标签（主题色底 + 白字）
  const timeTxt = fmtAxis(b.time, period);
  ctx.textAlign = 'center';
  const timeW = ctx.measureText(timeTxt).width;
  const tx = Math.max(padL + 4 + timeW / 2, Math.min(padL + plotW - 4 - timeW / 2, cx));
  const ty = plotH + 9;
  ctx.fillStyle = colors.accent;
  roundRect(ctx, tx - timeW / 2 - 4, ty - 7, timeW + 8, 14, 3);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(timeTxt, tx, ty);

  // OHLC 读数
  const up = b.close >= b.open;
  const col = up ? colors.red : colors.green;
  const txt =
    `${fmtAxis(b.time, period)}  开${b.open.toFixed(digits)} 高${b.high.toFixed(digits)} ` +
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

// 证券卡片分时图：实线价格走势 + 水平点线零轴（prevClose）
// opts.dayStart / opts.dayEnd 指定 x 轴交易日固定范围（如 9:30-15:00），不传则从 bars 推断
export function renderIntradayChart(canvas, bars, prevClose, opts = {}) {
  const colors = resolveColors();
  const parent = canvas.parentElement;
  const expanded = parent && parent.classList.contains('expanded');
  // 展开时直接用 CSS 最终高度 150px 绘制。若取动画过程中的 parent.clientHeight，
  // canvas 会先按中间高度渲染，容器展开完成后再跳变到最终高度，出现“展开后又变高一点”的顿挫。
  // 外部可传入 opts.height 指定固定高度。
  const cssH = opts.height || (expanded ? 150 : 80);
  const { ctx, w, h } = setupCanvas(canvas, cssH);
  ctx.clearRect(0, 0, w, h);

  const pc = Number(prevClose) || (bars && bars.length ? bars[0].close : 0);
  if (!pc) {
    ctx.fillStyle = colors.muted;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('暂无分时数据', w / 2, h / 2);
    return;
  }

  const padL = 8, padR = 8, padT = 6, padB = 6;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // x 轴：优先使用传入的交易日固定范围，否则按数据首尾自适应
  let dayStart, dayEnd;
  if (opts.dayStart && opts.dayEnd) {
    dayStart = opts.dayStart;
    dayEnd = opts.dayEnd;
  } else if (bars && bars.length) {
    dayStart = bars[0].time;
    dayEnd = bars[bars.length - 1].time;
  } else {
    dayStart = dayEnd = 0;
  }
  // x 轴映射：剔除中午休市 11:30-13:00，上午 9:30-11:30 与下午 13:00-15:00 拼接
  const morningEnd = dayStart + 2 * 3600;         // 11:30
  const afternoonStart = dayStart + 3.5 * 3600;   // 13:00
  const morningMinutes = 120, afternoonMinutes = 120;
  const totalMinutes = morningMinutes + afternoonMinutes;
  const xOfTime = (t) => {
    if (dayEnd === dayStart) return padL + plotW / 2;
    if (t <= morningEnd) {
      const ratio = Math.max(0, Math.min(1, (t - dayStart) / (morningEnd - dayStart)));
      return padL + (ratio * morningMinutes / totalMinutes) * plotW;
    }
    if (t >= afternoonStart) {
      const ratio = Math.max(0, Math.min(1, (t - afternoonStart) / (dayEnd - afternoonStart)));
      return padL + ((morningMinutes + ratio * afternoonMinutes) / totalMinutes) * plotW;
    }
    // 处于休市时段（不应出现），映射到上午末尾
    return padL + (morningMinutes / totalMinutes) * plotW;
  };

  // y 轴：覆盖实际价格范围与 prevClose，零轴根据行情自然落位
  let minP = pc, maxP = pc;
  if (bars && bars.length) {
    for (const b of bars) {
      minP = Math.min(minP, b.low);
      maxP = Math.max(maxP, b.high);
    }
  }
  const pad = (maxP - minP) * 0.08 || pc * 0.005 || 0.01;
  const yMin = minP - pad;
  const yMax = maxP + pad;
  const yOf = (p) => padT + (1 - (p - yMin) / (yMax - yMin)) * plotH;

  // 零轴水平点线
  ctx.strokeStyle = colors.muted;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  const y0 = yOf(pc);
  if (y0 >= padT - 1 && y0 <= padT + plotH + 1) {
    ctx.beginPath();
    ctx.moveTo(padL, y0);
    ctx.lineTo(padL + plotW, y0);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // 价格实线：当天未跌（收盘 ≥ 昨收）用红色，跌用绿色
  if (bars && bars.length) {
    const lastClose = bars[bars.length - 1].close;
    const isUp = lastClose >= pc;
    ctx.strokeStyle = isUp ? colors.red : colors.green;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    bars.forEach((b, i) => {
      const x = xOfTime(b.time);
      const y = yOf(b.close);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}
