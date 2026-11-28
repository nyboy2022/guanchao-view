// 美东时间工具的测试（夏令时、收盘时间、交易时段）。运行：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from './helpers.mjs';

const { Feeds: F } = loadScripts(['js/feed.js']);
const iso = (t) => new Date(t).toISOString();
const at = (s) => Date.parse(s);

test('日线起点：冬令时、夏令时都是美东 0 点', () => {
  assert.equal(iso(F.etBarStart(at('2026-07-15T14:00:00Z'), '1d')), '2026-07-15T04:00:00.000Z'); // 夏令时 UTC-4
  assert.equal(iso(F.etBarStart(at('2026-11-02T15:00:00Z'), '1d')), '2026-11-02T05:00:00.000Z'); // 冬令时 UTC-5
});

test('夏令时结束那周：新日线和历史日线在同一个网格（以前固定 24 小时步长会差 1 小时）', () => {
  const friBeforeSwitch = F.etBarStart(at('2026-10-30T15:00:00Z'), '1d');
  const monAfterSwitch = F.etBarStart(at('2026-11-02T15:00:00Z'), '1d');
  assert.equal(F.etInfo(monAfterSwitch).min, 0, '还是美东 0 点');
  assert.notEqual(monAfterSwitch, friBeforeSwitch + 3 * 86400e3, '不是简单加 3 天');
});

test('周线从周一开始，月线从 1 号开始', () => {
  const wed = at('2026-11-04T15:00:00Z');
  assert.equal(F.etInfo(F.etBarStart(wed, '1w')).date, '2026-11-02');
  assert.equal(F.etInfo(F.etBarStart(wed, '1M')).date, '2026-11-01');
});

test('收盘倒计时的目标：美东 16:00', () => {
  const d = F.etBarStart(at('2026-07-15T14:00:00Z'), '1d');
  assert.equal(iso(F.etBarClose(d, 86400e3)), '2026-07-15T20:00:00.000Z');
  const w = F.etBarStart(at('2026-11-04T15:00:00Z'), '1w');
  assert.equal(iso(F.etBarClose(w, 604800e3)), '2026-11-06T21:00:00.000Z', '周线到周五收盘');
  const m = F.etBarStart(at('2027-01-12T15:00:00Z'), '1M');
  assert.equal(F.etInfo(F.etBarClose(m, 2629746e3)).date, '2027-01-29', '2027-01-31 是周日，月线到 29 号（周五）');
  assert.equal(F.etBarClose(1000, 60e3), 61000, '分钟线就是下一根开始');
});

test('美东交易时段', () => {
  assert.equal(F.etSession(at('2026-11-04T13:00:00Z')), 'pre');   // 08:00 ET
  assert.equal(F.etSession(at('2026-11-04T15:00:00Z')), 'rth');   // 10:00 ET
  assert.equal(F.etSession(at('2026-11-04T22:00:00Z')), 'post');  // 17:00 ET
  assert.equal(F.etSession(at('2026-11-05T02:00:00Z')), 'night'); // 21:00 ET
  assert.equal(F.etSession(at('2026-11-07T15:00:00Z')), 'closed'); // 周六
});

test('Alpaca 免费版订阅上限：K线优先，超出的记下来', () => {
  const A = F.AlpacaFeed;
  A.configure({ key: 'k', secret: 's', feed: 'iex' });
  let dropped = null; A.onSymbolCap((d) => (dropped = d));
  const list = Array.from({ length: 35 }, (_, i) => 'S' + i);
  const un1 = A.subscribeTickers(list, () => {});
  const un2 = A.subscribeKline('CHART', '1m', () => {}, null, null);
  assert.equal(dropped.length, 6, '35 只 + 1 个图 = 36，超出 6 只');
  assert.ok(!dropped.includes('CHART'), '图上的品种优先');
  assert.deepEqual([...dropped], ['S29', 'S30', 'S31', 'S32', 'S33', 'S34'], '列表末尾的先让出');
  A.configure({ key: 'k', secret: 's', feed: 'sip' });
  un2(); // 触发重新计算
  assert.equal(dropped.length, 0, 'SIP 付费版不限');
  un1();
});
