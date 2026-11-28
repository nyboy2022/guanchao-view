// 观潮看盘 · 多图：格子、市场切换、周期、布局、K线样式、对比叠加、财报标记、盘前盘后开关
// app/ 下的文件按 index.html 里的顺序加载，共用同一个顶层作用域（没有构建步骤，所以不用 import）。
// =====================================================================
// 多图：每个格子一个图表，共用同一个周期和指标设置
// =====================================================================
const chartBox = $('chart');
const cells = [];
function makeCell(k) {
  const el = document.createElement('div'); el.className = 'cell';
  el.innerHTML = '<div class="cell-head"><span class="sym"></span><span class="iv"></span><span class="px"></span><span class="chg"></span></div><div class="cell-body"></div>';
  const c = { k, el, symbol: null, token: 0, unsub: null, loadingMore: false, noMore: false, emptyText: _t('加载历史数据…'), status: 'connecting' };
  c.chart = new CandleChart(el.querySelector('.cell-body'), {
    onNeedMore: () => loadMore(c),
    onDrawingsChange: (list) => drawingsChanged(c, list),
    onToolDone: () => setTool('cursor'),
    onSelect: () => { if (c.k === M().active) renderLineAlertBtn(); },
    askText: (init) => prompt(_t('标注文字：'), init || ''),
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
  if (id === 'ytd') b.title = _t('日线，显示今年 1 月 1 日到现在');
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
  b.textContent = n === 1 ? _t('1图') : String(n); b.dataset.n = n; b.title = _t("同时显示 {0} 个图", [n]);
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
  if (!evCache.has(key)) evCache.set(key, f.events(s, Date.UTC(2015, 11, 1), state.avKey).catch((e) => ({ events: [], notes: [_t('读取失败：') + e.message] })));
  const r = await evCache.get(key);
  if (token !== c.token) return;
  c.chart.setEvents(r.events);
  if (c.k === M().active) { evNotes = r.notes; const el = $('ev-note'); if (el) el.textContent = evNotes.join(Prefs.semi); }
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
  if (compares().length >= 3) { alertToast(_t('最多对比 3 个品种'), _t('可以先删掉一个再加。')); return; }
  let ok = wantedSyms().includes(s);
  if (!ok) try { ok = await feed().validateSymbol(s); } catch (_) {}
  if (!ok) { alertToast(_t('找不到这个代码'), s); return; }
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
