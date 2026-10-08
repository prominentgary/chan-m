// _recalc_recursive.mjs —— 单根段递归（computeRecursiveSegment）规则回归
// 覆盖桌面版 drawing.js「单根点线递归」三大入口在移动端（跨周期承载级别）的映射：
//   B ：链首段起步（起点悬空）+ 相连段 ≥3        → 目标段起点 → 第 3 段终点
//   C ：更高周期左侧最近段方向相反且起点不粘连     → 高段右端点 → 目标段终点
//   C'：更高周期无左侧段时的兜底（链中 idx≥2 且与链首同向）→ 链首起点 → 目标段终点
import { computeRecursiveSegment } from './js/algo.js';

const t0 = 1782797400;
const MIN = 60;

let pass = 0, fail = 0;
const assert = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? '  [PASS] ' : '  [FAIL] ') + name + (extra ? '   ' + extra : '')); };
const mk = (id, st, sp, et, ep, extra) => {
  const seg = {
    id, kind: 'segment', period: '1m',
    direction: ep >= sp ? 'up' : 'down',
    start: { time: st, price: sp },
    end: { time: et, price: ep },
  };
  return extra ? Object.assign(seg, extra) : seg;
};
const eqPt = (p, t, v) => !!p && p.time === t && Math.abs(p.price - v) < 1e-9;

// ---------- 入口 B：链首段起步，其后 ≥3 段 ----------
console.log('\n[入口 B：链首段起步]');
{
  const a1 = mk('a1', t0, 1.0, t0 + 600, 1.1);
  const a2 = mk('a2', t0 + 600, 1.1, t0 + 1200, 1.05);
  const a3 = mk('a3', t0 + 1200, 1.05, t0 + 1800, 1.2);
  const segs = [a1, a2, a3];
  const r = computeRecursiveSegment(segs, [], 'a1');
  console.log('  结果:', JSON.stringify(r));
  assert('B-可递归', r.ok === true && r.entrance === 'B');
  assert('B-产物=链首起点→第3段终点', eqPt(r.start, t0, 1.0) && eqPt(r.end, t0 + 1800, 1.2));
  assert('B-构件=前3段', JSON.stringify(r.sourceIds) === JSON.stringify(['a1', 'a2', 'a3']));

  // 链长不足 3 段 → 不成立
  const r2 = computeRecursiveSegment([a1, a2], [], 'a1');
  assert('B-链长不足不成立', r2.ok === false && r2.reason === 'not_eligible');
}

// ---------- 优先级：B 成立时优先于 C ----------
console.log('\n[优先级：B 优先于 C]');
{
  // 高段 H 右端点与 a1 起点粘连（入口 C 因 headConnected 不成立），但入口 B 成立
  const a1 = mk('a1', t0, 1.0, t0 + 600, 1.1);
  const a2 = mk('a2', t0 + 600, 1.1, t0 + 1200, 1.05);
  const a3 = mk('a3', t0 + 1200, 1.05, t0 + 1800, 1.2);
  const H = mk('H', t0 - 600, 1.3, t0, 1.0, { period: '5m' });
  const r = computeRecursiveSegment([a1, a2, a3], [H], 'a1');
  console.log('  结果:', JSON.stringify(r));
  assert('优先级-B 命中而非 C', r.ok === true && r.entrance === 'B');
}

// ---------- 入口 C：更高周期左侧最近段（方向相反、不粘连） ----------
console.log('\n[入口 C：更高级别逆向续接]');
{
  const s1 = mk('s1', t0, 1.0, t0 + 600, 1.1);
  const s2 = mk('s2', t0 + 600, 1.1, t0 + 1200, 1.05);
  const s3 = mk('s3', t0 + 1200, 1.05, t0 + 1800, 1.15); // 目标段（非链首）
  const H = mk('H', t0, 1.2, t0 + 600, 1.0, { period: '5m' }); // down，右端点 t0+600 ≤ s3 起点 t0+1200
  const r = computeRecursiveSegment([s1, s2, s3], [H], 's3');
  console.log('  结果:', JSON.stringify(r));
  assert('C-可递归', r.ok === true && r.entrance === 'C');
  assert('C-产物=高段右端点→目标段终点', eqPt(r.start, t0 + 600, 1.0) && eqPt(r.end, t0 + 1800, 1.15));

  // 例外：目标段起点与高段右端点粘连 → 入口 C 不成立
  const H2 = mk('H2', t0 + 600, 1.2, t0 + 1200, 1.05, { period: '5m' }); // 右端点 = s3 起点
  const r2 = computeRecursiveSegment([s1, s2, s3], [H2], 's3');
  console.log('  粘连例外:', JSON.stringify(r2));
  assert('C-起点粘连不成立', r2.ok === false && r2.reason === 'not_eligible');

  // 方向相同 → 不成立（且 prevHigher 存在，不做 C' 兜底）
  const H3 = mk('H3', t0, 1.0, t0 + 600, 1.2, { period: '5m' }); // up
  const r3 = computeRecursiveSegment([s1, s2, s3], [H3], 's3');
  console.log('  同向不成立:', JSON.stringify(r3));
  assert('C-方向相同不成立', r3.ok === false && r3.reason === 'not_eligible');

  // 左侧最近：两根左侧高段取右端点最晚者
  const H4 = mk('H4', t0 - 1200, 1.4, t0 - 600, 1.3, { period: '5m' }); // down，更早
  const r4 = computeRecursiveSegment([s1, s2, s3], [H4, H], 's3');
  assert('C-取时间上最近的高段', r4.ok === true && eqPt(r4.start, t0 + 600, 1.0));
}

// ---------- 入口 C'：无高段可续接时的兜底 ----------
console.log('\n[入口 C\u2032：链中段兜底]');
{
  const c1 = mk('c1', t0, 1.0, t0 + 600, 1.1);
  const c2 = mk('c2', t0 + 600, 1.1, t0 + 1200, 1.05);
  const c3 = mk('c3', t0 + 1200, 1.05, t0 + 1800, 1.15); // idx=2 且与链首同向（up）
  const r = computeRecursiveSegment([c1, c2, c3], [], 'c3');
  console.log('  结果:', JSON.stringify(r));
  assert('C\u2032-可递归', r.ok === true && r.entrance === 'C2');
  assert('C\u2032-产物=链首起点→目标段终点', eqPt(r.start, t0, 1.0) && eqPt(r.end, t0 + 1800, 1.15));

  // idx 不足（第 2 段）→ 不成立
  const r2 = computeRecursiveSegment([c1, c2, c3], [], 'c2');
  assert('C\u2032-索引不足不成立', r2.ok === false && r2.reason === 'not_eligible');

  // idx≥2 但目标段与链首反向 → 不成立
  const d1 = mk('d1', t0, 1.0, t0 + 600, 1.1);
  const d2 = mk('d2', t0 + 600, 1.1, t0 + 1200, 1.05);
  const d3 = mk('d3', t0 + 1200, 1.05, t0 + 1800, 1.0); // down，与链首 up 反向
  const r3 = computeRecursiveSegment([d1, d2, d3], [], 'd3');
  assert('C\u2032-反向不成立', r3.ok === false && r3.reason === 'not_eligible');

  // 高段只在目标段右侧（不构成 prevHigher）→ 仍走 C'
  const Hr = mk('Hr', t0 + 2400, 1.15, t0 + 3000, 1.0, { period: '5m' });
  const r4 = computeRecursiveSegment([c1, c2, c3], [Hr], 'c3');
  assert('C\u2032-右侧高段不影响', r4.ok === true && r4.entrance === 'C2');

  // 高段全部在左侧但方向相同 → 不成立，且不误走 C'
  const Hl = mk('Hl', t0 - 600, 1.0, t0 - 300, 1.2, { period: '5m' }); // up，右端点 < c3 起点
  const r5 = computeRecursiveSegment([c1, c2, c3], [Hl], 'c3');
  console.log('  左侧同向高段:', JSON.stringify(r5));
  assert('C\u2032-左侧同向高段时不误兜底', r5.ok === false && r5.reason === 'not_eligible');
}

// ---------- 边界：盯盘/追踪段、目标缺失、端点时间反序 ----------
console.log('\n[边界]');
{
  const w = mk('w', t0, 1.0, t0 + 600, 1.1, { _isWatch: true });
  const w2 = mk('w2', t0 + 600, 1.1, t0 + 1200, 1.05);
  const w3 = mk('w3', t0 + 1200, 1.05, t0 + 1800, 1.2);
  const r = computeRecursiveSegment([w, w2, w3], [], 'w');
  assert('盯盘段拒绝', r.ok === false && r.reason === 'not_plain');

  const t = mk('t', t0, 1.0, t0 + 600, 1.1, { _isTrack: true });
  const r2 = computeRecursiveSegment([t], [], 't');
  assert('追踪段拒绝', r2.ok === false && r2.reason === 'not_plain');

  const r3 = computeRecursiveSegment([], [], 'none');
  assert('目标缺失', r3.ok === false && r3.reason === 'no_target');

  // 目标段 points 顺序反序（start.time > end.time）时按时间有序归一化
  const e1 = { id: 'e1', kind: 'segment', period: '1m', direction: 'up', start: { time: t0 + 600, price: 1.1 }, end: { time: t0, price: 1.0 } };
  const e2 = mk('e2', t0 + 600, 1.1, t0 + 1200, 1.05);
  const e3 = mk('e3', t0 + 1200, 1.05, t0 + 1800, 1.2);
  const r4 = computeRecursiveSegment([e1, e2, e3], [], 'e1');
  console.log('  反序:', JSON.stringify(r4));
  assert('反序端点-仍可递归且取时间有序端点', r4.ok === true && eqPt(r4.start, t0, 1.0) && eqPt(r4.end, t0 + 1800, 1.2));
}

// ---------- 合成场景：1m 递归产物 → 5m 桶，再对 5m 段递归（级联） ----------
console.log('\n[级联：1m→5m 产物作为更高级别的左侧段参与 5m→30m 递归]');
{
  // 1m 链（每段 5 分钟）：三段递归成一根 5m 段
  const m1 = mk('m1', t0, 1.0, t0 + 300, 1.1);
  const m2 = mk('m2', t0 + 300, 1.1, t0 + 600, 1.05);
  const m3 = mk('m3', t0 + 600, 1.05, t0 + 900, 1.2);
  const r1 = computeRecursiveSegment([m1, m2, m3], [], 'm1');
  const made5 = mk('made5', r1.start.time, r1.start.price, r1.end.time, r1.end.price, { period: '5m', _isRecursive: true });
  assert('级联-1m 递归产物生成', r1.ok === true && eqPt(made5.start, t0, 1.0) && eqPt(made5.end, t0 + 900, 1.2));

  // 5m 桶：递归产物（up）+ 其后三段 5m 段；对第 3 段（与链首同向）递归 → 30m 段
  const n1 = made5;
  const n2 = mk('n2', t0 + 900, 1.2, t0 + 1200, 1.15, { period: '5m' });
  const n3 = mk('n3', t0 + 1200, 1.15, t0 + 1500, 1.3, { period: '5m' });
  const r2 = computeRecursiveSegment([n1, n2, n3], [], 'n3');
  console.log('  5m→30m:', JSON.stringify(r2));
  assert('级联-5m 段可继续递归', r2.ok === true && r2.entrance === 'C2');
  assert('级联-产物覆盖链首到目标段', eqPt(r2.start, t0, 1.0) && eqPt(r2.end, t0 + 1500, 1.3));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
