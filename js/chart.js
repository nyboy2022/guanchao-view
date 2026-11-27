// 自绘 Canvas K线图：K线、成交量、叠加指标、副图指标、十字光标、缩放平移、画线工具。
(function (global) {
  const AXIS_W = 76;     // 右侧价格轴宽度
  const TIME_H = 24;     // 底部时间轴高度
  const SUB_H = 120;     // 每个副图高度
  const PAD = 12;        // 主图上下留白

  const C = {
    bg: '#0d1117', grid: '#1a2130', axis: '#8b95a7', axisLine: '#263042',
    up: '#2ebd85', down: '#f0506e', cross: '#6b7790', text: '#d5dbe6',
    labelBg: '#2a3447', draw: '#ffb547', drawSel: '#ffffff', sep: '#263042',
  };

  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const mag = 10 ** Math.floor(Math.log10(raw));
    const n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }
  function decimalsFor(price) {
    const a = Math.abs(price);
    if (global.ChartUtil && global.ChartUtil.stockMode) return a >= 1 ? 2 : 4;
    if (a >= 1000) return 2; if (a >= 10) return 3; if (a >= 1) return 4; if (a >= 0.01) return 5; return 8;
  }
  function fmtVol(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
    return v.toFixed(2);
  }
  function fmtNum(v) {
    const a = Math.abs(v);
    if (a >= 1e4) return (v < 0 ? '-' : '') + fmtVol(a);
    if (a >= 100) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    if (a === 0) return '0';
    return v.toPrecision(3);
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtTime(t, ms, full) {
    const d = new Date(t);
    const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (full) return ms >= 86400e3 ? date : `${date} ${hm}`;
    return ms >= 86400e3 ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : hm;
  }
  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const L = dx * dx + dy * dy;
    let t = L ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const FIBX = [0, 0.382, 0.618, 1, 1.272, 1.618, 2, 2.618];
  const THREE_POINT = new Set(['channel', 'fibext']);
  function fmtSpan(ms) {
    const m = Math.round(ms / 60e3);
    if (m < 60) return m + ' 分钟';
    if (m < 1440) return (m / 60).toFixed(m % 60 ? 1 : 0) + ' 小时';
    return (m / 1440).toFixed(m % 1440 ? 1 : 0) + ' 天';
  }

  class Chart {
    constructor(container, opts) {
      this.el = container;
      this.opts = opts || {};
      this.canvas = document.createElement('canvas');
      this.canvas.style.display = 'block';
      this.canvas.style.touchAction = 'none';
      container.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.bars = [];
      this.intervalMs = 60e3;
      this.indicators = [];   // 用户配置的指标实例
      this.ind = [];          // [{inst, out}] 只含可见的，已算好
      this.spacing = 8;
      this.rightIndex = 0;
      this.yZoom = 1;
      this.mouse = null;
      this.drawings = [];
      this.selectedId = null;
      this.tool = 'cursor';
      this.pending = null;       // 正在绘制的图形
      this.drag = null;
      this.lastTickAt = 0;
      this.dirty = true;
      this._bind();
      new ResizeObserver(() => this.resize()).observe(container);
      this.resize();
      const loop = () => {
        requestAnimationFrame(loop); // 先排下一帧：即使这一帧出错，图表也不会就此停止刷新
        if (!this.dirty) return;
        this.dirty = false;
        try { this.render(); }
        catch (e) { if (!this._errShown) { this._errShown = true; window.dispatchEvent(new ErrorEvent('error', { error: e, message: '图表绘制出错：' + e.message })); } }
      };
      requestAnimationFrame(loop);
      // 每秒刷新一次，用于 K 线收盘倒计时
      setInterval(() => (this.dirty = true), 1000);
    }

    // ---------------- 数据 ----------------
    setData(bars, intervalMs) {
      this.bars = bars;
      this.intervalMs = intervalMs;
      this.rightIndex = bars.length - 1 + 6;
      this.yZoom = 1;
      this.recalc();
    }
    prependData(older) {
      if (!older.length) return;
      const first = this.bars[0] ? this.bars[0].t : Infinity;
      const add = older.filter((b) => b.t < first);
      this.bars = add.concat(this.bars);
      this.rightIndex += add.length;
      this.recalc();
    }
    updateBar(bar) {
      const n = this.bars.length;
      if (!n) return;
      const last = this.bars[n - 1];
      const following = this.rightIndex >= n - 1 - 0.5;
      if (bar.t === last.t) this.bars[n - 1] = bar;
      else if (bar.t > last.t) {
        this.bars.push(bar);
        if (following) this.rightIndex += 1;
      } else return;
      this.lastTickAt = Date.now();
      this.recalc();
    }
    setIndicators(list) { this.indicators = list.map((x) => ({ ...x, params: { ...x.params } })); this.recalc(); }
    // K线样式：candle 蜡烛 / hollow 空心 / ha 平均K线 / line 折线 / area 面积
    setChartType(t) { this.chartType = t; this.recalc(); }
    setVolumeProfile(on) { this.vprofile = !!on; this.dirty = true; }
    // 对比叠加：[{ symbol, color, bars }]
    setCompares(list) { this.compares = list || []; this._alignCompares(); this.dirty = true; }
    updateCompareLast(symbol, price) {
      const c = (this.compares || []).find((x) => x.symbol === symbol); if (!c || !c.bars.length) return;
      c.bars[c.bars.length - 1] = { ...c.bars[c.bars.length - 1], c: price }; this._alignCompares(); this.dirty = true;
    }
    _alignCompares() {
      for (const c of this.compares || []) {
        const al = new Array(this.bars.length).fill(null); let j = 0, last = null;
        for (let i = 0; i < this.bars.length; i++) {
          const t = this.bars[i].t;
          while (j < c.bars.length && c.bars[j].t <= t) { last = c.bars[j].c; j++; }
          al[i] = last;
        }
        c.al = al;
      }
    }
    // 对比线换算到主图价格坐标：从可见区域第一根开始，按同样的涨跌幅画
    _compareLines(i0, i1) {
      const out = [];
      for (const c of this.compares || []) {
        if (!c.al) continue;
        let b0 = -1; for (let i = i0; i <= i1; i++) if (c.al[i] != null) { b0 = i; break; }
        if (b0 < 0) continue;
        const base = this.bars[b0].c, cb = c.al[b0];
        out.push({ label: c.symbol, color: c.color, b0, data: c.al.map((v) => (v == null ? null : (base * v) / cb)), al: c.al });
      }
      return out;
    }
    _displayBars() { return this.chartType === 'ha' && this.ha ? this.ha : this.bars; }
    recalc() {
      if (this.chartType === 'ha') {
        const ha = []; for (let i = 0; i < this.bars.length; i++) {
          const b = this.bars[i], c = (b.o + b.h + b.l + b.c) / 4, o = i ? (ha[i - 1].o + ha[i - 1].c) / 2 : (b.o + b.c) / 2;
          ha.push({ t: b.t, o, c, h: Math.max(b.h, o, c), l: Math.min(b.l, o, c), v: b.v });
        }
        this.ha = ha;
      }
      if (this.compares && this.compares.length) this._alignCompares();
      this.ind = this.indicators.filter((x) => x.visible !== false).map((inst) => ({ inst, out: Indicators.compute(inst, this.bars, { sessionKey: this.sessionKey }) }));
      this.dirty = true;
    }
    _overlays() { return this.ind.filter((x) => Indicators.TYPES[x.inst.type].kind === 'overlay'); }
    _overlayLines() { const r = []; for (const x of this._overlays()) r.push(...x.out.lines); return r; }
    setSessionKey(fn) { this.sessionKey = fn; }
    setAlerts(list) { this.alerts = list || []; this.dirty = true; }
    // 财报 / 分红 / 拆股标记：[{t, kind:'earn'|'div'|'split', title, detail, beat}]
    setEvents(list) { this.events = list || []; this.dirty = true; }
    selectedDrawing() { return this.drawings.find((d) => d.id === this.selectedId) || null; }
    // 画线在某个时间点的价格（趋势线向右延长），用于画线警报。与图上看到的位置一致（按K线序号插值）
    drawingPriceAt(d, t) {
      if (d.type === 'hline') return d.p1.p;
      if (d.type !== 'trend' && d.type !== 'ray') return null;
      const a = this.timeToIndex(d.p1.t), b = this.timeToIndex(d.p2.t), x = this.timeToIndex(t);
      if (a === b) return d.p2.p;
      return d.p1.p + ((d.p2.p - d.p1.p) * (x - a)) / (b - a);
    }
    _drawAlerts(S, plotW) {
      if (!this.alerts || !this.alerts.length) return;
      const ctx = this.ctx;
      ctx.font = '11px system-ui'; ctx.textBaseline = 'middle';
      for (const a of this.alerts) {
        let p = a.price, x = plotW - 4;
        if (a.drawingId) {
          const d = this.drawings.find((z) => z.id === a.drawingId); if (!d) continue;
          const lastT = this.bars.length ? this.bars[this.bars.length - 1].t : Date.now();
          p = this.drawingPriceAt(d, lastT); if (p == null) continue;
          x = Math.min(plotW - 4, this.xOf(this.bars.length - 1, plotW) + 30);
        } else {
          const y = Math.round(S.y(p)) + 0.5;
          ctx.strokeStyle = a.active ? 'rgba(255,181,71,0.85)' : 'rgba(139,149,167,0.5)'; ctx.setLineDash([6, 4]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); ctx.setLineDash([]);
        }
        const y = S.y(p);
        const t = '🔔 ' + (a.text || p.toFixed(decimalsFor(p)));
        const w = ctx.measureText(t).width + 10;
        ctx.fillStyle = a.active ? 'rgba(255,181,71,0.9)' : 'rgba(80,90,110,0.9)';
        ctx.fillRect(x - w, y - 9, w, 18);
        ctx.fillStyle = '#10151e'; ctx.textAlign = 'right'; ctx.fillText(t, x - 5, y);
      }
    }
    setDrawings(list) { this.drawings = list; this.selectedId = null; this.dirty = true; this._selChanged(); }
    _selChanged() { if (this._lastSel !== this.selectedId) { this._lastSel = this.selectedId; this.opts.onSelect && this.opts.onSelect(this.selectedDrawing()); } }
    setTool(tool) { this.tool = tool; this.pending = null; this.canvas.style.cursor = tool === 'cursor' ? 'default' : 'crosshair'; this.dirty = true; }
    deleteSelected() {
      if (!this.selectedId) return;
      this.drawings = this.drawings.filter((d) => d.id !== this.selectedId);
      this.selectedId = null; this._drawingsChanged();
    }
    clearDrawings() { this.drawings = []; this.selectedId = null; this._drawingsChanged(); }
    // ---- 多图联动：十字线和可视范围 ----
    _emitHover(t) { if (this._lastHover === t) return; this._lastHover = t; this.opts.onHover && this.opts.onHover(t); }
    _emitView() {
      if (!this.opts.onView || !this.bars.length) return;
      const n = this.bars.length;
      this.opts.onView({ t: this.indexToTime(Math.min(this.rightIndex, n - 1)), over: Math.max(0, this.rightIndex - (n - 1)), spacing: this.spacing });
    }
    syncHover(t) { if (this.syncT !== t) { this.syncT = t; this.dirty = true; } }
    // timeOnly：周期不同的图只对齐右边缘的时间，各自保留自己的缩放
    syncView(v, timeOnly) {
      if (!this.bars.length) return;
      if (!timeOnly) this.spacing = v.spacing;
      this.rightIndex = v.over > 0 ? this.bars.length - 1 + v.over : this.timeToIndex(v.t);
      this._clampView(); this._maybeNeedMore(); this.dirty = true;
    }
    // 显示从 t0 到最新的全部K线（用于“今年至今”）
    fitFrom(t0) {
      const n = this.bars.length; if (!n) return;
      let i0 = this.bars.findIndex((b) => b.t >= t0); if (i0 < 0) i0 = n - 1;
      const plotW = this.w - AXIS_W, count = n - i0 + 3;
      this.spacing = Math.max(1.5, Math.min(60, plotW / count));
      this.rightIndex = n - 1 + 2; this.yZoom = 1; this.dirty = true;
    }
    goLatest() { this.rightIndex = this.bars.length - 1 + 6; this.yZoom = 1; this.dirty = true; }
    _drawingsChanged() { this.dirty = true; this.opts.onDrawingsChange && this.opts.onDrawingsChange(this.drawings); }
    // 右键菜单用
    addDrawing(d) { this.drawings.push(d); this.selectedId = d.id; this._drawingsChanged(); }
    drawingsChanged() { this._drawingsChanged(); }
    selectDrawing(id) { this.selectedId = id; this.dirty = true; this._selChanged(); }
    resetView() { this.spacing = 8; this.goLatest(); this._clampView(); this._emitView(); }

    // ---------------- 布局与坐标 ----------------
    resize() {
      const r = this.el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.w = Math.max(200, r.width); this.h = Math.max(200, r.height);
      this.canvas.width = this.w * dpr; this.canvas.height = this.h * dpr;
      this.canvas.style.width = this.w + 'px'; this.canvas.style.height = this.h + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.dirty = true;
    }
    layout() {
      const plotW = this.w - AXIS_W;
      const subs = this.ind.filter((x) => Indicators.TYPES[x.inst.type].kind === 'pane');
      const total = this.h - TIME_H;
      // 副图越多每个越矮，主图至少保留一半高度
      const subH = subs.length ? Math.min(SUB_H, Math.floor((total * (subs.length > 2 ? 0.5 : 0.22 * subs.length)) / subs.length)) : 0;
      const mainH = total - subs.length * subH;
      const panes = [{ id: 'main', top: 0, h: mainH }];
      subs.forEach((x, k) => panes.push({ id: x.inst.id, kind: x.inst.type, ind: x, top: mainH + k * subH, h: subH }));
      return { plotW, panes, plotH: total };
    }
    xOf(i, plotW) { return plotW - (this.rightIndex - i) * this.spacing; }
    indexAtX(x, plotW) { return this.rightIndex - (plotW - x) / this.spacing; }
    // 时间 <-> 索引（允许小数、允许超出已有数据范围）
    timeToIndex(t) {
      const b = this.bars, n = b.length;
      if (!n) return 0;
      if (t <= b[0].t) return (t - b[0].t) / this.intervalMs;
      if (t >= b[n - 1].t) return n - 1 + (t - b[n - 1].t) / this.intervalMs;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (b[m].t <= t) lo = m; else hi = m; }
      return lo + (t - b[lo].t) / (b[hi].t - b[lo].t);
    }
    indexToTime(i) {
      const b = this.bars, n = b.length;
      if (!n) return 0;
      if (i <= 0) return b[0].t + i * this.intervalMs;
      if (i >= n - 1) return b[n - 1].t + (i - (n - 1)) * this.intervalMs;
      const lo = Math.floor(i), f = i - lo;
      return b[lo].t + f * (b[lo + 1].t - b[lo].t);
    }
    visibleRange(plotW) {
      const i0 = Math.max(0, Math.floor(this.indexAtX(0, plotW)));
      const i1 = Math.min(this.bars.length - 1, Math.ceil(this.rightIndex));
      return [i0, i1];
    }
    mainScale(pane, i0, i1) {
      let lo = Infinity, hi = -Infinity;
      const B = this._displayBars(), lineOnly = this.chartType === 'line' || this.chartType === 'area';
      for (let i = i0; i <= i1; i++) { const b = B[i]; const l = lineOnly ? b.c : b.l, h = lineOnly ? b.c : b.h; if (l < lo) lo = l; if (h > hi) hi = h; }
      for (const ln of this._overlayLines().concat(this._cmp || [])) for (let i = i0; i <= i1; i++) {
        const v = ln.data[i]; if (v == null) continue; if (v < lo) lo = v; if (v > hi) hi = v;
      }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      if (hi === lo) { hi += 1; lo -= 1; }
      const mid = (hi + lo) / 2, half = ((hi - lo) / 2) * this.yZoom;
      return this._scale(pane, mid - half, mid + half, PAD);
    }
    _scale(pane, min, max, pad) {
      const top = pane.top + pad, h = pane.h - pad * 2;
      return {
        min, max,
        y: (p) => top + ((max - p) / (max - min)) * h,
        p: (y) => max - ((y - top) / h) * (max - min),
      };
    }
    paneAt(y, L) { return L.panes.find((p) => y >= p.top && y < p.top + p.h); }

    // ---------------- 渲染 ----------------
    render() {
      this._selChanged();
      const ctx = this.ctx, L = this.layout(), { plotW } = L;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, this.w, this.h);
      if (!this.bars.length) {
        ctx.fillStyle = C.axis; ctx.font = '14px system-ui'; ctx.textAlign = 'center';
        ctx.fillText(this.opts.emptyText ? this.opts.emptyText() : '加载中…', this.w / 2, this.h / 2);
        return;
      }
      const [i0, i1] = this.visibleRange(plotW);
      const main = L.panes[0];
      this._cmp = this._compareLines(i0, Math.max(i0, i1));
      const S = this.mainScale(main, i0, Math.max(i0, i1));
      this._S = S; this._L = L;

      this._drawTimeGrid(L, i0, i1);
      // 主图
      ctx.save(); ctx.beginPath(); ctx.rect(0, main.top, plotW, main.h); ctx.clip();
      this._drawPriceGrid(main, S, plotW);
      if (!this.ind.some((x) => x.inst.type === 'vol')) this._drawVolume(main, i0, i1, plotW); // 有成交量副图时，主图不再叠加
      if (this.vprofile) this._drawVolumeProfile(main, S, i0, i1, plotW);
      this._drawMain(S, i0, i1, plotW);
      for (const ln of this._cmp) this._drawLine(ln.data, S, i0, i1, plotW, ln.color, [6, 3]);
      for (const ln of this._overlayLines()) this._drawLine(ln.data, S, i0, i1, plotW, ln.color, ln.dash, ln.style);
      this._drawAlerts(S, plotW);
      this._drawDrawings(S, plotW);
      this._drawEvents(main, plotW);
      ctx.restore();
      this._drawPriceAxis(main, S, plotW);
      this._drawLastPrice(main, S, plotW);

      // 副图
      for (const pane of L.panes.slice(1)) this._drawSubPane(pane, i0, i1, plotW);

      this._drawTimeAxis(L, i0, i1);
      this._drawCrosshair(L, S);
      this._drawLegend(L, i1);
      this._drawEventTip(L);
    }
    _drawEvents(main, plotW) {
      this._evBoxes = [];
      const ev = this.events; if (!ev || !ev.length || !this.bars.length) return;
      const ctx = this.ctx, n = this.bars.length, stack = new Map();
      const COL = { earn: '#ffb547', div: '#4fa3ff', split: '#b48cff' }, LET = { earn: 'E', div: 'D', split: 'S' };
      ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const e of ev) {
        const fi = this.timeToIndex(e.t);
        const i = fi > n - 1 ? Math.round(fi) : Math.floor(fi + 1e-6); // 落在包含这个时间的那根K线上
        if (i < 0) continue;
        const x = this.xOf(i, plotW); if (x < -8 || x > plotW + 8) continue;
        const k = stack.get(i) || 0; stack.set(i, k + 1);
        const y = main.top + main.h - 11 - k * 19, r = 8;
        const col = e.kind === 'earn' && e.beat ? (e.beat === 'beat' ? C.up : C.down) : COL[e.kind] || '#999';
        ctx.fillStyle = C.bg; ctx.beginPath(); ctx.arc(x, y, r + 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#0b0f17'; ctx.fillText(LET[e.kind] || '?', x, y + 0.5);
        this._evBoxes.push({ x, y, r, e });
      }
    }
    eventAt(x, y) { return (this._evBoxes || []).find((b) => (x - b.x) ** 2 + (y - b.y) ** 2 <= (b.r + 2) ** 2) || null; }
    _drawEventTip(L) {
      const m = this.mouse; if (!m) return;
      const b = this.eventAt(m.x, m.y); if (!b) return;
      const ctx = this.ctx, lines = [b.e.title, ...String(b.e.detail || '').split(' · ')];
      ctx.font = '12px system-ui';
      const w = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 16, h = lines.length * 17 + 10;
      let x = Math.min(b.x + 12, L.plotW - w - 4), y = Math.max(4, b.y - h - 8);
      if (x < 4) x = 4;
      ctx.fillStyle = 'rgba(22,29,41,0.96)'; ctx.strokeStyle = '#3a4760'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.rect(x + 0.5, y + 0.5, w, h); ctx.fill(); ctx.stroke();
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      lines.forEach((s, k) => { ctx.fillStyle = k ? C.text : '#ffb547'; ctx.font = k ? '12px system-ui' : 'bold 12px system-ui'; ctx.fillText(s, x + 8, y + 6 + k * 17); });
    }
    _drawTimeGrid(L, i0, i1) {
      const ctx = this.ctx, { plotW } = L;
      const step = Math.max(1, Math.round(90 / this.spacing));
      this._timeStep = step;
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.beginPath();
      const start = Math.floor(this.indexAtX(0, plotW) / step) * step;
      for (let i = start; i <= this.rightIndex; i += step) {
        const x = Math.round(this.xOf(i, plotW)) + 0.5;
        if (x < 0 || x > plotW) continue;
        ctx.moveTo(x, 0); ctx.lineTo(x, L.plotH);
      }
      ctx.stroke();
    }
    _drawPriceGrid(pane, S, plotW) {
      const ctx = this.ctx;
      const step = niceStep(S.max - S.min, pane.h / 60);
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.beginPath();
      for (let p = Math.ceil(S.min / step) * step; p <= S.max; p += step) {
        const y = Math.round(S.y(p)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(plotW, y);
      }
      ctx.stroke();
    }
    _drawPriceAxis(pane, S, plotW) {
      const ctx = this.ctx;
      ctx.fillStyle = C.bg; ctx.fillRect(plotW, pane.top, AXIS_W, pane.h);
      ctx.strokeStyle = C.axisLine; ctx.beginPath(); ctx.moveTo(plotW + 0.5, pane.top); ctx.lineTo(plotW + 0.5, pane.top + pane.h); ctx.stroke();
      const step = niceStep(S.max - S.min, pane.h / 60);
      const dec = Math.max(0, Math.min(8, -Math.floor(Math.log10(step)) + (step / 10 ** Math.floor(Math.log10(step)) === 1 ? 0 : 1)));
      ctx.fillStyle = C.axis; ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      for (let p = Math.ceil(S.min / step) * step; p <= S.max; p += step) {
        const y = S.y(p); if (y < pane.top + 6 || y > pane.top + pane.h - 6) continue;
        ctx.fillText(p.toFixed(dec), plotW + 6, y);
      }
    }
    _drawMain(S, i0, i1, plotW) {
      const t = this.chartType || 'candle';
      if (t === 'line' || t === 'area') {
        const ctx = this.ctx, closes = this.bars.map((b) => b.c);
        if (t === 'area') {
          let started = false, firstX = 0, lastX = 0;
          ctx.beginPath();
          for (let i = i0; i <= i1; i++) { const x = this.xOf(i, plotW), y = S.y(closes[i]); if (!started) { ctx.moveTo(x, y); firstX = x; started = true; } else ctx.lineTo(x, y); lastX = x; }
          const bottom = this._L.panes[0].top + this._L.panes[0].h;
          ctx.lineTo(lastX, bottom); ctx.lineTo(firstX, bottom); ctx.closePath();
          const g = ctx.createLinearGradient(0, this._L.panes[0].top, 0, bottom);
          g.addColorStop(0, 'rgba(90,176,255,0.35)'); g.addColorStop(1, 'rgba(90,176,255,0.02)');
          ctx.fillStyle = g; ctx.fill();
        }
        ctx.lineWidth = 1.8; this._drawLine(closes, S, i0, i1, plotW, '#5ab0ff'); ctx.lineWidth = 1;
        return;
      }
      if (t === 'hollow') return this._drawHollow(S, i0, i1, plotW);
      return this._drawCandles(S, i0, i1, plotW, t === 'ha' ? this.ha : this.bars);
    }
    // 空心K线：收盘高于开盘画空心，低于开盘画实心；颜色按和上一根收盘比涨跌
    _drawHollow(S, i0, i1, plotW) {
      const ctx = this.ctx, bw = Math.max(1, Math.floor(this.spacing * 0.72)), B = this.bars;
      ctx.lineWidth = 1;
      for (let i = i0; i <= i1; i++) {
        const b = B[i], prev = B[i - 1], col = !prev || b.c >= prev.c ? C.up : C.down;
        const x = Math.round(this.xOf(i, plotW)), yo = S.y(b.o), yc = S.y(b.c);
        const top = Math.round(Math.min(yo, yc)), bot = Math.round(Math.max(yo, yc)), hgt = Math.max(1, bot - top);
        ctx.strokeStyle = ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(x + 0.5, Math.round(S.y(b.h))); ctx.lineTo(x + 0.5, top); ctx.moveTo(x + 0.5, bot); ctx.lineTo(x + 0.5, Math.round(S.y(b.l))); ctx.stroke();
        if (b.c >= b.o && bw >= 3) ctx.strokeRect(x - Math.floor(bw / 2) + 0.5, top + 0.5, bw - 1, Math.max(1, hgt - 1));
        else ctx.fillRect(x - Math.floor(bw / 2), top, bw, hgt);
      }
    }
    // 成交量分布：可见区域内各价位的成交量，画在主图右侧；最大的一档（POC）高亮
    _drawVolumeProfile(pane, S, i0, i1, plotW) {
      const ctx = this.ctx, n = Math.max(12, Math.min(48, Math.floor(pane.h / 12)));
      const lo = S.min, hi = S.max, step = (hi - lo) / n; if (!(step > 0)) return;
      const up = new Array(n).fill(0), dn = new Array(n).fill(0);
      for (let i = i0; i <= i1; i++) {
        const b = this.bars[i]; if (!b.v) continue;
        const a = Math.max(0, Math.floor((b.l - lo) / step)), z = Math.min(n - 1, Math.floor((b.h - lo) / step));
        if (z < a) continue;
        const per = b.v / (z - a + 1), arr = b.c >= b.o ? up : dn;
        for (let k = a; k <= z; k++) arr[k] += per;
      }
      let mx = 0, poc = 0; for (let k = 0; k < n; k++) { const t = up[k] + dn[k]; if (t > mx) { mx = t; poc = k; } }
      if (!mx) return;
      const W = plotW * 0.24;
      for (let k = 0; k < n; k++) {
        const y0 = S.y(lo + (k + 1) * step), y1 = S.y(lo + k * step), h = Math.max(1, y1 - y0 - 1);
        const wu = (up[k] / mx) * W, wd = (dn[k] / mx) * W;
        ctx.fillStyle = k === poc ? 'rgba(255,181,71,0.45)' : 'rgba(46,189,133,0.22)'; ctx.fillRect(plotW - wu - wd, y0, wu, h);
        ctx.fillStyle = k === poc ? 'rgba(255,181,71,0.65)' : 'rgba(240,80,110,0.22)'; ctx.fillRect(plotW - wd, y0, wd, h);
      }
      const yp = S.y(lo + (poc + 0.5) * step);
      ctx.strokeStyle = 'rgba(255,181,71,0.7)'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(0, yp); ctx.lineTo(plotW, yp); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#ffb547'; ctx.font = '10px system-ui'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText('POC 成交最密集', plotW - W - 6, yp - 2);
    }
    _drawCandles(S, i0, i1, plotW, B) {
      B = B || this.bars;
      const ctx = this.ctx, bw = Math.max(1, Math.floor(this.spacing * 0.72));
      for (const up of [true, false]) {
        ctx.fillStyle = ctx.strokeStyle = up ? C.up : C.down;
        ctx.beginPath();
        for (let i = i0; i <= i1; i++) {
          const b = B[i]; if ((b.c >= b.o) !== up) continue;
          const x = Math.round(this.xOf(i, plotW));
          ctx.moveTo(x + 0.5, Math.round(S.y(b.h))); ctx.lineTo(x + 0.5, Math.round(S.y(b.l)));
        }
        ctx.lineWidth = 1; ctx.stroke();
        for (let i = i0; i <= i1; i++) {
          const b = B[i]; if ((b.c >= b.o) !== up) continue;
          const x = Math.round(this.xOf(i, plotW));
          const yo = S.y(b.o), yc = S.y(b.c);
          const top = Math.round(Math.min(yo, yc)), hgt = Math.max(1, Math.round(Math.abs(yc - yo)));
          ctx.fillRect(x - Math.floor(bw / 2), top, bw, hgt);
        }
      }
    }
    _drawVolume(pane, i0, i1, plotW) {
      const ctx = this.ctx, bw = Math.max(1, Math.floor(this.spacing * 0.72));
      let mx = 0; for (let i = i0; i <= i1; i++) mx = Math.max(mx, this.bars[i].v);
      if (!mx) return;
      const vh = pane.h * 0.18, base = pane.top + pane.h;
      for (let i = i0; i <= i1; i++) {
        const b = this.bars[i], x = Math.round(this.xOf(i, plotW));
        const hh = (b.v / mx) * vh;
        ctx.fillStyle = b.c >= b.o ? 'rgba(46,189,133,0.28)' : 'rgba(240,80,110,0.28)';
        ctx.fillRect(x - Math.floor(bw / 2), base - hh, bw, hh);
      }
    }
    _drawLine(data, S, i0, i1, plotW, color, dash, style) {
      const ctx = this.ctx;
      if (style === 'dots') {
        ctx.fillStyle = color; const r = Math.max(1.2, Math.min(2.5, this.spacing * 0.22));
        ctx.beginPath();
        for (let i = Math.max(0, i0); i <= Math.min(data.length - 1, i1); i++) {
          const v = data[i]; if (v == null) continue;
          const x = this.xOf(i, plotW), y = S.y(v); ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2);
        }
        ctx.fill(); return;
      }
      ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.setLineDash(dash || []);
      ctx.beginPath(); let started = false;
      for (let i = Math.max(0, i0 - 1); i <= Math.min(data.length - 1, i1 + 1); i++) {
        const v = data[i]; if (v == null) { started = false; continue; }
        const x = this.xOf(i, plotW), y = S.y(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    _drawLastPrice(pane, S, plotW) {
      const ctx = this.ctx, last = this.bars[this.bars.length - 1];
      const y = S.y(last.c);
      if (y < pane.top || y > pane.top + pane.h) return;
      const col = last.c >= last.o ? C.up : C.down;
      ctx.strokeStyle = col; ctx.setLineDash([2, 3]); ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(plotW, Math.round(y) + 0.5); ctx.stroke(); ctx.setLineDash([]);
      // 价格标签 + 收盘倒计时
      let next = last.t + this.intervalMs;
      if (this.intervalMs > 25 * 86400e3) { const d = new Date(last.t); next = new Date(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()).getTime(); }
      const remain = Math.max(0, next - Date.now());
      const s = Math.floor(remain / 1000);
      const cd = s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
        : s >= 3600 ? `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}` : `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
      ctx.fillStyle = col; ctx.fillRect(plotW, y - 9, AXIS_W, 32);
      ctx.fillStyle = '#fff'; ctx.font = '600 11px ui-monospace, Menlo, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(last.c.toFixed(decimalsFor(last.c)), plotW + 6, y);
      ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.fillText(cd, plotW + 6, y + 14);
    }
    _drawSubPane(pane, i0, i1, plotW) {
      const ctx = this.ctx;
      ctx.strokeStyle = C.sep; ctx.beginPath(); ctx.moveTo(0, pane.top + 0.5); ctx.lineTo(this.w, pane.top + 0.5); ctx.stroke();
      ctx.save(); ctx.beginPath(); ctx.rect(0, pane.top, plotW, pane.h); ctx.clip();
      const inst = pane.ind.inst, out = pane.ind.out, lines = out.lines || [], hist = out.hist;
      // 纵轴范围：固定范围（RSI 0~100）或按可见区域自动
      let lo, hi;
      if (Array.isArray(out.range)) [lo, hi] = out.range;
      else {
        lo = Infinity; hi = -Infinity;
        const arrs = lines.map((l) => l.data); if (hist) arrs.push(hist.data);
        for (const arr of arrs) for (let i = i0; i <= i1; i++) { const v = arr[i]; if (v == null) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (out.band) { lo = Math.min(lo, out.band[0]); hi = Math.max(hi, out.band[1]); }
        if (!isFinite(lo)) { lo = 0; hi = 1; }
        if (out.range === 'zero' || hist) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
        if (out.symmetric) { const a = Math.max(Math.abs(lo), Math.abs(hi)) || 1; lo = -a; hi = a; }
        if (hi === lo) { hi += 1; lo -= 1; }
      }
      const S = this._scale(pane, lo, hi, 6);
      if (out.band) { ctx.fillStyle = 'rgba(143,155,179,0.06)'; ctx.fillRect(0, S.y(out.band[1]), plotW, S.y(out.band[0]) - S.y(out.band[1])); }
      if (out.levels) {
        ctx.strokeStyle = C.grid; ctx.setLineDash([3, 3]); ctx.beginPath();
        for (const v of out.levels) { const y = Math.round(S.y(v)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(plotW, y); }
        ctx.stroke(); ctx.setLineDash([]);
      }
      if (hist) {
        const bw = Math.max(1, Math.floor(this.spacing * (hist.mode === 'bar' ? 0.72 : 0.6))), y0 = S.y(0);
        for (let i = i0; i <= i1; i++) {
          const v = hist.data[i]; if (v == null) continue;
          const x = Math.round(this.xOf(i, plotW)), y = S.y(v);
          const pos = hist.mode === 'bar' ? this.bars[i].c >= this.bars[i].o : v >= 0;
          ctx.fillStyle = pos ? 'rgba(46,189,133,0.6)' : 'rgba(240,80,110,0.6)';
          ctx.fillRect(x - Math.floor(bw / 2), Math.min(y, y0), bw, Math.max(1, Math.abs(y - y0)));
        }
      }
      for (const ln of lines) this._drawLine(ln.data, S, i0, i1, plotW, ln.color, ln.dash, ln.style);
      ctx.restore();
      pane.S = S;
      const fmt = (v) => (v == null ? '-' : out.priceLike ? v.toFixed(decimalsFor(v)) : out.range === 'zero' ? fmtVol(v) : fmtNum(v));
      pane.fmt = fmt;
      // 轴
      ctx.fillStyle = C.bg; ctx.fillRect(plotW, pane.top + 1, AXIS_W, pane.h - 1);
      ctx.strokeStyle = C.axisLine; ctx.beginPath(); ctx.moveTo(plotW + 0.5, pane.top); ctx.lineTo(plotW + 0.5, pane.top + pane.h); ctx.stroke();
      ctx.fillStyle = C.axis; ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      let ticks = out.levels;
      if (!ticks) { const st = niceStep(hi - lo, Math.max(2, pane.h / 45)); ticks = []; for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) ticks.push(v); }
      for (const v of ticks) { const y = S.y(v); if (y < pane.top + 8 || y > pane.top + pane.h - 4) continue; ctx.fillText(fmtNum(v), plotW + 6, y); }
      // 副图图例
      const idx = this._hoverIndex() ?? i1;
      ctx.font = '11px system-ui'; ctx.textBaseline = 'top'; let x = 8;
      const put = (t, col) => {
        const w = ctx.measureText(t).width;
        ctx.fillStyle = 'rgba(13,17,23,0.72)'; ctx.fillRect(x - 3, pane.top + 4, w + 8, 15);
        ctx.fillStyle = col; ctx.fillText(t, x, pane.top + 6); x += w + 10;
      };
      put(Indicators.label(inst), C.axis);
      if (hist && hist.mode === 'bar') { const b = this.bars[idx]; put(hist.label + ' ' + (b ? fmtVol(b.v) : '-'), b && b.c >= b.o ? C.up : C.down); }
      for (const ln of lines) put(`${ln.label} ${fmt(ln.data[idx])}`, ln.color);
      if (hist && hist.mode === 'sign') { const v = hist.data[idx]; put(`${hist.label} ${fmt(v)}`, v >= 0 ? C.up : C.down); }
    }
    _drawTimeAxis(L, i0, i1) {
      const ctx = this.ctx, { plotW } = L, y = L.plotH;
      ctx.fillStyle = C.bg; ctx.fillRect(0, y, this.w, TIME_H);
      ctx.strokeStyle = C.axisLine; ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(this.w, y + 0.5); ctx.stroke();
      ctx.fillStyle = C.axis; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const step = this._timeStep;
      const start = Math.floor(this.indexAtX(0, plotW) / step) * step;
      for (let i = start; i <= this.rightIndex; i += step) {
        const x = this.xOf(i, plotW); if (x < 20 || x > plotW - 20) continue;
        const t = this.indexToTime(i), d = new Date(t);
        let label = fmtTime(t, this.intervalMs, false);
        if (this.intervalMs < 86400e3 && d.getHours() === 0 && d.getMinutes() === 0) label = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        if (this.intervalMs >= 86400e3 && d.getMonth() === 0 && d.getDate() <= 7) label = String(d.getFullYear());
        ctx.fillText(label, x, y + TIME_H / 2);
      }
    }
    _hoverIndex() {
      if (!this.mouse && this.syncT != null && this.bars.length) { const i = Math.floor(this.timeToIndex(this.syncT) + 1e-6); return i >= 0 && i < this.bars.length ? i : null; }
      if (!this.mouse || !this._L || this.mouse.x < 0 || this.mouse.y < 0 || this.mouse.x >= this._L.plotW || this.mouse.y >= this._L.plotH) return null;
      const i = Math.round(this.indexAtX(this.mouse.x, this._L.plotW));
      return i >= 0 && i < this.bars.length ? i : null;
    }
    _drawCrosshair(L, S) {
      if (!this.mouse && this.syncT != null && this.bars.length) {
        // 其它图上鼠标所在的时间：画一条竖线
        const i = Math.floor(this.timeToIndex(this.syncT) + 1e-6), x = Math.round(this.xOf(i, L.plotW)) + 0.5;
        if (x < 0 || x > L.plotW) return;
        const ctx = this.ctx;
        ctx.strokeStyle = C.cross; ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, L.plotH); ctx.stroke(); ctx.setLineDash([]);
        const tl = fmtTime(this.indexToTime(i), this.intervalMs, true);
        ctx.font = '11px system-ui'; const tw = ctx.measureText(tl).width + 14;
        ctx.fillStyle = C.labelBg; ctx.fillRect(x - tw / 2, L.plotH + 1, tw, TIME_H - 2);
        ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(tl, x, L.plotH + TIME_H / 2);
        return;
      }
      const m = this.mouse; if (!m || m.x < 0 || m.y < 0 || m.x >= L.plotW || m.y >= L.plotH || this.drag?.type === 'pan') return;
      const ctx = this.ctx, { plotW } = L;
      const fi = Math.round(this.indexAtX(m.x, plotW));
      const x = Math.round(this.xOf(fi, plotW)) + 0.5, y = Math.round(m.y) + 0.5;
      ctx.strokeStyle = C.cross; ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(x, 0); ctx.lineTo(x, L.plotH); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); ctx.setLineDash([]);
      // 价格标签
      const pane = this.paneAt(m.y, L);
      const sc = !pane ? null : pane.id === 'main' ? S : pane.S;
      if (sc) {
        const v = sc.p(m.y);
        const txt = pane.id === 'main' ? v.toFixed(decimalsFor(v)) : (pane.fmt ? pane.fmt(v) : v.toFixed(2));
        ctx.fillStyle = C.labelBg; ctx.fillRect(plotW, y - 10, AXIS_W, 20);
        ctx.fillStyle = C.text; ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(txt, plotW + 6, y);
      }
      // 时间标签
      const tl = fmtTime(this.indexToTime(fi), this.intervalMs, true);
      ctx.font = '11px system-ui'; const tw = ctx.measureText(tl).width + 14;
      ctx.fillStyle = C.labelBg; ctx.fillRect(x - tw / 2, L.plotH + 1, tw, TIME_H - 2);
      ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(tl, x, L.plotH + TIME_H / 2);
    }
    _drawLegend(L, i1) {
      const ctx = this.ctx, idx = this._hoverIndex() ?? Math.min(i1, this.bars.length - 1);
      const b = this.bars[idx]; if (!b) return;
      const prev = this.bars[idx - 1];
      const chg = prev ? ((b.c - prev.c) / prev.c) * 100 : 0;
      const dec = decimalsFor(b.c), col = b.c >= b.o ? C.up : C.down;
      ctx.font = '12px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      let x = 8; let y = 8;
      const maxX = this._L.plotW - 12;
      // 每段文字带半透明底色，避免与 K 线重叠时看不清；放不下就换行
      const put = (t, c, gap = 8) => {
        const w = ctx.measureText(t).width;
        if (x > 8 && x + w > maxX) { x = 8; y += 17; }
        ctx.fillStyle = 'rgba(13,17,23,0.72)'; ctx.fillRect(x - 3, y - 2, w + gap, 16);
        ctx.fillStyle = c; ctx.fillText(t, x, y); x += w + gap;
      };
      // 多图时格子较小：平时只显示收盘价，鼠标移上来才显示完整数值
      const compact = this.w < 560, hovering = !!this.mouse || this.syncT != null;
      if (!compact || hovering) {
        put('开', C.axis); put(b.o.toFixed(dec), col);
        put('高', C.axis); put(b.h.toFixed(dec), col);
        put('低', C.axis); put(b.l.toFixed(dec), col);
      }
      put('收', C.axis); put(b.c.toFixed(dec), col);
      put((chg >= 0 ? '+' : '') + chg.toFixed(2) + '%', chg >= 0 ? C.up : C.down);
      if (!compact || hovering) { put('量', C.axis); put(fmtVol(b.v), C.text); }
      if (compact && !hovering) return;
      // 叠加指标数值
      x = 8; y += 18; ctx.font = '11px ui-monospace, Menlo, monospace';
      for (const c of this._cmp || []) {
        const v = c.al[idx], v0 = c.al[c.b0], m0 = this.bars[c.b0].c;
        if (v == null || !v0) continue;
        const pc = (v / v0 - 1) * 100, pm = (this.bars[idx].c / m0 - 1) * 100;
        put(`${c.label} ${pc >= 0 ? '+' : ''}${pc.toFixed(2)}%（本品种 ${pm >= 0 ? '+' : ''}${pm.toFixed(2)}%）`, c.color, 10);
      }
      for (const o of this._overlays()) {
        const lines = o.out.lines;
        if (lines.length > 1) put(Indicators.label(o.inst), C.axis, 6);
        for (const ln of lines) { const v = ln.data[idx]; put(`${ln.label} ${v == null ? '-' : v.toFixed(dec)}`, ln.color, 10); }
      }
    }

    // ---------------- 画线 ----------------
    _pt(d, S, plotW) { return { x: this.xOf(this.timeToIndex(d.t), plotW), y: S.y(d.p) }; }
    _drawDrawings(S, plotW) {
      const ctx = this.ctx;
      const list = this.pending ? this.drawings.concat([this.pending]) : this.drawings;
      this._boxes = {};
      for (const d of list) {
        const sel = d.id === this.selectedId || d === this.pending;
        ctx.strokeStyle = sel ? C.drawSel : (d.color || C.draw); ctx.lineWidth = sel ? 1.6 : 1.3;
        ctx.fillStyle = ctx.strokeStyle;
        const handles = [];
        const line = (a, b) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
        if (d.type === 'hline') {
          const y = S.y(d.p1.p); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
          ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
          ctx.fillText(d.p1.p.toFixed(decimalsFor(d.p1.p)), plotW - 4, y - 2);
        } else if (d.type === 'text') {
          const a = this._pt(d.p1, S, plotW);
          ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          const lines = String(d.text || '').split('\n');
          const w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 12, h = lines.length * 17 + 6;
          ctx.fillStyle = sel ? 'rgba(255,181,71,0.25)' : 'rgba(22,29,41,0.88)';
          ctx.fillRect(a.x, a.y - h / 2, w, h);
          ctx.strokeRect(a.x + 0.5, a.y - h / 2 + 0.5, w, h);
          ctx.fillStyle = d.color || C.draw;
          lines.forEach((t, k) => ctx.fillText(t, a.x + 6, a.y - h / 2 + 3 + 8.5 + k * 17));
          this._boxes[d.id] = { x0: a.x, y0: a.y - h / 2, x1: a.x + w, y1: a.y + h / 2 };
          handles.push(a);
        } else {
          const a = this._pt(d.p1, S, plotW), b = this._pt(d.p2, S, plotW);
          const c = d.p3 ? this._pt(d.p3, S, plotW) : null;
          handles.push(a, b); if (c) handles.push(c);
          if (d.type === 'trend') line(a, b);
          else if (d.type === 'ray') line(a, this._rayEnd(a, b, plotW));
          else if (d.type === 'rect') {
            ctx.globalAlpha = 0.12; ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
            ctx.globalAlpha = 1; ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
          } else if (d.type === 'fib') {
            const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
            ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
            for (const r of FIB) {
              const p = d.p2.p + (d.p1.p - d.p2.p) * r, y = S.y(p);
              ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
              ctx.fillText(`${r} (${p.toFixed(decimalsFor(p))})`, x0 + 2, y - 1);
            }
            ctx.setLineDash([3, 3]); line(a, b); ctx.setLineDash([]);
          } else if (d.type === 'channel') {
            line(a, b);
            if (c) {
              const [a2, b2] = this._channelPts(d, S, plotW);
              line(a2, b2);
              ctx.globalAlpha = 0.08; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(b2.x, b2.y); ctx.lineTo(a2.x, a2.y); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
              ctx.setLineDash([4, 4]); line({ x: a.x, y: (a.y + a2.y) / 2 }, { x: b.x, y: (b.y + b2.y) / 2 }); ctx.setLineDash([]);
            }
          } else if (d.type === 'fibext') {
            ctx.setLineDash([3, 3]); line(a, b); if (c) line(b, c); ctx.setLineDash([]);
            if (c) {
              ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
              const x0 = c.x, x1 = Math.max(c.x + 40, Math.min(plotW, c.x + Math.abs(b.x - a.x) * 1.5));
              for (const r of FIBX) {
                const p = d.p3.p + (d.p2.p - d.p1.p) * r, y = S.y(p);
                ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
                ctx.fillText(`${r} (${p.toFixed(decimalsFor(p))})`, x0 + 2, y - 1);
              }
            }
          } else if (d.type === 'measure') {
            const up = d.p2.p >= d.p1.p, col = up ? '46,189,133' : '240,80,110';
            const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
            ctx.fillStyle = `rgba(${col},0.16)`; ctx.fillRect(x0, y0, w, h);
            ctx.strokeStyle = `rgba(${col},0.9)`; line({ x: a.x, y: a.y }, { x: a.x, y: b.y }); line({ x: a.x, y: b.y }, b);
            const dp = d.p2.p - d.p1.p, pct = (dp / d.p1.p) * 100;
            const nb = Math.round(this.timeToIndex(d.p2.t) - this.timeToIndex(d.p1.t));
            const txt = [`${dp >= 0 ? '+' : ''}${dp.toFixed(decimalsFor(d.p1.p))}（${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%）`, `${Math.abs(nb)} 根K线 · ${fmtSpan(Math.abs(d.p2.t - d.p1.t))}`];
            ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            const tw = Math.max(...txt.map((t) => ctx.measureText(t).width)) + 14, lx = (a.x + b.x) / 2, ly = up ? y0 - 24 : y0 + h + 24;
            ctx.fillStyle = `rgba(${col},0.92)`; ctx.fillRect(lx - tw / 2, ly - 18, tw, 36);
            ctx.fillStyle = '#fff'; ctx.fillText(txt[0], lx, ly - 8); ctx.fillText(txt[1], lx, ly + 8);
          }
        }
        if (d.locked && handles[0] || d.locked && d.type === 'hline') { const hp = handles[0] || { x: 12, y: S.y(d.p1.p) }; ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText('🔒', hp.x + 4, hp.y - 3); }
        if (sel && !d.locked) for (const h of handles) { ctx.fillStyle = C.bg; ctx.strokeStyle = C.drawSel; ctx.beginPath(); ctx.arc(h.x, h.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      }
    }
    _rayEnd(a, b, plotW) {
      const dx = b.x - a.x, dy = b.y - a.y;
      if (Math.abs(dx) < 1e-6) return { x: a.x, y: dy > 0 ? 1e5 : -1e5 };
      const X = dx > 0 ? plotW + 10 : -10, k = (X - a.x) / dx;
      return { x: X, y: a.y + dy * k };
    }
    // 平行通道的另一条线：主线（p1→p2）按 p3 平移
    _channelPts(d, S, plotW) {
      const i1 = this.timeToIndex(d.p1.t), i2 = this.timeToIndex(d.p2.t), i3 = this.timeToIndex(d.p3.t);
      const onLine = i2 === i1 ? d.p1.p : d.p1.p + ((d.p2.p - d.p1.p) * (i3 - i1)) / (i2 - i1);
      const dp = d.p3.p - onLine;
      return [this._pt({ t: d.p1.t, p: d.p1.p + dp }, S, plotW), this._pt({ t: d.p2.t, p: d.p2.p + dp }, S, plotW)];
    }
    _hitDrawing(x, y) {
      const S = this._S, plotW = this._L.plotW;
      for (let k = this.drawings.length - 1; k >= 0; k--) {
        const d = this.drawings[k];
        if (d.type === 'hline') { if (Math.abs(S.y(d.p1.p) - y) < 6) return { d, part: 'body' }; continue; }
        if (d.type === 'text') { const bx = this._boxes && this._boxes[d.id]; if (bx && x >= bx.x0 && x <= bx.x1 && y >= bx.y0 && y <= bx.y1) return { d, part: 'body' }; continue; }
        const a = this._pt(d.p1, S, plotW), b = this._pt(d.p2, S, plotW);
        const c = d.p3 ? this._pt(d.p3, S, plotW) : null;
        if (Math.hypot(x - a.x, y - a.y) < 7) return { d, part: 'p1' };
        if (Math.hypot(x - b.x, y - b.y) < 7) return { d, part: 'p2' };
        if (c && Math.hypot(x - c.x, y - c.y) < 7) return { d, part: 'p3' };
        let hit = false;
        if (d.type === 'trend') hit = distToSeg(x, y, a.x, a.y, b.x, b.y) < 6;
        else if (d.type === 'ray') { const e = this._rayEnd(a, b, plotW); hit = distToSeg(x, y, a.x, a.y, e.x, e.y) < 6; }
        else if (d.type === 'rect' || d.type === 'measure') {
          const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
          hit = x >= x0 - 4 && x <= x1 + 4 && y >= y0 - 4 && y <= y1 + 4;
        } else if (d.type === 'fib') {
          const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
          if (x >= x0 && x <= x1) hit = FIB.some((r) => Math.abs(S.y(d.p2.p + (d.p1.p - d.p2.p) * r) - y) < 5);
        } else if (d.type === 'channel') {
          hit = distToSeg(x, y, a.x, a.y, b.x, b.y) < 6;
          if (!hit && c) { const [a2, b2] = this._channelPts(d, S, plotW); hit = distToSeg(x, y, a2.x, a2.y, b2.x, b2.y) < 6; }
        } else if (d.type === 'fibext') {
          hit = distToSeg(x, y, a.x, a.y, b.x, b.y) < 5 || (c && distToSeg(x, y, b.x, b.y, c.x, c.y) < 5);
          if (!hit && c && x >= c.x) hit = FIBX.some((r) => Math.abs(S.y(d.p3.p + (d.p2.p - d.p1.p) * r) - y) < 5);
        }
        if (hit) return { d, part: 'body' };
      }
      return null;
    }
    _pointAt(x, y) { return { t: this.indexToTime(this.indexAtX(x, this._L.plotW)), p: this._S.p(y) }; }

    // ---------------- 交互 ----------------
    _bind() {
      const cv = this.canvas;
      const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      cv.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return; // 右键交给 contextmenu
        if (!this._L || !this.bars.length) return;
        cv.setPointerCapture(e.pointerId);
        const m = pos(e), L = this._L;
        this.mouse = m;
        if (m.x > L.plotW && m.y < L.panes[0].h) { this.drag = { type: 'yzoom', y: m.y, z: this.yZoom }; return; }
        if (m.y > L.plotH) { this.drag = { type: 'xzoom', x: m.x, s: this.spacing }; return; }
        const inMain = m.y < L.panes[0].h && m.x < L.plotW;
        // 两次点击模式下的第二次点击：完成绘制
        if (this.pending && (this.pending._waiting || this.pending._w3)) { this._finishPending(); return; }
        if (this.tool !== 'cursor' && inMain) {
          const p = this._pointAt(m.x, m.y);
          const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          if (this.tool === 'hline') {
            this.drawings.push({ id, type: 'hline', p1: p }); this.selectedId = id;
            this._drawingsChanged(); this._toolDone(); return;
          }
          if (this.tool === 'text') {
            try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
            const text = this.opts.askText ? this.opts.askText('') : null;
            if (text) { this.drawings.push({ id, type: 'text', p1: p, text }); this.selectedId = id; this._drawingsChanged(); }
            this._toolDone(); return;
          }
          this.pending = { id, type: this.tool, p1: p, p2: { ...p } };
          this.drag = { type: 'draw', x: m.x, y: m.y }; this.dirty = true; return;
        }
        if (inMain) {
          const hit = this._hitDrawing(m.x, m.y);
          if (hit && hit.d.locked) { this.selectedId = hit.d.id; this.dirty = true; this.drag = { type: 'pan', x: m.x, r: this.rightIndex }; return; }
          if (hit) {
            this.selectedId = hit.d.id;
            this.drag = { type: 'edit', part: hit.part, d: hit.d, start: this._pointAt(m.x, m.y), orig: JSON.parse(JSON.stringify(hit.d)), moved: false };
            this.dirty = true; return;
          }
          if (this.selectedId) { this.selectedId = null; this.dirty = true; }
        }
        this.drag = { type: 'pan', x: m.x, r: this.rightIndex };
        cv.style.cursor = 'grabbing';
      });
      cv.addEventListener('pointermove', (e) => {
        const m = pos(e); this.mouse = m; this.dirty = true;
        const d = this.drag;
        if (this._L && m.x >= 0 && m.x < this._L.plotW && m.y >= 0 && m.y < this._L.plotH) this._emitHover(this.indexToTime(Math.round(this.indexAtX(m.x, this._L.plotW))));
        else this._emitHover(null);
        if (this.pending && this.pending._waiting) { this.pending.p2 = this._pointAt(m.x, m.y); return; }
        if (this.pending && this.pending._w3) { this.pending.p3 = this._pointAt(m.x, m.y); return; }
        if (!d) {
          if (this.tool === 'cursor' && this._L) {
            const L = this._L;
            if (m.x > L.plotW) cv.style.cursor = m.y < L.panes[0].h ? 'ns-resize' : 'default';
            else if (m.y > L.plotH) cv.style.cursor = 'ew-resize';
            else cv.style.cursor = m.y < L.panes[0].h && this._hitDrawing(m.x, m.y) ? 'pointer' : 'default';
          }
          return;
        }
        if (d.type === 'pan') { this.rightIndex = d.r + (d.x - m.x) / this.spacing; this._clampView(); this._maybeNeedMore(); this._emitView(); }
        else if (d.type === 'yzoom') { this.yZoom = Math.max(0.1, Math.min(20, d.z * Math.exp((m.y - d.y) / 150))); }
        else if (d.type === 'xzoom') { this._zoomAround(this._L.plotW, d.s * Math.exp((m.x - d.x) / 150), true); this._emitView(); }
        else if (d.type === 'draw') { this.pending.p2 = this._pointAt(m.x, m.y); }
        else if (d.type === 'edit') {
          const cur = this._pointAt(m.x, m.y); d.moved = true;
          if (d.part === 'p1' || d.part === 'p2' || d.part === 'p3') d.d[d.part] = cur;
          else {
            const dt = cur.t - d.start.t, dp = cur.p - d.start.p;
            d.d.p1 = { t: d.orig.p1.t + dt, p: d.orig.p1.p + dp };
            if (d.orig.p2) d.d.p2 = { t: d.orig.p2.t + dt, p: d.orig.p2.p + dp };
            if (d.orig.p3) d.d.p3 = { t: d.orig.p3.t + dt, p: d.orig.p3.p + dp };
          }
        }
      });
      const up = (e) => {
        const d = this.drag; this.drag = null;
        if (this.tool === 'cursor') cv.style.cursor = 'default';
        if (!d) return;
        if (d.type === 'draw') {
          const m = pos(e);
          if (Math.hypot(m.x - d.x, m.y - d.y) < 4) this.pending._waiting = true; // 改为“点两下”模式
          else this._finishPending();
        } else if (d.type === 'edit' && d.moved) this._drawingsChanged();
        this.dirty = true;
      };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      cv.addEventListener('pointerleave', () => { if (!this.drag) { this.mouse = null; this.dirty = true; this._emitHover(null); } });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (!this._L) return;
        const m = pos(e);
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          // 触控板横向滑动 / Shift+滚轮：平移
          this.rightIndex += (e.deltaX || e.deltaY) / this.spacing; this._clampView(); this._maybeNeedMore();
        } else {
          const ns = this.spacing * Math.exp(-e.deltaY * 0.0015);
          this._zoomAround(Math.min(m.x, this._L.plotW), ns, false);
        }
        this.dirty = true; this._emitView();
      }, { passive: false });
      // 右键：交给外面弹菜单（右键点在画线上会先选中它）
      cv.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!this._L || !this.bars.length || !this.opts.onContext) return;
        const m = pos(e), L = this._L;
        if (this.pending) { this.pending = null; this.dirty = true; }
        const inMainY = m.y < L.panes[0].h;
        const info = { clientX: e.clientX, clientY: e.clientY, area: m.y > L.plotH ? 'time' : m.x > L.plotW ? (inMainY ? 'price' : 'sub') : inMainY ? 'main' : 'sub' };
        if (inMainY && m.y <= L.plotH) { info.price = this._S.p(m.y); info.t = this.indexToTime(Math.round(this.indexAtX(Math.min(m.x, L.plotW), L.plotW))); }
        if (info.area === 'main') {
          const hit = this._hitDrawing(m.x, m.y);
          if (hit) { info.drawing = hit.d; this.selectedId = hit.d.id; this.dirty = true; this._selChanged(); }
          info.point = this._pointAt(m.x, m.y);
        }
        this.opts.onContext(info);
      });
      cv.addEventListener('dblclick', (e) => {
        const m = pos(e);
        if (this._L && m.x > this._L.plotW) { this.yZoom = 1; this.dirty = true; }
        if (this._L && m.y > this._L.plotH) { this.spacing = 8; this.goLatest(); this._emitView(); }
        // 双击文字标注：修改文字
        if (this._L && m.x < this._L.plotW && m.y < this._L.panes[0].h) {
          const hit = this._hitDrawing(m.x, m.y);
          if (hit && hit.d.type === 'text' && !hit.d.locked && this.opts.askText) {
            const t = this.opts.askText(hit.d.text);
            if (t != null && t !== '') { hit.d.text = t; this._drawingsChanged(); }
          }
        }
      });
    }
    _finishPending() {
      const p = this.pending; delete p._waiting;
      // 三点工具（平行通道、斐波那契扩展）：前两点定好后，再移动鼠标定第三点，点一下完成
      if (THREE_POINT.has(p.type) && !p._w3) { p.p3 = { ...p.p2 }; p._w3 = true; this.dirty = true; return; }
      delete p._w3;
      this.drawings.push(p); this.selectedId = p.id; this.pending = null;
      this._drawingsChanged(); this._toolDone();
    }
    _toolDone() { this.opts.onToolDone && this.opts.onToolDone(); }
    _zoomAround(x, ns, anchorRight) {
      const plotW = this._L.plotW;
      ns = Math.max(1.5, Math.min(60, ns));
      const ax = anchorRight ? plotW : x;
      const i = this.indexAtX(ax, plotW);
      this.spacing = ns;
      this.rightIndex = i + (plotW - ax) / ns;
      this._clampView(); this._maybeNeedMore(); this.dirty = true;
    }
    _clampView() {
      const n = this.bars.length, vis = this._L ? this._L.plotW / this.spacing : 100;
      this.rightIndex = Math.min(this.rightIndex, n - 1 + vis * 0.8);
      this.rightIndex = Math.max(this.rightIndex, Math.min(n - 1, vis * 0.2));
    }
    _maybeNeedMore() {
      if (!this._L) return;
      if (this.indexAtX(0, this._L.plotW) < 100 && this.opts.onNeedMore) this.opts.onNeedMore();
    }
  }

  global.CandleChart = Chart;
  global.ChartUtil = { decimalsFor, fmtVol, fmtNum };
})(window);
