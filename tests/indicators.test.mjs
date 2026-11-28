// 指标计算的单元测试。运行：node --test tests/
// 不需要安装任何依赖（用 Node 自带的 node:test），把浏览器脚本放进沙箱里加载。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from './helpers.mjs';

const { Indicators: I } = loadScripts(['js/indicators.js']);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const closeArr = (got, want, eps = 1e-9) => {
  assert.equal(got.length, want.length);
  want.forEach((w, i) => (w == null ? assert.equal(got[i], null, `下标 ${i}`) : close(got[i], w, eps)));
};
const bar = (c, h = c, l = c, v = 1, t = 0) => ({ t, o: c, h, l, c, v });

test('SMA 简单均线', () => {
  closeArr(I.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  // 中间有空值：从空值后面重新累计
  closeArr(I.sma([1, null, 2, 3, 4], 2), [null, null, null, 2.5, 3.5]);
});

test('EMA 指数均线：前 n 根取平均作为起点', () => {
  closeArr(I.ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('WMA 加权均线', () => {
  closeArr(I.wma([1, 2, 3], 3), [null, null, 14 / 6]);
});

test('RMA（Wilder 平滑）', () => {
  closeArr(I.rma([1, 2, 3, 4], 2), [null, 1.5, 2.25, 3.125]);
});

test('BOLL 布林带', () => {
  const b = I.boll([1, 2, 3], 3, 2), sd = Math.sqrt(2 / 3);
  closeArr(b.mid, [null, null, 2]);
  closeArr(b.up, [null, null, 2 + 2 * sd]);
  closeArr(b.dn, [null, null, 2 - 2 * sd]);
  const flat = I.boll([5, 5, 5, 5], 2, 2);
  assert.deepEqual([...flat.up.slice(1)], [5, 5, 5]);
});

test('RSI', () => {
  closeArr(I.rsi([1, 2, 1, 2], 2), [null, null, 50, 75]);
  assert.ok(I.rsi([1, 2, 3, 4, 5, 6], 3).slice(3).every((x) => x === 100), '一直涨 = 100');
  assert.ok(I.rsi([6, 5, 4, 3, 2, 1], 3).slice(3).every((x) => x === 0), '一直跌 = 0');
});

test('MACD：价格不变时 DIF、DEA、柱子都是 0', () => {
  const m = I.macd(new Array(60).fill(10), 12, 26, 9);
  assert.equal(m.dif[24], null);
  close(m.dif[25], 0); close(m.dea[33], 0); close(m.hist[59], 0);
  assert.equal(m.dea[32], null, 'DEA 要等 DIF 有 9 个值才开始');
});

test('KDJ：高低价相同时 RSV 记为 50', () => {
  const k = I.kdj([bar(10), bar(10), bar(10)], 2, 3, 3);
  closeArr(k.k, [null, 50, 50]); closeArr(k.d, [null, 50, 50]); closeArr(k.j, [null, 50, 50]);
});

test('KDJ：收在最高价时 K 往 100 靠', () => {
  const k = I.kdj([bar(10, 11, 9), bar(12, 12, 10)], 2, 3, 3);
  close(k.k[1], (1 * 100 + 2 * 50) / 3); // RSV = 100
});

test('ATR：真实波幅取三者最大', () => {
  // 第二根跳空：|h - 前收| = 5 大于 h - l = 2
  const a = I.atr([bar(10, 11, 9), bar(14, 15, 13)], 1);
  closeArr(a, [2, 5]);
});

test('OBV 能量潮', () => {
  closeArr(I.obv([bar(1, 1, 1, 10), bar(2, 2, 2, 10), bar(2, 2, 2, 10), bar(1, 1, 1, 10)]), [0, 10, 10, 0]);
});

test('CCI：价格不变时为 0', () => {
  closeArr(I.cci([bar(10), bar(10), bar(10)], 3), [null, null, 0]);
});

test('WR 威廉指标：−100 ~ 0', () => {
  const bars = [bar(10, 12, 8), bar(12, 12, 8), bar(8, 12, 8)];
  closeArr(I.willr(bars, 2), [null, 0, -100]);
});

test('SAR：稳定上涨时一直在最低价下方并逐步上移', () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(100 + i, 101 + i, 99 + i));
  const s = I.sar(bars, 0.02, 0.2);
  for (let i = 2; i < bars.length; i++) {
    assert.ok(s[i] < bars[i].l, `第 ${i} 根 SAR 应在最低价下方`);
    assert.ok(s[i] >= s[i - 1], `第 ${i} 根 SAR 应不低于前一根`);
  }
});

test('SAR：跌破后翻到上方', () => {
  const up = Array.from({ length: 10 }, (_, i) => bar(100 + i, 101 + i, 99 + i));
  const s = I.sar([...up, bar(80, 90, 79)], 0.02, 0.2);
  assert.ok(s[10] > 90, '翻转后 SAR 在最高价上方');
});

test('VWAP：按交易日重新累计', () => {
  const day = (t) => Math.floor(t / 100);
  const bars = [
    { t: 0, o: 10, h: 10, l: 10, c: 10, v: 1 },
    { t: 1, o: 20, h: 20, l: 20, c: 20, v: 3 },
    { t: 100, o: 50, h: 50, l: 50, c: 50, v: 2 },
  ];
  closeArr(I.vwap(bars, day), [10, 17.5, 50]);
});

test('compute：每种指标在随机行情上都能算出来，长度一致、没有 NaN', () => {
  let p = 100, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const bars = Array.from({ length: 300 }, (_, i) => {
    const o = p, c = p * (1 + (rnd() - 0.5) * 0.04);
    p = c;
    return { t: i * 60e3, o, h: Math.max(o, c) * 1.01, l: Math.min(o, c) * 0.99, c, v: 100 + rnd() * 900 };
  });
  for (const type of Object.keys(I.TYPES)) {
    const out = I.compute(I.create(type), bars, { sessionKey: (t) => Math.floor(t / 86400e3) });
    const series = [...(out.lines || []).map((l) => l.data), ...(out.hist ? [out.hist.data] : [])];
    assert.ok(series.length, `${type} 没有输出`);
    for (const d of series) {
      assert.equal(d.length, bars.length, `${type} 长度不对`);
      assert.ok(d.every((x) => x == null || Number.isFinite(x)), `${type} 出现 NaN / Infinity`);
      assert.ok(d.slice(-1)[0] != null, `${type} 最后一根没有值`);
    }
  }
});

test('sanitize：丢掉无法识别的指标，参数限制在范围内', () => {
  const list = I.sanitize([{ type: 'ma', params: { n: 99999 } }, { type: 'nope' }, 'junk']);
  assert.equal(list.length, 1);
  assert.equal(list[0].type, 'ma');
  assert.ok(list[0].params.n <= 1000);
});
