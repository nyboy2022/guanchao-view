// 观潮看盘 · 自选列表（多列表、板块、拖动排序）、实时报价订阅、盘前盘后夜盘
// app/ 下的文件按 index.html 里的顺序加载，共用同一个顶层作用域（没有构建步骤，所以不用 import）。
// =====================================================================
// 自选：多个列表，每个列表里可以分板块，拖动排序
// =====================================================================
const ul = $('watchlist');
function renderListSelect() {
  const sel = $('list-sel'); sel.innerHTML = '';
  for (const l of M().lists) {
    const o = document.createElement('option'); o.value = l.id; o.textContent = dispName(l.name) + Prefs.paren(listSyms(l).length); sel.appendChild(o);
  }
  sel.value = activeList().id;
}
$('list-sel').onchange = (e) => { M().activeList = e.target.value; save(); renderWatchlist(); startTickers(); };
$('list-new').onclick = () => {
  const name = (prompt(_t('新列表的名字：'), _t('新列表')) || '').trim(); if (!name) return;
  const l = { id: uid('l'), name, items: [] }; M().lists.push(l); M().activeList = l.id; save(); renderWatchlist(); startTickers();
  $('add-input').focus();
};
$('list-ren').onclick = () => {
  const l = activeList(); const name = (prompt(_t('列表改名为：'), l.name) || '').trim(); if (!name) return;
  l.name = name; save(); renderWatchlist();
};
$('list-del').onclick = () => {
  if (M().lists.length <= 1) { alertToast(_t('至少要保留一个列表'), _t('可以先新建一个列表再删这个。')); return; }
  const l = activeList();
  if (!confirm(_t("删除列表「{0}」？里面的 {1} 个品种会从这个列表移除（不影响其它列表）。", [l.name, listSyms(l).length]))) return;
  M().lists = M().lists.filter((x) => x !== l); M().activeList = M().lists[0].id; save(); renderWatchlist(); startTickers();
};
$('sec-new').onclick = () => {
  const name = (prompt(_t('新板块的名字（例如：科技、半导体、ETF）：'), '') || '').trim(); if (!name) return;
  activeList().items.push(sec(name)); save(); renderWatchlist();
};

function countIn(items, h) { let n = 0; for (let i = h + 1; i < items.length && items[i].t !== 'h'; i++) n++; return n; }
function renderWatchlist() {
  renderListSelect();
  const items = activeList().items, cur = activeCell() && activeCell().symbol;
  const shown = new Set(visibleCells().map((c) => c.symbol));
  const alertSet = new Set(state.alerts.filter((a) => a.active && a.market === state.market).map((a) => a.symbol));
  ul.innerHTML = '';
  if (!items.length) { const e = document.createElement('li'); e.className = 'wl-empty'; e.textContent = _t('这个列表还是空的，在上面输入代码添加'); ul.appendChild(e); return; }
  let section = null;
  items.forEach((it, idx) => {
    const li = document.createElement('li');
    li.draggable = true; li.dataset.idx = idx;
    if (it.t === 'h') {
      section = it;
      li.className = 'sec';
      li.innerHTML = `<span class="caret">${it.collapsed ? '▸' : '▾'}</span><span class="sname">${esc(dispName(it.name))}</span><small>${countIn(items, idx)}</small>` +
        _t('<button class="ren" title="重命名板块">✎</button><button class="x" title="删除板块（里面的品种保留）">×</button>');
      li.onclick = (e) => {
        if (e.target.classList.contains('x')) { e.stopPropagation(); items.splice(idx, 1); save(); renderWatchlist(); return; }
        if (e.target.classList.contains('ren')) {
          e.stopPropagation(); const name = (prompt(_t('板块改名为：'), it.name) || '').trim(); if (name) { it.name = name; save(); renderWatchlist(); } return;
        }
        it.collapsed = !it.collapsed; save(); renderWatchlist();
      };
    } else {
      const s = it.s, t = tickers[s];
      li.dataset.sym = s;
      li.className = (s === cur ? 'on ' : shown.has(s) && M().layout > 1 ? 'shown ' : '') + (section ? 'in-sec ' : '') + (section && section.collapsed ? 'hide' : '');
      const [base, quote] = s.split('-');
      li.innerHTML = `<span class="sym">${esc(base)}${quote ? `<small style="color:var(--faint)">/${esc(quote)}</small>` : ''}${alertSet.has(s) ? _t('<span class="bell" title="有生效中的警报">🔔</span>') : ''}</span>` +
        `<span class="px">${fmtPx(t && t.last)}</span><span class="chg ${t ? (t.changePct >= 0 ? 'up' : 'down') : ''}">${t ? fmtPct(t.changePct) : '—'}</span>` +
        extHtml(s) + _t('<button class="x" title="移出这个列表">×</button>');
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
// 美股非常规时段：大数字也跟着盘前 / 盘后 / 夜盘的最新成交跳动
//   涨跌幅基准：盘前、夜盘相对最近一个常规时段收盘；盘后相对昨收（即全天涨跌）
const closeRef = {}, prevRef = {};
function extToMain(s, price) {
  if (state.market !== 'us' || price == null || !isFinite(price)) return;
  const ses = Feeds.etSession(Date.now()); if (ses === 'rth') return;
  const base = ses === 'post' ? (prevRef[s] || closeRef[s]) : closeRef[s];
  updateTickerRow(s, { last: price, changePct: base ? ((price - base) / base) * 100 : 0, ext: true }, false, !state.extHours);
}
function updateTickerRow(s, t, snapshot, quietAlert) {
  if (snapshot && state.market === 'us' && Feeds.etSession(Date.now()) !== 'rth' && !t.ext) {
    closeRef[s] = t.last; prevRef[s] = t.changePct > -100 ? t.last / (1 + t.changePct / 100) : null;
    const q = extQ[s]; if (q && q.price != null) { tickers[s] = t; extToMain(s, q.price); return; }
  }
  tickers[s] = t;
  for (const c of visibleCells()) if (!snapshot && c.symbol !== s && compares().includes(s)) c.chart.updateCompareLast(s, t.last);
  onPrice(state.market, s, t.last, snapshot || quietAlert);
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
// 需要实时报价的品种：所有图 + 对比 + 本市场有生效警报的品种 + 当前列表
// 顺序就是优先级：Alpaca 免费版一条连接最多 30 只，超出时列表末尾的先改成每 30 秒刷新一次快照
function wantedSyms() {
  const set = new Set();
  for (const c of visibleCells()) if (c.symbol) set.add(c.symbol);
  for (const x of compares()) set.add(x);
  for (const a of state.alerts) if (a.active && a.market === state.market) set.add(a.symbol);
  for (const s of listSyms()) set.add(s);
  return [...set];
}
let capNoted = '', capTimer = null;
Feeds.AlpacaFeed.onSymbolCap((dropped) => {
  clearInterval(capTimer); capTimer = null;
  if (!dropped.length) { capNoted = ''; return; }
  if (dropped.join() !== capNoted) {
    capNoted = dropped.join();
    alertToast(_t('超过 30 只的部分改为定时刷新'), _t("Alpaca 免费版同时最多实时订阅 30 只股票。这 {0} 只改为每 30 秒刷新一次：{1}", [dropped.length, dropped.join(Prefs.listSep)]));
  }
  const poll = async () => {
    const f = feed(), syms = Feeds.AlpacaFeed.droppedSymbols();
    if (f !== Feeds.AlpacaFeed || !syms.length) return;
    try { const snap = await f.fetchTickers(syms); for (const s in snap) updateTickerRow(s, snap[s]); } catch (_) {}
  };
  capTimer = setInterval(poll, 30e3);
});
// ---------- 盘前 / 盘后 / 夜盘（只有美股）----------
let extQ = {}, extNote = '', extTimer = null;
// 时段切换时（如 08:00、17:00）D 标记要跟着变
setInterval(() => { cells.forEach(renderCellHead); renderQuote(); }, 30e3);
const EXT_LABEL = { pre: _t('盘前'), post: _t('盘后'), night: _t('夜盘') };
const extShown = (s) => state.market === 'us' && !!extQ[s];
function extHtml(s) {
  const q = extShown(s) && extQ[s]; if (!q) return '';
  // 参考价用上面一行的常规时段价格（收盘后就是官方收盘价），两行对得上
  const ref = closeRef[s] != null ? closeRef[s] : (tickers[s] && !tickers[s].ext && tickers[s].last) || q.ref;
  const pct = q.price != null && ref ? ((q.price - ref) / ref) * 100 : null;
  const when = q.t ? new Date(q.t).toLocaleTimeString(Prefs.locale, { hour: '2-digit', minute: '2-digit' }) : '';
  const tip = q.price == null ? _t("{0}还没有成交", [EXT_LABEL[q.session]]) : _t("{0}最新成交 {1}，涨跌相对常规时段收盘 {2}", [EXT_LABEL[q.session], when, fmtPx(ref)]);
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
  for (const [s, q] of Object.entries(extQ)) if (q.price != null && closeRef[s] != null) extToMain(s, q.price);
  if (had || Object.keys(extQ).length) renderWatchlist();
  renderExtNote();
}
function onExtTrade(s, x) {
  if (x.session === 'rth' || x.session === 'closed') return;
  const q = extQ[s]; if (!q) { if (closeRef[s] != null) extToMain(s, x.price); return; }
  if (q.t && x.t < q.t) return;
  extQ[s] = { ...q, price: x.price, t: x.t, session: x.session, delayed: false };
  renderExtRow(s);
  extToMain(s, x.price);
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
  if (!ok) { inp.classList.add('err'); inp.title = _t('找不到该代码'); setTimeout(() => inp.classList.remove('err'), 1500); return; }
  items.push(sym(s)); save(); inp.value = '';
  renderWatchlist(); startTickers();
};
