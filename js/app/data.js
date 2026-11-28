// 观潮看盘 · 报价显示、K线加载、在图里打开品种
// app/ 下的文件按 index.html 里的顺序加载，共用同一个顶层作用域（没有构建步骤，所以不用 import）。
// ---------- 报价：顶部 + 每个格子的小标题 ----------
const fmtPx = (v) => (v == null ? '—' : v.toFixed(ChartUtil.decimalsFor(v)));
const fmtPct = (p) => (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
const cellPrice = (c) => { const b = c.chart.bars[c.chart.bars.length - 1]; const t = tickers[c.symbol]; return b ? b.c : t && t.last; };
// 延迟 15 分钟的价格旁边放一个黄圈 D
const DLY_TIP = _t('延迟 15 分钟：这个价格来自全市场数据（Alpaca 免费版这时没有实时成交），比实际晚约 15 分钟');
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
    ce.textContent = fmtPct(t.changePct) + '  ' + (state.market === 'us' ? _t('今日') : '24h');
    ce.className = 'q-change ' + (t.changePct >= 0 ? 'up' : 'down');
    $('q-price').className = 'q-price ' + (t.changePct >= 0 ? 'up' : 'down');
  } else { ce.textContent = ''; $('q-price').className = 'q-price'; }
  setDly($('q-price'), chartDelayed() && px != null);
  if (px != null) document.title = (flashTitle ? '🔔 ' : '') + _t("{0} {1} · 观潮看盘", [s, fmtPx(px)]);
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
  c.emptyText = _t('加载历史数据…');
  c.chart.setSessionKey(state.market === 'us' ? etDay : utcDay);
  c.chart.setBarClose(state.market === 'us' ? Feeds.etBarClose : null);
  c.chart.setData([], Feeds.INTERVAL_MS[iv]);
  c.chart.setDrawings(state.drawings[symbol] || []);
  renderCellHead(c);
  const isActive = () => c.k === M().active;
  if (f === Feeds.AlpacaFeed && !f.hasKey()) {
    c.emptyText = _t('请先点右上角「⚙ 设置」填入 Alpaca API Key 或 Tradier Token');
    c.status = 'nokey'; if (isActive()) setStatus('nokey');
    showBanner(_t('看美股实时行情需要一个免费的 Alpaca API Key（在 alpaca.markets 注册后生成），或者 Tradier 证券账户的 Token，填到设置里。'), _t('打开设置'), openSettings);
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
        showBanner(_t("无法连接{0} 行情接口（网络或地区限制），已切换为演示数据。图表上的价格不是真实行情。", [state.market === 'us' ? (state.alpaca.tradier ? ' Tradier' : ' Alpaca') : ' OKX']));
        startTickers(); loadAll();
      }
      return;
    }
    c.emptyText = err.kind === 'auth' ? _t('API Key 无效或没有权限') : _t('加载失败：') + err.message;
    c.status = err.kind === 'auth' ? (state.alpaca.feed === 'sip' && !state.alpaca.tradier ? 'noperm' : 'autherr') : 'error';
    if (isActive()) setStatus(c.status);
    c.chart.dirty = true;
    return;
  }
  if (token !== c.token) return;
  if (!bars.length) c.emptyText = state.market === 'us' && !state.extHours ? _t('这个周期暂无常规时段数据') : _t('这个周期暂无数据');
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
