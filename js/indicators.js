// 技术指标：计算函数 + 可自定义的指标类型定义。
// 每个“指标实例”形如 { id, type, params: {...}, color, visible }，可以添加多条（例如 MA5、MA10、MA60）。
//
// compute(inst, bars, ctx) 的返回格式（图表只认这个格式，不关心具体是什么指标）：
//   主图 overlay：{ lines: [{ label, color, data, dash?, style?: 'dots' }] }
//   副图 pane：   { lines: [...], hist?: { label, data, mode: 'sign' | 'bar' }, levels?: [数值], range?: [min, max] }
//     hist.mode = 'sign' 按正负着色（MACD）；'bar' 按当根 K 线涨跌着色（成交量）
(function (global) {
  const nulls = (n) => new Array(n).fill(null);

  function sma(values, n) {
    const out = nulls(values.length);
    let sum = 0, cnt = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) { sum = 0; cnt = 0; continue; }
      sum += v; cnt++;
      if (cnt > n) sum -= values[i - n];
      if (cnt >= n) out[i] = sum / n;
    }
    return out;
  }

  function wma(values, n) {
    const out = nulls(values.length), den = (n * (n + 1)) / 2;
    for (let i = n - 1; i < values.length; i++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += values[i - k] * (n - k);
      out[i] = s / den;
    }
    return out;
  }

  function ema(values, n) {
    const out = nulls(values.length);
    const k = 2 / (n + 1);
    let prev = null, seed = 0, cnt = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) continue;
      if (prev == null) {
        seed += v; cnt++;
        if (cnt === n) { prev = seed / n; out[i] = prev; }
        continue;
      }
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // Wilder 平滑（RMA），RSI / ATR 用
  function rma(values, n) {
    const out = nulls(values.length);
    let prev = null, seed = 0, cnt = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) continue;
      if (prev == null) { seed += v; cnt++; if (cnt === n) { prev = seed / n; out[i] = prev; } continue; }
      prev = (prev * (n - 1) + v) / n;
      out[i] = prev;
    }
    return out;
  }

  // 国内常用的 SMA(X, N, M)：Y = (M*X + (N-M)*Y') / N，KDJ 用
  function cnSma(values, n, m, init) {
    const out = nulls(values.length);
    let y = init;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) continue;
      y = (m * v + (n - m) * y) / n;
      out[i] = y;
    }
    return out;
  }

  function highest(arr, n, i) { let m = -Infinity; for (let j = i - n + 1; j <= i; j++) if (arr[j] > m) m = arr[j]; return m; }
  function lowest(arr, n, i) { let m = Infinity; for (let j = i - n + 1; j <= i; j++) if (arr[j] < m) m = arr[j]; return m; }

  function boll(closes, n, mult) {
    const mid = sma(closes, n);
    const up = nulls(closes.length), dn = nulls(closes.length);
    for (let i = n - 1; i < closes.length; i++) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / n);
      up[i] = mid[i] + mult * sd;
      dn[i] = mid[i] - mult * sd;
    }
    return { mid, up, dn };
  }

  function rsi(closes, n) {
    const g = nulls(closes.length), l = nulls(closes.length);
    for (let i = 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g[i] = d > 0 ? d : 0; l[i] = d < 0 ? -d : 0; }
    const ag = rma(g, n), al = rma(l, n);
    return ag.map((v, i) => (v == null ? null : al[i] === 0 ? 100 : 100 - 100 / (1 + v / al[i])));
  }

  function macd(closes, fast, slow, signal) {
    const ef = ema(closes, fast), es = ema(closes, slow);
    const dif = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
    const dea = ema(dif, signal);
    const hist = dif.map((v, i) => (v != null && dea[i] != null ? v - dea[i] : null));
    return { dif, dea, hist };
  }

  // KDJ（国内常用版本）：RSV → K = SMA(RSV, m1, 1)，D = SMA(K, m2, 1)，J = 3K − 2D
  function kdj(bars, n, m1, m2) {
    const H = bars.map((b) => b.h), L = bars.map((b) => b.l);
    const rsv = bars.map((b, i) => {
      if (i < n - 1) return null;
      const hh = highest(H, n, i), ll = lowest(L, n, i);
      return hh === ll ? 50 : ((b.c - ll) / (hh - ll)) * 100;
    });
    const k = cnSma(rsv, m1, 1, 50), d = cnSma(k, m2, 1, 50);
    const j = k.map((v, i) => (v == null ? null : 3 * v - 2 * d[i]));
    return { k, d, j };
  }

  function trueRange(bars) {
    return bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
  }
  const atr = (bars, n) => rma(trueRange(bars), n);

  function obv(bars) {
    const out = nulls(bars.length); let s = 0;
    for (let i = 0; i < bars.length; i++) {
      if (i > 0) s += bars[i].c > bars[i - 1].c ? bars[i].v : bars[i].c < bars[i - 1].c ? -bars[i].v : 0;
      out[i] = s;
    }
    return out;
  }

  function cci(bars, n) {
    const tp = bars.map((b) => (b.h + b.l + b.c) / 3), m = sma(tp, n), out = nulls(bars.length);
    for (let i = n - 1; i < bars.length; i++) {
      let md = 0; for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
      md /= n;
      out[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
    }
    return out;
  }

  // 威廉指标，取值 −100 ~ 0（常见定义）
  function willr(bars, n) {
    const H = bars.map((b) => b.h), L = bars.map((b) => b.l);
    return bars.map((b, i) => {
      if (i < n - 1) return null;
      const hh = highest(H, n, i), ll = lowest(L, n, i);
      return hh === ll ? -50 : ((hh - b.c) / (hh - ll)) * -100;
    });
  }

  // 抛物线 SAR
  function sar(bars, step, maxStep) {
    const out = nulls(bars.length);
    if (bars.length < 2) return out;
    let up = bars[1].c >= bars[0].c;
    let af = step, ep = up ? Math.max(bars[0].h, bars[1].h) : Math.min(bars[0].l, bars[1].l);
    let s = up ? Math.min(bars[0].l, bars[1].l) : Math.max(bars[0].h, bars[1].h);
    out[1] = s;
    for (let i = 2; i < bars.length; i++) {
      const b = bars[i];
      s = s + af * (ep - s);
      if (up) {
        s = Math.min(s, bars[i - 1].l, bars[i - 2].l);
        if (b.l < s) { up = false; s = ep; ep = b.l; af = step; }
        else if (b.h > ep) { ep = b.h; af = Math.min(maxStep, af + step); }
      } else {
        s = Math.max(s, bars[i - 1].h, bars[i - 2].h);
        if (b.h > s) { up = true; s = ep; ep = b.h; af = step; }
        else if (b.l < ep) { ep = b.l; af = Math.min(maxStep, af + step); }
      }
      out[i] = s;
    }
    return out;
  }

  // VWAP：每个交易日（美股按美东日期、加密货币按 UTC 日期）重新累计
  function vwap(bars, sessionKey) {
    const out = nulls(bars.length);
    let key = null, pv = 0, vv = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i], k = sessionKey(b.t);
      if (k !== key) { key = k; pv = 0; vv = 0; }
      const tp = (b.h + b.l + b.c) / 3;
      pv += tp * b.v; vv += b.v;
      out[i] = vv ? pv / vv : tp;
    }
    return out;
  }
  const utcDay = (t) => Math.floor(t / 86400e3);

  // ---------- 可自定义的指标类型 ----------
  // params：可调参数；kind：overlay 画在主图 / pane 单独副图
  const P = (key, label, def, min, max, step) => ({ key, label, def, min, max, step });
  const TYPES = {
    ma:   { name: _t('MA 均线'),         kind: 'overlay', params: [P('n', _t('周期'), 20, 1, 1000)], color: '#f5c451' },
    ema:  { name: _t('EMA 指数均线'),    kind: 'overlay', params: [P('n', _t('周期'), 12, 1, 1000)], color: '#ff8f5a' },
    wma:  { name: _t('WMA 加权均线'),    kind: 'overlay', params: [P('n', _t('周期'), 20, 1, 500)], color: '#4fd1c5' },
    boll: { name: _t('BOLL 布林带'),     kind: 'overlay', params: [P('n', _t('周期'), 20, 2, 500), P('k', _t('倍数'), 2, 0.1, 10, 0.1)], color: '#e0a3ff' },
    vwap: { name: _t('VWAP 成交量加权均价'), kind: 'overlay', params: [], color: '#ff6fae' },
    sar:  { name: _t('SAR 抛物线'),      kind: 'overlay', params: [P('step', _t('步长'), 0.02, 0.001, 0.5, 0.001), P('max', _t('上限'), 0.2, 0.01, 1, 0.01)], color: '#9ad16b' },
    vol:  { name: _t('VOL 成交量'),      kind: 'pane', params: [P('n1', _t('均线1'), 5, 1, 500), P('n2', _t('均线2'), 10, 1, 500)], color: '#f5c451' },
    rsi:  { name: 'RSI',             kind: 'pane', params: [P('n', _t('周期'), 14, 2, 500), P('hi', _t('超买'), 70, 50, 100), P('lo', _t('超卖'), 30, 0, 50)], color: '#c58cff' },
    macd: { name: 'MACD',            kind: 'pane', params: [P('fast', _t('快线'), 12, 1, 500), P('slow', _t('慢线'), 26, 2, 500), P('signal', _t('信号'), 9, 1, 500)], color: '#5ab0ff' },
    kdj:  { name: _t('KDJ 随机指标'),    kind: 'pane', params: [P('n', _t('周期'), 9, 2, 500), P('m1', _t('K平滑'), 3, 1, 50), P('m2', _t('D平滑'), 3, 1, 50)], color: '#f5c451' },
    atr:  { name: _t('ATR 真实波幅'),    kind: 'pane', params: [P('n', _t('周期'), 14, 1, 500)], color: '#ff8f5a' },
    obv:  { name: _t('OBV 能量潮'),      kind: 'pane', params: [P('n', _t('均线'), 20, 1, 500)], color: '#4fd1c5' },
    cci:  { name: _t('CCI 顺势指标'),    kind: 'pane', params: [P('n', _t('周期'), 20, 2, 500)], color: '#5ab0ff' },
    wr:   { name: _t('WR 威廉指标'),     kind: 'pane', params: [P('n', _t('周期'), 14, 2, 500)], color: '#e0a3ff' },
  };
  const PALETTE = ['#f5c451', '#5ab0ff', '#c58cff', '#ff8f5a', '#4fd1c5', '#e0a3ff', '#9ad16b', '#ff6fae'];
  const SECOND = '#ff8f5a', THIRD = '#c58cff';

  let seq = 0;
  function create(type, params, color) {
    const def = TYPES[type];
    const p = {};
    for (const x of def.params) p[x.key] = params && params[x.key] != null ? params[x.key] : x.def;
    return { id: 'i' + Date.now().toString(36) + (seq++), type, params: p, color: color || def.color, visible: true };
  }
  function defaults() {
    return [
      create('ma', { n: 20 }, '#f5c451'),
      create('ma', { n: 50 }, '#5ab0ff'),
      create('ma', { n: 200 }, '#c58cff'),
      create('rsi', { n: 14 }),
    ];
  }
  // 清洗从本地存储读出的数据，丢掉不认识或参数不合法的
  function sanitize(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const it of list) {
      if (!it || !TYPES[it.type]) continue;
      const inst = create(it.type, it.params, typeof it.color === 'string' ? it.color : undefined);
      inst.id = typeof it.id === 'string' ? it.id : inst.id;
      inst.visible = it.visible !== false;
      for (const x of TYPES[it.type].params) {
        let v = Number(inst.params[x.key]);
        if (!isFinite(v)) v = x.def;
        inst.params[x.key] = Math.min(x.max, Math.max(x.min, v));
      }
      out.push(inst);
    }
    return out;
  }
  function label(inst) {
    const p = inst.params;
    switch (inst.type) {
      case 'ma': return `MA${p.n}`;
      case 'ema': return `EMA${p.n}`;
      case 'wma': return `WMA${p.n}`;
      case 'boll': return `BOLL(${p.n},${p.k})`;
      case 'vwap': return 'VWAP';
      case 'sar': return `SAR(${p.step},${p.max})`;
      case 'vol': return `VOL ${p.n1} ${p.n2}`;
      case 'rsi': return `RSI ${p.n}`;
      case 'macd': return `MACD ${p.fast} ${p.slow} ${p.signal}`;
      case 'kdj': return `KDJ ${p.n} ${p.m1} ${p.m2}`;
      case 'atr': return `ATR ${p.n}`;
      case 'obv': return `OBV ${p.n}`;
      case 'cci': return `CCI ${p.n}`;
      case 'wr': return `WR ${p.n}`;
    }
    return inst.type;
  }

  // 计算一个指标实例，返回格式见文件开头。ctx.sessionKey(t) 用于 VWAP 判断是否同一交易日
  function compute(inst, bars, ctx) {
    const closes = bars.map((b) => b.c), p = inst.params, n = Math.round(p.n), c = inst.color;
    const R = Math.round;
    switch (inst.type) {
      case 'ma': return { lines: [{ label: label(inst), color: c, data: sma(closes, n) }] };
      case 'ema': return { lines: [{ label: label(inst), color: c, data: ema(closes, n) }] };
      case 'wma': return { lines: [{ label: label(inst), color: c, data: wma(closes, n) }] };
      case 'boll': {
        const b = boll(closes, n, p.k);
        return { lines: [
          { label: 'UP', color: c, data: b.up, dash: [4, 3] },
          { label: 'MID', color: c, data: b.mid },
          { label: 'DN', color: c, data: b.dn, dash: [4, 3] },
        ] };
      }
      case 'vwap': return { lines: [{ label: 'VWAP', color: c, data: vwap(bars, (ctx && ctx.sessionKey) || utcDay) }] };
      case 'sar': return { lines: [{ label: 'SAR', color: c, data: sar(bars, p.step, p.max), style: 'dots' }] };
      case 'vol': {
        const v = bars.map((b) => b.v);
        return { hist: { label: 'VOL', data: v, mode: 'bar' }, lines: [
          { label: `MA${R(p.n1)}`, color: c, data: sma(v, R(p.n1)) },
          { label: `MA${R(p.n2)}`, color: '#5ab0ff', data: sma(v, R(p.n2)) },
        ], range: 'zero' };
      }
      case 'rsi': return { lines: [{ label: 'RSI', color: c, data: rsi(closes, n) }], levels: [p.lo, p.hi], band: [p.lo, p.hi], range: [0, 100] };
      case 'macd': {
        const m = macd(closes, R(p.fast), R(p.slow), R(p.signal));
        return { hist: { label: 'HIST', data: m.hist, mode: 'sign' }, lines: [
          { label: 'DIF', color: c, data: m.dif }, { label: 'DEA', color: SECOND, data: m.dea },
        ], levels: [0], symmetric: true };
      }
      case 'kdj': {
        const k = kdj(bars, n, R(p.m1), R(p.m2));
        return { lines: [
          { label: 'K', color: c, data: k.k }, { label: 'D', color: '#5ab0ff', data: k.d }, { label: 'J', color: THIRD, data: k.j },
        ], levels: [20, 80], band: [20, 80] };
      }
      case 'atr': return { lines: [{ label: 'ATR', color: c, data: atr(bars, n) }], priceLike: true };
      case 'obv': {
        const o = obv(bars);
        return { lines: [{ label: 'OBV', color: c, data: o }, { label: `MA${n}`, color: SECOND, data: sma(o, n) }] };
      }
      case 'cci': return { lines: [{ label: 'CCI', color: c, data: cci(bars, n) }], levels: [-100, 100], band: [-100, 100] };
      case 'wr': return { lines: [{ label: 'WR', color: c, data: willr(bars, n) }], levels: [-80, -20], band: [-80, -20], range: [-100, 0] };
    }
    return { lines: [] };
  }

  global.Indicators = { sma, ema, wma, rma, boll, rsi, macd, kdj, atr, obv, cci, willr, sar, vwap, TYPES, PALETTE, create, defaults, sanitize, label, compute };
})(window);
