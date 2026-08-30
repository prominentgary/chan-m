import { createRequire } from 'module';
import {
  calcNaturalDuanEndFull, canContinueFromSeg, narrowAlleyResult, rollbackResult,
  findBarIdxByTime, mergeCandidatePlatforms, evalWatchSegmentDone, evalAutoContinue,
  evalNextSegmentExhausted, tightenCurrentResult,
} from './js/watchmode.js';
const requireNode = createRequire(import.meta.url);
const t0 = 1782797400;

let pass = 0, fail = 0;
const assert = (name, cond, extra) => { cond?pass++:fail++; console.log((cond?'  [PASS] ':'  [FAIL] ')+name+(extra?'   '+extra:'')); };

// 严格单调上行（无逆向极值、无重叠）：用于验证「已画完」与「wait」分支
function mono(n, start, step, startAt=0) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const p = start + i*step;
    arr.push({ time: t0 + (startAt + i)*1800, open:p, high:p, low:p, close:p });
  }
  return arr;
}

// 交替上/下尖峰（high 交替 1.03/1.05，low 交替 0.97/0.95）→ distinct peaks，制造大 overlap 跨数且保留多个可收紧极值
function zig(n, startAt=48) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const even = i % 2 === 0;
    const high = even ? 1.03 : 1.05;
    const low = even ? 0.97 : 0.95;
    arr.push({ time: t0 + (startAt + i) * 1800, open: (high+low)/2, high, low, close: (high+low)/2 });
  }
  return arr;
}

// ============ 窄胡同：a = 同一走廊内的递增平台(各间距>2N，互不合并/压制)，a.end=末平台峰值；其后 9+ 根持续上行 → b(down)长档失败 → 收紧 a(仅长档) 回溯到更早平台 ============
console.log('\n[窄胡同 - 合成成功]');
const A = [];
for (let i = 0; i < 25; i++) { // 走廊 bar0..24，全体 low=0.97 保证 overlap 连续（aSpan 大）
  let hi = 1.0;                      // 基准高
  if (i >= 2  && i <= 4)  hi = 1.02; // 平台1 (间隔>窗口，不被压制)
  if (i >= 10 && i <= 12) hi = 1.05; // 平台2
  if (i >= 18 && i <= 20) hi = 1.08; // 平台3
  if (i === 24) hi = 1.12;           // a.end 峰值
  A.push({ time: t0 + i*1800, open: (hi+0.97)/2, high: hi, low: 0.97, close: (hi+0.97)/2 });
}
for (let i = 25; i < 42; i++) { const p = 0.9 + (i-25)*0.3; A.push({ time: t0 + i*1800, open:p, high:p+0.02, low:p-0.02, close:p }); } // 随后严格上行
const a = { id:'A', direction:'up', start:{time:A[0].time,price:0.97}, end:{time:A[24].time,price:1.12} };
const aRight = findBarIdxByTime(A, a.end.time);
const b = calcNaturalDuanEndFull(A, aRight, a.end.price, 'down');
const ample = (A.length - aRight) >= 9;
const bLong = b && b.matchedTier && b.matchedTier.indexOf('长档')===0;
const n = narrowAlleyResult(a, [a], A);
console.log('  b._reason:', (b&&b._reason), '| b长档:', !!bLong, '| 充足:', ample, '| narrow:', JSON.stringify(n));
// —— 调试：直接看 findExtremes 返回与各候选跨度 ——
const Araw = (await import('./js/watchmode.js')).findExtremes(A, 0, 'up', 7, 50, 0.97);
console.log('  原始候选:', JSON.stringify(Araw.map(p=>`${p.barIdx}:${p.price}`)));
for (const p of Araw) console.log('  span('+p.barIdx+')=', (await import('./js/watchmode.js')).calcMaxOverlapSpan(A,0,p.barIdx));
const rec = calcNaturalDuanEndFull(A, 0, 0.97, 'up', 17, true);
console.log('  REC(收紧重算):', JSON.stringify({reason:rec._reason, endInfo:rec.endInfo, tier:rec.matchedTier, hit:rec.hitExtremes?.map(p=>p.barIdx)}));
console.log('  b._reason:', (b&&b._reason), '| b长档:', !!bLong, '| 充足:', ample, '| narrow:', JSON.stringify(n));
assert('窄胡同-行情充足', ample);
assert('窄胡同-b未命中长档', !bLong);
assert('窄胡同-收紧成功(ok:true)', n.ok === true);
assert('窄胡同-收紧终点更早', n.ok && n.newEnd.barIdx < aRight);
assert('窄胡同-返回tempMax', n.ok && n.tempMax > 0);

// ============ 死胡同：前段 a2 = 交替尖峰区间(bar0..18, bar18=峰值1.08)；w=下行3根；其后严格跌破→ canContinue(up) 失败 rule_not_found → 回溯收紧 a2 ============
console.log('\n[死胡同 - 合成成功]');
const B = zig(19, 0);
B[18].high = 1.08; B[18].close = 1.08; B[18].low = 0.97;
for (let i = 19; i < 22; i++) { const p = 1.0 - (i-19)*0.1; B.push({ time: t0 + i*1800, open:p, high:p+0.01, low:p-0.01, close:p }); } // w
for (let i = 22; i < 40; i++) { const p = 0.6 - (i-22)*0.1; B.push({ time: t0 + i*1800, open:p, high:p-0.05, low:p-0.1, close:p }); } // 严格跌破：high < w.end
const a2 = { id:'a2', direction:'up', start:{time:B[0].time,price:0.97}, end:{time:B[18].time,price:1.08} };
const w = { id:'w', direction:'down', start:{time:B[18].time,price:1.08}, end:{time:B[20].time,price:0.82} };
const segs2 = [a2, w];
const a2Right = findBarIdxByTime(B, a2.end.time);
const con = canContinueFromSeg(segs2, w, B);
const rb = rollbackResult(segs2, w, B);
console.log('  canContinue:', JSON.stringify(con));
console.log('  rollback:', JSON.stringify(rb));
assert('死胡同-续接失败且非already_done', con.can === false && con.reason === 'rule_not_found');
assert('死胡同-回溯成功(ok:true)', rb.ok === true);
assert('死胡同-回溯到前段a2', rb.ok && rb.prevSeg === a2);
assert('死胡同-回溯终点更早', rb.ok && rb.newEnd.barIdx < a2Right);

// ============ 「已画完(avail<9)」排除：窄胡同/死胡同都不应触发（这是调用点 guard） ============
console.log('\n[窄胡同/死胡同 - 已画完(avail<9)排除]');
// a) 窄胡同 guard：b 起步后行情不足9根(avail<9) => 调用点 `bars.length-startIdx>=9` 为假，不收紧
const r = mono(7, 0, 0.05, 0); // 7 根严格上行，其后无下行极值
const ra = { id:'ra', direction:'up', start:{time:r[0].time,price:1.0}, end:{time:r[1].time,price:1.05} };
const raRight = findBarIdxByTime(r, ra.end.time);
const rb2 = calcNaturalDuanEndFull(r, raRight, ra.end.price, 'down');
const raAvail = r.length - raRight;
const narrowGuard = raAvail >= 9; // 与 app.js L2644 一致
assert('已画完-窄胡同guard(avail<9不触发)', narrowGuard === false && (rb2 && rb2._reason === 'already_done'));
console.log('  avail:', raAvail, 'b._reason:', rb2?._reason, '窄胡同触发?', !!narrowGuard);
// b) 死胡同 guard：canContinueFromSeg 判 already_done（而非 rule_not_found，不再走回溯）
const d = mono(5, 0, 0.02, 0);
const da = { id:'da', direction:'up', start:{time:d[0].time,price:1.0}, end:{time:d[3].time,price:1.05} };
const db = { id:'db', direction:'down', start:{time:d[3].time,price:1.05}, end:{time:d[4].time,price:1.04} };
const dCon = canContinueFromSeg([da, db], db, d);
console.log('  死胡同 canContinue:', JSON.stringify({can:dCon.can, reason:dCon.reason, tier:dCon.matchedTier}));
assert('已画完-死胡同guard判already_done', dCon.can === false && dCon.reason === 'already_done');

// ============ 短档兜底：无长档候选时命中短档[3,9) ============
console.log('\n[短档兜底 - 合成成功]');
const shortBars = zig(8, 0); // 交替尖峰，起步跨数至多 8 => 长档无望，短档命中
const sh = calcNaturalDuanEndFull(shortBars, 0, shortBars[0].close, 'up');
console.log('  短档结果:', JSON.stringify({reason:sh._reason, tier:sh.matchedTier, end:sh.endInfo?sh.endInfo.barIdx:'-', hit:sh.hitExtremes?.map(p=>p.barIdx)}));
assert('短档-命中短档且找到终点', !!sh.endInfo && (sh.matchedTier || '').indexOf('短档') === 0);
assert('短档-终点在起步后', !!sh.endInfo && sh.endInfo.barIdx > 0);

// ============ 平台合并 mergeCandidatePlatforms 三分支 ============
console.log('\n[平台合并 mergeCandidatePlatforms]');
const mk = (...prices) => prices.map((price, i) => ({ time: t0 + i*1800, price }));
const pl2 = mergeCandidatePlatforms(mk(1.0, 1.0));                                   // 2根 -> 首
const pl4 = mergeCandidatePlatforms(mk(1.0, 1.0, 1.0, 1.0));                         // 4根 -> 中间(偶数偏左 idx1)
const pl12 = mergeCandidatePlatforms(Array(12).fill(1.0));                           // 12根 -> 首/中/尾
assert('平台合并-2根取首', pl2.length === 1 && pl2[0].price === 1.0);
assert('平台合并-4根取中间', pl4.length === 1 && pl4[0].time === t0 + 1*1800);
assert('平台合并-12根取首中尾', pl12.length === 3);

// ============ evalWatchSegmentDone 阶段：growing / confirming / done ============
console.log('\n[evalWatchSegmentDone 阶段]');
const g40 = () => zig(40, 0); // 全链 overlap，span≈总根数
// growing：起步span<=27 未封顶
const gr = g40();
const gSeg = { id:'g', direction:'up', start:{time:gr[0].time,price:0.97}, end:{time:gr[3].time,price:1.03} };
const gDone = evalWatchSegmentDone(gSeg, gr.slice(0, 10), 0); // 仅10根: span=10<=27未封顶
console.log('  growing:', JSON.stringify({done:gDone.done, capped:gDone.capped, confirmed:gDone.confirmed, maxSpan:gDone.maxSpan}));
assert('段阶段-growing未画完(not capped)', gDone.done === false && gDone.capped === false);
// confirming：起步span>27 封顶但 line头 未确认
const cfSeg = { ...gSeg, end:{time:gr[30].time,price:1.03} };
const cfDone = evalWatchSegmentDone(cfSeg, gr, 0); // lastIdx=39, endIdx=30 => 未确认
console.log('  confirming:', JSON.stringify({done:cfDone.done, capped:cfDone.capped, confirmed:cfDone.confirmed}));
assert('段阶段-confirming(封顶未确认)', cfDone.done === false && cfDone.capped === true && cfDone.confirmed === false);
// done：封顶且 line头 已确认(endIdx 距 latest >= 10)
const dnSeg = { ...gSeg, end:{time:gr[8].time,price:1.03} };
const dnDone = evalWatchSegmentDone(dnSeg, gr, 0); // lastIdx=39, endIdx=8
console.log('  done:', JSON.stringify({done:dnDone.done, capped:dnDone.capped, confirmed:dnDone.confirmed}));
assert('段阶段-done(封顶且确认)', dnDone.done === true && dnDone.capped === true && dnDone.confirmed === true);

// ============ evalAutoContinue 判定：continue / wait / fix ============
console.log('\n[evalAutoContinue 判定]');
// continue：zig 全链 overlap 封顶且确认，且下一段(反向)可找到极值
const cnSeg = { id:'cn', direction:'up', start:{time:g40()[0].time,price:0.97}, end:{time:g40()[6].time,price:1.05} };
const cnVerdict = evalAutoContinue([cnSeg], cnSeg, /*bars*/ zig(40,0), 0);
console.log('  continue 判定:', cnVerdict);
assert('自动- continue(可续接)', cnVerdict === 'continue');
// wait：封顶确认、下一段不可接、但下一段 span<=27(仍长) → wait
const wt = zig(31, 0); // bars0..30 全链 overlap(31根) => capped；且后无重叠单链
const wtSeg = { id:'wt', direction:'up', start:{time:wt[0].time,price:0.97}, end:{time:wt[30].time,price:1.05} };
for (let i = 31; i < 56; i++) { const p = 1.20 + (i-31)*0.05; wt.push({ time: t0 + i*1800, open:p, high:p, low:p, close:p }); } // 严格上行(无下行极值、无重叠)
const wtVerdict = evalAutoContinue([wtSeg], wtSeg, wt, 0);
console.log('  wait 判定:', wtVerdict, '| 次段exh:', JSON.stringify(evalNextSegmentExhausted(wtSeg, wt, 0, 30)));
assert('自动- wait(画完等下一段)', wtVerdict === 'wait');
// fix：封顶确认 + 下一段不可接 + 下一段已充分发展(overlap>27 高位平台无反向极值)
const fx = zig(11, 0); // bars0..10
const fxSeg = { id:'fx', direction:'up', start:{time:fx[0].time,price:1.0}, end:{time:fx[10].time,price:1.05} };
for (let i = 11; i < 60; i++) { const p = 1.20; fx.push({ time: t0 + i*1800, open:p, high:p+0.02, low:p-0.02, close:p }); } // 高位重叠平台(low>1.05 无下行极值) span 大
const fxVerdict = evalAutoContinue([fxSeg], fxSeg, fx, 0);
console.log('  fix 判定:', fxVerdict, '| 次段exh:', JSON.stringify(evalNextSegmentExhausted(fxSeg, fx, 0, 11)));
assert('自动- fix(捕尽且不可接)', fxVerdict === 'fix');

// ============ tightenCurrentResult 回修：too_small 守卫 + 成功 ============
console.log('\n[tightenCurrentResult 回修]');
const tiny = zig(6, 0); // seg 跨数很小 -> 收紧后上限<3
const tSeg = { id:'t', direction:'up', start:{time:tiny[0].time,price:0.97}, end:{time:tiny[2].time,price:1.03} };
const tSmall = tightenCurrentResult(tSeg, tiny, 0);
console.log('  too_small:', JSON.stringify(tSmall));
assert('回修-跨数过小守卫(too_small)', tSmall.ok === false && tSmall.reason === 'too_small');
// 成功回修：走廊(低=0.97)内三个错开峰(间距>7，仅 N=7 时早峰不被晚峰压制)，收紧后应回溯到中间峰/早峰
const T2 = [];
for (let i = 0; i < 24; i++) {
  let hi = 1.0;
  if (i === 8)  hi = 1.05; // 早峰
  if (i === 16) hi = 1.08; // 中峰
  if (i === 23) hi = 1.10; // 终点峰
  T2.push({ time: t0 + i*1800, open: (hi+0.97)/2, high: hi, low: 0.97, close: (hi+0.97)/2 });
}
const tSeg2 = { id:'t3', direction:'up', start:{time:T2[0].time,price:0.97}, end:{time:T2[23].time,price:1.10} };
const tR2 = tightenCurrentResult(tSeg2, T2, 0);
console.log('  回修成功:', JSON.stringify({ok:tR2.ok, newEnd:tR2.newEnd?tR2.newEnd.barIdx:'-', price:tR2.newEnd?.price, tempMax:tR2.tempMax, curSpan:tR2.curSpan, reason:tR2.reason}));
assert('回修-成功收紧到更早终点', tR2.ok === true && tR2.newEnd.barIdx > 0 && tR2.newEnd.barIdx < 23);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);