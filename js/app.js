// 应用层：市场切换、周期、多图布局、自选列表（多列表 + 板块 + 拖动排序）、指标、画线、警报、实时订阅。
(function () {
  const INTERVALS = [['1m', '1分'], ['5m', '5分'], ['15m', '15分'], ['30m', '30分'], ['1h', '1时'], ['4h', '4时'], ['1d', '日'], ['1w', '周'], ['1M', '月'], ['ytd', '今年至今']];
  const LAYOUTS = [1, 2, 4, 6, 8];
  const STORE = 'guanchao.v1';
  const $ = (id) => document.getElementById(id);
  const FORCE_DEMO = /[?&]demo\b/.test(location.search);
  const REAL = { crypto: Feeds.OkxFeed, us: Feeds.AlpacaFeed };
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 出错时直接显示在页面顶部，方便排查 ----------
  window.addEventListener('error', (e) => {
    const err = e.error, where = err && err.stack ? String(err.stack).split('\n')[1] || '' : (e.filename ? `${e.filename}:${e.lineno}` : '');
    const b = $('banner'); if (!b) return;
    b.hidden = false; b.textContent = `程序出错：${e.message || err} ${where.trim()}`;
  });
  window.addEventListener('unhandledrejection', (e) => {
    const b = $('banner'); if (!b) return;
    b.hidden = false; b.textContent = '程序出错：' + (e.reason && e.reason.message || e.reason);
  });

  // ---------- 本地保存 ----------
  const sec = (name) => ({ t: 'h', id: uid('h'), name, collapsed: false });
  const sym = (s) => ({ t: 's', s });
  const DEFAULT_LISTS = {
    crypto: () => [{ id: uid('l'), name: '我的自选', items: [sec('主流'), sym('BTC-USDT'), sym('ETH-USDT'), sec('其他'), sym('SOL-USDT'), sym('BNB-USDT'), sym('XRP-USDT'), sym('DOGE-USDT')] }],
    us: () => [{ id: uid('l'), name: '我的自选', items: [sec('科技'), sym('AAPL'), sym('MSFT'), sym('NVDA'), sym('AMZN'), sym('TSLA'), sec('指数 ETF'), sym('SPY'), sym('QQQ')] }],
  };
  const defaults = {
    market: 'crypto', interval: '15m',
    markets: {},
    indicators: null,
    alpaca: { key: '', secret: '', feed: 'iex', tradier: '' },
    extHours: false,
    drawings: {},
    alerts: [],
    alertLog: [],
    avKey: '',
    push: { ntfy: '', discord: '', bark: '' },
    events: true,
    layouts: [],
  };
  let state;
  try { state = { ...defaults, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch (_) { state = { ...defaults }; }
  // 第一版数据迁移：BTCUSDT → BTC-USDT
  if (state.watchlist) {
    const conv = (s) => Feeds.OkxFeed.normalizeSymbol(s);
    state.markets = { ...state.markets, crypto: { symbol: conv(state.symbol || 'BTCUSDT'), watchlist: state.watchlist.map(conv) } };
    for (const k of Object.keys(state.drawings)) if (!k.includes('-') && /USDT$/.test(k)) state.drawings[conv(k)] = state.drawings[k];
    delete state.watchlist; delete state.symbol;
  }
  state.markets = state.markets || {};
  for (const m of ['crypto', 'us']) {
    const old = state.markets[m] || {}, mk = { ...old };
    // 旧版单一自选数组 → 多列表
    if (!Array.isArray(mk.lists) || !mk.lists.length) {
      mk.lists = Array.isArray(old.watchlist) && old.watchlist.length
        ? [{ id: uid('l'), name: '我的自选', items: old.watchlist.map(sym) }]
        : DEFAULT_LISTS[m]();
    }
    delete mk.watchlist;
    if (!mk.lists.some((l) => l.id === mk.activeList)) mk.activeList = mk.lists[0].id;
    if (!LAYOUTS.includes(mk.layout)) mk.layout = 1;
    if (!Array.isArray(mk.cells)) mk.cells = [old.symbol || REAL[m].defaults.symbol];
    delete mk.symbol;
    mk.active = Math.min(Math.max(0, mk.active | 0), mk.layout - 1);
    state.markets[m] = mk;
  }
  state.alpaca = { ...defaults.alpaca, ...state.alpaca };
  if (!Array.isArray(state.alerts)) state.alerts = [];
  if (!Array.isArray(state.alertLog)) state.alertLog = [];
  if (!Array.isArray(state.layouts)) state.layouts = [];
  state.push = { ...defaults.push, ...(state.push || {}) };
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (_) {} };
  Feeds.AlpacaFeed.configure(state.alpaca);
  Feeds.AlpacaFeed.setRthOnly(!state.extHours);
  // 指标：旧版是开关对象 {ma:true,...}，新版是可自定义的实例列表
  state.indicators = Indicators.sanitize(state.indicators) || (() => {
    const old = state.indicators && typeof state.indicators === 'object' ? state.indicators : null;
    if (!old) return Indicators.defaults();
    const list = [];
    if (old.ma) list.push(Indicators.create('ma', { n: 20 }, '#f5c451'), Indicators.create('ma', { n: 50 }, '#5ab0ff'), Indicators.create('ma', { n: 200 }, '#c58cff'));
    if (old.ema) list.push(Indicators.create('ema', { n: 12 }, '#ff8f5a'), Indicators.create('ema', { n: 26 }, '#4fd1c5'));
    if (old.boll) list.push(Indicators.create('boll'));
    if (old.rsi) list.push(Indicators.create('rsi'));
    if (old.macd) list.push(Indicators.create('macd'));
    return list;
  })();
  save();

  const M = () => state.markets[state.market];
  const IV_NAME = Object.fromEntries(INTERVALS);
  // 每个图自己的周期：M().ivs[k] 是周期按钮的 id（'1m' … '1M'、'ytd'），没设过就用最近一次选的
  const ivKey = (k) => { const v = (M().ivs || [])[k]; return v || (state.range === 'ytd' ? 'ytd' : state.interval); };
  const ivOf = (k) => (ivKey(k) === 'ytd' ? '1d' : ivKey(k));
  const activeList = () => M().lists.find((l) => l.id === M().activeList) || M().lists[0];
  const listSyms = (l) => (l || activeList()).items.filter((x) => x.t === 's').map((x) => x.s);
  const simFeeds = { crypto: Feeds.makeSim(Feeds.OkxFeed), us: Feeds.makeSim(Feeds.AlpacaFeed) };
  const usingSim = { crypto: FORCE_DEMO, us: FORCE_DEMO };
  const feedOf = (m) => (usingSim[m] ? simFeeds[m] : REAL[m]);
  const feed = () => feedOf(state.market);
  // VWAP 按交易日重新累计：美股按美东日期，加密货币按 UTC 日期（美东时间按整点缓存，避免反复格式化）
  const etCache = new Map();
  const etDay = (t) => { const h = Math.floor(t / 3600e3); let v = etCache.get(h); if (v === undefined) { v = Feeds.etInfo(t).date; etCache.set(h, v); } return v; };
  const utcDay = (t) => Math.floor(t / 86400e3);

  let tickers = {};
  let lastEventAt = 0;

  // =====================================================================
  // 多图：每个格子一个图表，共用同一个周期和指标设置
  // =====================================================================
  const chartBox = $('chart');
  const cells = [];
  function makeCell(k) {
    const el = document.createElement('div'); el.className = 'cell';
    el.innerHTML = '<div class="cell-head"><span class="sym"></span><span class="iv"></span><span class="px"></span><span class="chg"></span></div><div class="cell-body"></div>';
    const c = { k, el, symbol: null, token: 0, unsub: null, loadingMore: false, noMore: false, emptyText: '加载历史数据…', status: 'connecting' };
    c.chart = new CandleChart(el.querySelector('.cell-body'), {
      onNeedMore: () => loadMore(c),
      onDrawingsChange: (list) => drawingsChanged(c, list),
      onToolDone: () => setTool('cursor'),
      onSelect: () => { if (c.k === M().active) renderLineAlertBtn(); },
      askText: (init) => prompt('标注文字：', init || ''),
      onContext: (info) => openCtxMenu(c, info),
      // 多图联动：鼠标位置、缩放平移同步到其它图
      onHover: (t) => { if (syncOn()) for (const o of visibleCells()) if (o !== c) o.chart.syncHover(t); },
      onView: (v) => { if (syncOn()) for (const o of visibleCells()) if (o !== c) o.chart.syncView(v, o.iv !== c.iv); },
      emptyText: () => c.emptyText,
    });
    c.chart.setIndicators(state.indicators);
    c.chart.setChartType(state.chartType || 'candle');
    c.chart.setVolumeProfile(state.vprofile);
    // 按下鼠标就切换为“当前图”（用 capture，先于图表自己的处理）
    el.addEventListener('pointerdown', () => setActive(c.k), true);
    return c;
  }
  const activeCell = () => cells[M().active] || cells[0];
  const syncOn = () => state.sync !== false && M().layout > 1;
  function setActive(k) {
    if (k === M().active || k >= M().layout) return;
    M().active = k; save();
    cells.forEach((c) => c.el.classList.toggle('on', c.k === k));
    renderQuote(); renderWatchlist(); renderLineAlertBtn(); setStatus(activeCell().status, true); markInterval();
  }
  function applyLayout() {
    const n = M().layout;
    while (cells.length < n) cells.push(makeCell(cells.length));
    chartBox.className = 'chart n' + n + (n > 1 ? ' multi' : '');
    chartBox.innerHTML = '';
    // 新增的格子自动填上自选里还没显示的品种
    const syms = M().cells, pool = listSyms().filter((s) => !syms.includes(s));
    for (let k = 0; k < n; k++) if (!syms[k]) syms[k] = pool.shift() || syms[0] || feed().defaults.symbol;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k];
      if (k < n) { chartBox.appendChild(c.el); c.el.classList.toggle('on', k === M().active); }
      else { stopCell(c); c.symbol = null; }
    }
    $('layout').querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.n === n));
    $('sync-btn').hidden = n === 1;
    $('sync-btn').classList.toggle('on', state.sync !== false);
    save();
  }
  function stopCell(c) { c.token++; if (c.unsub) { c.unsub(); c.unsub = null; } }
  const visibleCells = () => cells.slice(0, M().layout);

  // ---------- 市场切换 ----------
  const markMarket = () => $('market').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === state.market));
  $('market').querySelectorAll('button').forEach((b) => (b.onclick = () => {
    if (b.dataset.m === state.market) return;
    state.market = b.dataset.m; save(); startMarket();
  }));

  // ---------- 周期 ----------
  const ivBox = $('intervals');
  for (const [id, label] of INTERVALS) {
    const b = document.createElement('button');
    b.textContent = label; b.dataset.iv = id;
    if (id === 'ytd') b.title = '日线，显示今年 1 月 1 日到现在';
    // “今年至今”是日线 + 把视图缩放到今年 1 月 1 日以来
    // 多图时只改当前选中的图（橙色边框那个）
    b.onclick = () => {
      const m = M();
      m.ivs = Array.from({ length: Math.max(m.layout, (m.ivs || []).length) }, (_, k) => ivKey(k)); // 先把各图现在的周期记下来
      if (id === 'ytd') { state.interval = '1d'; state.range = 'ytd'; } else { state.interval = id; state.range = null; }
      if (m.layout === 1) m.ivs = [id]; else m.ivs[m.active] = id;
      save(); loadAll(true);
    };
    ivBox.appendChild(b);
  }
  const markInterval = () => { const cur = ivKey(M().active); ivBox.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.iv === cur)); };

  // ---------- 布局 ----------
  for (const n of LAYOUTS) {
    const b = document.createElement('button');
    b.textContent = n === 1 ? '1图' : String(n); b.dataset.n = n; b.title = `同时显示 ${n} 个图`;
    b.onclick = () => {
      if (M().layout === n) return;
      M().layout = n; M().active = Math.min(M().active, n - 1); save();
      applyLayout(); loadAll(true); startTickers();
    };
    $('layout').appendChild(b);
  }

  $('sync-btn').onclick = () => {
    state.sync = state.sync === false; save();
    $('sync-btn').classList.toggle('on', state.sync !== false);
    if (!state.sync) for (const c of cells) c.chart.syncHover(null);
  };

  // ---------- K线样式 ----------
  $('ctype').value = state.chartType || 'candle';
  $('ctype').onchange = () => { state.chartType = $('ctype').value; save(); cells.forEach((c) => c.chart.setChartType(state.chartType)); };

  // ---------- 对比叠加：同图叠加其它品种（按同样的起点比涨跌幅） ----------
  const CMP_COLORS = ['#ff6fae', '#4fd1c5', '#9ad16b'];
  const cmpCache = new Map();
  const compares = () => (M().compares = M().compares || []);
  function getCmpBars(sym, iv) {
    const key = [state.market, sym, iv, state.extHours, feed().id].join('|');
    if (!cmpCache.has(key)) cmpCache.set(key, feed().loadHistory(sym, iv).catch(() => { cmpCache.delete(key); return []; }));
    return cmpCache.get(key);
  }
  // ---------- 财报 / 分红 / 拆股标记 ----------
  const evCache = new Map(); // 品种 → Promise<{events, notes}>
  let evNotes = [];
  async function loadEvents(c) {
    const f = feed(), s = c.symbol, token = c.token;
    if (!state.events || state.market !== 'us' || !f.events) { c.chart.setEvents([]); return; }
    const key = f.id + '|' + s;
    if (!evCache.has(key)) evCache.set(key, f.events(s, Date.UTC(2015, 11, 1), state.avKey).catch((e) => ({ events: [], notes: ['读取失败：' + e.message] })));
    const r = await evCache.get(key);
    if (token !== c.token) return;
    c.chart.setEvents(r.events);
    if (c.k === M().active) { evNotes = r.notes; const el = $('ev-note'); if (el) el.textContent = evNotes.join('；'); }
  }
  async function loadCompares(c) {
    const token = c.token, list = [];
    for (const [k, sym] of compares().entries()) {
      if (sym === c.symbol) continue;
      const bars = await getCmpBars(sym, c.iv);
      if (token !== c.token) return;
      list.push({ symbol: sym, color: CMP_COLORS[k % CMP_COLORS.length], bars: bars.map((b) => ({ ...b })) });
    }
    c.chart.setCompares(list);
  }
  async function addCompare(raw) {
    const s = feed().normalizeSymbol(raw || '');
    if (!s || compares().includes(s)) return;
    if (compares().length >= 3) { alertToast('最多对比 3 个品种', '可以先删掉一个再加。'); return; }
    let ok = wantedSyms().includes(s);
    if (!ok) try { ok = await feed().validateSymbol(s); } catch (_) {}
    if (!ok) { alertToast('找不到这个代码', s); return; }
    compares().push(s); save(); renderIndicatorPanel();
    visibleCells().forEach(loadCompares); startTickers();
  }

  // ---------- 盘前盘后（仅美股） ----------
  const extBtn = $('ext-btn');
  extBtn.onclick = () => {
    state.extHours = !state.extHours; save();
    Feeds.AlpacaFeed.setRthOnly(!state.extHours);
    extBtn.classList.toggle('on', state.extHours);
    loadAll(); startTickers();
  };

  // ---------- 指标面板（可自定义：改参数、改颜色、加多条、隐藏、删除） ----------
  const indList = $('ind-list');
  const applyIndicators = () => { save(); cells.forEach((c) => c.chart.setIndicators(state.indicators)); };
  function renderIndicatorPanel() {
    indList.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ind-head';
    head.innerHTML = '<b>指标</b><small>改完立即生效，会自动保存；所有图共用</small>';
    indList.appendChild(head);
    // 成交量分布
    const vp = document.createElement('div'); vp.className = 'ind-sec';
    vp.innerHTML = `<label><input type="checkbox" id="vp-cb" ${state.vprofile ? 'checked' : ''}>成交量分布（各价位成交量，画在主图右侧）</label>`;
    vp.querySelector('input').onchange = (e) => { state.vprofile = e.target.checked; save(); cells.forEach((c) => c.chart.setVolumeProfile(state.vprofile)); };
    indList.appendChild(vp);
    // 财报 / 分红标记
    const evs = document.createElement('div'); evs.className = 'ind-sec ev-sec';
    evs.innerHTML = state.market === 'us'
      ? `<label><input type="checkbox" id="ev-cb" ${state.events ? 'checked' : ''}>财报 / 分红 / 拆股标记（图底部的 E、D、S，鼠标移上去看详情）</label><small id="ev-note">${esc(state.events ? evNotes.join('；') : '')}</small>`
      : '<label class="off"><input type="checkbox" disabled>财报 / 分红标记：只有美股有</label>';
    const evcb = evs.querySelector('#ev-cb');
    if (evcb) evcb.onchange = (e) => { state.events = e.target.checked; save(); visibleCells().forEach(loadEvents); renderIndicatorPanel(); };
    indList.appendChild(evs);
    // 对比叠加
    const cmp = document.createElement('div'); cmp.className = 'ind-sec';
    cmp.innerHTML = '<span>对比叠加</span>' + compares().map((x, k) => `<span class="chip"><i style="background:${CMP_COLORS[k % 3]}"></i>${esc(x)}<button data-k="${k}" title="去掉">×</button></span>`).join('') +
      `<input type="text" id="cmp-in" placeholder="${state.market === 'us' ? 'SPY' : 'ETH'}" spellcheck="false"><button class="btn" id="cmp-add">+ 对比</button>`;
    cmp.querySelectorAll('.chip button').forEach((b) => (b.onclick = () => {
      compares().splice(+b.dataset.k, 1); save(); renderIndicatorPanel(); visibleCells().forEach(loadCompares); startTickers();
    }));
    cmp.querySelector('#cmp-add').onclick = () => addCompare(cmp.querySelector('#cmp-in').value);
    cmp.querySelector('#cmp-in').onkeydown = (e) => { if (e.key === 'Enter') addCompare(e.target.value); };
    indList.appendChild(cmp);
    if (!state.indicators.length) {
      const e = document.createElement('div'); e.className = 'ind-empty'; e.textContent = '还没有指标，在下面添加'; indList.appendChild(e);
    }
    state.indicators.forEach((inst, idx) => {
      const def = Indicators.TYPES[inst.type];
      const row = document.createElement('div');
      row.className = 'ind-row' + (inst.visible === false ? ' off' : '');
      const vis = document.createElement('input');
      vis.type = 'checkbox'; vis.checked = inst.visible !== false; vis.title = '显示 / 隐藏';
      vis.onchange = () => { inst.visible = vis.checked; row.classList.toggle('off', !vis.checked); applyIndicators(); };
      const name = document.createElement('span');
      name.className = 'ind-name'; name.textContent = def.name.split(' ')[0];
      name.title = def.name + (def.kind === 'pane' ? '（副图）' : '（主图）');
      row.append(vis, name);
      const params = document.createElement('span');
      params.className = 'ind-params';
      if (!def.params.length) { const s = document.createElement('label'); s.textContent = inst.type === 'vwap' ? '每个交易日重新计算' : '无参数'; params.appendChild(s); }
      for (const pd of def.params) {
        const l = document.createElement('label');
        l.textContent = pd.label;
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = pd.min; inp.max = pd.max; inp.step = pd.step || 1; inp.value = inst.params[pd.key];
        inp.onchange = () => {
          let v = Number(inp.value);
          if (!isFinite(v) || inp.value === '') v = pd.def;
          v = Math.min(pd.max, Math.max(pd.min, pd.step ? v : Math.round(v)));
          inp.value = v; inst.params[pd.key] = v; applyIndicators();
        };
        l.appendChild(inp); params.appendChild(l);
      }
      row.appendChild(params);
      const color = document.createElement('input');
      color.type = 'color'; color.value = inst.color; color.title = '颜色';
      color.oninput = () => { inst.color = color.value; applyIndicators(); };
      const del = document.createElement('button');
      del.className = 'ind-del'; del.textContent = '×'; del.title = '删除';
      del.onclick = () => { state.indicators.splice(idx, 1); applyIndicators(); renderIndicatorPanel(); };
      row.append(color, del);
      indList.appendChild(row);
    });
    const add = document.createElement('div');
    add.className = 'ind-add';
    const sel = document.createElement('select');
    for (const kind of ['overlay', 'pane']) {
      const g = document.createElement('optgroup'); g.label = kind === 'overlay' ? '主图（画在K线上）' : '副图（单独一栏）';
      for (const [k, d] of Object.entries(Indicators.TYPES)) if (d.kind === kind) {
        const o = document.createElement('option'); o.value = k; o.textContent = d.name; g.appendChild(o);
      }
      sel.appendChild(g);
    }
    const btn = document.createElement('button');
    btn.className = 'btn primary'; btn.textContent = '+ 添加';
    btn.onclick = () => {
      const type = sel.value;
      // 同类指标再加一条时，换个颜色、默认周期也错开，方便区分
      const same = state.indicators.filter((x) => x.type === type).length;
      const inst = Indicators.create(type, undefined, same ? Indicators.PALETTE[(state.indicators.length) % Indicators.PALETTE.length] : undefined);
      if (same && (type === 'ma' || type === 'ema' || type === 'wma')) inst.params.n = [5, 10, 30, 60, 120][same % 5];
      state.indicators.push(inst); applyIndicators(); renderIndicatorPanel();
      indList.querySelector('.ind-add select').value = type;
    };
    const reset = document.createElement('button');
    reset.className = 'btn'; reset.textContent = '恢复默认';
    reset.onclick = () => { state.indicators = Indicators.defaults(); applyIndicators(); renderIndicatorPanel(); };
    add.append(sel, btn, reset);
    indList.appendChild(add);
  }
  renderIndicatorPanel();
  const menus = ['ind-menu', 'alert-menu', 'lay-menu'];
  const closeMenus = (keep) => menus.forEach((id) => id !== keep && $(id).classList.remove('open'));
  $('ind-btn').onclick = (e) => { e.stopPropagation(); closeMenus('ind-menu'); $('ind-menu').classList.toggle('open'); };
  $('lay-btn').onclick = (e) => { e.stopPropagation(); closeMenus('lay-menu'); if ($('lay-menu').classList.toggle('open')) renderLayoutPanel(); };
  $('alert-btn').onclick = (e) => {
    e.stopPropagation(); closeMenus('alert-menu');
    if ($('alert-menu').classList.toggle('open')) renderAlertPanel(true);
  };
  document.addEventListener('click', (e) => {
    const path = e.composedPath();
    for (const id of menus) if (!path.includes($(id))) $(id).classList.remove('open');
  });
  $('latest-btn').onclick = () => visibleCells().forEach((c) => c.chart.goLatest());

  // ---------- 画线工具 ----------
  function setTool(t) {
    cells.forEach((c) => c.chart.setTool(t));
    document.querySelectorAll('#tools [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  }
  document.querySelectorAll('#tools [data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  $('del-sel').onclick = () => activeCell().chart.deleteSelected();
  $('del-all').onclick = () => activeCell().chart.clearDrawings();
  // ---------- 快捷键 ----------
  const KEY_TOOLS = { KeyT: 'trend', KeyR: 'ray', KeyH: 'hline', KeyC: 'channel', KeyB: 'rect', KeyF: 'fib', KeyX: 'fibext', KeyN: 'text', KeyM: 'measure' };
  const anyDialogOpen = () => [...document.querySelectorAll('dialog')].some((d) => d.open);
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable) return;
    if (anyDialogOpen() || !$('sym-search').hidden) return;
    if (e.metaKey || e.ctrlKey) return; // 不抢系统快捷键（复制、刷新等）
    const c = activeCell(), ch = c && c.chart;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Delete' || e.key === 'Backspace') { ch.deleteSelected(); return done(); }
    if (e.key === 'Escape') { setTool('cursor'); closeCtx(); return; }
    if (e.altKey) {
      if (KEY_TOOLS[e.code]) { setTool(KEY_TOOLS[e.code]); return done(); }
      const dg = /^Digit([1-5])$/.exec(e.code);
      if (dg) { $('layout').querySelector(`[data-n="${LAYOUTS[+dg[1] - 1]}"]`).click(); return done(); }
      if (e.code === 'KeyA') { $('alert-btn').click(); return done(); }
      if (e.code === 'KeyI') { $('ind-btn').click(); return done(); }
      if (e.code === 'KeyS') { $('sc-btn').click(); return done(); }
      return;
    }
    if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) { $('keys-help').showModal(); return done(); }
    if (e.shiftKey && /^Digit\d$/.test(e.code)) {
      const n = +e.code.slice(5), id = n === 0 ? 'ytd' : INTERVALS[n - 1] && INTERVALS[n - 1][0];
      if (id) { ivBox.querySelector(`[data-iv="${id}"]`).click(); return done(); }
    }
    if (e.key === ',' || e.key === '.') {
      const ids = INTERVALS.map((x) => x[0]), k = ids.indexOf(ivKey(M().active));
      const nk = Math.max(0, Math.min(ids.length - 1, k + (e.key === '.' ? 1 : -1)));
      if (nk !== k) ivBox.querySelector(`[data-iv="${ids[nk]}"]`).click();
      return done();
    }
    if (!ch) return;
    if (e.key === 'ArrowLeft') { ch.panBy(e.shiftKey ? -0.5 : -0.1); return done(); }
    if (e.key === 'ArrowRight') { ch.panBy(e.shiftKey ? 0.5 : 0.1); return done(); }
    if (e.key === 'ArrowUp') { ch.zoomBy(1.25); return done(); }
    if (e.key === 'ArrowDown') { ch.zoomBy(0.8); return done(); }
    if (e.key === 'End') { ch.goLatest(); return done(); }
    if (e.key === 'Home') { ch.resetView(); return done(); }
    if (e.key === 'Tab' && M().layout > 1) { const n = M().layout; setActive((M().active + (e.shiftKey ? n - 1 : 1)) % n); return done(); }
    // 直接打字：字母或数字开头，弹出代码框
    if (!e.shiftKey && e.key.length === 1 && /[a-z0-9]/i.test(e.key)) { openSymSearch(e.key); return done(); }
  });
  $('keys-btn').onclick = () => $('keys-help').showModal();
  $('keys-close').onclick = () => $('keys-help').close();

  // 代码框：输入代码回车，在当前图打开；下面列出自选里匹配的品种
  const symBox = $('sym-search'), symIn = $('sym-input'), symSug = $('sym-sug');
  let sugSel = 0, sugList = [];
  function allKnownSyms() {
    const set = new Set();
    for (const l of M().lists) for (const it of l.items) if (it.t === 's') set.add(it.s);
    for (const x of compares()) set.add(x);
    return [...set];
  }
  function renderSug() {
    const q = symIn.value.trim().toUpperCase();
    const all = allKnownSyms();
    sugList = q ? all.filter((x) => x.startsWith(q)).concat(all.filter((x) => !x.startsWith(q) && x.includes(q))).slice(0, 8) : [];
    sugSel = Math.min(sugSel, Math.max(0, sugList.length - 1));
    symSug.innerHTML = sugList.map((x, k) => `<li class="${k === sugSel ? 'on' : ''}" data-s="${esc(x)}">${esc(x)}<span>${tickers[x] ? fmtPx(tickers[x].last) : ''}</span></li>`).join('');
  }
  function openSymSearch(first) {
    symBox.hidden = false; symIn.value = first || ''; sugSel = 0; renderSug();
    symIn.focus(); symIn.setSelectionRange(symIn.value.length, symIn.value.length);
  }
  const closeSym = () => { symBox.hidden = true; symIn.blur(); };
  async function submitSym(raw) {
    const s = feed().normalizeSymbol(raw || '');
    closeSym();
    if (!s) return;
    if (!allKnownSyms().includes(s)) {
      let ok = false; try { ok = await feed().validateSymbol(s); } catch (_) {}
      if (!ok) { alertToast('找不到这个代码', s); return; }
    }
    openSymbol(s);
  }
  symIn.addEventListener('input', () => { sugSel = 0; renderSug(); });
  symIn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSym(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sugSel = Math.min(sugList.length - 1, sugSel + 1); renderSug(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sugSel = Math.max(0, sugSel - 1); renderSug(); }
    else if (e.key === 'Enter') { e.preventDefault(); const q = symIn.value.trim().toUpperCase(); submitSym(sugList.length && sugList[sugSel] && (sugSel > 0 || sugList[0].startsWith(q)) ? sugList[sugSel] : symIn.value); }
  });
  symIn.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== symIn) symBox.hidden = true; }, 150));
  symSug.addEventListener('pointerdown', (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); submitSym(li.dataset.s); } });
  function drawingsChanged(c, list) {
    state.drawings[c.symbol] = list;
    // 画线被删掉了，对应的画线警报也一起删掉
    const ids = new Set(list.map((d) => d.id));
    const before = state.alerts.length;
    state.alerts = state.alerts.filter((a) => !(a.kind === 'line' && a.market === state.market && a.symbol === c.symbol && !ids.has(a.drawingId)));
    save();
    // 其它显示同一品种的图也同步
    for (const o of visibleCells()) if (o !== c && o.symbol === c.symbol) o.chart.setDrawings(list.slice());
    if (before !== state.alerts.length) alertsChanged();
    else pushChartAlerts();
  }

  // ---------- 美股设置 ----------
  const dlg = $('settings'), form = $('settings-form');
  function openSettings() {
    form.key.value = state.alpaca.key; form.secret.value = state.alpaca.secret; form.feed.value = state.alpaca.feed; form.tradier.value = state.alpaca.tradier || ''; form.avkey.value = state.avKey || '';
    $('bk-res').textContent = ''; form.ntfy.value = state.push.ntfy; form.discord.value = state.push.discord; form.bark.value = state.push.bark; $('push-test-res').textContent = ''; $('tr-test-res').textContent = '';
    dlg.showModal();
  }
  $('settings-btn').onclick = openSettings;
  $('tr-test').onclick = async () => {
    const el = $('tr-test-res'), tok = form.tradier.value.trim();
    if (!tok) { el.textContent = '先填 Token'; return; }
    el.textContent = '测试中…';
    const r = await Feeds.AlpacaFeed.testTradier(tok);
    if (!r.ok) { el.textContent = '✗ ' + r.msg; return; }
    const age = r.t ? Math.round((Date.now() - r.t) / 60e3) : null;
    el.textContent = `✓ 连接成功：AAPL 最新成交 ${fmtPx(r.last)}` + (r.t ? `（${new Date(r.t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${age != null && age < 2 ? '，实时' : ''}）` : '') + `，近几天分钟K线 ${r.bars} 根`;
  };
  const readPushForm = () => ({ ntfy: form.ntfy.value.trim(), discord: form.discord.value.trim(), bark: form.bark.value.trim() });
  $('ntfy-gen').onclick = () => { const r = crypto.getRandomValues(new Uint8Array(9)); form.ntfy.value = 'guanchao-' + [...r].map((x) => 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]).join(''); };
  // ---------- 备份：导出 / 导入 ----------
  const SECRET_FIELDS = (st) => { st.alpaca = { ...st.alpaca, key: '', secret: '', tradier: '' }; st.avKey = ''; st.push = { ntfy: '', discord: '', bark: '' }; return st; };
  $('bk-export').onclick = () => {
    save();
    let data = JSON.parse(JSON.stringify(state));
    const withKeys = $('bk-keys').checked;
    if (!withKeys) data = SECRET_FIELDS(data);
    const pack = { app: 'guanchao', version: 1, exportedAt: new Date().toISOString(), withKeys, data };
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    const name = `guanchao-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    const a = document.createElement('a');
    // 用 data: 地址：本地文件打开的页面里 blob: 地址会丢掉文件名
    a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(pack, null, 1));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    $('bk-res').textContent = `已导出 ${name}（在「下载」文件夹）` + (withKeys ? '，包含 Key' : '，不含 Key');
  };
  $('bk-import').onclick = () => $('bk-file').click();
  $('bk-file').onchange = async () => {
    const f = $('bk-file').files[0]; $('bk-file').value = '';
    if (!f) return;
    let pack;
    try { pack = JSON.parse(await f.text()); } catch (_) { $('bk-res').textContent = '这个文件不是有效的备份'; return; }
    if (!pack || pack.app !== 'guanchao' || !pack.data || typeof pack.data !== 'object' || !pack.data.markets) { $('bk-res').textContent = '这个文件不是观潮看盘的备份'; return; }
    const d = pack.data, n = (m) => (d.markets[m] && d.markets[m].lists || []).reduce((k, l) => k + l.items.filter((x) => x.t === 's').length, 0);
    const msg = `导入 ${new Date(pack.exportedAt).toLocaleString()} 的备份？\n\n` +
      `美股 ${n('us')} 只、加密货币 ${n('crypto')} 只，画线 ${Object.values(d.drawings || {}).reduce((k, l) => k + l.length, 0)} 条，布局 ${(d.layouts || []).length} 个，警报 ${(d.alerts || []).length} 个。\n\n` +
      `现在的自选、画线、布局、警报和设置会被替换。` + (pack.withKeys ? '备份里的 Key 也会替换现在的 Key。' : '备份里没有 Key，会保留你现在的 Key。');
    if (!confirm(msg)) return;
    const next = { ...d };
    if (!pack.withKeys) { next.alpaca = { ...(d.alpaca || {}), key: state.alpaca.key, secret: state.alpaca.secret, tradier: state.alpaca.tradier || '' }; next.avKey = state.avKey; next.push = { ...state.push }; }
    try { localStorage.setItem(STORE, JSON.stringify(next)); } catch (_) { $('bk-res').textContent = '保存失败'; return; }
    dlg.close(); location.reload();
  };
  $('push-test').onclick = async () => {
    const cfg = readPushForm(), el = $('push-test-res');
    if (!cfg.ntfy && !cfg.discord && !cfg.bark) { el.textContent = '先填一个推送方式'; return; }
    el.textContent = '发送中…';
    const r = await sendPush('🔔 观潮看盘测试', '收到这条，说明警报推送设置好了。', cfg);
    el.textContent = r.map((x) => `${x.name}${x.ok === true ? ' ✓ 已发出' : x.ok === false ? ' ✗ ' + x.err : ' 已发出（请看手机/频道）'}`).join('　');
  };
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    state.alpaca = { key: form.key.value.trim(), secret: form.secret.value.trim(), feed: form.feed.value, tradier: form.tradier.value.trim() };
    const avChanged = (state.avKey || '') !== form.avkey.value.trim();
    state.avKey = form.avkey.value.trim(); if (avChanged) evCache.clear();
    state.push = readPushForm();
    save(); Feeds.AlpacaFeed.configure(state.alpaca);
    if (!FORCE_DEMO) usingSim.us = false;
    if (state.market === 'us') startMarket(); else startAlertWatch();
  });

  // ---------- 状态显示 ----------
  const STATUS_TEXT = {
    live: '实时', connecting: '连接中…', reconnecting: '断线重连中…', sim: '演示数据', error: '加载失败',
    autherr: 'API Key 无效', noperm: '无权限（SIP 需付费套餐）', paused: '已暂停（其它窗口在用）', connlimit: '连接数超限', symlimit: '订阅数超限', nokey: '未设置 API Key',
  };
  let statusBanner = false;
  // 实时推送诊断：状态旁显示最近一笔成交是几秒前，鼠标移上去看详情
  setInterval(() => {
    const el = $('status'), f = feed();
    if (!el || !f.streamStats || el.dataset.state !== 'live') { if (el) el.title = ''; const x = el && el.querySelector('em'); if (x) x.remove(); return; }
    const st = f.streamStats(), age = st.last ? Math.max(0, Math.round((Date.now() - st.last.t) / 1000)) : null;
    let em = el.querySelector('em'); if (!em) { em = document.createElement('em'); el.appendChild(em); }
    em.textContent = age == null ? ' · 等待成交' : age < 60 ? ` · ${age}秒前` : age < 3600 ? ` · ${Math.round(age / 60)}分钟前` : ' · 暂无新成交';
    el.title = `实时来源：${st.src}，订阅 ${st.subs} 只\n收到成交 ${st.n} 笔` + (st.last ? `\n最近一笔：${st.last.sym} ${fmtPx(st.last.p)}，${new Date(st.last.t).toLocaleTimeString('zh-CN')}` : '');
  }, 2000);
  function setStatus(s, quiet) {
    const el = $('status');
    el.className = 'status ' + (s === 'live' ? 'live' : s === 'sim' || s === 'nokey' ? 'sim' : '');
    el.querySelector('span').textContent = STATUS_TEXT[s] || s;
    el.dataset.state = s;
    if (quiet) return;
    // 连接恢复正常后，清掉之前因连接问题弹出的提示
    if (s === 'live' && statusBanner) { statusBanner = false; showBanner(''); }
    if (['autherr', 'noperm', 'connlimit', 'symlimit'].includes(s)) statusBanner = true;
    if (s === 'autherr') showBanner(state.alpaca.tradier ? 'Alpaca Key 或 Tradier Token 被拒绝，请检查是否填对。Tradier 要用正式环境（Production）的 Access Token，不能用 Sandbox 的。' : 'Alpaca 拒绝了你的 API Key，请检查 Key 和 Secret 是否填对。', '打开设置', openSettings);
    if (s === 'noperm') showBanner('当前 Alpaca 账号没有 SIP 全市场实时数据权限（需要付费套餐）。可以在设置里改回 IEX（免费）。', '打开设置', openSettings);
    if (s === 'connlimit') showBanner('Alpaca 免费账号同时只能开一个行情连接，正在自动重试。如果一直连不上，请关掉其它正在使用这个 Key 的窗口或程序。');
    if (s === 'symlimit') showBanner('超过 Alpaca 免费账号的订阅上限（同时最多 30 只股票，包括所有图、当前自选列表和警报里的股票），请减少一些。');
  }
  setInterval(() => {
    const el = $('status');
    if (el.dataset.state !== 'live' || !lastEventAt) return;
    const age = Math.round((Date.now() - lastEventAt) / 1000);
    el.querySelector('span').textContent = age <= 2 ? '实时' : age < 120 ? `实时 · ${age}秒前有成交` : '已连接 · 暂无成交';
  }, 1000);
  function showBanner(text, btnText, btnFn) {
    const b = $('banner'); b.hidden = !text; b.textContent = text || '';
    if (btnText) { const x = document.createElement('button'); x.className = 'btn'; x.textContent = btnText; x.onclick = btnFn; b.appendChild(x); }
  }
  function renderSourceNote() {
    let t = '数据源：' + feed().label;
    if (state.market === 'us' && feed() === Feeds.AlpacaFeed) t += state.extHours ? ' · 含盘前盘后' : ' · 只看常规时段（多数看盘软件的默认做法）';
    $('source-note').textContent = t + ' · 时间为本地时区';
  }

  // ---------- 报价：顶部 + 每个格子的小标题 ----------
  const fmtPx = (v) => (v == null ? '—' : v.toFixed(ChartUtil.decimalsFor(v)));
  const fmtPct = (p) => (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
  const cellPrice = (c) => { const b = c.chart.bars[c.chart.bars.length - 1]; const t = tickers[c.symbol]; return b ? b.c : t && t.last; };
  // 延迟 15 分钟的价格旁边放一个黄圈 D
  const DLY_TIP = '延迟 15 分钟：这个价格来自全市场数据（Alpaca 免费版这时没有实时成交），比实际晚约 15 分钟';
  const dlyHtml = (tip) => `<span class="dly" title="${esc(tip || DLY_TIP)}">D</span>`;
  const chartDelayed = () => state.market === 'us' && !!(feed().chartDelayed && feed().chartDelayed());
  function setDly(after, on) {
    const nx = after.nextElementSibling, has = nx && nx.classList.contains('dly');
    if (on && !has) after.insertAdjacentHTML('afterend', dlyHtml());
    else if (!on && has) nx.remove();
  }
  function renderCellHead(c) {
    const h = c.el.querySelector('.cell-head'), t = tickers[c.symbol], px = cellPrice(c);
    h.querySelector('.sym').textContent = c.symbol || '';
    h.querySelector('.iv').textContent = IV_NAME[ivKey(c.k)] || '';
    const pe = h.querySelector('.px'), ce = h.querySelector('.chg');
    pe.textContent = fmtPx(px);
    ce.textContent = t ? fmtPct(t.changePct) : '';
    const cls = t ? (t.changePct >= 0 ? 'up' : 'down') : '';
    pe.className = 'px ' + cls; ce.className = 'chg ' + cls;
    setDly(pe, chartDelayed() && px != null);
  }
  let flashTitle = false;
  function renderQuote() {
    const c = activeCell(); if (!c) return;
    const s = c.symbol, t = tickers[s], px = cellPrice(c);
    $('q-symbol').textContent = s;
    $('q-price').textContent = fmtPx(px);
    const ce = $('q-change');
    if (t) {
      ce.textContent = fmtPct(t.changePct) + '  ' + (state.market === 'us' ? '今日' : '24h');
      ce.className = 'q-change ' + (t.changePct >= 0 ? 'up' : 'down');
      $('q-price').className = 'q-price ' + (t.changePct >= 0 ? 'up' : 'down');
    } else { ce.textContent = ''; $('q-price').className = 'q-price'; }
    setDly($('q-price'), chartDelayed() && px != null);
    if (px != null) document.title = (flashTitle ? '🔔 ' : '') + `${s} ${fmtPx(px)} · 观潮看盘`;
  }

  // ---------- 加载 K 线 ----------
  function loadAll(onlyChanged) {
    if (!onlyChanged) cmpCache.clear();
    markInterval(); renderSourceNote();
    for (const c of visibleCells()) {
      const s = M().cells[c.k];
      if (onlyChanged && c.symbol === s && c.iv === ivOf(c.k) && c.ivKey === ivKey(c.k) && c.feedId === feed().id + state.extHours) continue;
      loadCell(c, s);
    }
    renderQuote(); renderWatchlist(); pushChartAlerts(); renderLineAlertBtn();
  }
  async function loadCell(c, symbol) {
    const token = ++c.token, f = feed();
    if (c.unsub) { c.unsub(); c.unsub = null; }
    const iv = ivOf(c.k), ytd = ivKey(c.k) === 'ytd';
    c.symbol = symbol; c.iv = iv; c.ivKey = ivKey(c.k); c.feedId = f.id + state.extHours;
    c.noMore = false; c.loadingMore = false;
    c.emptyText = '加载历史数据…';
    c.chart.setSessionKey(state.market === 'us' ? etDay : utcDay);
    c.chart.setData([], Feeds.INTERVAL_MS[iv]);
    c.chart.setDrawings(state.drawings[symbol] || []);
    renderCellHead(c);
    const isActive = () => c.k === M().active;
    if (f === Feeds.AlpacaFeed && !f.hasKey()) {
      c.emptyText = '请先点右上角「⚙ 设置」填入 Alpaca API Key 或 Tradier Token';
      c.status = 'nokey'; if (isActive()) setStatus('nokey');
      showBanner('看美股实时行情需要一个免费的 Alpaca API Key（在 alpaca.markets 注册后生成），或者 Tradier 证券账户的 Token，填到设置里。', '打开设置', openSettings);
      c.chart.dirty = true;
      return;
    }
    let bars;
    try {
      bars = await f.loadHistory(symbol, iv);
    } catch (err) {
      if (token !== c.token) return;
      if (err.kind === 'network' && f.id !== 'sim') {
        if (!usingSim[state.market]) {
          usingSim[state.market] = true;
          showBanner(`无法连接${state.market === 'us' ? (state.alpaca.tradier ? ' Tradier' : ' Alpaca') : ' OKX'} 行情接口（网络或地区限制），已切换为演示数据。图表上的价格不是真实行情。`);
          startTickers(); loadAll();
        }
        return;
      }
      c.emptyText = err.kind === 'auth' ? 'API Key 无效或没有权限' : '加载失败：' + err.message;
      c.status = err.kind === 'auth' ? (state.alpaca.feed === 'sip' && !state.alpaca.tradier ? 'noperm' : 'autherr') : 'error';
      if (isActive()) setStatus(c.status);
      c.chart.dirty = true;
      return;
    }
    if (token !== c.token) return;
    if (!bars.length) c.emptyText = state.market === 'us' && !state.extHours ? '这个周期暂无常规时段数据' : '这个周期暂无数据';
    c.chart.setData(bars, Feeds.INTERVAL_MS[iv]);
    if (compares().length) loadCompares(c); else c.chart.setCompares([]);
    loadEvents(c);
    if (ytd) c.chart.fitFrom(new Date(new Date().getFullYear(), 0, 1).getTime());
    // 数据源一次给的K线不多时，自动再往前补两页，保证 MA200 这类长周期指标一打开就有值
    if (bars.length && bars.length < 400) (async () => { for (let k = 0; k < 2 && token === c.token && !c.noMore && c.chart.bars.length < 400; k++) await loadMore(c); })();
    renderCellHead(c); if (isActive()) renderQuote();
    c.unsub = f.subscribeKline(symbol, iv, (bar) => {
      if (token !== c.token) return;
      lastEventAt = Date.now();
      c.chart.updateBar(bar);
      uiLater('head' + c.k, () => { renderCellHead(c); if (isActive()) renderQuote(); }); // 文字最多每帧刷新一次
      onPrice(state.market, symbol, bar.c);
    }, (s) => { c.status = s; if (isActive()) setStatus(s); }, bars[bars.length - 1]);
  }
  async function loadMore(c) {
    if (c.loadingMore || c.noMore || !c.chart.bars.length) return;
    c.loadingMore = true;
    const token = c.token;
    try {
      const older = await feed().loadHistory(c.symbol, c.iv, c.chart.bars[0].t - 1);
      if (token !== c.token) return;
      if (!older.length || older[0].t >= c.chart.bars[0].t) c.noMore = true; else c.chart.prependData(older);
    } catch (_) { /* 下次滚动再试 */ }
    finally { c.loadingMore = false; }
  }
  // 在当前图里打开某个品种
  function openSymbol(s) {
    const c = activeCell();
    if (c.symbol === s) return;
    M().cells[c.k] = s; save();
    loadCell(c, s); renderQuote(); renderWatchlist(); pushChartAlerts(); renderLineAlertBtn(); startTickers();
  }

  // =====================================================================
  // 自选：多个列表，每个列表里可以分板块，拖动排序
  // =====================================================================
  const ul = $('watchlist');
  function renderListSelect() {
    const sel = $('list-sel'); sel.innerHTML = '';
    for (const l of M().lists) {
      const o = document.createElement('option'); o.value = l.id; o.textContent = `${l.name}（${listSyms(l).length}）`; sel.appendChild(o);
    }
    sel.value = activeList().id;
  }
  $('list-sel').onchange = (e) => { M().activeList = e.target.value; save(); renderWatchlist(); startTickers(); };
  $('list-new').onclick = () => {
    const name = (prompt('新列表的名字：', '新列表') || '').trim(); if (!name) return;
    const l = { id: uid('l'), name, items: [] }; M().lists.push(l); M().activeList = l.id; save(); renderWatchlist(); startTickers();
    $('add-input').focus();
  };
  $('list-ren').onclick = () => {
    const l = activeList(); const name = (prompt('列表改名为：', l.name) || '').trim(); if (!name) return;
    l.name = name; save(); renderWatchlist();
  };
  $('list-del').onclick = () => {
    if (M().lists.length <= 1) { alertToast('至少要保留一个列表', '可以先新建一个列表再删这个。'); return; }
    const l = activeList();
    if (!confirm(`删除列表「${l.name}」？里面的 ${listSyms(l).length} 个品种会从这个列表移除（不影响其它列表）。`)) return;
    M().lists = M().lists.filter((x) => x !== l); M().activeList = M().lists[0].id; save(); renderWatchlist(); startTickers();
  };
  $('sec-new').onclick = () => {
    const name = (prompt('新板块的名字（例如：科技、半导体、ETF）：', '') || '').trim(); if (!name) return;
    activeList().items.push(sec(name)); save(); renderWatchlist();
  };

  function countIn(items, h) { let n = 0; for (let i = h + 1; i < items.length && items[i].t !== 'h'; i++) n++; return n; }
  function renderWatchlist() {
    renderListSelect();
    const items = activeList().items, cur = activeCell() && activeCell().symbol;
    const shown = new Set(visibleCells().map((c) => c.symbol));
    const alertSet = new Set(state.alerts.filter((a) => a.active && a.market === state.market).map((a) => a.symbol));
    ul.innerHTML = '';
    if (!items.length) { const e = document.createElement('li'); e.className = 'wl-empty'; e.textContent = '这个列表还是空的，在上面输入代码添加'; ul.appendChild(e); return; }
    let section = null;
    items.forEach((it, idx) => {
      const li = document.createElement('li');
      li.draggable = true; li.dataset.idx = idx;
      if (it.t === 'h') {
        section = it;
        li.className = 'sec';
        li.innerHTML = `<span class="caret">${it.collapsed ? '▸' : '▾'}</span><span class="sname">${esc(it.name)}</span><small>${countIn(items, idx)}</small>` +
          '<button class="ren" title="重命名板块">✎</button><button class="x" title="删除板块（里面的品种保留）">×</button>';
        li.onclick = (e) => {
          if (e.target.classList.contains('x')) { e.stopPropagation(); items.splice(idx, 1); save(); renderWatchlist(); return; }
          if (e.target.classList.contains('ren')) {
            e.stopPropagation(); const name = (prompt('板块改名为：', it.name) || '').trim(); if (name) { it.name = name; save(); renderWatchlist(); } return;
          }
          it.collapsed = !it.collapsed; save(); renderWatchlist();
        };
      } else {
        const s = it.s, t = tickers[s];
        li.dataset.sym = s;
        li.className = (s === cur ? 'on ' : shown.has(s) && M().layout > 1 ? 'shown ' : '') + (section ? 'in-sec ' : '') + (section && section.collapsed ? 'hide' : '');
        const [base, quote] = s.split('-');
        li.innerHTML = `<span class="sym">${esc(base)}${quote ? `<small style="color:#6b7790">/${esc(quote)}</small>` : ''}${alertSet.has(s) ? '<span class="bell" title="有生效中的警报">🔔</span>' : ''}</span>` +
          `<span class="px">${fmtPx(t && t.last)}</span><span class="chg ${t ? (t.changePct >= 0 ? 'up' : 'down') : ''}">${t ? fmtPct(t.changePct) : '—'}</span>` +
          extHtml(s) + '<button class="x" title="移出这个列表">×</button>';
        if (extShown(s)) li.classList.add('has-ext');
        li.onclick = (e) => {
          if (e.target.classList.contains('x')) { e.stopPropagation(); items.splice(idx, 1); save(); renderWatchlist(); startTickers(); return; }
          openSymbol(s);
        };
      }
      ul.appendChild(li);
    });
  }

  // ---- 拖动排序：拖股票可以换位置、拖进别的板块；拖板块标题会连同里面的股票一起移动 ----
  let dragIdx = null;
  const clearDrop = () => ul.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  ul.addEventListener('dragstart', (e) => {
    const li = e.target.closest && e.target.closest('li[data-idx]'); if (!li) return;
    dragIdx = +li.dataset.idx; li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(dragIdx)); } catch (_) {}
  });
  ul.addEventListener('dragend', () => { dragIdx = null; clearDrop(); ul.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging')); });
  const dropPos = (e) => {
    const li = e.target.closest && e.target.closest('li[data-idx]'); if (!li) return null;
    const r = li.getBoundingClientRect();
    return { li, idx: +li.dataset.idx, after: e.clientY > r.top + r.height / 2 };
  };
  ul.addEventListener('dragover', (e) => {
    if (dragIdx == null) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const p = dropPos(e); clearDrop(); if (!p) return;
    p.li.classList.add(p.after ? 'drop-after' : 'drop-before');
  });
  ul.addEventListener('drop', (e) => {
    if (dragIdx == null) return;
    e.preventDefault();
    const p = dropPos(e); clearDrop();
    if (p) moveItem(activeList().items, dragIdx, p.idx, p.after);
    dragIdx = null; save(); renderWatchlist();
  });
  function moveItem(items, from, to, after) {
    let len = 1;
    if (items[from].t === 'h') while (from + len < items.length && items[from + len].t !== 'h') len++;
    if (to >= from && to < from + len) return;                 // 拖到自己身上
    let ins = to + (after ? 1 : 0);
    // 放到一个已收起的板块标题下方：放进这个板块的最后
    if (after && items[to].t === 'h' && items[to].collapsed) ins = to + 1 + countIn(items, to);
    const block = items.splice(from, len);
    if (ins > from) ins -= len;
    // 板块只能整体插在别的板块之间，不能插进别的板块中间
    if (block[0].t === 'h') while (ins < items.length && items[ins].t !== 'h') ins++;
    items.splice(ins, 0, ...block);
  }

  // snapshot = true：来自定时快照（可能和逐笔成交来源不同），只作为警报的比较基准，不触发警报
  // 把同一帧里的多次界面刷新合并成一次（繁忙股票每秒几十笔成交）
  const uiJobs = new Map(); let uiRaf = 0;
  function uiLater(key, fn) {
    uiJobs.set(key, fn);
    if (!uiRaf) uiRaf = requestAnimationFrame(() => { uiRaf = 0; const jobs = [...uiJobs.values()]; uiJobs.clear(); for (const f of jobs) { try { f(); } catch (_) {} } });
  }
  const shownPx = {}; // 自选里上次画出来的价格（决定闪绿还是闪红）
  function updateTickerRow(s, t, snapshot) {
    tickers[s] = t;
    for (const c of visibleCells()) if (!snapshot && c.symbol !== s && compares().includes(s)) c.chart.updateCompareLast(s, t.last);
    onPrice(state.market, s, t.last, snapshot);
    uiLater('tk' + s, () => renderTickerRow(s));
  }
  function renderTickerRow(s) {
    const t = tickers[s]; if (!t) return;
    const prev = shownPx[s] != null ? { last: shownPx[s] } : null; shownPx[s] = t.last;
    for (const li of ul.querySelectorAll(`li[data-sym="${CSS.escape(s)}"]`)) {
      li.querySelector('.px').textContent = fmtPx(t.last);
      const c = li.querySelector('.chg');
      c.textContent = fmtPct(t.changePct);
      c.className = 'chg ' + (t.changePct >= 0 ? 'up' : 'down');
      if (prev && prev.last !== t.last) {
        li.classList.remove('flash-up', 'flash-down'); void li.offsetWidth;
        li.classList.add(t.last > prev.last ? 'flash-up' : 'flash-down');
      }
    }
    if (extQ[s]) renderExtRow(s);
    for (const c of visibleCells()) if (c.symbol === s) renderCellHead(c);
    if (activeCell() && s === activeCell().symbol) renderQuote();
  }
  // 需要实时报价的品种：当前列表 + 所有图 + 本市场有生效警报的品种（Alpaca 免费版一条连接最多 30 只）
  function wantedSyms() {
    const set = new Set(listSyms());
    for (const c of visibleCells()) if (c.symbol) set.add(c.symbol);
    for (const a of state.alerts) if (a.active && a.market === state.market) set.add(a.symbol);
    for (const x of compares()) set.add(x);
    return [...set];
  }
  // ---------- 盘前 / 盘后 / 夜盘（只有美股）----------
  let extQ = {}, extNote = '', extTimer = null;
  // 时段切换时（如 08:00、17:00）D 标记要跟着变
  setInterval(() => { cells.forEach(renderCellHead); renderQuote(); }, 30e3);
  const EXT_LABEL = { pre: '盘前', post: '盘后', night: '夜盘' };
  const extShown = (s) => state.market === 'us' && !!extQ[s];
  function extHtml(s) {
    const q = extShown(s) && extQ[s]; if (!q) return '';
    // 参考价用上面一行的常规时段价格（收盘后就是官方收盘价），两行对得上
    const ref = (tickers[s] && tickers[s].last) || q.ref;
    const pct = q.price != null && ref ? ((q.price - ref) / ref) * 100 : null;
    const when = q.t ? new Date(q.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    const tip = q.price == null ? `${EXT_LABEL[q.session]}还没有成交` : `${EXT_LABEL[q.session]}最新成交 ${when}，涨跌相对常规时段收盘 ${fmtPx(ref)}`;
    return `<span class="ext" title="${esc(tip)}"><i class="${q.session}">${EXT_LABEL[q.session]}</i>${q.price == null ? '—' : fmtPx(q.price)}${q.delayed && q.price != null ? dlyHtml() : ''}` +
      `<b class="${pct == null ? '' : pct >= 0 ? 'up' : 'down'}">${pct == null ? '' : fmtPct(pct)}</b></span>`;
  }
  function renderExtRow(s) {
    for (const li of ul.querySelectorAll(`li[data-sym="${CSS.escape(s)}"]`)) {
      const old = li.querySelector('.ext'); if (old) old.remove();
      const h = extHtml(s);
      li.classList.toggle('has-ext', !!h);
      if (h) li.querySelector('.chg').insertAdjacentHTML('afterend', h);
    }
  }
  function renderExtNote() { const el = $('ext-note'); if (el) { el.textContent = state.market === 'us' ? extNote : ''; el.hidden = !el.textContent; } }
  async function loadExt(token, syms) {
    const f = feed();
    if (state.market !== 'us' || !f.extQuotes) { extQ = {}; extNote = ''; renderExtNote(); return; }
    let r; try { r = await f.extQuotes(syms); } catch (_) { return; }
    if (token !== tickerToken) return;
    const had = Object.keys(extQ).length;
    extQ = r.session === 'rth' ? {} : r.quotes; extNote = r.nightNote || '';
    if (had || Object.keys(extQ).length) renderWatchlist();
    renderExtNote();
  }
  function onExtTrade(s, x) {
    const q = extQ[s]; if (!q || x.session === 'rth' || x.session === 'closed') return;
    if (q.t && x.t < q.t) return;
    extQ[s] = { ...q, price: x.price, t: x.t, session: x.session, delayed: false };
    renderExtRow(s);
  }
  let unsubTickers = null, tickerToken = 0;
  async function startTickers() {
    const token = ++tickerToken, f = feed();
    if (unsubTickers) { unsubTickers(); unsubTickers = null; }
    startAlertWatch();
    if (f === Feeds.AlpacaFeed && !f.hasKey()) return;
    const syms = wantedSyms();
    try { const snap = await f.fetchTickers(syms); if (token === tickerToken) for (const s in snap) updateTickerRow(s, snap[s], true); } catch (_) {}
    if (token !== tickerToken) return;
    unsubTickers = f.subscribeTickers(syms, (s, t) => updateTickerRow(s, t), (s, x) => onExtTrade(s, x));
    // 盘前盘后夜盘：先读一次，之后每分钟刷新（也负责时段切换，比如 9:30 开盘后自动隐藏）
    clearInterval(extTimer); extQ = {}; extNote = ''; renderExtNote();
    if (state.market === 'us') { loadExt(token, syms); extTimer = setInterval(() => loadExt(token, syms), 60e3); }
  }
  $('add-form').onsubmit = async (e) => {
    e.preventDefault();
    const inp = $('add-input');
    const s = feed().normalizeSymbol(inp.value);
    if (!s) return;
    const items = activeList().items;
    if (items.some((x) => x.t === 's' && x.s === s)) { inp.value = ''; return; }
    let ok = false;
    try { ok = await feed().validateSymbol(s); } catch (_) {}
    if (!ok) { inp.classList.add('err'); inp.title = '找不到该代码'; setTimeout(() => inp.classList.remove('err'), 1500); return; }
    items.push(sym(s)); save(); inp.value = '';
    renderWatchlist(); startTickers();
  };

  // =====================================================================
  // 警报：到价提醒 + 画线（水平线 / 趋势线）穿越提醒
  //   { id, market, symbol, kind: 'price'|'line', cond: 'up'|'down'|'cross', price, drawingId, repeat: 'once'|'every', active, created, lastAt }
  // =====================================================================
  const COND = { up: '上穿', down: '下穿', cross: '穿越' };
  const lastPx = {};            // 'market:symbol' → 最近一次价格
  const drawingOf = (a) => (state.drawings[a.symbol] || []).find((d) => d.id === a.drawingId);
  function alertLevel(a, t) {
    if (a.kind === 'price') return a.price;
    const d = drawingOf(a); if (!d) return null;
    // 图里正在显示这个品种：按图上看到的位置算（趋势线向右延长）
    const c = a.market === state.market && visibleCells().find((x) => x.symbol === a.symbol && x.chart.bars.length);
    if (c) return c.chart.drawingPriceAt(d, t);
    if (d.type === 'hline') return d.p1.p;
    if (d.p2.t === d.p1.t) return d.p2.p;
    return d.p1.p + ((d.p2.p - d.p1.p) * (t - d.p1.t)) / (d.p2.t - d.p1.t);
  }
  function onPrice(market, s, p, baseline) {
    if (p == null || !isFinite(p)) return;
    const key = market + ':' + s, prev = lastPx[key];
    lastPx[key] = p;
    if (baseline || prev == null || prev === p) return;
    const now = Date.now();
    let fired = false;
    for (const a of state.alerts) {
      if (!a.active || a.market !== market || a.symbol !== s) continue;
      const lv = alertLevel(a, now); if (lv == null) continue;
      const up = prev < lv && p >= lv, down = prev > lv && p <= lv;
      if (!((a.cond === 'up' && up) || (a.cond === 'down' && down) || (a.cond === 'cross' && (up || down)))) continue;
      if (a.repeat === 'every' && a.lastAt && now - a.lastAt < 60e3) continue; // 每次提醒：同一条 1 分钟内最多响一次
      a.lastAt = now;
      if (a.repeat !== 'every') a.active = false;
      fired = true;
      fireAlert(a, p, lv, up ? '上穿' : '下穿');
    }
    if (fired) alertsChanged();
  }
  function alertTitle(a) {
    if (a.kind === 'price') return `${a.symbol} ${COND[a.cond]} ${fmtPx(a.price)}`;
    const d = drawingOf(a);
    return `${a.symbol} ${COND[a.cond]} ${d && d.type === 'hline' ? '水平线 ' + fmtPx(d.p1.p) : d && d.type === 'ray' ? '射线' : '趋势线'}`;
  }
  const hhmmss = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
  const fullTime = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });
  // ---------- 推送到手机 / Discord ----------
  // 都用浏览器能直接发的“简单请求”，不需要后台服务；Discord 和 Bark 没有跨域回应，只能确认“已发出”
  async function sendPush(title, body, cfg) {
    cfg = cfg || state.push; const out = [];
    if (cfg.ntfy) {
      let server = 'https://ntfy.sh', topic = cfg.ntfy;
      const m = /^(https?:\/\/[^/]+)\/([^/?#]+)/.exec(cfg.ntfy); if (m) { server = m[1]; topic = m[2]; }
      try {
        const r = await fetch(server + '/', { method: 'POST', body: JSON.stringify({ topic, title, message: body, tags: ['chart_with_upwards_trend'], priority: 4 }) });
        out.push({ name: 'ntfy', ok: r.ok, err: 'HTTP ' + r.status });
      } catch (e) { out.push({ name: 'ntfy', ok: false, err: '连不上' }); }
    }
    if (cfg.discord) {
      try {
        const fd = new FormData(); fd.append('payload_json', JSON.stringify({ content: `**${title}**\n${body}`, username: '观潮看盘' }));
        await fetch(cfg.discord, { method: 'POST', body: fd, mode: 'no-cors' }); out.push({ name: 'Discord', ok: null });
      } catch (e) { out.push({ name: 'Discord', ok: false, err: '连不上' }); }
    }
    if (cfg.bark) {
      const base = /^https?:\/\//.test(cfg.bark) ? cfg.bark.replace(/\/+$/, '') : 'https://api.day.app/' + cfg.bark;
      try { await fetch(`${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${encodeURIComponent('观潮看盘')}`, { mode: 'no-cors' }); out.push({ name: 'Bark', ok: null }); }
      catch (e) { out.push({ name: 'Bark', ok: false, err: '连不上' }); }
    }
    return out;
  }
  function fireAlert(a, p, lv, dir) {
    const title = `🔔 ${a.symbol} ${dir} ${fmtPx(lv)}`;
    const body = `现价 ${fmtPx(p)} · ${a.kind === 'line' ? '画线警报' : '到价警报'} · ${hhmmss(Date.now())}` + (a.repeat === 'every' ? '' : '（已自动关闭）');
    state.alertLog.unshift({ t: Date.now(), text: `${a.symbol} ${dir} ${fmtPx(lv)}，现价 ${fmtPx(p)}` });
    state.alertLog.length = Math.min(state.alertLog.length, 30);
    alertToast(title, body, true);
    beep();
    try { if (window.Notification && Notification.permission === 'granted') new Notification(title, { body }); } catch (_) {}
    sendPush(title, body);
    flashTitle = true; renderQuote();
  }
  window.addEventListener('focus', () => { if (flashTitle) { flashTitle = false; renderQuote(); } });
  function alertToast(title, body, sticky) {
    const box = $('toasts');
    const el = document.createElement('div'); el.className = 'toast';
    el.innerHTML = `<b>${esc(title)}</b><div>${esc(body)}</div><button title="关闭">×</button>`;
    el.querySelector('button').onclick = () => el.remove();
    box.prepend(el);
    while (box.children.length > 5) box.lastChild.remove();
    setTimeout(() => el.remove(), sticky ? 120e3 : 6e3);
  }
  // 提示音：浏览器要求用户先点过页面才能出声，所以第一次点击时就准备好
  let audio = null;
  const unlockAudio = () => {
    if (flashTitle) { flashTitle = false; renderQuote(); }
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch (_) {}
  };
  document.addEventListener('pointerdown', unlockAudio, true);
  document.addEventListener('keydown', unlockAudio, true);
  function beep() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const t0 = audio.currentTime + 0.02;
      for (let k = 0; k < 3; k++) {
        const o = audio.createOscillator(), g = audio.createGain(), s = t0 + k * 0.22;
        o.type = 'sine'; o.frequency.value = k === 2 ? 1175 : 880;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.35, s + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.18);
        o.connect(g).connect(audio.destination); o.start(s); o.stop(s + 0.2);
      }
    } catch (_) {}
  }
  function askNotify() {
    try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission().then(() => renderAlertPanel()); } catch (_) {}
  }
  function addAlert(a) {
    state.alerts.push({ id: uid('a'), market: state.market, repeat: 'once', active: true, created: Date.now(), ...a });
    alertsChanged(); askNotify(); startTickers();
    alertToast('已添加警报', alertTitle(state.alerts[state.alerts.length - 1]));
  }
  function alertsChanged() { save(); pushChartAlerts(); renderAlertPanel(); renderWatchlist(); renderBadge(); }
  function renderBadge() {
    const n = state.alerts.filter((a) => a.active).length, b = $('alert-count');
    b.hidden = !n; b.textContent = n;
  }
  function pushChartAlerts() {
    for (const c of visibleCells()) {
      c.chart.setAlerts(state.alerts.filter((a) => a.market === state.market && a.symbol === c.symbol && (a.active || a.kind === 'price'))
        .map((a) => ({ price: a.price, drawingId: a.kind === 'line' ? a.drawingId : null, active: a.active, text: a.kind === 'line' ? COND[a.cond] : null })));
    }
  }
  function renderLineAlertBtn() {
    const c = activeCell(), d = c && c.chart.selectedDrawing();
    const ok = !!d && ['hline', 'trend', 'ray'].includes(d.type);
    $('alert-line').disabled = !ok;
    const box = $('al-line-box');
    if (box) renderLineBox(box, ok ? d : null);
  }
  $('alert-line').onclick = (e) => {
    const d = activeCell().chart.selectedDrawing(); if (!d) return;
    e.stopPropagation();
    $('ind-menu').classList.remove('open'); $('alert-menu').classList.add('open'); renderAlertPanel(true);
  };
  function renderLineBox(box, d) {
    if (!d) { box.innerHTML = '<span>画线警报：先在图上画一条水平线或趋势线并点选它，就能在这里给它设警报（左侧工具栏的 🔔 也可以）。</span>'; return; }
    const c = activeCell(), lv = c.chart.drawingPriceAt(d, Date.now());
    box.innerHTML = `<span>选中的${{ hline: '水平线', trend: '趋势线', ray: '射线' }[d.type]}（${esc(c.symbol)}，现在约 ${fmtPx(lv)}）</span>` +
      '<select id="al-line-cond"><option value="cross">穿越</option><option value="up">上穿</option><option value="down">下穿</option></select>' +
      '<select id="al-line-rep"><option value="once">仅一次</option><option value="every">每次</option></select>' +
      '<button class="btn primary" id="al-line-add">设警报</button>';
    box.querySelector('#al-line-add').onclick = () => {
      if (state.alerts.some((a) => a.kind === 'line' && a.drawingId === d.id && a.active)) { alertToast('这条线已经有警报了', '可以在下面的列表里停用或删除。'); return; }
      addAlert({ kind: 'line', symbol: c.symbol, drawingId: d.id, cond: box.querySelector('#al-line-cond').value, repeat: box.querySelector('#al-line-rep').value });
    };
  }
  const alertPanel = $('alert-panel');
  function renderAlertPanel(fresh) {
    if (!$('alert-menu').classList.contains('open')) { renderBadge(); return; }
    const c = activeCell(), px = c ? cellPrice(c) : null;
    const old = { sym: $('alert-sym') && $('alert-sym').value, price: $('alert-price') && $('alert-price').value };
    alertPanel.innerHTML = '';
    const head = document.createElement('div'); head.className = 'ind-head';
    head.innerHTML = '<b>价格警报</b><small>触发时：页面弹窗 + 提示音 + 系统通知</small>';
    const f = document.createElement('form'); f.className = 'al-form';
    f.innerHTML = '<label>品种<input id="alert-sym" autocomplete="off" spellcheck="false" style="text-transform:uppercase"></label>' +
      '<label>价格<input id="alert-price" type="number" step="any"></label>' +
      '<label>条件<select id="alert-cond"><option value="cross">到价（自动判断涨到/跌到）</option><option value="up">上穿（涨到）</option><option value="down">下穿（跌到）</option></select></label>' +
      '<label>提醒次数<select id="alert-rep"><option value="once">仅一次（触发后自动关闭）</option><option value="every">每次穿过都提醒</option></select></label>' +
      '<div class="row"><button class="btn primary">+ 添加到价警报</button></div>';
    f.querySelector('#alert-sym').value = !fresh && old.sym ? old.sym : (c ? c.symbol : '');
    f.querySelector('#alert-price').value = !fresh && old.price ? old.price : (px != null ? fmtPx(px) : '');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const s = feed().normalizeSymbol(f.querySelector('#alert-sym').value), p = Number(f.querySelector('#alert-price').value);
      if (!s || !isFinite(p) || p <= 0) { alertToast('请填写品种和价格', '价格要大于 0。'); return; }
      const known = wantedSyms().includes(s) || (await feed().validateSymbol(s).catch(() => false));
      if (!known) { alertToast('找不到这个代码', s); return; }
      let cond = f.querySelector('#alert-cond').value;
      const cur = lastPx[state.market + ':' + s] ?? (tickers[s] && tickers[s].last);
      if (cond === 'cross' && cur != null) cond = p >= cur ? 'up' : 'down'; // 按现价自动判断方向
      addAlert({ kind: 'price', symbol: s, price: p, cond, repeat: f.querySelector('#alert-rep').value });
    };
    const lineBox = document.createElement('div'); lineBox.className = 'al-line'; lineBox.id = 'al-line-box';
    alertPanel.append(head, f, lineBox);
    const d = c && c.chart.selectedDrawing();
    renderLineBox(lineBox, d && ['hline', 'trend', 'ray'].includes(d.type) ? d : null);
    // 列表
    const list = document.createElement('div'); list.className = 'al-list';
    const sorted = state.alerts.slice().sort((x, y) => (y.active - x.active) || (y.created - x.created));
    if (!sorted.length) { const e = document.createElement('div'); e.className = 'ind-empty'; e.textContent = '还没有警报'; list.appendChild(e); }
    for (const a of sorted) {
      const row = document.createElement('div'); row.className = 'al-row' + (a.active ? '' : ' off');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = a.active; cb.title = '启用 / 停用';
      cb.onchange = () => { a.active = cb.checked; if (a.active) a.lastAt = 0; alertsChanged(); startTickers(); };
      const desc = document.createElement('span'); desc.className = 'al-desc';
      const status = a.active ? (a.repeat === 'every' ? '生效中 · 每次穿过都提醒' : '生效中 · 仅一次') : (a.lastAt ? `已触发 ${fullTime(a.lastAt)}` : '已停用');
      desc.innerHTML = `<span class="al-tag">${a.market === 'us' ? '美股' : '币'}</span>${esc(alertTitle(a))}<small>${status}</small>`;
      desc.style.cursor = 'pointer'; desc.title = '在当前图打开';
      desc.onclick = () => { if (a.market === state.market) openSymbol(a.symbol); };
      const del = document.createElement('button'); del.className = 'ind-del'; del.textContent = '×'; del.title = '删除';
      del.onclick = () => { state.alerts = state.alerts.filter((x) => x !== a); alertsChanged(); startTickers(); };
      row.append(cb, desc, del); list.appendChild(row);
    }
    alertPanel.appendChild(list);
    // 通知状态 + 试听 + 最近触发
    const foot = document.createElement('div'); foot.className = 'al-foot';
    const perm = window.Notification ? Notification.permission : 'unsupported';
    foot.innerHTML = `<span>系统通知：${{ granted: '已开启', denied: '被拒绝（可在浏览器的网站设置里打开）', default: '未开启', unsupported: '此浏览器不支持' }[perm]}</span>`;
    if (perm === 'default') { const b = document.createElement('button'); b.className = 'btn'; b.textContent = '开启系统通知'; b.onclick = askNotify; foot.appendChild(b); }
    const t = document.createElement('button'); t.className = 'btn'; t.textContent = '试听提示音'; t.onclick = beep; foot.appendChild(t);
    alertPanel.appendChild(foot);
    if (state.alertLog.length) {
      const lg = document.createElement('div'); lg.className = 'al-log';
      lg.innerHTML = '<b>最近触发</b><br>' + state.alertLog.slice(0, 5).map((x) => `${fullTime(x.t)}　${esc(x.text)}`).join('<br>');
      alertPanel.appendChild(lg);
    }
    renderBadge();
  }
  // 另一个市场的警报也要盯着（例如看美股时，币的警报照样提醒）
  let unsubOther = null;
  function startAlertWatch() {
    if (unsubOther) { unsubOther(); unsubOther = null; }
    const other = state.market === 'us' ? 'crypto' : 'us';
    const syms = [...new Set(state.alerts.filter((a) => a.active && a.market === other).map((a) => a.symbol))];
    if (!syms.length) return;
    const f = feedOf(other);
    if (f === Feeds.AlpacaFeed && !f.hasKey()) return;
    unsubOther = f.subscribeTickers(syms, (s, t) => onPrice(other, s, t.last));
  }

  // =====================================================================
  // 筛选器：用日线扫描自选里的品种
  // =====================================================================
  const scDlg = $('screener');
  let scResults = [];
  $('sc-btn').onclick = () => { $('sc-status').textContent = scHint(); scDlg.showModal(); };
  const scHint = () => state.market === 'us'
    ? '用日线数据计算。美股免费版的日线截至约 15 分钟前（全市场数据），盘中最新几分钟的变化不在里面。'
    : '用 OKX 日线（按 UTC 0 点切日）计算，所以“今日涨跌”和自选里的 24 小时涨跌不完全一样。';
  $('sc-scope').onchange = () => { $('sc-custom').hidden = $('sc-scope').value !== 'custom'; };
  function scSymbols() {
    const scope = $('sc-scope').value;
    if (scope === 'custom') return [...new Set($('sc-custom').value.split(/[\s,，]+/).map((x) => feed().normalizeSymbol(x)).filter(Boolean))];
    if (scope === 'all') return [...new Set(M().lists.flatMap((l) => listSyms(l)))];
    return listSyms();
  }
  const num = (id) => Number($(id).value);
  function scEval(bars) {
    const n = bars.length; if (n < 2) return null;
    const C = bars.map((b) => b.c), last = bars[n - 1], prev = bars[n - 2];
    const r = { last: last.c, chg: (last.c / prev.c - 1) * 100, hits: [] };
    const vols = bars.slice(Math.max(0, n - 21), n - 1).map((b) => b.v);
    r.volRatio = vols.length ? last.v / (vols.reduce((a, b) => a + b, 0) / vols.length || 1) : null;
    const rsi = Indicators.rsi(C, 14); r.rsi = rsi[n - 1];
    const checks = [];
    const on = (id) => $(id).checked;
    if (on('sc-up')) checks.push([r.chg >= num('sc-up-v'), `涨 ≥ ${num('sc-up-v')}%`]);
    if (on('sc-dn')) checks.push([r.chg <= -num('sc-dn-v'), `跌 ≥ ${num('sc-dn-v')}%`]);
    if (on('sc-vol')) checks.push([r.volRatio != null && r.volRatio >= num('sc-vol-v'), `放量 ${num('sc-vol-v')} 倍`]);
    if (on('sc-above')) { const k = Math.round(num('sc-above-v')), m = Indicators.sma(C, k)[n - 1]; checks.push([m != null && last.c > m, `站上 MA${k}`]); }
    if (on('sc-below')) { const k = Math.round(num('sc-below-v')), m = Indicators.sma(C, k)[n - 1]; checks.push([m != null && last.c < m, `跌破 MA${k}`]); }
    if (on('sc-cross')) {
      const k = Math.round(num('sc-cross-v')), d = Math.round(num('sc-cross-d')), m = Indicators.sma(C, k);
      let hit = false; for (let j = Math.max(1, n - d); j < n; j++) if (m[j - 1] != null && C[j - 1] <= m[j - 1] && C[j] > m[j]) hit = true;
      checks.push([hit, `${d} 天内上穿 MA${k}`]);
    }
    if (on('sc-high')) { const k = Math.round(num('sc-high-v')), hh = Math.max(...bars.slice(Math.max(0, n - 1 - k), n - 1).map((b) => b.h)); checks.push([n > k && last.h >= hh, `创 ${k} 日新高`]); }
    if (on('sc-low')) { const k = Math.round(num('sc-low-v')), ll = Math.min(...bars.slice(Math.max(0, n - 1 - k), n - 1).map((b) => b.l)); checks.push([n > k && last.l <= ll, `创 ${k} 日新低`]); }
    if (on('sc-rsihi')) checks.push([r.rsi != null && r.rsi >= num('sc-rsihi-v'), `RSI ≥ ${num('sc-rsihi-v')}`]);
    if (on('sc-rsilo')) checks.push([r.rsi != null && r.rsi <= num('sc-rsilo-v'), `RSI ≤ ${num('sc-rsilo-v')}`]);
    r.hits = checks.filter((x) => x[0]).map((x) => x[1]);
    r.pass = !checks.length || ($('sc-mode').value === 'all' ? r.hits.length === checks.length : r.hits.length > 0);
    return r;
  }
  $('sc-run').onclick = async () => {
    const syms = scSymbols(), st = $('sc-status');
    if (!syms.length) { st.textContent = '没有要扫描的品种'; return; }
    if (feed() === Feeds.AlpacaFeed && !feed().hasKey()) { st.textContent = '请先在设置里填 Alpaca API Key'; return; }
    st.textContent = `正在获取 ${syms.length} 个品种的日线…`; $('sc-run').disabled = true;
    let data = {};
    try { data = await feed().dailyBars(syms, 260, (k) => (st.textContent = `正在获取日线… ${k}/${syms.length}`)); }
    catch (e) { st.textContent = '获取数据失败：' + e.message; $('sc-run').disabled = false; return; }
    $('sc-run').disabled = false;
    scResults = [];
    const missing = [];
    for (const s of syms) { const r = data[s] && scEval(data[s]); if (!r) missing.push(s); else if (r.pass) scResults.push({ s, ...r }); }
    scResults.sort((a, b) => b.chg - a.chg);
    st.textContent = `扫描了 ${syms.length - missing.length} 个，符合条件 ${scResults.length} 个` + (missing.length ? `（${missing.join('、')} 没有数据）` : '');
    renderScResults();
  };
  function renderScResults() {
    const tb = $('sc-results'); tb.innerHTML = '';
    for (const r of scResults) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="sym">${esc(r.s)}</td><td>${fmtPx(r.last)}</td><td class="${r.chg >= 0 ? 'up' : 'down'}">${fmtPct(r.chg)}</td>` +
        `<td>${r.volRatio == null ? '—' : r.volRatio.toFixed(2)}</td><td>${r.rsi == null ? '—' : r.rsi.toFixed(1)}</td><td class="tags">${r.hits.map(esc).join('、') || '—'}</td>`;
      tr.title = '点击在当前图打开';
      tr.onclick = () => { openSymbol(r.s); };
      tb.appendChild(tr);
    }
    $('sc-save').disabled = !scResults.length;
  }
  $('sc-save').onclick = () => {
    const name = (prompt('把筛选结果存为新列表，名字：', '筛选 ' + new Date().toLocaleDateString('zh-CN')) || '').trim(); if (!name) return;
    const l = { id: uid('l'), name, items: scResults.map((r) => sym(r.s)) };
    M().lists.push(l); M().activeList = l.id; save(); renderWatchlist(); startTickers();
    $('sc-status').textContent = `已存为列表「${name}」`;
  };

  // ---------- 多窗口：Alpaca 免费账号只允许一条行情连接，新打开的窗口接管，旧窗口暂停 ----------
  let bc = null;
  try { bc = new BroadcastChannel('guanchao'); } catch (_) {}
  const claimAlpaca = () => { Feeds.AlpacaFeed.resume(); bc && bc.postMessage({ type: 'claim-alpaca' }); };
  if (bc) bc.onmessage = (e) => {
    if (!e.data || e.data.type !== 'claim-alpaca' || !Feeds.AlpacaFeed.hasKey()) return;
    Feeds.AlpacaFeed.pause();
    if (state.market === 'us') {
      setStatus('paused');
      showBanner('观潮看盘在另一个窗口打开了，这个窗口的美股实时推送已暂停（Alpaca 免费账号同时只能有一个连接）。', '在这个窗口继续', () => { claimAlpaca(); showBanner(''); });
    }
  };

  // ---------- 布局保存 / 一键切换 ----------
  // 一个布局 = 市场 + 几个图 + 每个图的品种 + 周期 + 指标 + K线样式 + 成交量分布 + 对比 + 财报标记
  const clone = (x) => JSON.parse(JSON.stringify(x));
  function snapshotLayout(name, id) {
    const m = M();
    return { id: id || uid('y'), name, market: state.market, layout: m.layout, cells: m.cells.slice(0, m.layout), active: m.active,
      interval: state.interval, range: state.range || null, ivs: m.cells.slice(0, m.layout).map((_, k) => ivKey(k)), indicators: clone(state.indicators), chartType: state.chartType || 'candle',
      vprofile: !!state.vprofile, compares: (m.compares || []).slice(), events: state.events !== false, sync: state.sync !== false, at: Date.now() };
  }
  const IV_LABEL = Object.fromEntries(INTERVALS);
  const ivDesc = (y) => { const l = (y.ivs && y.ivs.length ? [...new Set(y.ivs)] : [y.range === 'ytd' ? 'ytd' : y.interval]).map((x) => IV_LABEL[x] || x); return l.length > 2 ? '多周期' : l.join('/'); };
  const layoutDesc = (y) => `${y.market === 'us' ? '美股' : '加密'} · ${y.layout === 1 ? '1 图' : y.layout + ' 图'} · ${ivDesc(y)} · ${y.indicators.length} 个指标`;
  function applySavedLayout(y) {
    state.market = y.market;
    const m = M();
    m.layout = LAYOUTS.includes(y.layout) ? y.layout : 1;
    m.cells = y.cells.slice(); m.active = Math.min(y.active | 0, m.layout - 1);
    m.compares = (y.compares || []).slice();
    state.interval = y.interval; state.range = y.range || null;
    m.ivs = Array.isArray(y.ivs) ? y.ivs.slice() : [];
    state.indicators = Indicators.sanitize(clone(y.indicators)) || Indicators.defaults();
    state.chartType = y.chartType || 'candle'; state.vprofile = !!y.vprofile;
    state.events = y.events !== false; state.sync = y.sync !== false;
    state.curLayout = y.id;
    save();
    $('ctype').value = state.chartType;
    for (const c of cells) { c.chart.setIndicators(state.indicators); c.chart.setChartType(state.chartType); c.chart.setVolumeProfile(state.vprofile); }
    startMarket();
  }
  function renderLayoutPanel() {
    const box = $('lay-panel'); box.innerHTML = '';
    const head = document.createElement('div'); head.className = 'ind-head';
    head.innerHTML = '<b>布局</b><small>点名字一键切换；保存的是当前所有图的设置</small>';
    box.appendChild(head);
    const ul = document.createElement('div'); ul.className = 'lay-list';
    if (!state.layouts.length) ul.innerHTML = '<div class="lay-empty">还没有保存的布局。先把图摆好，在下面起个名字保存。</div>';
    for (const y of state.layouts) {
      const row = document.createElement('div'); row.className = 'lay-row' + (y.id === state.curLayout ? ' on' : '');
      row.innerHTML = `<button class="lay-go" title="切换到这个布局"><b>${esc(y.name)}</b><small>${esc(layoutDesc(y))}</small></button>` +
        '<button class="lay-act" data-a="over" title="用当前的图覆盖这个布局">覆盖</button><button class="lay-act" data-a="ren" title="改名">改名</button><button class="lay-act" data-a="del" title="删除">删除</button>';
      row.querySelector('.lay-go').onclick = () => { $('lay-menu').classList.remove('open'); applySavedLayout(y); };
      row.querySelectorAll('.lay-act').forEach((b) => (b.onclick = (e) => {
        e.stopPropagation();
        const a = b.dataset.a, k = state.layouts.indexOf(y);
        if (a === 'over') { state.layouts[k] = snapshotLayout(y.name, y.id); state.curLayout = y.id; save(); renderLayoutPanel(); alertToast('布局已更新', y.name); }
        if (a === 'ren') { const n = prompt('布局名字：', y.name); if (n && n.trim()) { y.name = n.trim().slice(0, 30); save(); renderLayoutPanel(); } }
        if (a === 'del') {
          if (b.dataset.sure) { state.layouts.splice(k, 1); if (state.curLayout === y.id) state.curLayout = null; save(); renderLayoutPanel(); }
          else { b.dataset.sure = '1'; b.textContent = '确认删除'; b.classList.add('danger'); setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = '删除'; b.classList.remove('danger'); } }, 3000); }
        }
      }));
      ul.appendChild(row);
    }
    box.appendChild(ul);
    const add = document.createElement('div'); add.className = 'ind-add lay-add';
    add.innerHTML = '<input type="text" id="lay-name" placeholder="新布局名字，如 科技股 4 图" maxlength="30"><button class="btn primary" id="lay-save">保存当前</button>';
    const doSave = () => {
      const inp = add.querySelector('#lay-name'), name = inp.value.trim() || `布局 ${state.layouts.length + 1}`;
      const y = snapshotLayout(name); state.layouts.push(y); state.curLayout = y.id; save(); renderLayoutPanel();
    };
    add.querySelector('#lay-save').onclick = doSave;
    add.querySelector('#lay-name').onkeydown = (e) => { if (e.key === 'Enter') doSave(); };
    box.appendChild(add);
  }

  // =====================================================================
  // 图表右键菜单
  // =====================================================================
  const ctxMenu = document.createElement('div'); ctxMenu.id = 'ctx-menu'; ctxMenu.hidden = true; document.body.appendChild(ctxMenu);
  const closeCtx = () => { ctxMenu.hidden = true; };
  document.addEventListener('pointerdown', (e) => { if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) closeCtx(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });
  window.addEventListener('blur', closeCtx); window.addEventListener('resize', closeCtx);
  const DRAW_NAME = { hline: '水平线', trend: '趋势线', ray: '射线', channel: '平行通道', rect: '矩形', fib: '斐波那契回撤', fibext: '斐波那契扩展', text: '文字标注', measure: '测量' };
  const DRAW_COLORS = ['#ffb547', '#ffffff', '#5ab0ff', '#2ebd85', '#f0506e', '#b48cff', '#4fd1c5', '#ff8f5a'];
  const newId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch (_) {}
    try { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch (_) { return false; }
  }
  function openCtxMenu(c, info) {
    setActive(c.k);
    const ch = c.chart, items = [];
    const item = (icon, label, fn, cls) => items.push({ icon, label, fn, cls });
    const sep = () => items.push({ sep: true });
    const row = (label, html, bind) => items.push({ row: true, label, html, bind });
    const d = info.drawing;
    if (d) {
      items.push({ head: DRAW_NAME[d.type] || '画线' });
      if (d.type !== 'measure') row('颜色', DRAW_COLORS.map((col) => `<button class="sw${(d.color || '#ffb547') === col ? ' on' : ''}" data-col="${col}" style="background:${col}" title="${col}"></button>`).join(''),
        (el) => el.querySelectorAll('.sw').forEach((b) => (b.onclick = () => { d.color = b.dataset.col; ch.drawingsChanged(); closeCtx(); })));
      if (['hline', 'trend', 'ray'].includes(d.type)) {
        const has = state.alerts.some((a) => a.kind === 'line' && a.drawingId === d.id && a.active);
        if (has) item('🔔', '这条线已有警报（在「警报」里管理）', () => { $('alert-btn').click(); }, 'muted');
        else item('🔔', '给这条线设警报（穿越时提醒）', () => addAlert({ kind: 'line', symbol: c.symbol, drawingId: d.id, cond: 'cross', repeat: 'once' }));
      }
      if (d.type === 'text') item('✎', '修改文字', () => { const t = prompt('标注文字：', d.text); if (t) { d.text = t; ch.drawingsChanged(); } });
      item(d.locked ? '🔓' : '🔒', d.locked ? '解锁（可以拖动）' : '锁定（防止误拖动）', () => { d.locked = !d.locked; ch.drawingsChanged(); });
      item('⧉', '复制一份', () => {
        const cp = JSON.parse(JSON.stringify(d)); cp.id = newId(); cp.locked = false;
        const S = ch._S, dp = S ? (S.max - S.min) * 0.03 : 0;
        for (const k of ['p1', 'p2', 'p3']) if (cp[k]) cp[k].p -= dp;
        ch.addDrawing(cp);
      });
      sep();
      item('🗑', '删除', () => ch.deleteSelected(), 'danger');
    } else {
      const p = info.price;
      if (p != null && (info.area === 'main' || info.area === 'price')) {
        const ps = fmtPx(p);
        items.push({ head: `${c.symbol} · 价格 ${ps}` });
        item('🔔', `在 ${ps} 设警报`, () => {
          const cur = cellPrice(c);
          addAlert({ kind: 'price', symbol: c.symbol, price: Number(ps), cond: cur != null && Number(ps) < cur ? 'down' : 'up', repeat: 'once' });
        });
        item('─', `在 ${ps} 画水平线`, () => ch.addDrawing({ id: newId(), type: 'hline', p1: { t: info.t, p: Number(ps) } }));
        if (info.point) item('T', '在这里加文字标记', () => { const t = prompt('标注文字：', ''); if (t) ch.addDrawing({ id: newId(), type: 'text', p1: info.point, text: t }); });
        item('📋', `复制价格 ${ps}`, async () => { alertToast(await copyText(ps) ? '已复制' : '复制失败', ps); });
        sep();
      } else items.push({ head: c.symbol });
      item('⇥', '回到最新', () => ch.goLatest());
      item('⟲', '重置缩放', () => ch.resetView());
      sep();
      const cur = ivKey(c.k);
      row(M().layout > 1 ? '这个图的周期' : '周期', INTERVALS.map(([id, l]) => `<button class="chip-b${id === cur ? ' on' : ''}" data-iv="${id}">${l}</button>`).join(''),
        (el) => el.querySelectorAll('[data-iv]').forEach((b) => (b.onclick = () => { closeCtx(); ivBox.querySelector(`[data-iv="${b.dataset.iv}"]`).click(); })));
      if (M().layout > 1) item('⊞', `所有图都用「${IV_NAME[cur]}」`, () => { const m = M(); m.ivs = visibleCells().map(() => cur); save(); loadAll(true); });
      const ct = state.chartType || 'candle';
      row('K线样式', [['candle', '蜡烛'], ['hollow', '空心'], ['ha', '平均K线'], ['line', '折线'], ['area', '面积']].map(([id, l]) => `<button class="chip-b${id === ct ? ' on' : ''}" data-ct="${id}">${l}</button>`).join(''),
        (el) => el.querySelectorAll('[data-ct]').forEach((b) => (b.onclick = () => { closeCtx(); $('ctype').value = b.dataset.ct; $('ctype').onchange(); })));
      sep();
      item('＋', '添加对比品种…', () => { $('ind-btn').click(); setTimeout(() => { const i = $('cmp-in'); if (i) i.focus(); }, 0); });
      item('ƒ', '指标设置…', () => $('ind-btn').click());
      if (state.market === 'us') item(state.events ? '☑' : '☐', '财报 / 分红标记', () => { state.events = !state.events; save(); visibleCells().forEach(loadEvents); renderIndicatorPanel(); });
      item(state.vprofile ? '☑' : '☐', '成交量分布', () => { state.vprofile = !state.vprofile; save(); cells.forEach((x) => x.chart.setVolumeProfile(state.vprofile)); renderIndicatorPanel(); });
      if (ch.drawings.length) { sep(); item('🗑', `删除这个图上的全部画线（${ch.drawings.length} 条）`, () => { if (confirm(`删除 ${c.symbol} 上的全部 ${ch.drawings.length} 条画线？`)) ch.clearDrawings(); }, 'danger'); }
    }
    // 渲染
    ctxMenu.innerHTML = '';
    for (const it of items) {
      if (it.sep) { ctxMenu.insertAdjacentHTML('beforeend', '<div class="cm-sep"></div>'); continue; }
      if (it.head) { const h = document.createElement('div'); h.className = 'cm-head'; h.textContent = it.head; ctxMenu.appendChild(h); continue; }
      if (it.row) {
        const r = document.createElement('div'); r.className = 'cm-row';
        r.innerHTML = `<span>${esc(it.label)}</span><div class="cm-chips">${it.html}</div>`;
        it.bind(r); ctxMenu.appendChild(r); continue;
      }
      const b = document.createElement('button'); b.className = 'cm-item ' + (it.cls || '');
      b.innerHTML = `<i>${esc(it.icon)}</i><span>${esc(it.label)}</span>`;
      b.onclick = () => { closeCtx(); it.fn(); };
      ctxMenu.appendChild(b);
    }
    ctxMenu.hidden = false;
    const r = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = Math.max(4, Math.min(info.clientX, innerWidth - r.width - 4)) + 'px';
    ctxMenu.style.top = Math.max(4, Math.min(info.clientY, innerHeight - r.height - 4)) + 'px';
  }

  // ---------- 启动 / 切换市场 ----------
  function startMarket() {
    evNotes = [];
    clearInterval(extTimer); extQ = {}; extNote = '';
    if (state.market === 'us') claimAlpaca();
    tickers = {};
    ChartUtil.stockMode = state.market === 'us';
    markMarket();
    extBtn.hidden = state.market !== 'us';
    extBtn.classList.toggle('on', state.extHours);
    document.querySelector('.wl-cols span:last-child').textContent = state.market === 'us' ? '今日涨跌' : '24h涨跌';
    $('add-input').placeholder = state.market === 'us' ? '添加，如 GOOGL' : '添加，如 ADA';
    showBanner(usingSim[state.market] ? '演示模式：价格为随机生成，不是真实行情。' : '');
    setStatus('connecting');
    for (const c of cells) { stopCell(c); c.symbol = null; }
    applyLayout();
    loadAll();
    startTickers();
    renderBadge();
    renderIndicatorPanel();
  }
  startMarket();
  if (/[?&]debug\b/.test(location.search)) window.__gc = { cells, state: () => state };
})();
