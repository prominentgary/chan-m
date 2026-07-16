// app.js —— Chan-M 入口：一键导入站点全部画线，按「证券 → 周期」展示，联网算力
// 注意：所有 import 路径均带版本号，每次发布新版本时请同步修改 html/js/sw 中的版本号
import { fetchBars, fetchRealtimeMulti, formatTime, formatPrice } from './fetcher.js?v=20260714y';
import { computeMACD } from './macd.js?v=20260714y';
import { segmentStrength, detectDivergence, detectOneBuySell, detectTwoAndThreeBuySell, computeZhongshuStrength, extendZhongshus } from './algo.js?v=20260715e';
import { renderSegments } from './table.js?v=20260715d';
import { renderMiniChart } from './minichart.js?v=20260717b';
import { loadStaticData } from './sync.js?v=20260714y';
import { openEditor } from './editor.js?v=20260715z';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const PERIODS = [
  ['1m', '1分'], ['5m', '5分'], ['15m', '15分'], ['30m', '30分'], ['60m', '60分'],
  ['day', '日'], ['week', '周'],
];
const periodLabel = (p) => (PERIODS.find((x) => x[0] === p) || [p, p])[1];

let longPressFired = false; // 周期行长按触发简图后，吞掉随后冒泡的 click，避免误进段详情

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

// 计算低级别周期的 hideBefore：优先用更高周期中时间上最新的一段（end 最大），
// 以其终点对齐到更高周期 K 线起点，使低周期图聚焦到「最新一段覆盖的交易日」。
// 安全回退：若更高周期数据比当前周期段更新（如 30m 末段 end 晚于 5m 末段 start），
// 纯按 end 对齐会把当前周期图清空，此时退回旧逻辑——用更高周期所有段的 max(start) 对齐，
// 保留更多历史段（例如 5m 图从 30m 起点起显示，而非变空或只剩 1 段）。
function computeHideBefore(higherSegments, higherPeriod, curSegments) {
  if (!higherPeriod || !higherSegments || !higherSegments.length) return null;
  let lastEnd = 0, maxStart = 0;
  for (const s of higherSegments) {
    const e = s.end?.time ?? s.start?.time ?? 0;
    const st = s.start?.time ?? s.end?.time ?? 0;
    if (e > lastEnd) lastEnd = e;
    if (st > maxStart) maxStart = st;
  }
  const hbEnd = lastEnd ? periodBarStart(lastEnd, higherPeriod) : null;
  if (hbEnd != null && curSegments && curSegments.length) {
    let curLastStart = 0;
    for (const s of curSegments) {
      const st = s.start?.time ?? s.end?.time ?? 0;
      if (st > curLastStart) curLastStart = st;
    }
    if (hbEnd > curLastStart) return maxStart ? periodBarStart(maxStart, higherPeriod) : hbEnd;
  }
  return hbEnd;
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
  editMode: false, // 段详情页是否处于「编辑」模式（显示卡片编辑/删除按钮）
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
// navigate 仅负责渲染，不写历史；历史由 pushView / goBack 管理（供系统返回键 & 手势使用）
function navigate(view, code = null, period = null) {
  state.view = view;
  state.selectedCode = code;
  state.selectedPeriod = period;
  updateHeaderBack();
  renderDingpanView();
}

// 进入周期列表/段列表时，在顶部「Chan-M」行左端显示返回图标（<）
function updateHeaderBack() {
  const backBtn = document.getElementById('btn-header-back');
  if (!backBtn) return;
  const show = state.view === 'periods' || state.view === 'detail';
  backBtn.hidden = !show;
}

const VIEW_DEPTH = { list: 0, periods: 1, detail: 2 };

// 前进到更深视图并写入历史记录（从列表进入周期、从周期进入详情）
function pushView(view, code = null, period = null) {
  const curDepth = VIEW_DEPTH[state.view] ?? 0;
  const newDepth = VIEW_DEPTH[view] ?? 0;
  navigate(view, code, period);
  if (newDepth > curDepth) history.pushState({ chanmView: view, code, period }, '');
  else if (newDepth < curDepth) history.back();
  else history.replaceState({ chanmView: view, code, period }, '');
}

// 计算上一级视图（基于当前 state，避免依赖历史栈深度）
function backTarget() {
  if (state.view === 'detail') return ['periods', state.selectedCode, state.selectedPeriod];
  if (state.view === 'periods') return ['list', null, null];
  return null;
}

function doBack() {
  const t = backTarget();
  if (t) navigate(t[0], t[1], t[2]);
  return !!t;
}

// 去重锁：安卓一次滑动可能同时触发「应用内手势」与「系统返回手势」，
// 二者都走 goBack/popstate，用 350ms 内的锁合并为一次返回，避免连跳两级。
let lastBackAt = 0;

// 返回上一级：手势、底部返回按钮、安卓/桌面硬件返回键 的统一入口
function goBack() {
  const t = backTarget();
  if (!t) return; // 已在根列表，不拦截，让系统返回（退出/最小化）生效
  if (history.state && history.state.chanmView) {
    lastBackAt = Date.now();
    doBack();        // 立即渲染上一级（提供跟手动画后的即时反馈）
    history.back();  // 同步历史；随后的 popstate 会被去重跳过
  } else {
    doBack();
  }
}
window.goBack = goBack;

// 系统/浏览器返回键：popstate 渲染对应视图；与应用内手势去重
window.addEventListener('popstate', (e) => {
  if (Date.now() - lastBackAt < 350) { lastBackAt = Date.now(); return; }
  lastBackAt = Date.now();
  const s = e.state || {};
  if (s.chanmView) navigate(s.chanmView, s.code, s.period);
  else navigate('list');
});

// ========== 卡片进出场动画 ==========
const STAGGER = 45; // 相邻卡片的进入延迟(ms)
let listEnterPlayed = false; // 根列表首次加载的进入动画只播一次

// 卡片自上而下依次进入（右移淡入）
function staggerEnter(root, selector) {
  if (!root) return;
  const items = root.querySelectorAll(selector);
  if (!items.length) return;
  items.forEach((el) => el.classList.add('anim-item', 'in-start'));
  void root.offsetWidth; // 强制回流，固定起始态，避免与进入动画冲突
  requestAnimationFrame(() => requestAnimationFrame(() => {
    items.forEach((el, i) => {
      el.style.transitionDelay = (i * STAGGER) + 'ms';
      el.classList.remove('in-start');
    });
  }));
}

// 返回时卡片自上而下依次左移淡出，结束后执行 goBack
function animateBack() {
  const b = document.getElementById('sec-list');
  if (!b) { if (window.goBack) window.goBack(); return; }
  const items = b.querySelectorAll('.period-row, .period-title, .plain-card, .zs-block');
  if (!items.length) { if (window.goBack) window.goBack(); return; }
  items.forEach((el, i) => {
    el.classList.add('anim-item', 'out');
    el.style.transitionDelay = (i * 40) + 'ms';
  });
  const total = items.length * 40 + 340;
  setTimeout(() => { if (window.goBack) window.goBack(); }, total);
}
window.animateBack = animateBack;

// 每次渲染盯盘视图前，清掉上一视图遗留的容器位移/阴影/动画类
function resetContainer() {
  const b = document.getElementById('sec-list');
  if (!b) return;
  b.style.transform = '';
  b.style.transition = '';
  b.style.boxShadow = '';
  b.classList.remove('swiping');
}

function renderDingpanView() {
  resetContainer();
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
    card.addEventListener('click', () => pushView('periods', card.dataset.code));
  });
  // 仅在首次加载时播一次卡片依次进入动画（搜索/重渲染不再重复）
  if (!listEnterPlayed) {
    listEnterPlayed = true;
    staggerEnter(box, '.sec-card');
  }
}

// 监听证券头部吸顶状态：下滚后为紧凑一行布局，未下滚为展开两行布局
function watchStickyCompact(header) {
  if (!header) return;
  let ticking = false;
  function update() {
    header.classList.toggle('compact', window.scrollY > 0);
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

// 与详情页一致的可见段/中枢计数：剔除被更高级别周期遮挡的隐藏段、隐藏中枢
function countVisible(sec, period) {
  const d = sec.drawings[period] || { segments: [], zhongshus: [] };
  const segments = d.segments || [];
  const zhongshus = d.zhongshus || [];
  const higherPeriod = getHigherPeriod(period, sec.periods || []);
  const higherSegments = (higherPeriod && sec.drawings[higherPeriod]?.segments) || [];
  const hideBefore = computeHideBefore(higherSegments, higherPeriod, segments);
  let visibleSegs = segments;
  if (hideBefore != null) {
    visibleSegs = segments.filter((s) => (s.start?.time ?? s.end?.time ?? 0) >= hideBefore);
  }
  const visibleIds = new Set(visibleSegs.map((s) => s.id));
  const visibleZs = (zhongshus || []).filter((z) => (z.segmentIds || []).some((id) => visibleIds.has(id)));
  return { segCount: visibleSegs.length, zsCount: visibleZs.length };
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
    const { segCount, zsCount } = countVisible(sec, p);
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
  if (backBtn) backBtn.addEventListener('click', () => animateBack());
  box.querySelectorAll('.period-row').forEach((row) => {
    const p = row.dataset.period;
    row.addEventListener('click', () => {
      if (longPressFired) { longPressFired = false; return; } // 长按已触发简图，吞掉随后的 click
      pushView('detail', code, p);
    });
    attachPeriodRowLongPress(row, code, p);
  });
  watchStickyCompact(box.querySelector('.sec-header'));
  staggerEnter(box, '.period-row');
}

// ========== 长按周期行 → 宽简图（底部抽屉） ==========
function openMiniSheet(code, period) {
  const sec = state.securities.find((s) => s.code === code);
  if (!sec) return;
  const rt = state._rtPrices?.[code];
  const name = sec.name || rt?.name || code;
  const d = sec.drawings[period] || { segments: [], zhongshus: [] };

  // 复用与详情页一致的 hideBefore 过滤，保证简图段集合与段卡片一致
  const higherPeriod = getHigherPeriod(period, sec.periods || []);
  const higherSegments = (higherPeriod && sec.drawings[higherPeriod]?.segments) || [];
  const hideBefore = computeHideBefore(higherSegments, higherPeriod, d.segments);
  let segs = [...(d.segments || [])];
  if (hideBefore != null) segs = segs.filter((s) => (s.start?.time ?? s.end?.time ?? 0) >= hideBefore);
  const visibleIds = new Set(segs.map((s) => s.id));
  const zss = (d.zhongshus || []).filter((z) => (z.segmentIds || []).some((id) => visibleIds.has(id)));

  let backdrop = document.getElementById('mini-sheet-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'mini-sheet-backdrop';
    backdrop.className = 'mini-sheet-backdrop';
    backdrop.addEventListener('click', closeMiniSheet);
    document.body.appendChild(backdrop);

    const sheet = document.createElement('div');
    sheet.id = 'mini-sheet';
    sheet.className = 'mini-sheet';
    sheet.innerHTML = `
      <div class="mini-sheet-head">
        <span class="mini-sheet-title" id="mini-sheet-title"></span>
        <button class="mini-sheet-close" id="mini-sheet-close" type="button" aria-label="关闭">✕</button>
      </div>
      <div class="mini-sheet-body" id="mini-sheet-body"></div>`;
    document.body.appendChild(sheet);
    document.getElementById('mini-sheet-close').addEventListener('click', closeMiniSheet);
  }

  document.getElementById('mini-sheet-title').textContent =
    `${name} · ${periodLabel(period)} · ${segs.length} 段 · ${zss.length} 中枢`;
  const body = document.getElementById('mini-sheet-body');
  renderMiniChart(body, segs, zss, { height: 210 });
  backdrop.classList.add('show');
  document.getElementById('mini-sheet').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeMiniSheet() {
  const backdrop = document.getElementById('mini-sheet-backdrop');
  const sheet = document.getElementById('mini-sheet');
  if (backdrop) backdrop.classList.remove('show');
  if (sheet) sheet.classList.remove('show');
  document.body.style.overflow = '';
}

// 长按周期行：按住 480ms 直接下拉出宽简图；移动超过 10px 视为滑动/滚动，取消
function attachPeriodRowLongPress(row, code, period) {
  let timer = null;
  let sx = 0, sy = 0;
  const LONG_MS = 480;
  const start = (x, y) => {
    longPressFired = false;
    sx = x; sy = y;
    timer = setTimeout(() => {
      longPressFired = true;
      openMiniSheet(code, period);
    }, LONG_MS);
  };
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  row.addEventListener('pointerdown', (e) => { start(e.clientX, e.clientY); });
  row.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) cancel();
  });
  row.addEventListener('pointerup', cancel);
  row.addEventListener('pointercancel', cancel);
  row.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ========== 周期详情渲染 ==========
async function renderPeriodDetail(code, period) {
  state.editMode = false;
  const box = $('#sec-list');
  const sec = state.securities.find((s) => s.code === code);
  if (!sec) { navigate('list'); return; }
  const rt = state._rtPrices?.[code];
  const name = sec.name || rt?.name || code;
  const displayCode = sec.code.toUpperCase();
  box.innerHTML = `
    <div class="sec-header">
      <div class="sec-head-main">
        <div class="sec-name" data-name="${code}">${name}</div>
        <div class="sec-meta">${displayCode} · ${periodLabel(period)}</div>
      </div>
      <div class="sec-header-actions">
        <button class="edit-seg-btn" type="button" aria-label="编辑段">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9"></path>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
          </svg>
        </button>
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
  if (backBtn) backBtn.addEventListener('click', () => animateBack());
  const addBtn = box.querySelector('.add-seg-btn');
  if (addBtn) addBtn.addEventListener('click', () => addSegment(code, period));
  const editBtn = box.querySelector('.edit-seg-btn');
  if (editBtn) editBtn.addEventListener('click', () => toggleEditMode(code, period));
  watchStickyCompact(box.querySelector('.sec-header'));
  await loadAndRenderPeriodDetail(code, period);
}

// 进入/退出段编辑模式：点击顶部「编辑」按钮后，卡片右上角才显示编辑/删除按钮
function toggleEditMode(code, period) {
  state.editMode = !state.editMode;
  const detail = $('#period-detail');
  if (detail) detail.classList.toggle('editing', state.editMode);
  const editBtn = document.querySelector('.edit-seg-btn');
  if (editBtn) editBtn.classList.toggle('active', state.editMode);
}

async function loadAndRenderPeriodDetail(code, period) {
  const sec = state.securities.find((s) => s.code === code);
  const detail = $('#period-detail');
  if (!sec || !detail) return;
  const d = sec.drawings[period] || { segments: [], zhongshus: [] };
  const group = { period, label: periodLabel(period), segments: [...d.segments], zhongshus: [...d.zhongshus], loaded: false, error: null };

  // 更高周期最新一段终点：用于在低级别周期隐藏过早的段卡片（聚焦到最新一段覆盖的交易日）
  const higherPeriod = getHigherPeriod(period, sec.periods || []);
  const higherSegments = (higherPeriod && sec.drawings[higherPeriod]?.segments) || [];

  try {
    const curRes = await fetchBars(code, period, 400);
    const bars = curRes.bars || [];
    state._currentBars = { code, period, bars };
    computeMACD(bars);
    computeStrengths(bars, group.segments, group.zhongshus);
    group.loaded = true;
    const hideBefore = computeHideBefore(higherSegments, higherPeriod, group.segments);
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
  staggerEnter(detail, '.period-title, .plain-card, .zs-block, .empty');
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
function barAtTime(bars, t) {
  if (!bars || !bars.length) return null;
  let nearest = bars[0];
  let min = Math.abs(bars[0].time - t);
  for (const b of bars) {
    const d = Math.abs(b.time - t);
    if (d < min) { min = d; nearest = b; }
  }
  return nearest;
}

function priceAtTime(bars, t) {
  const bar = barAtTime(bars, t);
  return bar ? bar.close : null;
}

// 按段涨跌方向，返回某根 K 线在起点/终点处应取的价格：
//   上涨段：起点=最低价(low)，终点=最高价(high)
//   下跌段：起点=最高价(high)，终点=最低价(low)
//   水平段：取收盘价(close)
function endpointPrice(bar, isStart, direction) {
  if (!bar) return null;
  if (direction === 'up') return isStart ? bar.low : bar.high;
  if (direction === 'down') return isStart ? bar.high : bar.low;
  return bar.close;
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
    // 先确定方向（无前段时用收盘价判断趋势），再按涨跌方向取对应端点高低价
    const sBar = barAtTime(bars, startTime);
    const eBar = barAtTime(bars, endTime);
    const direction = prevSeg
      ? oppositeDirection(prevSeg.direction)
      : (eBar && sBar && eBar.close >= sBar.close ? 'up' : 'down');
    const sPrice = endpointPrice(sBar, true, direction) ?? 0;
    const ePrice = endpointPrice(eBar, false, direction) ?? 0;
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
    openEditor(targetSeg, async (newStart, newEnd) => {
      let bars;
      try {
        bars = await ensureBars(code, period);
      } catch {
        alert('行情数据加载失败，请检查网络后重新编辑');
        return;
      }
      // 编辑起点/终点时间后，按原段涨跌方向从腾讯财经 K 线取对应高低价，避免沿用 PC 导出旧价格
      const sBar = barAtTime(bars, newStart);
      const eBar = barAtTime(bars, newEnd);
      const direction = targetSeg.direction;
      targetSeg.start.time = newStart;
      targetSeg.start.price = endpointPrice(sBar, true, direction) ?? targetSeg.start.price;
      targetSeg.end.time = newEnd;
      targetSeg.end.price = endpointPrice(eBar, false, direction) ?? targetSeg.end.price;
      targetSeg.direction = direction;
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
      pushView('detail', state.selectedCode, firstPeriod);
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
  // 配色主题：默认黑白（隐藏红涨绿跌），顶部按钮可切换回彩色
  const THEME_KEY = 'chan-m-theme';
  const themeBtn = document.getElementById('btn-theme-toggle');
  const themeClr = document.getElementById('theme-clr');
  const applyTheme = (mono) => {
    document.body.classList.toggle('mono', mono);
    // CLR. 文本：黑白态→黑字（代表黑白设置），彩色态→红字（代表彩色设置）
    if (themeClr) themeClr.style.color = mono ? '#111111' : '#fa5151';
    if (themeBtn) themeBtn.setAttribute('aria-label', mono ? '点击切换为彩色' : '点击切换为黑白');
  };
  const saved = localStorage.getItem(THEME_KEY);
  applyTheme(saved ? saved === 'mono' : true); // 无记录时默认黑白
  if (themeBtn) themeBtn.addEventListener('click', () => {
    const mono = !document.body.classList.contains('mono');
    applyTheme(mono);
    localStorage.setItem(THEME_KEY, mono ? 'mono' : 'color');
  });

  $('#sec-list').addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-act]');
    if (actionBtn) { onDetailAction(e); }
  });

  const headerBack = document.getElementById('btn-header-back');
  if (headerBack) headerBack.addEventListener('click', () => animateBack());

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
  history.replaceState({ chanmView: 'list' }, '');
  startIndexRealtime();

  // 自动加载画线数据（file:// 模式下跳过）
  if (location.protocol !== 'file:') {
    loadAllDrawings();
  }

  if ('serviceWorker' in navigator && !window.__CHANM_NOCACHE__) {
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js?v=20260716a').catch(() => {}));
  }

  window.__CHANM_LOADED__ = true;
}

init();
window.navigate = navigate;
