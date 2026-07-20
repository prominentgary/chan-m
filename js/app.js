// app.js —— Chan-M 入口：一键导入站点全部画线，按「证券 → 周期」展示，联网算力
// 注意：所有 import 路径均带版本号，每次发布新版本时请同步修改 html/js/sw 中的版本号
import { fetchBars, fetchRealtimeMulti, formatTime, formatPrice, isETF } from './fetcher.js?v=20260714y';
import { computeMACD } from './macd.js?v=20260714y';
import { segmentStrength, detectStrengthIndicators, detectOneBuySell, detectTwoAndThreeBuySell, computeZhongshuStrength, detectZhongshu } from './algo.js?v=20260719i';
import { renderSegments } from './table.js?v=20260719i';
import { renderMiniChart } from './minichart.js?v=20260717b';
import { loadStaticData } from './sync.js?v=20260719j';
import { openEditor } from './editor.js?v=20260715z';
import { makeZhongshu } from './model.js?v=20260719i';
import { buildFromStruct, formatChanSnapshot, alignPeriods } from '../shared/ai_snapshot.js?v=20260719a';

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
const ALERT_STORE_KEY = 'chan-m-alerts-v1';

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
  alerts: [],
  _alertTimer: null,
  _alertNotified: new Set(),
};

// 加载状态：用于区分「正在加载」与「真的没有数据」，避免首屏误报「暂无画线数据」
const loadState = { loading: false, error: null };

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

function loadAlerts() {
  try {
    const raw = localStorage.getItem(ALERT_STORE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveAlerts() {
  try {
    localStorage.setItem(ALERT_STORE_KEY, JSON.stringify(state.alerts));
  } catch {}
}

function addAlert(alert) {
  const id = 'alert_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const item = {
    id,
    code: alert.code,
    name: alert.name || '',
    type: alert.type,
    value: alert.value,
    enabled: true,
    triggered: false,
    createdAt: Date.now(),
    triggeredAt: null,
  };
  state.alerts.unshift(item);
  saveAlerts();
  return item;
}

function removeAlert(id) {
  state.alerts = state.alerts.filter((a) => a.id !== id);
  saveAlerts();
}

function toggleAlert(id) {
  const a = state.alerts.find((x) => x.id === id);
  if (a) {
    a.enabled = !a.enabled;
    if (a.enabled) {
      a.triggered = false;
      a.triggeredAt = null;
      state._alertNotified.delete(id);
    }
    saveAlerts();
  }
}

function alertTypeLabel(type) {
  const map = {
    price_above: '价格上破',
    price_below: '价格下破',
    change_pct_up: '涨幅超过',
    change_pct_down: '跌幅超过',
  };
  return map[type] || type;
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
    // 本地编辑优先，但 bars（来自导出）只存在于静态数据，需保留以计算 MACD 力度
    result[p] = ldTime >= sdTime
      ? { ...ld, bars: ld.bars || (sd ? sd.bars : null) }
      : sd;
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
  loadState.loading = true;
  loadState.error = null;
  renderDingpanView(); // 立即刷新：若列表仍为空则显示「加载中…」
  try {
    const list = await loadManifest();
    // 收集所有「证券 × 周期」任务，用 Promise.all 并行拉取，避免串行 await 造成的慢加载
    const securities = list.map((s) => ({
      code: s.code, name: s.name || null, periods: s.periods, drawings: {},
    }));
    const byCode = Object.fromEntries(securities.map((s) => [s.code, s]));
    const tasks = [];
    for (const s of list) {
      for (const p of s.periods) {
        tasks.push(loadStaticData(s.code, p).then((data) => ({ code: s.code, p, data })));
      }
    }
    const results = await Promise.all(tasks);
    const errors = [];
    for (const { code, p, data } of results) {
      if (data && (data.segments || data.zhongshus)) {
        byCode[code].drawings[p] = {
          segments: data.segments || [],
          zhongshus: data.zhongshus || [],
          exportedAt: data.exportedAt || 0,
          bars: data.bars || null,
        };
      } else {
        errors.push(`${code}_${p}.json`);
      }
    }
    // 合并本地编辑（与静态数据取较新者）
    for (const s of list) {
      byCode[s.code].drawings = mergeDrawings(byCode[s.code].drawings, s.code);
    }
    let segTotal = 0;
    for (const sec of securities) {
      for (const p of Object.keys(sec.drawings)) {
        segTotal += (sec.drawings[p].segments || []).length;
      }
    }
    state.securities = securities;
    renderDingpanView();
    startAllRealtime();
  } catch (e) {
    loadState.error = e.message || '导入失败';
  } finally {
    loadState.loading = false;
    renderDingpanView(); // 收尾渲染：加载中 → 列表 / 错误提示
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

// 返回上一级：手势、底部返回按钮、安卓/桌面硬件返回键 的统一入口
function backTarget() {
  if (state.view === 'detail') return ['periods', state.selectedCode, state.selectedPeriod];
  if (state.view === 'periods') return ['list', null, null];
  return null;
}

function doBack() {
  const t = backTarget();
  if (t) {
    if (t[0] === 'list') listEnterPlayed = false; // 返回列表时允许重播动画
    navigate(t[0], t[1], t[2]);
  }
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
    // 动画结束后清除内联 transitionDelay，避免影响后续退场动画
    const lastDelay = (items.length - 1) * STAGGER;
    setTimeout(() => {
      items.forEach((el) => { el.style.transitionDelay = ''; });
    }, lastDelay + 350);
  }));
}

// 返回上一级：手势、底部返回按钮、安卓/桌面硬件返回键 的统一入口
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

// ========== 加载界面诗句 ==========
// 证券列表为空（加载中或暂无数据）时，展示两首诗替代原来的文字提示。
function renderPoems(errorMsg) {
  return `
    <div class="poem-screen">
      <div class="poem">
        <div class="poem-head">善棋道人 ·《绝句》</div>
        <div class="poem-body">
          <p>烂柯真诀妙通神，一局曾经几度春。</p>
          <p>自出洞来无敌手，得饶人处且饶人。</p>
        </div>
      </div>
      <div class="poem">
        <div class="poem-head">黄庭坚 ·《杂诗七首·其一》</div>
        <div class="poem-body">
          <p>此身天地一蘧庐，世事消磨绿鬓疏。</p>
          <p>毕竟几人真得鹿，不知终日梦为鱼。</p>
        </div>
      </div>
      ${errorMsg ? `<div class="poem-err">${errorMsg}</div>` : ''}
    </div>`;
}

// ========== 证券列表渲染 ==========
function renderSecurityList(filterQuery = '') {
  const box = $('#sec-list');
  if (!state.securities.length) {
    box.innerHTML = renderPoems(loadState.error);
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
    const hasAlert = state.alerts.some((a) => a.code === sec.code && a.enabled && !a.triggered);
    return `
    <div class="sec-card" data-code="${sec.code}">
      <div class="sec-head">
        <div class="sec-info">
          <div class="sec-name" data-name="${sec.code}">${name}${hasAlert ? '<span class="sec-alert-dot"></span>' : ''}</div>
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
    const code = card.dataset.code;
    const sec = state.securities.find((s) => s.code === code);
    card.addEventListener('click', () => {
      if (secCardLongPressFired) { secCardLongPressFired = false; return; }
      pushView('periods', code);
    });
    attachSecCardLongPress(card, code, sec?.name || '');
  });
  // 仅在首次加载时播一次卡片依次进入动画（搜索/重渲染不再重复）
  if (!listEnterPlayed) {
    listEnterPlayed = true;
    staggerEnter(box, '.sec-card');
  }
}

let secCardLongPressFired = false;

function attachSecCardLongPress(card, code, name) {
  let timer = null;
  let sx = 0, sy = 0;
  const LONG_MS = 480;
  const start = (x, y) => {
    secCardLongPressFired = false;
    sx = x; sy = y;
    timer = setTimeout(() => {
      secCardLongPressFired = true;
      openAddAlertSheet(code, name);
    }, LONG_MS);
  };
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  card.addEventListener('pointerdown', (e) => { start(e.clientX, e.clientY); });
  card.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) cancel();
  });
  card.addEventListener('pointerup', cancel);
  card.addEventListener('pointercancel', cancel);
  card.addEventListener('contextmenu', (e) => e.preventDefault());
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
  const change = fmtIndexChange(rt?.price, rt?.prevClose);
  const priceText = rt?.price ? formatPrice(code, rt.price) : '';
  const periodTags = sec.periods.map((p) => periodLabel(p)).join('/');
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
    <div class="sec-card">
      <div class="sec-head">
        <div class="sec-info">
          <div class="sec-name" data-name="${code}">${name}</div>
          <div class="sec-meta">${displayCode} · ${periodTags}</div>
        </div>
        <div class="sec-right">
          <div class="sec-quote" data-rt="${code}">
            <div class="sec-price">${priceText}</div>
            <div class="sec-change ${change.cls}">${change.text}</div>
          </div>
        </div>
      </div>
      <button class="ai-snapshot-btn" data-ai-snapshot="${code}">盘面快照 for AI</button>
    </div>
    <div class="period-list">${rows}</div>
  `;
  box.querySelectorAll('.period-row').forEach((row) => {
    const p = row.dataset.period;
    row.addEventListener('click', () => {
      if (longPressFired) { longPressFired = false; return; } // 长按已触发简图，吞掉随后的 click
      pushView('detail', code, p);
    });
    attachPeriodRowLongPress(row, code, p);
  });
  const aiBtn = box.querySelector('.ai-snapshot-btn');
  if (aiBtn) {
    aiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyChanSnapshot(code);
    });
  }
  staggerEnter(box, '.sec-card, .period-row');
}

  // ========== 复制盘面快照（供 AI 解读） ==========
  function _toast(msg, ms) {
    let el = document.getElementById('__chanm_toast');
    if (!el) {
      el = document.createElement('div');
      el.id = '__chanm_toast';
      el.style.cssText = 'position:fixed;left:50%;top:42%;transform:translate(-50%,-50%);'
        + 'background:rgba(0,0,0,.82);color:#fff;padding:10px 16px;border-radius:8px;'
        + 'font-size:14px;z-index:9999;max-width:78%;text-align:center;pointer-events:none;'
        + 'opacity:0;transition:opacity .18s;';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el.__t);
    el.__t = setTimeout(function () { el.style.opacity = '0'; }, ms || 2200);
  }

  function copyChanSnapshot(code) {
    const sec = state.securities.find((s) => s.code === code);
    if (!sec) return;
    const periods = [];
    Object.keys(sec.drawings || {}).forEach((p) => {
      const d = sec.drawings[p];
      if (!d || !d.segments || d.segments.length === 0) return;
      // d.bars 为导出时嵌入的 K 线（含 MACD 精确力度）；缺失则退化为几何代理
      periods.push(buildFromStruct(d.segments, d.zhongshus, p, d.bars));
    });
    if (!periods.length) { _toast('该证券各周期暂无画线'); return; }
    alignPeriods(periods);
    const text = formatChanSnapshot({ code, name: sec.name, periods });
    copyTextToClipboard(text);
    _toast('盘面快照已复制，粘贴到任意 AI App 即可解读');
  }

  function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
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
  if (backdrop) { backdrop.classList.remove('show'); backdrop.style.opacity = ''; backdrop.style.transition = ''; }
  if (sheet) { sheet.classList.remove('show'); sheet.style.transform = ''; sheet.style.transition = ''; }
  document.body.style.overflow = '';
}
window.closeMiniSheet = closeMiniSheet;

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

// 详情页证券卡片：根据滚动位置切换折叠态（2 行 → 1 行）
function onDetailScroll() {
  const card = document.querySelector('.sec-card--detail');
  if (!card) return;
  card.classList.toggle('sec-card--collapsed', window.scrollY > 36);
}

// ========== 周期详情渲染 ==========
async function renderPeriodDetail(code, period) {
  const box = $('#sec-list');
  const sec = state.securities.find((s) => s.code === code);
  if (!sec) { navigate('list'); return; }
  const rt = state._rtPrices?.[code];
  const name = sec.name || rt?.name || code;
  const displayCode = sec.code.toUpperCase();
  const change = fmtIndexChange(rt?.price, rt?.prevClose);
  const priceText = rt?.price ? formatPrice(code, rt.price) : '';
  box.innerHTML = `
    <div class="sec-card sec-card--detail">
      <div class="sec-head">
        <div class="sec-info">
          <div class="sec-name" data-name="${code}">${name}</div>
          <div class="sec-meta">${displayCode} · ${periodLabel(period)}</div>
        </div>
        <div class="sec-right">
          <div class="sec-quote" data-rt="${code}">
            <div class="sec-price">${priceText}</div>
            <div class="sec-change ${change.cls}">${change.text}</div>
          </div>
        </div>
      </div>
    </div>
    <div id="period-detail"><div class="empty">加载中…</div></div>
  `;
  await loadAndRenderPeriodDetail(code, period);
  staggerEnter(box, '.sec-card');
  onDetailScroll(); // 同步初始折叠态（进入时若已下滚则立即折叠）
}

async function loadAndRenderPeriodDetail(code, period) {
  const sec = state.securities.find((s) => s.code === code);
  const detail = $('#period-detail');
  if (!sec || !detail) return;

  // 更高周期最新一段终点：用于在低级别周期隐藏过早的段卡片（聚焦到最新一段覆盖的交易日）
  const higherPeriod = getHigherPeriod(period, sec.periods || []);
  const higherSegments = (higherPeriod && sec.drawings[higherPeriod]?.segments) || [];

  try {
    const curRes = await fetchBars(code, period, 800);
    const bars = curRes.bars || [];
    state._currentBars = { code, period, bars };
    computeMACD(bars);
    // 先根据最新 K 线更新盯盘段终点（所有周期的最后一段均支持盯盘），再重新构建渲染分组
    updateWatchSegments(code, period, bars, false);
    const d = sec.drawings[period] || { segments: [], zhongshus: [] };
    const group = { period, label: periodLabel(period), segments: [...d.segments], zhongshus: [...d.zhongshus], loaded: false, error: null };
    computeStrengths(bars, group.segments, group.zhongshus);
    group.loaded = true;
    const hideBefore = computeHideBefore(higherSegments, higherPeriod, group.segments);
    if (!$('#period-detail')) return;
    renderSinglePeriodDetail(detail, code, group, hideBefore);
  } catch (err) {
    const d = sec.drawings[period] || { segments: [], zhongshus: [] };
    const group = { period, label: periodLabel(period), segments: [...d.segments], zhongshus: [...d.zhongshus], loaded: false, error: null };
    group.error = (err && err.message) || '加载失败';
    if (!$('#period-detail')) return;
    renderSinglePeriodDetail(detail, code, group, null);
  }
}

function renderSinglePeriodDetail(detail, code, g, hideBefore = null, animate = true) {
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
    attachSegmentCardActions(code, g.period);
    attachZhongshuEditActions(code, g.period);
  }
  if (animate) staggerEnter(detail, '.period-title, .plain-card, .zs-block, .empty');
}

// 中枢编辑/本地修改后，不重新拉取行情，直接用缓存 bars 重新计算并渲染
function refreshPeriodDetailWithoutFetch(code, period) {
  const sec = state.securities.find((s) => s.code === code);
  const detail = $('#period-detail');
  if (!sec || !detail) return;
  const d = sec.drawings[period] || { segments: [], zhongshus: [] };
  const group = {
    period,
    label: periodLabel(period),
    segments: [...(d.segments || [])],
    zhongshus: [...(d.zhongshus || [])],
    loaded: true,
    error: null,
  };
  const higherPeriod = getHigherPeriod(period, sec.periods || []);
  const higherSegments = (higherPeriod && sec.drawings[higherPeriod]?.segments) || [];
  const bars = state._currentBars?.bars || [];
  if (bars.length && group.segments.length) {
    computeStrengths(bars, group.segments, group.zhongshus);
  }
  const hideBefore = computeHideBefore(higherSegments, higherPeriod, group.segments);
  renderSinglePeriodDetail(detail, code, group, hideBefore, false);
}

// 长按段卡片：显示覆盖在该卡片上的操作蒙板（编辑 / 删除 / 新增）
function attachSegmentCardActions(code, period) {
  const detail = $('#period-detail');
  if (!detail) return;
  detail.querySelectorAll('.card').forEach((card) => {
    attachSegmentLongPress(card, code, period);
  });
}

let activeCardOverlay = null;

function attachSegmentLongPress(card, code, period) {
  let timer = null;
  let sx = 0, sy = 0;
  const LONG_MS = 480;
  const start = (x, y) => {
    sx = x; sy = y;
    timer = setTimeout(() => {
      showCardOverlay(card, code, period);
    }, LONG_MS);
  };
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  card.addEventListener('pointerdown', (e) => { start(e.clientX, e.clientY); });
  card.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) cancel();
  });
  card.addEventListener('pointerup', cancel);
  card.addEventListener('pointercancel', cancel);
  card.addEventListener('contextmenu', (e) => e.preventDefault());
}

function showCardOverlay(card, code, period) {
  hideCardOverlay();
  const segId = card.dataset.id;
  const sec = state.securities.find((s) => s.code === code);
  const d = sec?.drawings?.[period];
  const sorted = [...(d?.segments || [])].sort((a, b) => a.start.time - b.start.time);
  const idx = sorted.findIndex((s) => s.id === segId);
  const targetSeg = sorted[idx];
  const isWatch = targetSeg?._isWatch || false;
  const isLatest = !isWatch && targetSeg && sorted[sorted.length - 1]?.id === segId;
  const bars = state._currentBars?.bars || [];
  const detected = idx >= 0 ? detectZhongshu(sorted, idx, bars) : null;
  const otherZsIds = new Set();
  (d?.zhongshus || []).forEach((z) => {
    (z.segmentIds || []).forEach((id) => otherZsIds.add(id));
  });
  const canDetect = !isWatch && detected && detected.segmentIds.every((id) => !otherZsIds.has(id));

  const detectBtn = canDetect ? `
    <button class="overlay-btn icon accent" data-act="detect" aria-label="中枢识别">
      <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <rect x="4" y="7" width="16" height="10" rx="2"/>
        <path d="M4 12 H20"/>
      </svg>
    </button>
  ` : '';

  const watchBtn = isLatest ? `
    <button class="overlay-btn icon" data-act="watch" aria-label="盯盘">
      <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    </button>
  ` : '';

  const overlay = document.createElement('div');
  overlay.className = 'card-overlay';
  overlay.innerHTML = isWatch ? `
    <button class="overlay-btn icon" data-act="edit" aria-label="编辑">
      <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="4"/>
        <path d="M15 5 L19 9"/>
        <path d="M13 7 L17 11"/>
      </svg>
    </button>
    <button class="overlay-btn icon danger" data-act="del" aria-label="删除">
      <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  ` : `
    <button class="overlay-btn icon" data-act="edit" aria-label="编辑">
      <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="4"/>
        <path d="M15 5 L19 9"/>
        <path d="M13 7 L17 11"/>
      </svg>
    </button>
    <button class="overlay-btn icon danger" data-act="del" aria-label="删除">
      <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
    ${watchBtn}
    <button class="overlay-btn icon" data-act="add" aria-label="新增">
      <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>
    ${detectBtn}
  `;
  card.appendChild(overlay);
  activeCardOverlay = overlay;

  // 下一帧触发显示动画
  requestAnimationFrame(() => overlay.classList.add('show'));

  overlay.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) {
      hideCardOverlay();
      return;
    }
    e.stopPropagation();
    const segId = card.dataset.id;
    hideCardOverlay();
    handleSegmentAction(btn.dataset.act, segId, code, period);
  });

  // 点击卡片外部关闭蒙板
  setTimeout(() => {
    document.addEventListener('pointerdown', closeCardOverlayOnOutside, { once: true, capture: true });
  }, 0);
}

function closeCardOverlayOnOutside(e) {
  if (activeCardOverlay && !activeCardOverlay.contains(e.target)) {
    hideCardOverlay();
  }
}

function hideCardOverlay() {
  if (activeCardOverlay) {
    activeCardOverlay.classList.remove('show');
    activeCardOverlay.remove();
    activeCardOverlay = null;
  }
  document.removeEventListener('pointerdown', closeCardOverlayOnOutside, { capture: true });
}

// ========== 中枢编辑：长按标题进入编辑态，拖动上下边缘纳入/剔除段 ==========
let activeZsEdit = null; // { zsId, block, code, period }
const ZS_DRAG_THRESHOLD = 24;

function attachZhongshuEditActions(code, period) {
  const detail = $('#period-detail');
  if (!detail) return;
  detail.querySelectorAll('.zs-title').forEach((title) => {
    attachZhongshuTitleLongPress(title, code, period);
  });
  // 边缘也支持长按进入编辑态，兼容用户直接长按边缘区域的操作习惯
  detail.querySelectorAll('.zs-edge').forEach((edge) => {
    attachZhongshuTitleLongPress(edge, code, period);
  });
}

function attachZhongshuTitleLongPress(title, code, period) {
  let timer = null;
  let sx = 0, sy = 0;
  const LONG_MS = 480;
  const start = (x, y) => {
    sx = x; sy = y;
    timer = setTimeout(() => {
      if (activeZsEdit) return; // 已在编辑态（例如边缘长按与拖动共用事件时避免重复进入）
      enterZhongshuEditMode(title, code, period);
    }, LONG_MS);
  };
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  title.addEventListener('pointerdown', (e) => { start(e.clientX, e.clientY); });
  title.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) cancel();
  });
  title.addEventListener('pointerup', cancel);
  title.addEventListener('pointercancel', cancel);
  title.addEventListener('contextmenu', (e) => e.preventDefault());
}

function detectZsDomReversed(block, code, period) {
  const cards = block.querySelectorAll('.card[data-id]');
  if (cards.length < 2) return false;
  const sec = state.securities.find((s) => s.code === code);
  const d = sec?.drawings?.[period];
  const segMap = {};
  (d?.segments || []).forEach((s) => { segMap[s.id] = s; });
  const firstSeg = segMap[cards[0].dataset.id];
  const lastSeg = segMap[cards[cards.length - 1].dataset.id];
  if (!firstSeg || !lastSeg) return false;
  const t1 = firstSeg.end?.time ?? firstSeg.start?.time ?? 0;
  const t2 = lastSeg.end?.time ?? lastSeg.start?.time ?? 0;
  return t1 > t2;
}

function enterZhongshuEditMode(title, code, period) {
  if (activeZsEdit) exitZhongshuEditMode();
  const block = title.closest('.zs-block');
  const zsId = block?.dataset.zsId;
  if (!zsId || !block) return;

  const reversed = detectZsDomReversed(block, code, period);
  activeZsEdit = { zsId, block, code, period, reversed };
  block.classList.add('editing');

  // 编辑态右上角解散中枢按钮
  const closeBtn = document.createElement('button');
  closeBtn.className = 'zs-edit-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '解散中枢');
  closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    dissolveZhongshu(code, period, zsId);
  });
  const titleEl = block.querySelector('.zs-title');
  if (titleEl) titleEl.appendChild(closeBtn);

  block.querySelectorAll('.zs-edge').forEach((edge) => {
    edge.addEventListener('pointerdown', onZsEdgePointerDown);
  });

  document.addEventListener('pointerdown', closeZsEditOnOutside, { capture: true });
}

function exitZhongshuEditMode() {
  if (!activeZsEdit) return;
  const { block } = activeZsEdit;
  block.classList.remove('editing');
  block.querySelectorAll('.zs-edge').forEach((edge) => {
    edge.classList.remove('dragging');
    edge.removeEventListener('pointerdown', onZsEdgePointerDown);
  });
  block.querySelectorAll('.zs-edit-close').forEach((b) => b.remove());
  clearZsPreview();
  activeZsEdit = null;
  document.removeEventListener('pointerdown', closeZsEditOnOutside, { capture: true });
}

function closeZsEditOnOutside(e) {
  if (!activeZsEdit) return;
  if (activeZsEdit.block.contains(e.target)) return;
  e.preventDefault();
  exitZhongshuEditMode();
}

function onZsEdgePointerDown(e) {
  if (!activeZsEdit) return;
  e.preventDefault();
  e.stopPropagation();
  const edgeEl = e.currentTarget;
  const edge = edgeEl.dataset.edge;
  const startY = e.clientY;
  edgeEl.classList.add('dragging');

  const move = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    const dy = ev.clientY - startY;
    updateZsPreview(edge, dy);
  };
  const up = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    edgeEl.classList.remove('dragging');
    const dy = ev.clientY - startY;
    const resolved = resolveZsDragOp(edge, dy);
    clearZsPreview();
    if (resolved) applyZsEdit(resolved);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function resolveZsDragOp(edge, dy) {
  const reversed = activeZsEdit?.reversed || false;
  let op = null;
  let count = 0;
  if (edge === 'top') {
    if (dy < -ZS_DRAG_THRESHOLD) { op = reversed ? 'include-next' : 'include-prev'; count = Math.floor(-dy / ZS_DRAG_THRESHOLD); }
    else if (dy > ZS_DRAG_THRESHOLD) { op = reversed ? 'exclude-last' : 'exclude-first'; count = Math.floor(dy / ZS_DRAG_THRESHOLD); }
  } else if (edge === 'bottom') {
    if (dy > ZS_DRAG_THRESHOLD) { op = reversed ? 'include-prev' : 'include-next'; count = Math.floor(dy / ZS_DRAG_THRESHOLD); }
    else if (dy < -ZS_DRAG_THRESHOLD) { op = reversed ? 'exclude-first' : 'exclude-last'; count = Math.floor(-dy / ZS_DRAG_THRESHOLD); }
  }
  if (!op) return null;
  return { op, count };
}

// 计算中枢原始震荡区间 [low, high]，基于 baseSegmentIds（原始 3 段）
function getZhongshuRange(zs, segMap) {
  const baseIds = zs.baseSegmentIds || zs.segmentIds?.slice(0, 3) || [];
  const baseSegs = baseIds.map((id) => segMap[id]).filter(Boolean);
  if (baseSegs.length < 3) return null;
  const lows = baseSegs.map((s) => Math.min(s.start.price, s.end.price));
  const highs = baseSegs.map((s) => Math.max(s.start.price, s.end.price));
  return { low: Math.max(...lows), high: Math.min(...highs) };
}

// PC 端规则：段是否已离开中枢区间
// side: 'right' 检查段终点（右边界延伸）；'left' 检查段起点（左边界延伸）
function isSegmentLeavingZhongshu(seg, range, side) {
  if (!range) return false;
  const isUp = seg.end.price > seg.start.price;
  if (side === 'right') {
    if (isUp && seg.end.price < range.low) return true;
    if (!isUp && seg.end.price > range.high) return true;
  } else {
    if (isUp && seg.start.price > range.high) return true;
    if (!isUp && seg.start.price < range.low) return true;
  }
  return false;
}

// 是否与目标段在时间和价格上相连（容忍极小误差）
function isSegmentConnected(a, b) {
  if (!a || !b) return false;
  return (a.end.time === b.start.time && Math.abs(a.end.price - b.start.price) < 1e-3);
}

// PC 端延伸规则：候选段可被纳入中枢当且仅当：
// 1. 与当前边界相连；2. 自身未脱离中枢区间；3. 再外侧一段未脱离（否则候选段是离开段）
function canIncludeInZhongshu(candidate, range, side, outerSeg) {
  if (!candidate || !range) return false;
  if (isSegmentLeavingZhongshu(candidate, range, side)) return false;
  if (outerSeg && isSegmentLeavingZhongshu(outerSeg, range, side)) return false;
  return true;
}

// 模拟一次完整的纳入/剔除操作，返回受影响的段 ID 集合、新 segmentIds、是否解散
function computeZsEditResult(zs, d, op, count) {
  const sorted = [...(d.segments || [])].sort((a, b) => a.start.time - b.start.time);
  const segMap = {};
  sorted.forEach((s) => { segMap[s.id] = s; });

  // 兼容旧数据：未保存 baseSegmentIds 时按时间取前 3 段作为原始中枢
  let baseSegmentIds = zs.baseSegmentIds;
  if (!baseSegmentIds || baseSegmentIds.length !== 3) {
    baseSegmentIds = zs.segmentIds
      .map((id) => segMap[id])
      .filter(Boolean)
      .sort((a, b) => a.start.time - b.start.time)
      .slice(0, 3)
      .map((s) => s.id);
  }

  const otherZsIds = new Set();
  (d.zhongshus || []).forEach((z) => {
    if (z.id === zs.id) return;
    (z.segmentIds || []).forEach((id) => otherZsIds.add(id));
  });

  const range = getZhongshuRange({ ...zs, baseSegmentIds }, segMap);
  const baseIds = new Set(baseSegmentIds || []);
  let resultIds = zs.segmentIds
    .map((id) => segMap[id])
    .filter(Boolean)
    .sort((a, b) => a.start.time - b.start.time)
    .map((s) => s.id);
  let changed = false;
  let dissolve = false;

  for (let step = 0; step < count; step++) {
    const curIds = new Set(resultIds);
    let curFirst = -1, curLast = -1;
    sorted.forEach((s, i) => {
      if (curIds.has(s.id)) {
        if (curFirst < 0) curFirst = i;
        curLast = i;
      }
    });
    if (curFirst < 0) break;

    if (op === 'include-prev') {
      const prev = sorted[curFirst - 1];
      const prevPrev = sorted[curFirst - 2] || null;
      if (prev && !curIds.has(prev.id) && !otherZsIds.has(prev.id) &&
          isSegmentConnected(prev, sorted[curFirst]) &&
          canIncludeInZhongshu(prev, range, 'left', prevPrev)) {
        resultIds.unshift(prev.id);
        changed = true;
      } else break;
    } else if (op === 'include-next') {
      const next = sorted[curLast + 1];
      const nextNext = sorted[curLast + 2] || null;
      if (next && !curIds.has(next.id) && !otherZsIds.has(next.id) &&
          isSegmentConnected(sorted[curLast], next) &&
          canIncludeInZhongshu(next, range, 'right', nextNext)) {
        resultIds.push(next.id);
        changed = true;
      } else break;
    } else if (op === 'exclude-first') {
      if (resultIds.length <= 3) break;
      const first = sorted[curFirst];
      if (first && curIds.has(first.id) && !baseIds.has(first.id)) {
        resultIds = resultIds.filter((id) => id !== first.id);
        changed = true;
      } else break;
    } else if (op === 'exclude-last') {
      if (resultIds.length <= 3) break;
      const last = sorted[curLast];
      if (last && curIds.has(last.id) && !baseIds.has(last.id)) {
        resultIds = resultIds.filter((id) => id !== last.id);
        changed = true;
      } else break;
    }
  }

  return { changed, dissolve, segmentIds: resultIds, baseSegmentIds };
}

function updateZsPreview(edge, dy) {
  clearZsPreview();
  const resolved = resolveZsDragOp(edge, dy);
  if (!resolved || !activeZsEdit) {
    updateDragBadge(null, null);
    return;
  }

  const { op, count } = resolved;
  const { code, period, zsId } = activeZsEdit;
  const sec = state.securities.find((s) => s.code === code);
  const d = sec?.drawings?.[period];
  const zs = (d?.zhongshus || []).find((z) => z.id === zsId);
  if (!zs) {
    updateDragBadge(null, null);
    return;
  }

  const result = computeZsEditResult(zs, d, op, count);
  const originalIds = new Set(zs.segmentIds || []);
  const affected = [];
  if (op.startsWith('include')) {
    result.segmentIds.forEach((id) => { if (!originalIds.has(id)) affected.push(id); });
  } else {
    result.segmentIds.forEach((id) => { originalIds.delete(id); });
    affected.push(...originalIds);
  }

  const cls = op.startsWith('include') ? 'zs-preview-include' : 'zs-preview-exclude';
  affected.forEach((id) => {
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (card) card.classList.add(cls);
  });

  updateDragBadge(edge, dy, affected.length);
}

function updateDragBadge(edge, dy, effectiveCount) {
  if (!activeZsEdit) return;
  const edgeEl = edge ? activeZsEdit.block.querySelector(`.zs-edge[data-edge="${edge}"]`) : null;
  if (!edgeEl) {
    if (activeZsEdit) activeZsEdit.block.querySelectorAll('.zs-drag-badge').forEach((b) => b.remove());
    return;
  }
  const resolved = resolveZsDragOp(edge, dy);
  let badge = edgeEl.querySelector('.zs-drag-badge');
  if (!resolved || effectiveCount <= 0) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'zs-drag-badge';
    edgeEl.appendChild(badge);
  }
  const label = resolved.op.startsWith('include') ? '纳入' : '剔除';
  badge.textContent = `${label} ${effectiveCount} 段`;
}

function clearZsPreview() {
  document.querySelectorAll('.zs-preview-include, .zs-preview-exclude').forEach((el) => {
    el.classList.remove('zs-preview-include', 'zs-preview-exclude');
  });
  if (activeZsEdit) {
    activeZsEdit.block.querySelectorAll('.zs-drag-badge').forEach((b) => b.remove());
  }
}

function applyZsEdit(resolved) {
  if (!activeZsEdit || !resolved) return;
  const { op, count } = resolved;
  const { code, period, zsId } = activeZsEdit;
  const sec = state.securities.find((s) => s.code === code);
  const d = sec?.drawings?.[period];
  const zs = (d?.zhongshus || []).find((z) => z.id === zsId);
  if (!zs || !d) return;

  const result = computeZsEditResult(zs, d, op, count);
  if (!result.changed) return;

  zs.segmentIds = result.segmentIds;
  zs.baseSegmentIds = result.baseSegmentIds;
  if (result.dissolve) {
    d.zhongshus = (d.zhongshus || []).filter((z) => z.id !== zs.id);
  }

  try { navigator.vibrate?.(12); } catch {}
  exitZhongshuEditMode();
  saveLocalEdits(code, sec.drawings);
  refreshPeriodDetailWithoutFetch(code, period);
}

// 解散中枢：移除中枢结构，内部段恢复为普通段
function dissolveZhongshu(code, period, zsId) {
  const sec = state.securities.find((s) => s.code === code);
  const d = sec?.drawings?.[period];
  if (!d) return;
  d.zhongshus = (d.zhongshus || []).filter((z) => z.id !== zsId);
  try { navigator.vibrate?.(12); } catch {}
  exitZhongshuEditMode();
  saveLocalEdits(code, sec.drawings);
  refreshPeriodDetailWithoutFetch(code, period);
}

function handleSegmentAction(act, segId, code, period) {
  const sec = state.securities.find((s) => s.code === code);
  if (!sec) return;
  const d = sec.drawings[period];
  if (!d) return;
  const targetSeg = (d.segments || []).find((s) => s.id === segId);

  if (act === 'add') {
    addSegment(code, period);
  } else if (act === 'watch') {
    if (!targetSeg) return;
    addWatchSegment(code, period, segId);
  } else if (act === 'detect') {
    if (!targetSeg) return;
    const sorted = [...(d.segments || [])].sort((a, b) => a.start.time - b.start.time);
    const idx = sorted.findIndex((s) => s.id === segId);
    const bars = state._currentBars?.bars || [];
    const detected = idx >= 0 ? detectZhongshu(sorted, idx, bars) : null;
    if (!detected) {
      alert('选中的段无法构成中枢');
      return;
    }
    const otherZsIds = new Set();
    (d.zhongshus || []).forEach((z) => {
      (z.segmentIds || []).forEach((id) => otherZsIds.add(id));
    });
    if (detected.segmentIds.some((id) => otherZsIds.has(id))) {
      alert('选中的段已存在于其它中枢中');
      return;
    }
    d.zhongshus = d.zhongshus || [];
    d.zhongshus.push(makeZhongshu(detected.segmentIds, detected.baseSegmentIds));
    saveLocalEdits(code, sec.drawings);
    refreshPeriodDetailWithoutFetch(code, period);
  } else if (act === 'edit') {
    if (!targetSeg) return;
    const wasWatch = targetSeg._isWatch;
    openEditor(targetSeg, async (newStart, newEnd) => {
      let bars;
      try {
        bars = await ensureBars(code, period);
      } catch {
        alert('行情数据加载失败，请检查网络后重新编辑');
        return;
      }
      const sBar = barAtTime(bars, newStart);
      const eBar = barAtTime(bars, newEnd);
      const direction = targetSeg.direction;
      targetSeg.start.time = newStart;
      targetSeg.start.price = endpointPrice(sBar, true, direction) ?? targetSeg.start.price;
      targetSeg.end.time = newEnd;
      targetSeg.end.price = endpointPrice(eBar, false, direction) ?? targetSeg.end.price;
      targetSeg.direction = direction;
      // 盯盘段编辑后变为普通段，并基于新的终点自动生成新的盯盘段（所有周期通用）
      if (wasWatch) {
        delete targetSeg._isWatch;
        delete targetSeg._watchSourceId;
        const startIdx = bars.findIndex((b) => b.time === targetSeg.end.time);
        if (startIdx >= 0) {
          const watchDir = oppositeDirection(targetSeg.direction);
          const endInfo = calcWatchSegmentEnd(bars, startIdx, watchDir);
          if (endInfo) {
            d.segments.push({
              id: 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
              kind: 'segment',
              period,
              direction: watchDir,
              start: { time: targetSeg.end.time, price: targetSeg.end.price },
              end: { time: endInfo.time, price: endInfo.price },
              _isWatch: true,
              _watchSourceId: targetSeg.id,
            });
          }
        }
      }
      saveLocalEdits(code, sec.drawings);
      refreshPeriodDetailWithoutFetch(code, period);
    });
  } else if (act === 'del') {
    if (!targetSeg) return;
    if (!confirm('确定删除此段？')) return;
    d.segments = d.segments.filter((s) => s.id !== segId);
    (d.zhongshus || []).forEach((z) => {
      z.segmentIds = (z.segmentIds || []).filter((id) => id !== segId);
      if (z.baseSegmentIds) {
        z.baseSegmentIds = z.baseSegmentIds.filter((id) => id !== segId);
      }
    });
    d.zhongshus = (d.zhongshus || []).filter((z) => (z.segmentIds || []).length >= 3);
    saveLocalEdits(code, sec.drawings);
    refreshPeriodDetailWithoutFetch(code, period);
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
  startDetailRealtime();
}

// 盯盘实时刷新的轮询间隔（毫秒）：分钟线变化快用 15s，日/周线变化慢用 60s，避免无效轮询
function watchInterval(period) {
  return (period === 'day' || period === 'week') ? 60000 : 15000;
}

// 详情页：定时拉取最新 K 线并更新盯盘段终点（所有周期），仅在盯盘段发生变化时重绘。
// 定时器固定 15s 触发，但按当前周期做时间戳节流：日/周线实际约 60s 才真正发请求。
function startDetailRealtime() {
  if (state.rtTimers._detail) return;
  state.rtTimers._detail = setInterval(async () => {
    if (state.view !== 'detail' || state.activeTab !== 'dingpan' || document.hidden) return;
    const code = state.selectedCode;
    const period = state.selectedPeriod;
    const now = Date.now();
    // 按周期节流：未到该周期的刷新间隔则跳过本次网络请求
    if (now - (state._lastWatchFetch || 0) < watchInterval(period) - 200) return;
    const sec = state.securities.find((s) => s.code === code);
    if (!sec) return;
    const d = sec.drawings[period];
    if (!d || !(d.segments || []).some((s) => s._isWatch)) return;
    state._lastWatchFetch = now;
    try {
      const res = await fetchBars(code, period, 800);
      const bars = res.bars || [];
      state._currentBars = { code, period, bars };
      computeMACD(bars);
      const changed = updateWatchSegments(code, period, bars, false);
      if (changed) refreshPeriodDetailWithoutFetch(code, period);
    } catch {}
  }, 15000);
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
  const sorted = [...segments].sort((a, b) => a.start.time - b.start.time);
  let prevDir = null;
  sorted.forEach((s) => {
    s._strength = segmentStrength(bars, s, prevDir);
    if (s.direction !== 'horizontal') prevDir = s.direction;
  });
  computeZhongshuStrength(bars, segments, zhongshus);
  detectOneBuySell(segments, zhongshus);
  detectTwoAndThreeBuySell(segments, zhongshus);
  detectStrengthIndicators(segments, zhongshus);
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
  const res = await fetchBars(code, period, 800);
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
    refreshPeriodDetailWithoutFetch(code, period);
  }, defaults);
}

// 计算盯盘段终点：从起点所在 K 线到最新 K 线区间内的最高/最低价
function calcWatchSegmentEnd(bars, startIdx, direction) {
  if (!bars || startIdx < 0 || startIdx >= bars.length) return null;
  let endBar = bars[startIdx];
  if (direction === 'up') {
    for (let i = startIdx + 1; i < bars.length; i++) {
      if (bars[i].high > endBar.high) endBar = bars[i];
    }
  } else {
    for (let i = startIdx + 1; i < bars.length; i++) {
      if (bars[i].low < endBar.low) endBar = bars[i];
    }
  }
  return {
    time: endBar.time,
    price: direction === 'up' ? endBar.high : endBar.low,
  };
}

async function addWatchSegment(code, period, sourceSegId) {
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
  let segs = d.segments || [];
  // 同一源段只能有一个盯盘段，先移除旧的
  segs = segs.filter((s) => !(s._isWatch && s._watchSourceId === sourceSegId));
  const sourceSeg = segs.find((s) => s.id === sourceSegId);
  if (!sourceSeg) return;
  const startTime = sourceSeg.end.time;
  const startIdx = bars.findIndex((b) => b.time === startTime);
  if (startIdx < 0) {
    alert('未找到起点对应K线');
    return;
  }
  const direction = oppositeDirection(sourceSeg.direction);
  const endInfo = calcWatchSegmentEnd(bars, startIdx, direction);
  if (!endInfo) return;
  const seg = {
    id: 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    kind: 'segment',
    period,
    direction,
    start: { time: startTime, price: sourceSeg.end.price },
    end: { time: endInfo.time, price: endInfo.price },
    _isWatch: true,
    _watchSourceId: sourceSegId,
  };
  d.segments = [...segs, seg];
  sec.drawings[period] = d;
  saveLocalEdits(code, sec.drawings);
  refreshPeriodDetailWithoutFetch(code, period);
}

// 根据最新行情更新盯盘段终点；refresh 为 false 时只更新数据不重新渲染
function updateWatchSegments(code, period, bars, refresh = true) {
  const sec = state.securities.find((s) => s.code === code);
  if (!sec) return false;
  const d = sec.drawings[period];
  if (!d) return false;
  if (!bars || !bars.length) bars = state._currentBars?.bars || [];
  if (!bars || !bars.length) return false;
  const segs = d.segments || [];
  let changed = false;
  const newSegs = segs.filter((s) => {
    if (!s._isWatch) return true;
    const sourceSeg = segs.find((x) => x.id === s._watchSourceId);
    if (!sourceSeg) {
      changed = true;
      return false;
    }
    const startIdx = bars.findIndex((b) => b.time === sourceSeg.end.time);
    if (startIdx < 0) return true;
    const direction = oppositeDirection(sourceSeg.direction);
    const endInfo = calcWatchSegmentEnd(bars, startIdx, direction);
    if (!endInfo) return true;
    if (s.end.time !== endInfo.time || s.end.price !== endInfo.price) {
      s.end = { time: endInfo.time, price: endInfo.price };
      changed = true;
    }
    return true;
  });
  if (changed) {
    d.segments = newSegs;
    if (refresh) refreshPeriodDetailWithoutFetch(code, period);
  }
  return changed;
}

// ========== 底部 tabbar 视口适配（修复小米等安卓机页面切换时 tabbar 被遮挡/裁切） ==========
function adjustTabbarOffset() {
  const tabbar = document.querySelector('.wx-tabbar');
  if (!tabbar) return;

  const vv = window.visualViewport;
  if (!vv) {
    tabbar.style.transform = '';
    return;
  }

  // layout viewport 高度与 visual viewport 底部之间的差值，
  // 即为被底部浏览器工具栏/手势条遮挡的高度。
  const bottomOffset = window.innerHeight - (vv.offsetTop + vv.height);
  if (bottomOffset > 1) {
    // 将 tabbar 整体上移，使其始终位于可视区域底部；
    // CSS 中 bottom 已基于 safe-area-inset-bottom，这里再叠加动态工具栏偏移。
    // 保留 translateZ(0) 维持合成层，减少重绘抖动。
    tabbar.style.transform = `translateY(${-bottomOffset}px) translateZ(0)`;
  } else {
    tabbar.style.transform = '';
  }
}

function initTabbarViewportFix() {
  adjustTabbarOffset();
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', adjustTabbarOffset);
    vv.addEventListener('scroll', adjustTabbarOffset);
  }
  window.addEventListener('resize', adjustTabbarOffset);
  window.addEventListener('orientationchange', adjustTabbarOffset);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(adjustTabbarOffset, 100);
  });
  // 初始加载后多次校准，覆盖 MIUI 等延迟报告安全区/工具栏的场景
  [100, 300, 600, 1200, 2500].forEach((ms) => setTimeout(adjustTabbarOffset, ms));
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
    alert: '#alert-view',
    workbench: '#workbench-view',
    wo: '#wo-view',
  };
  Object.entries(views).forEach(([key, sel]) => {
    const el = document.querySelector(sel);
    if (el) el.style.display = key === name ? '' : 'none';
  });

  if (name === 'dingpan') renderDingpanView();
  if (name === 'hangqing') { renderHangqingView(); startIndexRealtime(); }
  if (name === 'alert') renderAlertView();
  if (name === 'workbench') renderWorkbenchView();
  if (name === 'wo') renderWoView();

  // 页面内容切换后，底部工具栏/安全区可能变化，重新校准 tabbar
  requestAnimationFrame(() => adjustTabbarOffset());
  setTimeout(adjustTabbarOffset, 100);
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

function renderAlertView() {
  const el = $('#alert-view');
  if (!el) return;
  const alerts = state.alerts;
  if (!alerts.length) {
    el.innerHTML = `
      <div class="alert-header">
        <div class="alert-title">价格提醒</div>
      </div>
      <div class="empty">暂无提醒<br><span style="font-size:13px;color:var(--wx-muted);">在盯盘列表长按证券可添加提醒</span></div>
    `;
    return;
  }
  const enabledCount = alerts.filter((a) => a.enabled && !a.triggered).length;
  const triggeredCount = alerts.filter((a) => a.triggered).length;
  el.innerHTML = `
    <div class="alert-header">
      <div class="alert-title">价格提醒</div>
      <div class="alert-stats">
        <span class="alert-stat active">监控中 ${enabledCount}</span>
        <span class="alert-stat done">已触发 ${triggeredCount}</span>
      </div>
    </div>
    <div class="alert-list">
      ${alerts.map((a) => {
        const rt = state._rtPrices?.[a.code];
        const curPrice = rt?.price;
        const name = a.name || rt?.name || a.code;
        const typeText = alertTypeLabel(a.type);
        let valueText = '';
        if (a.type === 'price_above' || a.type === 'price_below') {
          valueText = formatPrice(a.code, a.value);
        } else {
          valueText = (a.value > 0 ? '+' : '') + a.value.toFixed(2) + '%';
        }
        const statusCls = a.triggered ? 'triggered' : (a.enabled ? 'active' : 'disabled');
        const statusText = a.triggered ? '已触发' : (a.enabled ? '监控中' : '已关闭');
        const curText = curPrice != null ? `当前：${formatPrice(a.code, curPrice)}` : '';
        return `
          <div class="alert-card ${statusCls}" data-id="${a.id}">
            <div class="alert-card-head">
              <div class="alert-card-info">
                <div class="alert-card-name">${name}</div>
                <div class="alert-card-code">${a.code.toUpperCase()}</div>
              </div>
              <div class="alert-card-status ${statusCls}">${statusText}</div>
            </div>
            <div class="alert-card-body">
              <div class="alert-card-condition">
                <span class="alert-type-tag">${typeText}</span>
                <span class="alert-target-value">${valueText}</span>
              </div>
              <div class="alert-card-cur">${curText}</div>
            </div>
            <div class="alert-card-actions">
              <button class="alert-action-btn toggle-btn" data-act="toggle">${a.enabled ? '关闭' : '开启'}</button>
              <button class="alert-action-btn delete-btn" data-act="delete">删除</button>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
  el.querySelectorAll('.alert-card').forEach((card) => {
    const id = card.dataset.id;
    card.querySelector('[data-act="toggle"]').onclick = (e) => {
      e.stopPropagation();
      toggleAlert(id);
      renderAlertView();
    };
    card.querySelector('[data-act="delete"]').onclick = (e) => {
      e.stopPropagation();
      removeAlert(id);
      renderAlertView();
    };
  });
}

// ========== 添加提醒弹窗 ==========
let _alertSheetCode = null;

function openAddAlertSheet(code, name) {
  _alertSheetCode = code;
  const sec = state.securities.find((s) => s.code === code);
  const rt = state._rtPrices?.[code];
  const curPrice = rt?.price;
  const displayName = name || sec?.name || rt?.name || code;

  const existing = document.getElementById('alert-sheet');
  if (existing) existing.remove();

  const sheet = document.createElement('div');
  sheet.id = 'alert-sheet';
  sheet.className = 'action-sheet-mask';
  sheet.innerHTML = `
    <div class="action-sheet">
      <div class="action-sheet-title">
        <span>${displayName}</span>
        <button class="action-sheet-close" aria-label="关闭">×</button>
      </div>
      <div class="alert-sheet-body">
        <div class="alert-type-group">
          <div class="alert-type-label">提醒类型</div>
          <div class="alert-type-options">
            <button class="alert-type-opt active" data-type="price_above">价格上破</button>
            <button class="alert-type-opt" data-type="price_below">价格下破</button>
            <button class="alert-type-opt" data-type="change_pct_up">涨幅超过</button>
            <button class="alert-type-opt" data-type="change_pct_down">跌幅超过</button>
          </div>
        </div>
        <div class="alert-input-group">
          <div class="alert-input-label">目标值</div>
          <div class="alert-input-row">
            <input type="number" id="alert-input-value" step="0.001" placeholder="${curPrice != null ? '当前价 ' + formatPrice(code, curPrice) : '请输入'}">
            <span id="alert-input-unit">元</span>
          </div>
        </div>
        <div class="alert-quick-row">
          <button class="alert-quick-btn" data-pct="1">+1%</button>
          <button class="alert-quick-btn" data-pct="3">+3%</button>
          <button class="alert-quick-btn" data-pct="5">+5%</button>
          <button class="alert-quick-btn" data-pct="-1">-1%</button>
          <button class="alert-quick-btn" data-pct="-3">-3%</button>
          <button class="alert-quick-btn" data-pct="-5">-5%</button>
        </div>
      </div>
      <div class="action-sheet-footer">
        <button id="alert-add-confirm" class="primary">添加提醒</button>
      </div>
    </div>
  `;
  document.body.appendChild(sheet);

  let selectedType = 'price_above';

  const updateUnit = () => {
    const unitEl = sheet.querySelector('#alert-input-unit');
    if (selectedType.startsWith('change_pct')) {
      unitEl.textContent = '%';
    } else {
      unitEl.textContent = isETF(code) ? '元' : '元';
    }
  };

  sheet.querySelectorAll('.alert-type-opt').forEach((btn) => {
    btn.onclick = () => {
      sheet.querySelectorAll('.alert-type-opt').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedType = btn.dataset.type;
      updateUnit();
      const input = sheet.querySelector('#alert-input-value');
      if (selectedType.startsWith('change_pct')) {
        input.placeholder = '如 3.00';
        input.step = '0.01';
      } else {
        input.placeholder = curPrice != null ? '当前价 ' + formatPrice(code, curPrice) : '请输入';
        input.step = isETF(code) ? '0.001' : '0.01';
      }
    };
  });

  sheet.querySelectorAll('.alert-quick-btn').forEach((btn) => {
    btn.onclick = () => {
      const pct = parseFloat(btn.dataset.pct);
      const input = sheet.querySelector('#alert-input-value');
      if (curPrice != null) {
        const target = curPrice * (1 + pct / 100);
        input.value = formatPrice(code, target);
        sheet.querySelectorAll('.alert-type-opt').forEach((b) => b.classList.remove('active'));
        if (pct > 0) {
          selectedType = 'price_above';
          sheet.querySelector('[data-type="price_above"]').classList.add('active');
        } else {
          selectedType = 'price_below';
          sheet.querySelector('[data-type="price_below"]').classList.add('active');
        }
        updateUnit();
      }
    };
  });

  sheet.querySelector('.action-sheet-close').onclick = () => sheet.remove();
  sheet.onclick = (e) => { if (e.target === sheet) sheet.remove(); };

  sheet.querySelector('#alert-add-confirm').onclick = () => {
    const input = sheet.querySelector('#alert-input-value');
    const val = parseFloat(input.value);
    if (isNaN(val) || val <= 0) {
      alert('请输入有效的目标值');
      return;
    }
    addAlert({
      code,
      name: displayName,
      type: selectedType,
      value: val,
    });
    sheet.remove();
    if (state.activeTab === 'alert') renderAlertView();
    startAlertMonitor();
  };

  requestAnimationFrame(() => sheet.classList.add('show'));
}

// ========== 通知横幅 ==========
function showAlertNotification(alertItem, curPrice) {
  const existing = document.getElementById('alert-notification');
  if (existing) existing.remove();

  const name = alertItem.name || alertItem.code;
  const typeText = alertTypeLabel(alertItem.type);
  let valueText = '';
  if (alertItem.type === 'price_above' || alertItem.type === 'price_below') {
    valueText = formatPrice(alertItem.code, alertItem.value);
  } else {
    valueText = (alertItem.value > 0 ? '+' : '') + alertItem.value.toFixed(2) + '%';
  }
  const curText = curPrice != null ? `当前价 ${formatPrice(alertItem.code, curPrice)}` : '';

  const el = document.createElement('div');
  el.id = 'alert-notification';
  el.className = 'alert-notification';
  el.innerHTML = `
    <div class="alert-notif-icon">🔔</div>
    <div class="alert-notif-body">
      <div class="alert-notif-title">${name} · ${typeText}</div>
      <div class="alert-notif-desc">目标 ${valueText} · ${curText}</div>
    </div>
    <button class="alert-notif-close" aria-label="关闭">×</button>
  `;
  document.body.appendChild(el);

  el.querySelector('.alert-notif-close').onclick = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  };
  el.onclick = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
    switchTab('alert');
  };

  try {
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
  } catch {}

  requestAnimationFrame(() => {
    el.classList.add('show');
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 5000);
  });
}

// ========== 提醒检测与监控 ==========
function checkAlerts(rtPrices) {
  const triggered = [];
  for (const alert of state.alerts) {
    if (!alert.enabled || alert.triggered) continue;
    if (state._alertNotified.has(alert.id)) continue;
    const rt = rtPrices[alert.code];
    if (!rt || !rt.price || !rt.prevClose) continue;

    let hit = false;
    switch (alert.type) {
      case 'price_above':
        hit = rt.price >= alert.value;
        break;
      case 'price_below':
        hit = rt.price <= alert.value;
        break;
      case 'change_pct_up': {
        const pct = ((rt.price - rt.prevClose) / rt.prevClose) * 100;
        hit = pct >= alert.value;
        break;
      }
      case 'change_pct_down': {
        const pct = ((rt.price - rt.prevClose) / rt.prevClose) * 100;
        hit = pct <= -Math.abs(alert.value);
        break;
      }
    }

    if (hit) {
      alert.triggered = true;
      alert.triggeredAt = Date.now();
      state._alertNotified.add(alert.id);
      triggered.push({ alert, curPrice: rt.price });
    }
  }
  if (triggered.length) {
    saveAlerts();
    triggered.forEach(({ alert, curPrice }) => showAlertNotification(alert, curPrice));
    if (state.activeTab === 'alert') renderAlertView();
  }
  return triggered;
}

function startAlertMonitor() {
  if (state._alertTimer) return;
  const activeAlerts = state.alerts.filter((a) => a.enabled && !a.triggered);
  if (!activeAlerts.length) return;

  state._alertTimer = setInterval(async () => {
    if (document.hidden) return;
    const activeAlerts = state.alerts.filter((a) => a.enabled && !a.triggered);
    if (!activeAlerts.length) return;
    const codes = [...new Set(activeAlerts.map((a) => a.code))];
    if (!codes.length) return;
    try {
      const rt = await fetchRealtimeMulti(codes);
      if (rt) {
        state._rtPrices = { ...state._rtPrices, ...rt };
        checkAlerts(rt);
        if (state.activeTab === 'alert') renderAlertView();
        if (state.activeTab === 'dingpan' && state.view === 'list') renderSecurityList(state.searchQuery);
      }
    } catch {}
  }, 5000);
}

function stopAlertMonitor() {
  if (state._alertTimer) {
    clearInterval(state._alertTimer);
    state._alertTimer = null;
  }
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

  const headerBack = document.getElementById('btn-header-back');
  if (headerBack) headerBack.addEventListener('click', () => goBack());

  // 详情页证券卡片：下滚超过阈值时折叠为单行（吸顶由 CSS 处理）
  window.addEventListener('scroll', onDetailScroll, { passive: true });

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

  // file:// 模式下无法 fetch 站点数据，不进入加载态（保持「暂无画线数据」提示并引导用 start_chanm.bat）
  if (location.protocol !== 'file:') loadState.loading = true;

  // 先校准 tabbar 视口位置，再渲染首屏；避免小米等机型首屏时 bottom 计算延迟
  initTabbarViewportFix();

  switchTab('dingpan'); // 先渲染：若本地无缓存则显示「加载中…」而非「暂无画线数据」
  history.replaceState({ chanmView: 'list' }, '');
  startIndexRealtime();

  state.alerts = loadAlerts();
  startAlertMonitor();

  // 自动加载画线数据（file:// 模式下跳过）
  if (location.protocol !== 'file:') {
    loadAllDrawings();
  }

  if ('serviceWorker' in navigator && !window.__CHANM_NOCACHE__) {
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js?v=20260720a').catch(() => {}));
  }

  window.__CHANM_LOADED__ = true;
}

init();
window.navigate = navigate;
