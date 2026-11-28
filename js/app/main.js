// 观潮看盘 · 启动
// app/ 下的文件按 index.html 里的顺序加载，共用同一个顶层作用域（没有构建步骤，所以不用 import）。
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
  document.querySelector('.wl-cols span:last-child').textContent = state.market === 'us' ? _t('今日涨跌') : _t('24h涨跌');
  $('add-input').placeholder = state.market === 'us' ? _t('添加，如 GOOGL') : _t('添加，如 ADA');
  showBanner(usingSim[state.market] ? _t('演示模式：价格为随机生成，不是真实行情。') : '');
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
