import { formatPrice } from './fetcher.js?v=20260714y';

// table.js —— 段/中枢 的微信会话列表风格渲染（无图表）

function segCard(seg, idx, ctx, readonly, extraClass = '') {
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
  return `
  <div class="card ${extraClass}" data-id="${seg.id}">
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
        <div class="point-row"><span class="point-label">起点</span> ${ctx.fmt(seg.start.time)} <span class="point-price">${formatPrice(ctx.code, seg.start.price)}</span></div>
        <div class="point-row"><span class="point-label">终点</span> ${ctx.fmt(seg.end.time)} <span class="point-price">${formatPrice(ctx.code, seg.end.price)}</span></div>
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
  return `<div class="zs-title">中枢 ${num} · ${ids.length} 段</div>`;
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

  // 单纯按时间顺序：从近期往远期（结束时间倒序）
  const sorted = [...segs].sort(
    (a, b) => (b.end?.time ?? b.start?.time) - (a.end?.time ?? a.start?.time)
  );

  const total = sorted.length;
  let html = '';
  let pos = 0; // 0 = 最上方（最近）；编号从远到近：最上面=total，最下面=1
  let i = 0;
  while (i < sorted.length) {
    const cat = zsById[sorted[i].id]; // 中枢序号，或 undefined（普通段）
    // 收集连续同类段（同属一个中枢，或连续普通段）
    const run = [];
    let j = i;
    while (j < sorted.length && (zsById[sorted[j].id] ?? -1) === (cat ?? -1)) {
      run.push(sorted[j]);
      j++;
    }
    if (cat != null) {
      // 中枢：用「中枢框」样式圈出，内部段贴在一起
      html += `<div class="zs-block">${zhongshuHeader(zsArr[cat], cat, zsNumber[cat], ctx)}`;
      run.forEach((seg) => (html += segCard(seg, total - pos++, ctx, readonly)));
      html += `</div>`;
    } else {
      // 普通段：每张卡片独立、互不相连
      run.forEach((seg) => (html += segCard(seg, total - pos++, ctx, readonly, 'plain-card')));
    }
    i = j;
  }
  container.innerHTML = html;
}