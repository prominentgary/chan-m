// fetcher.js —— 腾讯财经接口封装（已实测，2026-07-11）
// 纯前端直连，CORS: Access-Control-Allow-Origin: *
// 归一化输出：{ time:秒, open, close, high, low, volume }

import { applyForwardAdjustAsync } from './adjust.js?v=20260725b';

// 腾讯 qt.ifzq.gtimg.cn 系列接口返回 GBK 编码的文本。
// 直接用 fetch().text() 默认按 UTF-8 解码会导致中文名乱码（锟斤拷）。
// 因此改为读取 arrayBuffer 后按服务端声明的字符集（或 GBK）解码。
async function fetchAsText(url) {
  const resp = await fetch(url);
  const buf = await resp.arrayBuffer();
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  // 提取 charset，如 gb2312 / gbk / gb18030 / utf-8
  const m = ct.match(/charset=([\w-]+)/);
  let charset = m ? m[1].toLowerCase() : '';
  if (!charset || charset === 'gb2312' || charset === 'gb18030') charset = 'gbk';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch (_) {
    return new TextDecoder('utf-8').decode(buf);
  }
}

// 专业展示代码（159611.SZ）<-> 腾讯接口代码（sz159611）
export function toApiCode(code) {
  const s = String(code || '').trim();
  const m = s.match(/^(\d{6})\.(SZ|SH)$/i);
  if (m) return m[2].toLowerCase() + m[1];
  if (/^(sh|sz)/i.test(s)) return s.toLowerCase();
  return s.toLowerCase();
}

export function toDisplayCode(code) {
  const s = String(code || '').trim().toLowerCase();
  if (/^(sh|sz)/i.test(s)) {
    const market = s.slice(0, 2).toUpperCase();
    return `${s.slice(2)}.${market === 'SH' ? 'SH' : 'SZ'}`;
  }
  const m = s.match(/^(\d{6})\.(sz|sh)$/i);
  if (m) return `${m[1]}.${m[2].toUpperCase()}`;
  return s.toUpperCase();
}

// 日/周/月 K线：使用腾讯官方"前复权"接口（fqkline + qfq），
// 历史价格已按除权/份额折算校正，无断层。若 qfq 字段缺失则回退不复权
// 数据（由 fetchBars 里的本地前复权兜底）。
async function fetchDay(code, period, count = 320) {
  const api = toApiCode(code);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${api},${period},,,${count},qfq`;
  const json = await (await fetch(url)).json();
  const d = json?.data?.[api] || {};
  const arr = d['qfq' + period] || d[period] || [];
  return arr.map((k) => ({
    time: dateStrToSec(k[0]),
    open: +k[1], close: +k[2], high: +k[3], low: +k[4], volume: +k[5],
  }));
}

// 分钟 K线：host 不带 web.，返回 JSONP（m5_today=...）
async function fetchMinute(code, period, count = 640) {
  const api = toApiCode(code);
  const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${api},${period},,${count}&_var=${period}_today`;
  const text = await (await fetch(url)).text();
  const json = JSON.parse(text.replace(/^.*?=/, ''));
  const arr = json?.data?.[api]?.[period] || [];
  const bars = arr.map((k) => ({
    time: minuteStrToSec(k[0]),
    open: +k[1], close: +k[2], high: +k[3], low: +k[4], volume: +(k[5] || 0),
  }));
  return { bars, qt: json?.data?.[api]?.qt?.[api] || null };
}

// 实时行情：赋值串 v_code="f1~f2~..."
async function fetchRealtime(code) {
  const api = toApiCode(code);
  const url = `https://qt.gtimg.cn/q=${api}`;
  const text = await fetchAsText(url);
  const m = text.match(/="([^"]*)"/);
  if (!m) return null;
  const f = m[1].split('~');
  return {
    name: f[1],
    code: f[2],
    price: +f[3],
    prevClose: +f[4],
    open: +f[5],
    high: +f[33] || +f[6],
    low: +f[34] || +f[7],
    time: f[30] || '',
  };
}

// 批量实时行情（一次查多个代码），返回 { code: {name, code, price, prevClose} }，无效代码不返回。
// 入参 code 可统一为专业格式（159611.SZ），返回 key 也会映射回原始入参代码，保持与本地数据一致。
export async function fetchRealtimeMulti(codes) {
  const apiCodes = codes.map((c) => toApiCode(c));
  const url = `https://qt.gtimg.cn/q=${apiCodes.join(',')}`;
  const text = await fetchAsText(url);
  const out = {};
  text.split(';').forEach((line) => {
    const m = line.match(/v_(\w+)="([^"]*)"/);
    if (!m) return;
    const f = m[2].split('~');
    if (!f[1]) return; // 无名称 = 无效代码
    const price = +f[3];
    const prevClose = +f[4];
    out[m[1]] = { name: f[1], code: f[2], price, prevClose };
  });
  // 把结果 key 从腾讯代码（sh/sz 前缀）映射回原始入参代码（专业格式）
  const map = {};
  apiCodes.forEach((api, i) => { map[api] = codes[i]; });
  const remapped = {};
  for (const [k, v] of Object.entries(out)) {
    remapped[map[k] || k] = v;
  }
  return remapped;
}

// 代码归一化辅助：
//  - 已带 sh/sz 前缀 → 原样（转小写）返回
//  - 纯数字代码 → 返回 null，需走 resolveCode 异步确定市场
export function normalizeCode(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (/^(sh|sz)/.test(s)) return s;
  return null;
}

// 解析用户输入的代码：纯数字时询问腾讯实时接口确定 sh/sz 前缀。
// 沪/深同号（如 000001 既是上证指数也是平安银行）属歧义，取第一个有效市场；
// 如需精确指定，请在手机端直接输入 sh/sz 前缀或专业格式（159611.SZ）。
// 统一返回专业展示格式（159611.SZ / 588080.SH）。
export async function resolveCode(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{6})\.(SZ|SH)$/i);
  if (m) return `${m[1]}.${m[2].toUpperCase()}`;
  if (/^(sh|sz)/i.test(s)) return toDisplayCode(s);
  if (!/^\d+$/.test(s)) return toDisplayCode(s);
  const candidates = ['sh' + s, 'sz' + s];
  try {
    const r = await fetchRealtimeMulti(candidates);
    for (const c of candidates) if (r[c]) return toDisplayCode(c);
  } catch (e) {}
  return toDisplayCode('sh' + s); // 兜底
}

// UI 周期 -> 腾讯分钟线周期（腾讯接口用 m1/m5/m15/m30/m60）
const TENCENT_MINUTE = { '1m': 'm1', '5m': 'm5', '15m': 'm15', '30m': 'm30', '60m': 'm60' };

// 统一入口：根据周期自动选日线/分钟线。
// 日/周/月线直接用官方 qfq 前复权数据（applyForwardAdjustAsync 检测不到
// 断层时原样返回，仅在回退到不复权数据时兜底）；分钟线腾讯无 qfq 接口，
// 用官方 qfq 日线推导精确因子做本地前复权。
export async function fetchBars(code, period, count) {
  const api = toApiCode(code);
  if (period === 'day' || period === 'week' || period === 'month') {
    const bars = await fetchDay(api, period, count);
    return { bars: await applyForwardAdjustAsync(bars, period, api), qt: null };
  }
  const tp = TENCENT_MINUTE[period] || period;
  const res = await fetchMinute(api, tp, count);
  return { ...res, bars: await applyForwardAdjustAsync(res.bars, period, api) };
}

// ---- 时间解析 ----
export function dateStrToSec(s) {
  // "2025-03-18" -> 当天 00:00 的 Unix 秒
  return Math.floor(new Date(s.replace(/-/g, '/') + ' 00:00:00').getTime() / 1000);
}
export function minuteStrToSec(s) {
  // "202606231345" -> Unix 秒
  const y = +s.slice(0, 4), mo = +s.slice(4, 6), d = +s.slice(6, 8);
  const h = +s.slice(8, 10), mi = +s.slice(10, 12);
  return Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000);
}
export function secToInputValue(sec) {
  // -> "YYYY-MM-DDTHH:mm" 供 datetime-local 使用
  const dt = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`;
}
export function inputValueToSec(v) {
  const [d, t] = v.split('T');
  const [Y, M, D] = d.split('-').map(Number);
  const [h, m] = (t || '00:00').split(':').map(Number);
  return Math.floor(new Date(Y, M - 1, D, h, m).getTime() / 1000);
}
export function formatTime(sec, withTime = true) {
  const dt = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const d = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  return withTime ? `${d} ${p(dt.getHours())}:${p(dt.getMinutes())}` : d;
}

// 判断是否为 ETF/基金：代码以 1 或 5 开头的 6 位数字（兼容 sh/sz 前缀与 .SZ/.SH 后缀）
export function isETF(code) {
  const c = String(code || '')
    .replace(/^(sh|sz)/i, '')
    .replace(/\.(SZ|SH)$/i, '');
  return /^[15]\d{5}$/.test(c);
}

// 格式化价格：ETF 保留 3 位，股票/指数保留 2 位
export function formatPrice(code, price) {
  if (price == null || Number.isNaN(price)) return '';
  const digits = isETF(code) ? 3 : 2;
  return price.toFixed(digits);
}

// ---- 大盘涨跌分布（沪深京 A 股全量统计，口径对齐东方财富行情页）----
// 说明：push2ex 的 getTopicZDFenBu 返回的是一份更新不及时/口径不同的快照，
// 与东财行情页上的实时涨跌分布对不上（实测收盘时 涨家数 4716 vs 4869），故不用它。
// 这里按东财行情页的口径自己统计：拉全量 A 股（约 5900 只，100 只/页，并发 10），
// 只取 f3（涨跌幅%）分档；涨停/跌停数取东财涨停池/跌停池的 tc（与图上「涨停/跌停」一致）。
// 分档（与东财 9 根柱一致）：涨停 / 5%以上 / 1-5% / 0-1% / 平盘 / 0-1% / 1-5% / 5%以下 / 跌停
const A_SHARE_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
// 注意：clist 的 pz 硬上限是 100（实测传 6000 仍只回 100 条），只能分页拉全量。
// 并发从 6 提到 10，约 59 页的串行波次由 10 降到 6，实测耗时约减半。
const BREADTH_PZ = 100;
const BREADTH_CONCURRENCY = 10;

async function fetchAsharePage(pn) {
  const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${BREADTH_PZ}&np=1&fltt=2&invt=2&fid=f3&po=1&fs=${A_SHARE_FS}&fields=f3&_=${Date.now()}`;
  const res = await fetch(url);
  const json = await res.json();
  const d = json?.data;
  if (!d || !Array.isArray(d.diff)) throw new Error('clist page empty');
  return { total: +d.total || 0, vals: d.diff.map((o) => o.f3).filter((v) => typeof v === 'number') };
}

// 全量 A 股涨跌幅数组（停牌/无报价的股票 f3 为 "-"，自然被剔除，与东财一致）
async function fetchAllAshareChange() {
  const first = await fetchAsharePage(1);
  const pages = Math.max(1, Math.ceil(first.total / BREADTH_PZ));
  const vals = first.vals.slice();
  let failed = 0;
  let next = 2;
  const worker = async () => {
    for (;;) {
      const pn = next++;
      if (pn > pages) return;
      try {
        const r = await fetchAsharePage(pn);
        for (const v of r.vals) vals.push(v);
      } catch (e) {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BREADTH_CONCURRENCY, pages) }, worker));
  // 掉页超过 10% 视为不完整，宁可不更新也不要出错数
  if (!vals.length || failed > Math.max(2, Math.floor(pages * 0.1))) throw new Error('breadth incomplete');
  return vals;
}

// 涨停/跌停家数：东财涨停池 / 跌停池（date 必须是交易日，节假日向前回退）
async function fetchLimitCount(kind) {
  const api = kind === 'zt' ? 'getTopicZTPool' : 'getTopicDTPool';
  const sort = kind === 'zt' ? 'fbt:asc' : 'fund:asc';
  const d = new Date();
  for (let i = 0; i < 5; i++) {
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const url = `https://push2ex.eastmoney.com/${api}?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=${sort}&date=${ymd}`;
    try {
      const json = await (await fetch(url)).json();
      if (json?.data && Number.isFinite(+json.data.tc)) return +json.data.tc;
    } catch (e) { /* 换前一天再试 */ }
    d.setDate(d.getDate() - 1);
  }
  return null;
}

// 返回 { up, down, flat, limitUp, limitDown, total, buckets:[{label,value,dir,lv}] }
export async function fetchMarketBreadth() {
  const [vals, zt, dt] = await Promise.all([
    fetchAllAshareChange(),
    fetchLimitCount('zt').catch(() => null),
    fetchLimitCount('dt').catch(() => null),
  ]);
  let up = 0, down = 0, flat = 0;
  let ge5 = 0, u1to5 = 0, u0to1 = 0, m1to0 = 0, m5tom1 = 0, le5 = 0;
  for (const v of vals) {
    if (v > 0) up++; else if (v < 0) down++; else flat++;
    if (v >= 5) ge5++;          // ≥5%（含涨停）
    else if (v > 1) u1to5++;    // 1%~5%
    else if (v > 0) u0to1++;    // 0%~1%
    else if (v < -5) le5++;     // ≤-5%（含跌停）
    else if (v < -1) m5tom1++;  // -5%~-1%
    else if (v < 0) m1to0++;    // -1%~0%
  }
  // 涨跌停池拿不到时按 0 处理（对应档位会并入相邻档，不至于出现负数）
  const limitUp = Math.max(0, Math.min(zt == null ? 0 : zt, ge5));
  const limitDown = Math.max(0, Math.min(dt == null ? 0 : dt, le5));
  const buckets = [
    { label: '涨停', value: limitUp, dir: 1, lv: 4 },
    { label: '>5%', value: Math.max(0, ge5 - limitUp), dir: 1, lv: 3 },
    { label: '1-5%', value: u1to5, dir: 1, lv: 2 },
    { label: '0-1%', value: u0to1, dir: 1, lv: 1 },
    { label: '平盘', value: flat, dir: 0, lv: 0 },
    { label: '0-1%', value: m1to0, dir: -1, lv: 1 },
    { label: '1-5%', value: m5tom1, dir: -1, lv: 2 },
    { label: '<-5%', value: Math.max(0, le5 - limitDown), dir: -1, lv: 3 },
    { label: '跌停', value: limitDown, dir: -1, lv: 4 },
  ];
  return { up, down, flat, limitUp, limitDown, total: vals.length, buckets };
}

// ---- 三市成交额（上证 + 深证 + 北证50 的分时成交额即沪深京总成交额）----
// 实时总额走 ulist（一次请求几百字节，10s 级刷新）；「较前一日同期」的基准曲线
// 用分时接口（ndays=2）取一次并缓存 30 分钟，避免每次都拉 2 天分时（约 60KB）。
const AMOUNT_SECIDS = ['1.000001', '0.399001', '0.899050'];
let _amtBaseline = null; // { at, days:[d1,d2], byDate:{day:{'HH:mm':累计成交额}} }

function hmToMin(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

async function buildAmountBaseline() {
  const trendsList = await Promise.all(AMOUNT_SECIDS.map(async (secid) => {
    const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f7,f8&fields2=f51,f53,f56,f57&ndays=2&iscr=0&_=${Date.now()}`;
    const json = await (await fetch(url)).json();
    return json?.data?.trends || [];
  }));
  // day -> { 'HH:mm': 三市累计成交额 }（按分钟累加）
  const acc = {};
  trendsList.forEach((trends) => {
    trends.forEach((line) => {
      const p = String(line).split(',');
      const ts = p[0] || '';
      if (ts.length < 16) return;
      const day = ts.slice(0, 10);
      const hm = ts.slice(11, 16);
      const amt = +p[3] || 0;
      const m = acc[day] || (acc[day] = {});
      m[hm] = (m[hm] || 0) + amt;
    });
  });
  const days = Object.keys(acc).sort();
  if (!days.length) throw new Error('amount baseline empty');
  // 转成累计值
  const byDate = {};
  days.forEach((day) => {
    const src = acc[day];
    let sum = 0;
    const cum = {};
    Object.keys(src).sort().forEach((hm) => { sum += src[hm]; cum[hm] = sum; });
    byDate[day] = cum;
  });
  return { at: Date.now(), days, byDate };
}

async function getAmountBaseline() {
  if (!_amtBaseline || Date.now() - _amtBaseline.at > 30 * 60 * 1000) {
    _amtBaseline = await buildAmountBaseline();
  }
  return _amtBaseline;
}

// 当前时点 → 对比用的分钟（收盘/休市后固定为 15:00）
function amountCutoffHm(now = new Date()) {
  const hm = now.getHours() * 60 + now.getMinutes();
  const p = (n) => String(n).padStart(2, '0');
  if (hm <= 9 * 60 + 30) return '09:30';
  if (hm < 11 * 60 + 30) return `${p(Math.floor(hm / 60))}:${p(hm % 60)}`;
  if (hm < 13 * 60) return '11:30';
  if (hm < 15 * 60) return `${p(Math.floor(hm / 60))}:${p(hm % 60)}`;
  return '15:00';
}

// 返回 { total, prevSame, date } 单位：元
export async function fetchMarketAmount() {
  const [total, baseline] = await Promise.all([
    (async () => {
      const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${AMOUNT_SECIDS.join(',')}&fields=f12,f14,f6&_=${Date.now()}`;
      const json = await (await fetch(url)).json();
      const diff = json?.data?.diff;
      if (!Array.isArray(diff) || !diff.length) throw new Error('amount empty');
      return diff.reduce((a, x) => a + (typeof x.f6 === 'number' ? x.f6 : 0), 0);
    })(),
    getAmountBaseline(),
  ]);
  const days = baseline.days;
  const cur = days[days.length - 1];
  const prev = days.length > 1 ? days[days.length - 2] : null;
  const today = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  // 当前这一档数据不是今天（盘前/休市日）：对比用整日，避免拿半天跟整天比
  const cutoff = cur === today ? amountCutoffHm() : '15:00';
  let prevSame = null;
  if (prev) {
    const pm = baseline.byDate[prev];
    const keys = Object.keys(pm).filter((hm) => hmToMin(hm) <= hmToMin(cutoff)).sort();
    if (keys.length) prevSame = pm[keys[keys.length - 1]];
  }
  return { total, prevSame, date: cur };
}

// ---- 美股指数（东方财富全球指数，secid 由东财统一编号，CORS 已开放）----
// 100.DJIA 道琼斯 / 100.NDX 纳斯达克 / 100.SPX 标普500 / 251.SOX 费城半导体指数
export const US_INDEX_LIST = [
  { secid: '100.DJIA', code: 'DJIA', label: '道琼斯' },
  { secid: '100.NDX', code: 'NDX', label: '纳斯达克' },
  { secid: '100.SPX', code: 'SPX', label: '标普500' },
  { secid: '251.SOX', code: 'SOX', label: '费城半导体' },
];

// 批量实时行情：返回 { DJIA: { price, pct, prevClose }, ... }（key 用 f12 指数代码）
export async function fetchUsIndexQuotes() {
  const secids = US_INDEX_LIST.map((x) => x.secid).join(',');
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f2,f3,f12,f18&_=${Date.now()}`;
  const json = await (await fetch(url)).json();
  const diff = json?.data?.diff;
  if (!Array.isArray(diff) || !diff.length) throw new Error('us quote empty');
  const out = {};
  diff.forEach((x) => {
    out[String(x.f12).toUpperCase()] = {
      price: typeof x.f2 === 'number' ? x.f2 : null,
      pct: typeof x.f3 === 'number' ? x.f3 : null,
      prevClose: typeof x.f18 === 'number' ? x.f18 : null,
    };
  });
  return out;
}

// 分时（最近一个美股交易日，22:30-05:00 或 21:30-04:00，按实际首尾点自适应）
// 返回 { bars:[{time,open,high,low,close,volume}], prevClose, dayStart, dayEnd, date }
export async function fetchUsIndexIntraday(secid) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f7,f8&fields2=f51,f53,f56,f57&ndays=1&iscr=0&_=${Date.now()}`;
  const json = await (await fetch(url)).json();
  const d = json?.data;
  if (!d || !Array.isArray(d.trends) || !d.trends.length) throw new Error('us trends empty');
  const bars = [];
  d.trends.forEach((line) => {
    const p = String(line).split(',');
    const ts = p[0] || '';
    if (ts.length < 16) return;
    const close = +p[1];
    const time = Math.floor(new Date(ts.replace(/-/g, '/')).getTime() / 1000);
    if (!Number.isFinite(time) || !Number.isFinite(close) || close <= 0) return;
    // 分时只有每分钟收盘价，高开低收都取该值：y 轴范围仍由价格序列决定
    bars.push({ time, open: close, high: close, low: close, close, volume: 0 });
  });
  if (!bars.length) throw new Error('us trends parse empty');
  // x 轴固定铺满一个完整交易时段（6.5 小时，首个数据点即开盘时刻）：
  // 盘中只画到当前时刻，不会因为数据少而被拉伸占满整幅图
  const dayStart = bars[0].time;
  const dayEnd = Math.max(dayStart + 6.5 * 3600, bars[bars.length - 1].time);
  return {
    bars,
    prevClose: +d.preClose || 0,
    dayStart,
    dayEnd,
    date: String(d.trends[0]).slice(0, 10),
  };
}


