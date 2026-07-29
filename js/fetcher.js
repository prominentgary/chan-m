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


