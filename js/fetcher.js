// fetcher.js —— 腾讯财经接口封装（已实测，2026-07-11）
// 纯前端直连，CORS: Access-Control-Allow-Origin: *
// 归一化输出：{ time:秒, open, close, high, low, volume }

// 日/周/月 K线：host 带 web.，返回纯 JSON
async function fetchDay(code, period, count = 320) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${code},${period},,${count}`;
  const json = await (await fetch(url)).json();
  const arr = json?.data?.[code]?.[period] || [];
  return arr.map((k) => ({
    time: dateStrToSec(k[0]),
    open: +k[1], close: +k[2], high: +k[3], low: +k[4], volume: +k[5],
  }));
}

// 分钟 K线：host 不带 web.，返回 JSONP（m5_today=...）
async function fetchMinute(code, period, count = 640) {
  const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},${period},,${count}&_var=${period}_today`;
  const text = await (await fetch(url)).text();
  const json = JSON.parse(text.replace(/^.*?=/, ''));
  const arr = json?.data?.[code]?.[period] || [];
  const bars = arr.map((k) => ({
    time: minuteStrToSec(k[0]),
    open: +k[1], close: +k[2], high: +k[3], low: +k[4], volume: +(k[5] || 0),
  }));
  return { bars, qt: json?.data?.[code]?.qt?.[code] || null };
}

// 实时行情：赋值串 v_code="f1~f2~..."
async function fetchRealtime(code) {
  const url = `https://qt.gtimg.cn/q=${code}`;
  const text = await (await fetch(url)).text();
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
// 用于纯数字代码自动推断 sh/sz 市场前缀。
export async function fetchRealtimeMulti(codes) {
  const url = `https://qt.gtimg.cn/q=${codes.join(',')}`;
  const text = await (await fetch(url)).text();
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
  return out;
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
// 如需精确指定，请在手机端直接输入 sh/sz 前缀。
export async function resolveCode(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (/^(sh|sz)/.test(s)) return s;
  if (!/^\d+$/.test(s)) return s;
  const candidates = ['sh' + s, 'sz' + s];
  try {
    const r = await fetchRealtimeMulti(candidates);
    for (const c of candidates) if (r[c]) return c;
  } catch (e) {}
  return 'sh' + s; // 兜底
}

// UI 周期 -> 腾讯分钟线周期（腾讯接口用 m1/m5/m15/m30/m60）
const TENCENT_MINUTE = { '1m': 'm1', '5m': 'm5', '15m': 'm15', '30m': 'm30', '60m': 'm60' };

// 统一入口：根据周期自动选日线/分钟线
export async function fetchBars(code, period, count) {
  if (period === 'day' || period === 'week' || period === 'month') {
    const bars = await fetchDay(code, period, count);
    return { bars, qt: null };
  }
  const tp = TENCENT_MINUTE[period] || period;
  return fetchMinute(code, tp, count);
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

// 判断是否为 ETF/基金：代码以 1 或 5 开头的 6 位数字
export function isETF(code) {
  const c = String(code || '').replace(/^(sh|sz)/i, '');
  return /^[15]\d{5}$/.test(c);
}

// 格式化价格：ETF 保留 3 位，股票/指数保留 2 位
export function formatPrice(code, price) {
  if (price == null || Number.isNaN(price)) return '';
  const digits = isETF(code) ? 3 : 2;
  return price.toFixed(digits);
}


