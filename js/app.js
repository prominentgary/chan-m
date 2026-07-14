// app.js —— Chan-M 入口：一键导入站点全部画线，按「证券 → 周期」展示，联网算力
// 注意：所有 import 路径均带版本号，每次发布新版本时请同步修改 html/js/sw 中的版本号
import { fetchBars, fetchRealtimeMulti, formatTime, formatPrice } from './fetcher.js?v=20260714y';
import { computeMACD } from './macd.js?v=20260714y';
import { segmentStrength, detectDivergence, detectOneBuySell, detectTwoAndThreeBuySell, computeZhongshuStrength, extendZhongshus } from './algo.js?v=20260715e';
import { renderSegments } from './table.js?v=20260715c';
import { loadStaticData } from './sync.js?v=20260714y';
import { openEditor } from './editor.js?v=20260715z';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const PERIODS = [
  ['1m', '1分'], ['5m', '5分'], ['15m', '15分'], ['30m', '30分'], ['60m', '60分'],
  ['day', '日'], ['week', '周'],
];
const periodLabel = (p) => (PERIODS.find((x) => x[0] === p) || [p, p])[1];

// 返回当前周期在证券可用周期列表中的下一个更高级别周期
function getHigherPeriod(period, availablePeriods) {
  const idx = PERIODS.findIndex((x) => x[0] === period);
  if (idx < 0) return null;
  for (let i = idx + 1; i < PERIODS.length; i++) {
    if (availablePeriods.includes(PERIODS[i][0])) return PERIODS[i][0];
  }
  return null;
}

// 把当日内某个交易时间换算成距 9:30 的分钟数（已扣除午休）
function marketMinutesFrom930(t) {
  const dt = new Date(t * 1000);
  const hm = dt.getHours() * 60 + dt.getMinutes();
  if (hm < 13 * 60) return hm - (9 * 60 + 30);
  return (hm - 13 * 60) + 120;
}

// 给定目标时间 t（通常对应某根高周期 K 线的结束时间），返回该 K 线的开始时间
function periodBarStart(t, period) {
  if (period === 'day' || period === 'week' || period === 'month') {
    const dt = new Date(t * 1000);
    dt.setHours(0, 0, 0, 0);
    return Math.floor(dt.getTime() / 1000);
  }
  const minutes = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60 }[period];
  if (!minutes) return t;
  const mm = marketMinutesFrom930(t);
  if (mm <= 0) {
    const dt = new Date(t * 1000);
    dt.setHours(9, 30, 0, 0);
    return Math.floor(dt.getTime() / 1000);
  }
  const startMm = Math.floor((mm - 1) / minutes) * minutes;
  const startHm = startMm < 120
    ? (9 * 60 + 30) + startMm
    : 13 * 60 + (startMm - 120);
  const dt = new Date(t * 1000);
  dt.setHours(Math.floor(startHm / 60), startHm % 60, 0, 0);
  return Math.floor(dt.getTime() / 1000);
}

const STORE_KEY_PREFIX = 'chan-m-sec-';

// 行情页固定展示的大盘指数
const INDEX_CODES = [
  { code: 'sh000001', label: '上证指数' },
  { code: 'sz399001', label: '深证成指' },
  { code: 'sz399006', label: '创业板指' },
  { code: 'sh000688', label: '科创50' },
];

const state = {
  securities: [],
  selectedCode: null,
  selectedPeriod: null,
  view: 'list', // 'list' | 'periods' | 'detail'
  rtTimers: {},
  activeTab: 'dingpan',
  indexQuotes: {},
  _rtPrices: {},
  _currentBars: null,
  searchQuery: '',
};

function fmt(sec, period) { return formatTime(sec, period !== 'day'); }
function setStatus(t) { /* 顶部状态栏已移除，保留函数避免其它调用报错 */ }

// ========== 本地持久化 ==========
function secStoreKey(code) { return STORE_KEY_PREFIX + code; }

function loadLocalEdits(code) {
  try {
    const raw = localStorage.getItem(secStoreKey(code));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveLocalEdits(code, drawings) {
  try {
    localStorage.setItem(secStoreKey(code), JSON.stringify({ drawings, savedAt: Date.now() }));
  } catch {}
}

// 合并静态数据和本地编辑：取两者中较新的
function mergeDrawings(staticData, code) {
  const local = loadLocalEdits(code);
  if (!local || !staticData) return staticData || {};
  const result = {};
  const allPeriods = new Set([...Object.keys(staticData), ...Object.keys(local.drawings || {})]);
  for (const p of allPeriods) {
    const sd = staticData[p];
    const ld = (local.drawings || {})[p];
    if (!sd) { result[p] = ld; continue; }
    if (!ld) { result[p] = sd; continue; }
    const sdTime = sd.exportedAt || 0;
    const ldTime = local.savedAt || 0;
    result[p] = ldTime >= sdTime ? ld : sd;
  }
  return result;
}

// ========== 清单加载 ==========
async function loadManifest() {
  let res;
  try {
    res = await fetch('data/manifest.json?v=' + Date.now());
  } catch (e) {
    const hint = location.protocol === 'file:'
      ? '（当前为 file:// 协议，请通过 http:// 访问，或运行 start_chanm.bat）'
      : '（网络错误：' + (e.message || '未知') + '）';
    throw new Error('数据清单加载失败' + hint);
  }
  if (!res.ok) {
    throw new Error('数据清单不存在（HTTP ' + res.status + '），请先运行 PC 端导出');
  }
  const j = await res.json();
  if (!j || !Array.isArray(j.securities) || !j.securities.length) {
    throw new Error('数据清单为空，请先在 PC 端导出画线');
  }
  return j.securities;
}

async function loadAllDrawings() {
  setStatus('导入中…');
  try {
    const list = await loadManifest();
    const securities = [];
    let segTotal = 0;
    const errors = [];
    for (const s of list) {
      const staticDrawings = {};
      for (const p of s.periods) {
        const data = await loadStaticData(s.code, p);
        if (data && (data.segments || data.zhongshus)) {
          staticDrawings[p] = {
            segments: data.segments || [],
            zhongshus: data.zhongshus || [],
            exportedAt: data.exportedAt || 0,
          };
        } else {
          errors.push(`${s.code}_${p}.json`);
        }
      }
      const drawings = mergeDrawings(staticDrawings, s.code);
      for (const p of Object.keys(drawings)) {
        segTotal += (drawings[p].segments || []).length;
      }
      securities.push({ code: s.code, name: s.name || null, periods: s.periods, drawings });
    }
    state.securities = securities;
    renderDingpanView();
    startAllRealtime();
    let msg = `已导入 ${securities.length} 个证券 · ${segTotal} 段画线`;
    if (errors.length) msg += ` · ${errors.length} 个文件缺失`;
    setStatus(msg);
  } catch (e) {
    setStatus(e.message || '导入失败');
  }
}

// ========== 导航 ==========
function navigate(view, code = null, period = null) {
  state.view = view;
  state.selectedCode = code;
  state.selectedPeriod = period;
  renderDingpanView();
}

function renderDingpanView() {
  if (state.activeTab !== 'dingpan') return;
  if (state.view === 'list') renderSecurityList(state.searchQuery);
  else if (state.view === 'periods') renderPeriodList(state.selectedCode);
  else if (state.view === 'detail') renderPeriodDetail(state.selectedCode, state.selectedPeriod);
}

// ========== 证券列表渲染 ==========
function renderSecurityList(filterQuery = '') {
  const box = $('#sec-list');
  if (!state.securities.length) {
    box.innerHTML = '<div class="empty">暂无画线数据，请先在 PC 端导出</div>';
    return;
  }
  const q = String(filterQuery || '').trim().toLowerCase();
  const filtered = state.securities.filter((sec) => {
    if (!q) return true;
    const rt = state._rtPrices?.[sec.code];
    const name = String(sec.name || rt?.name || '').toLowerCase();
    return sec.code.toLowerCase().includes(q) || name.includes(q);
  });
  if (!filtered.length) {
    box.innerHTML = '<div class="empty">未找到匹配的证券</div>';
    return;
  }
  box.innerHTML = filtered.map((sec) => {
    const rt = state._rtPrices?.[sec.code];
    const name = sec.name || rt?.name || sec.code;
    const change = fmtIndexChange(rt?.price, rt?.prevClose);
    const priceText = rt?.price ? formatPrice(sec.code, rt.price) : '';
    const periodTags = sec.periods.map((p) => periodLabel(p)).join('/');
    const displayCode = sec.code.toUpperCase();
    return `
    <div class="sec-card" data-code="${sec.code}">
      <div class="sec-head">
        <div class="sec-info">
          <div class="sec-name" data-name="${sec.code}">${name}</div>
          <div class="sec-meta">${displayCode} · ${periodTags}</div>
        </div>
        <div class="sec-right">
          <div class="sec-quote" data-rt="${sec.code}">
            <div class="sec-price">${priceText}</div>
            <div class="sec-change ${change.cls}">${change.text}</div>
          </div>
          <span class="sec-arrow">▸</span>
        </div>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('.sec-card').forEach((card) => {
    card.addEventListener('click', () => navigate('periods', card.dataset.code));
  });
}

// 监听证券头部吸顶状态：吸顶后切换为紧凑一行布局
function watchStickyCompact(header) {
  if (!header) return;
  const HEADER_HEIGHT = 48;
  let ticking = false;
  function update() {
    const rect = header.getBoundingClientRect();
    header.classList.toggle('compact', rect.top <= HEADER_HEIGHT);
    ticking = false;
  }
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  update();
}

// ========== 周期列表渲染 ==========
function renderPeriodList(code) {
  const box = $('#sec-list');
  const sec = state.securities.find((s) => s.code === code);
  if (!sec) { navigate('list'); return; }
  const rt = state._rtPrices?.[code];
  const name = sec.name || rt?.name || code;
  const displayCode = sec.code.toUpperCase();
  const rows = sec.periods.map((p) => {
    const d = sec.drawings[p] || { segments: [], zhongshus: [] };
    const segCount = d.segments?.length || 0;
    const zsCount = d.zhongshus?.length || 0;
    return `
    <div class="period-row" data-period="${p}">
      <div class="period-row-info">
        <div class="period-row-name">${periodLabel(p)}</div>
        <div class="period-row-meta">${segCount} 段 · ${zsCount} 中枢</div>
      </div>
      <span class="sec-arrow">▸</span>
    </div>`;
  }).join('');
  box.innerHTML = `
    <div class="sec-header">
      <div class="sec-name" data-name="${code}">${name}</div>
      <div class="sec-meta">${displayCode} · ${sec.periods.length} 周期</div>
    </div>
    <div class="period-list">${rows}</div>
    <div class="nav-back nav-back-bottom" data-back="list">← 返回证券列表</div>
  `;
  const backBtn = box.querySelector('[data-back="list"]');
  if (backBtn) backBtn.addEventListener('click', () => navigate('list'));
  box.querySelectorAll('.period-row').forEach((row) => {
    row.addEventListener('click', () => navigate('detail', code, row.dataset.period));
  });
  watchStickyCompact(box.querySelector('.sec-header'));
}

// ========== 周期详情渲染 ==========
async function renderPeriodDetail(code, period) {
  const box = $('#sec-list');
  const sec = state.securities.find((s) => s.code === code);
  if (!sec) { navigate('list'); return; }
  const rt = state._rtPrices?.[code];
  const name = sec.name || rt?.name || code;
  const displayCode = sec.code.toUpperCase();
  box.innerHTML = `
    <div class="sec-header">
      <div class="sec-name" data-name="${code}">${name}</div>
      <div class="header-right">
        <div class="sec-meta">${displayCode} · ${periodLabel(period)}</div>
        <button class="add-seg-btn" aria-label="添加段">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>
    </div>
    <div id="period-detail"><div class="empty">加载中…</div></div>
    <div class="nav-back nav-back-bottom" data-back="periods">← 返回周期列表</div>
  `;
  const backBtn = box.querySelector('[data-back="periods"]');
  if (backBtn) backBtn.addEventListener('click', () => navigate('periods', code));
  const addBtn = box.querySelector('.add-seg-btn');
  if (addBtn) addBtn.addEventListener('click', () => addSegment(code, period));
  watchStickyCompact(box.querySelector('.sec-header'));
  await loadAndRenderPeriodDetail(code, period);
}

async function loadAndRenderPeriodDetail(code, period) {
  const sec = state.securities.find((s) => s.code === code);
  const detail = $('#period-detail');
  if (!sec || !detail) return;
  const d = sec.drawings[period] || { segments: [], zhongshus: [] };
  const group = { period, label: periodLabel(period), segments: [...d.segments], zhongshus: [...d.zhongshus], loaded: false, error: null };

  // 更高周期最后一段起点：用于在低级别周期隐藏过早的段卡片
  const higherPeriod = getHigherPeriod(period, sec.periods || []);
  const higherSegments = (higherPeriod && sec.drawings[higherPeriod]?.segments) || [];
  const higherLastStart = higherSegments.length
    ? Math.max(...higherSegments.map((s) => s.start?.time ?? 0))
    : null;

  try {
    const curRes = await fetchBars(code, period, 400);
    const bars = curRes.bars || [];
    state._currentBars = { code, period, bars };
    computeMACD(bars);
    computeStrengths(bars, group.segments, group.zhongshus);
    group.loaded = true;
    const hideBefore = higherLastStart != null ? periodBarStart(higherLastStart, higherPeriod) : null;
    if (!$('#period-detail')) return;
    renderSinglePeriodDetail(detail, code, group, hideBefore);
  } catch (err) {
    group.error = (err && err.message) || '加载失败';
    if (!$('#period-detail')) return;
    renderSinglePeriodDetail(detail, code, group, null);
  }
}

function renderSinglePeriodDetail(detail, code, g, hideBefore = null) {
  detail.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'period-title';
  let label = g.label;
  if (g.error) label += ' · 加载失败';
  else if (!g.loaded) label += ' · 加载中…';
  header.textContent = label;
  if (g.error) {
    const retry = document.createElement('button');
    retry.className = 'mini retry-btn';
    retry.textContent = '重试';
    retry.style.cssText = 'margin-left:8px;font-size:11px;padding:2px 8px;';
    retry.onclick = (e) => { e.stopPropagation(); loadAndRenderPeriodDetail(state.selectedCode, g.period); };
    header.appendChild(retry);
  }
  detail.appendChild(header);
  if (g.loaded || g.error) {
    renderSegments(detail, g.segments || [], g.zhongshus || [], (t) => fmt(t, g.period), code, false, hideBefore);
  }
}

// ========== 实时行情 ==========
function startAllRealtime() {
  // 清理证券实时行情定时器，保留大盘指数定时器
  Object.entries(state.rtTimers).forEach(([key, timer]) => {
    if (key !== '_index') clearInterval(timer);
  });
  const indexTimer = state.rtTimers._index;
  state.rtTimers = indexTimer ? { _index: indexTimer } : {};
  state._rtPrices = {};
  const codes = state.securities.map((s) => s.code);
  if (!codes.length) return;

  const tick = async () => {
    try {
      const results = await fetchRealtimeMulti(codes);
      state._rtPrices = results;
      for (const code of Object.keys(results)) {
        const quoteEl = document.querySelector(`.sec-quote[data-rt="${code}"]`);
        if (quoteEl) {
          const r = results[code];
          const change = fmtIndexChange(r.price, r.prevClose);
          quoteEl.innerHTML = `<div class="sec-price">${r.price ? formatPrice(code, r.price) : ''}</div><div class="sec-change ${change.cls}">${change.text}</div>`;
        }
        const nameEl = document.querySelector(`[data-name="${code}"]`);
        const sec = state.securities.find((s) => s.code === code);
        if (nameEl && results[code].name && !(sec && sec.name)) nameEl.textContent = results[code].name;
      }
    } catch {}
  };
  tick();
  state.rtTimers._all = setInterval(tick, 5000);
}

// ========== 大盘指数行情 ==========
function fmtIndexChange(price, prevClose) {
  if (!prevClose || prevClose <= 0 || !Number.isFinite(price)) return { text: '—', cls: '' };
  const change = price - prevClose;
  const pct = (change / prevClose) * 100;
  const sign = change > 0 ? '+' : '';
  return {
    text: `${sign}${pct.toFixed(2)}%`,
    cls: change > 0 ? 'up' : change < 0 ? 'down' : '',
  };
}

async function refreshIndexQuotes() {
  try {
    const codes = INDEX_CODES.map((i) => i.code);
    const results = await fetchRealtimeMulti(codes);
    state.indexQuotes = results || {};
    renderHangqingView();
  } catch {}
}

function startIndexRealtime() {
  if (state.rtTimers._index) return;
  refreshIndexQuotes();
  state.rtTimers._index = setInterval(refreshIndexQuotes, 5000);
}

// ========== 算力 ==========
function computeStrengths(bars, segments, zhongshus) {
  extendZhongshus(segments, zhongshus); // 先补全中枢延伸段（移动端自行计算）
  const sorted = [...segments].sort((a, b) => a.start.time - b.start.time);
  let prevDir = null;
  sorted.forEach((s) => {
    s._strength = segmentStrength(bars, s, prevDir);
    if (s.direction !== 'horizontal') prevDir = s.direction;
  });
  computeZhongshuStrength(bars, segments, zhongshus);
  detectOneBuySell(segments, zhongshus);
  detectTwoAndThreeBuySell(segments, zhongshus);
  const last = { up: null, down: null };
  sorted.forEach((s) => {
    const prev = last[s.direction];
    s._divergence = prev ? detectDivergence(prev, s) : null;
    last[s.direction] = s;
  });
}

// ========== 新增段 ==========
function priceAtTime(bars, t) {
  if (!bars || !bars.length) return null;
  let nearest = bars[0];
  let min = Math.abs(bars[0].time - t);
  for (const b of bars) {
    const d = Math.abs(b.time - t);
    if (d < min) { min = d; nearest = b; }
  }
  return nearest.close;
}

async function ensureBars(code, period) {
  if (state._currentBars && state._currentBars.code === code && state._currentBars.period === period) {
    return state._currentBars.bars;
  }
  const res = await fetchBars(code, period, 400);
  const bars = res.bars || [];
  state._currentBars = { code, period, bars };
  return bars;
}

function oppositeDirection(dir) {
  return dir === 'up' ? 'down' : 'up';
}

async function addSegment(code, period) {
  const sec = state.securities.find((s) => s.code === code);
  if (!sec) return;
  let bars;
  try {
    bars = await ensureBars(code, period);
  } catch (e) {
    alert('行情数据加载失败，请检查网络后重试');
    return;
  }
  const d = sec.drawings[period] || { segments: [], zhongshus: [] };
  const segs = d.segments || [];
  const prevSeg = segs.length
    ? [...segs].sort((a, b) => (b.end?.time ?? b.start?.time) - (a.end?.time ?? a.start?.time))[0]
    : null;
  const now = Math.floor(Date.now() / 1000);
  const defaults = {
    startTime: prevSeg ? prevSeg.end.time : now - 3600,
    endTime: now,
  };
  openEditor(null, (startTime, endTime) => {
    if (endTime <= startTime) { alert('终点必须晚于起点'); return; }
    const sPrice = priceAtTime(bars, startTime) || 0;
    const ePrice = priceAtTime(bars, endTime) || 0;
    const direction = prevSeg
      ? oppositeDirection(prevSeg.direction)
      : (ePrice >= sPrice ? 'up' : 'down');
    const seg = {
      id: 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      kind: 'segment',
      period,
      direction,
      start: { time: startTime, price: sPrice },
      end: { time: endTime, price: ePrice },
    };
    d.segments = [...segs, seg];
    sec.drawings[period] = d;
    saveLocalEdits(code, sec.drawings);
    loadAndRenderPeriodDetail(code, period);
  }, defaults);
}

// ========== 段编辑与删除 ==========
function onDetailAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  e.stopPropagation();
  const act = btn.dataset.act;
  const segId = btn.dataset.id;
  const code = state.selectedCode;
  const period = state.selectedPeriod;
  if (!code || !period) return;
  const sec = state.securities.find((s) => s.code === code);
  if (!sec) return;
  const d = sec.drawings[period];
  if (!d) return;
  const targetSeg = (d.segments || []).find((s) => s.id === segId);
  if (!targetSeg) return;

  if (act === 'edit') {
    openEditor(targetSeg, (newStart, newEnd) => {
      targetSeg.start.time = newStart;
      targetSeg.end.time = newEnd;
      targetSeg.direction = targetSeg.end.price >= targetSeg.start.price ? 'up' : 'down';
      saveLocalEdits(code, sec.drawings);
      loadAndRenderPeriodDetail(code, period);
    });
  } else if (act === 'del') {
    if (!confirm('确定删除此段？')) return;
    d.segments = d.segments.filter((s) => s.id !== segId);
    (d.zhongshus || []).forEach((z) => {
      z.segmentIds = (z.segmentIds || []).filter((id) => id !== segId);
    });
    d.zhongshus = (d.zhongshus || []).filter((z) => (z.segmentIds || []).length >= 3);
    saveLocalEdits(code, sec.drawings);
    loadAndRenderPeriodDetail(code, period);
  }
}

// ========== Tab 切换 ==========
function switchTab(name) {
  state.activeTab = name;
  $$('.wx-tab').forEach((t) => t.classList.remove('active'));
  const tabEl = document.querySelector(`.wx-tab[data-tab="${name}"]`);
  if (tabEl) tabEl.classList.add('active');

  const views = {
    dingpan: '#sec-list',
    hangqing: '#hangqing-view',
    bianji: '#bianji-view',
    workbench: '#workbench-view',
    wo: '#wo-view',
  };
  Object.entries(views).forEach(([key, sel]) => {
    const el = document.querySelector(sel);
    if (el) el.style.display = key === name ? '' : 'none';
  });

  if (name === 'dingpan') renderDingpanView();
  if (name === 'hangqing') { renderHangqingView(); startIndexRealtime(); }
  if (name === 'bianji') renderBianjiView();
  if (name === 'workbench') renderWorkbenchView();
  if (name === 'wo') renderWoView();
}

function renderHangqingView() {
  const el = $('#hangqing-view');
  if (!el) return;

  const cards = INDEX_CODES.map((idx) => {
    const rt = state.indexQuotes[idx.code];
    const price = rt?.price ? rt.price.toFixed(2) : '—';
    const change = fmtIndexChange(rt?.price, rt?.prevClose);
    return `
      <div class='index-card'>
        <div class='index-main'>
          <div class='index-name'>${idx.label}</div>
          <div class='index-code'>${idx.code}</div>
        </div>
        <div class='index-data'>
          <div class='index-price'>${price}</div>
          <div class='index-change ${change.cls}'>${change.text}</div>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `<div class='index-grid'>${cards}</div>`;
}

function renderBianjiView() {
  const el = $('#bianji-view');
  if (!el) return;
  el.innerHTML = `
    <div class="bianji-content">
      <h3>段编辑</h3>
      <p class="empty">进入证券周期详情后，点击段卡片中的「编辑端点」或「删除」按钮进行操作。</p>
      <h3>添加段</h3>
      <p class="empty">点击下方按钮，手动添加一个段。</p>
      <div style="padding:12px;display:flex;gap:8px;">
        <button id="btn-add-seg" class="mini" style="flex:1;">添加段</button>
      </div>
    </div>`;
  $('#btn-add-seg').onclick = () => {
    if (!state.selectedCode) { alert('请先在盯盘页选择一个证券'); return; }
    const sec = state.securities.find((s) => s.code === state.selectedCode);
    if (!sec) return;
    const firstPeriod = sec.periods?.[0] || '1m';
    openEditor(null, (newStart, newEnd) => {
      const d = sec.drawings[firstPeriod] || { segments: [], zhongshus: [] };
      const seg = {
        id: 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        kind: 'segment',
        period: firstPeriod,
        direction: 0,
        start: { time: newStart, price: 0 },
        end: { time: newEnd, price: 0 },
      };
      seg.direction = seg.end.price >= seg.start.price ? 'up' : 'down';
      d.segments = [...(d.segments || []), seg];
      sec.drawings[firstPeriod] = d;
      saveLocalEdits(state.selectedCode, sec.drawings);
      switchTab('dingpan');
      navigate('detail', state.selectedCode, firstPeriod);
    });
  };
}

function renderWorkbenchView() {
  const el = $('#workbench-view');
  if (!el) return;
  if (!state.securities.length) {
    el.innerHTML = '<div class="empty">请先加载画线数据</div>';
    return;
  }
  let totalSegs = 0, totalZs = 0;
  let bsCount = 0;
  state.securities.forEach((sec) => {
    Object.values(sec.drawings).forEach((d) => {
      totalSegs += (d.segments || []).length;
      totalZs += (d.zhongshus || []).length;
      (d.segments || []).forEach((s) => { if (s._buySell) bsCount++; });
    });
  });
  el.innerHTML = `
    <div class="wx-list">
      <div class="zs-block">
        <div class="zs-title">数据概览</div>
        <div class="card">
          <div class="card-body">
            <div class="card-desc">证券：${state.securities.length} 只</div>
            <div class="card-desc">段：${totalSegs} 条</div>
            <div class="card-desc">中枢：${totalZs} 个</div>
            <div class="card-desc">买卖点：${bsCount} 个</div>
          </div>
        </div>
      </div>
      <div class="zs-block">
        <div class="zs-title">导出</div>
        <div class="card">
          <div class="card-body">
            <div class="card-desc">将所有修改导出为 JSON 文件，可回传桌面端</div>
            <div class="card-actions">
              <button class="mini" id="btn-export-all">导出全部</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  $('#btn-export-all').onclick = () => {
    const all = state.securities.map((sec) => ({
      code: sec.code,
      drawings: sec.drawings,
    }));
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chan-m-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

function renderWoView() {
  const el = $('#wo-view');
  if (!el) return;
  el.innerHTML = `
    <div class="wx-list">
      <div class="zs-block">
        <div class="zs-title">关于 Chan-M</div>
        <div class="card">
          <div class="card-body">
            <div class="card-desc">手机端缠论盯盘工具</div>
            <div class="card-desc">数据源：腾讯财经</div>
            <div class="card-desc">画线数据：从桌面端 Chan 导出</div>
          </div>
        </div>
      </div>
      <div class="zs-block">
        <div class="zs-title">数据管理</div>
        <div class="card">
          <div class="card-body">
            <div class="card-desc">清除所有本地编辑数据</div>
            <div class="card-actions">
              <button class="mini danger" id="btn-clear-all">清除本地数据</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  $('#btn-clear-all').onclick = () => {
    if (!confirm('确定清除所有本地编辑数据？静态数据不会受影响。')) return;
    state.securities.forEach((sec) => {
      localStorage.removeItem(secStoreKey(sec.code));
    });
    alert('已清除，请重新加载。');
    location.reload();
  };
}

// ========== 搜索 ==========
function onSearchInput(e) {
  state.searchQuery = e.target.value;
  if (state.view !== 'list') navigate('list');
  renderSecurityList(state.searchQuery);
}

// ========== 初始化 ==========
function init() {
  $('#sec-list').addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-act]');
    if (actionBtn) { onDetailAction(e); }
  });

  $$('.wx-tab').forEach((tab) => {
    const name = tab.dataset.tab || '';
    tab.addEventListener('click', () => switchTab(name));
  });

  const searchInput = $('#search-input');
  if (searchInput) {
    let isComposing = false;
    searchInput.addEventListener('compositionstart', () => { isComposing = true; });
    searchInput.addEventListener('compositionend', () => { isComposing = false; onSearchInput({ target: searchInput }); });
    searchInput.addEventListener('input', () => { if (!isComposing) onSearchInput({ target: searchInput }); });
  }

  switchTab('dingpan');
  startIndexRealtime();

  // 自动加载画线数据（file:// 模式下跳过）
  if (location.protocol !== 'file:') {
    loadAllDrawings();
  }

  if ('serviceWorker' in navigator && !window.__CHANM_NOCACHE__) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js?v=20260715b').catch(() => {}));
  }

  window.__CHANM_LOADED__ = true;
}

init();
window.navigate = navigate;
