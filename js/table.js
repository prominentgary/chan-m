import { formatPrice } from './fetcher.js?v=20260714y';

// table.js —— 段/中枢 的微信会话列表风格渲染（无图表）

function segCard(seg, idx, ctx, readonly, extraClass = '', reversed = false) {
  const st = seg._strength || { macdArea: 0, priceChangePct: 0, barCount: 0 };
  const dirUp = seg.direction === 'up';
  const color = dirUp ? 'var(--wx-red)' : 'var(--wx-green)';
  const avatarBg = dirUp ? 'var(--wx-red-soft)' : 'var(--wx-green-soft)';
  const avatarTxt = dirUp ? 'var(--wx-red)' : 'var(--wx-green)';
  const si = seg._strengthIndicator;
  const siColor = si === '力度减弱' ? 'var(--wx-green)' : 'var(--wx-red)';
  const siSoft = si === '力度减弱' ? 'var(--wx-green-soft)' : 'var(--wx-red-soft)';
  const siHtml = si
    ? `<span class="badge" style="background:${siSoft};color:${siColor};border:1px solid ${siColor}">${si}</span>`
    : '';
  const bsIsBuy = (seg._bsColor || '#07c160') === '#07c160';
  const bsColor = bsIsBuy ? 'var(--wx-green)' : 'var(--wx-red)';
  const bsSoft = bsIsBuy ? 'var(--wx-green-soft)' : 'var(--wx-red-soft)';
  const bs = seg._buySell
    ? `<span class="badge" style="background:${bsSoft};color:${bsColor};border:1px solid ${bsColor}">${seg._bsLabel || seg._buySell}</span>`
    : '';
  const pct = st.priceChangePct >= 0 ? `+${st.priceChangePct}%` : `${st.priceChangePct}%`;
  const maxArea = ctx.maxArea || 1;
  const w = Math.min(100, (Math.abs(st.macdArea) / maxArea) * 100);
  const macdAreaInt = Math.round(st.macdArea || 0);
  const watchBadge = seg._isWatch ? `
    <div class="watch-badge" aria-label="盯盘">
      <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    </div>
  ` : '';
  return `
  <div class="card ${extraClass}${seg._isWatch ? ' watch-card' : ''}" data-id="${seg.id}">
    ${watchBadge}
    <div class="card-avatar" style="background:${avatarBg};color:${avatarTxt}">${idx}</div>
    <div class="card-body">
      <div class="card-head">
        <div class="card-name">
          <span class="dir" style="color:${color}">${dirUp ? '上涨' : '下跌'}</span>
          <span class="pct" style="color:${color}">${pct}</span>
          ${bs}${siHtml}
        </div>
      </div>
      <div class="card-desc">
        ${reversed
          ? `<div class="point-row"><span class="point-label">终点</span> ${ctx.fmt(seg.end.time)} <span class="point-price">${formatPrice(ctx.code, seg.end.price)}</span></div>
        <div class="point-row"><span class="point-label">起点</span> ${ctx.fmt(seg.start.time)} <span class="point-price">${formatPrice(ctx.code, seg.start.price)}</span></div>`
          : `<div class="point-row"><span class="point-label">起点</span> ${ctx.fmt(seg.start.time)} <span class="point-price">${formatPrice(ctx.code, seg.start.price)}</span></div>
        <div class="point-row"><span class="point-label">终点</span> ${ctx.fmt(seg.end.time)} <span class="point-price">${formatPrice(ctx.code, seg.end.price)}</span></div>`}
      </div>
      <div class="strength">
        <div class="bar"><div class="bar-fill" style="width:${w}%;background:${color}"></div></div>
        <span class="strength-val">${macdAreaInt}</span>
      </div>
    </div>
  </div>`;
}

function zhongshuHeader(zs, zi, num, ctx) {
  const ids = zs.segmentIds || [];
  return `<div class="zs-title" data-zs-id="${zs.id}">中枢 ${num} · ${ids.length} 段</div>`;
}

export function renderSegments(container, segments, zhongshus, fmt, code = '', readonly = false, hideBefore = null) {
  let segs = [...segments];
  if (hideBefore != null) {
    segs = segs.filter((s) => (s.start?.time ?? s.end?.time ?? 0) >= hideBefore);
  }
  if (!segs.length) {
    container.innerHTML = `<div class="empty">暂无段</div>`;
    return;
  }
  const maxArea = Math.max(1, ...segs.map((s) => Math.abs((s._strength?.macdArea) || 0)));
  const ctx = { fmt, maxArea, code };

  const visibleIds = new Set(segs.map((s) => s.id));
  const zsArr = (zhongshus || [])
    .map((z) => ({ ...z, segmentIds: (z.segmentIds || []).filter((id) => visibleIds.has(id)) }))
    .filter((z) => z.segmentIds.length);
  const zsById = {};
  zsArr.forEach((z, zi) => z.segmentIds.forEach((id) => (zsById[id] = zi)));

  // 中枢按时间倒序编号：最近的中枢号最大（与段号“从远到近”一致）
  const segMap = {};
  segs.forEach((s) => { segMap[s.id] = s; });
  const zsCount = zsArr.length;
  const zsOrdered = [...zsArr]
    .map((z, idx) => {
      const zSegs = (z.segmentIds || []).map((id) => segMap[id]).filter(Boolean);
      const t = zSegs.reduce((m, s) => Math.max(m, s.end?.time ?? s.start?.time ?? 0), 0);
      return { idx, t };
    })
    .sort((a, b) => b.t - a.t);
  const zsNumber = {};
  zsOrdered.forEach((z, rank) => { zsNumber[z.idx] = zsCount - rank; });

  // 真实段序号（时间正序：最早 = 1 … 最新 = total），编号与排列顺序无关
  const byTimeAsc = [...segs].sort(
    (a, b) => (a.end?.time ?? a.start?.time) - (b.end?.time ?? b.start?.time)
  );
  const realIdx = {};
  byTimeAsc.forEach((s, k) => (realIdx[s.id] = k + 1));

  // 周期内第1段（整个段列表时间最早的段）决定整体排列方向：
  // 上涨 → 倒序（新在上，卡片内终点在上）；下跌 → 顺序（旧在上，卡片内起点在上）
  const firstSeg = byTimeAsc[0];
  const reversed = firstSeg.direction === 'up';

  // 单纯按时间顺序：从近期往远期（结束时间倒序）
  const sorted = [...segs].sort(
    (a, b) => (b.end?.time ?? b.start?.time) - (a.end?.time ?? a.start?.time)
  );
  // 整体按方向排列（注意：run 之间也需连续，故对整张列表反转，而非仅 run 内部）
  const ordered = reversed ? sorted : [...sorted].reverse();

  let html = '';
  let i = 0;
  while (i < ordered.length) {
    const cat = zsById[ordered[i].id]; // 中枢序号，或 undefined（普通段）
    // 收集连续同类段（同属一个中枢，或连续普通段）
    const run = [];
    let j = i;
    while (j < ordered.length && (zsById[ordered[j].id] ?? -1) === (cat ?? -1)) {
      run.push(ordered[j]);
      j++;
    }
    if (cat != null) {
      // 中枢：用「中枢框」样式圈出，内部段贴在一起；增加上下边缘拖动区供编辑模式使用
      const zsId = zsArr[cat].id;
      html += `<div class="zs-block" data-zs-id="${zsId}">
        <div class="zs-edge zs-edge-top" data-edge="top" aria-label="上边缘"></div>
        ${zhongshuHeader(zsArr[cat], cat, zsNumber[cat], ctx)}`;
      run.forEach((seg) => (html += segCard(seg, realIdx[seg.id], ctx, readonly, '', reversed)));
      html += `<div class="zs-edge zs-edge-bottom" data-edge="bottom" aria-label="下边缘"></div></div>`;
    } else {
      // 普通段：每张卡片独立、互不相连
      run.forEach((seg) => (html += segCard(seg, realIdx[seg.id], ctx, readonly, 'plain-card', reversed)));
    }
    i = j;
  }
  container.innerHTML = html;
}