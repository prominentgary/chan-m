// macd.js —— MACD 计算（DIF / DEA / 柱）
// 输入归一化 bars（含 close），原地补充 dif/dea/macd 字段

function ema(arr, period, key) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  for (let i = 0; i < arr.length; i++) {
    prev = i === 0 ? arr[0][key] : arr[i][key] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function computeMACD(bars, fast = 12, slow = 26, signal = 9) {
  if (!bars.length) return bars;
  const closeEmaFast = ema(bars, fast, 'close');
  const closeEmaSlow = ema(bars, slow, 'close');
  const dif = bars.map((_, i) => closeEmaFast[i] - closeEmaSlow[i]);
  // DEA = EMA(dif, 9)
  const k = 2 / (signal + 1);
  const dea = [];
  let prev = dif[0];
  for (let i = 0; i < dif.length; i++) {
    prev = i === 0 ? dif[0] : dif[i] * k + prev * (1 - k);
    dea.push(prev);
  }
  bars.forEach((b, i) => {
    b.dif = dif[i];
    b.dea = dea[i];
    b.macd = (dif[i] - dea[i]) * 2; // 柱（红正绿负）
  });
  return bars;
}
