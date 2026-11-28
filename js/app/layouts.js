// 观潮看盘 · 多窗口接管、布局保存和一键切换
// app/ 下的文件按 index.html 里的顺序加载，共用同一个顶层作用域（没有构建步骤，所以不用 import）。
// ---------- 多窗口：Alpaca 免费账号只允许一条行情连接，新打开的窗口接管，旧窗口暂停 ----------
let bc = null;
try { bc = new BroadcastChannel('guanchao'); } catch (_) {}
const claimAlpaca = () => { Feeds.AlpacaFeed.resume(); bc && bc.postMessage({ type: 'claim-alpaca' }); };
if (bc) bc.onmessage = (e) => {
  if (!e.data || e.data.type !== 'claim-alpaca' || !Feeds.AlpacaFeed.hasKey()) return;
  Feeds.AlpacaFeed.pause();
  if (state.market === 'us') {
    setStatus('paused');
    showBanner(_t('观潮看盘在另一个窗口打开了，这个窗口的美股实时推送已暂停（Alpaca 免费账号同时只能有一个连接）。'), _t('在这个窗口继续'), () => { claimAlpaca(); showBanner(''); });
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
const ivDesc = (y) => { const l = (y.ivs && y.ivs.length ? [...new Set(y.ivs)] : [y.range === 'ytd' ? 'ytd' : y.interval]).map((x) => IV_LABEL[x] || x); return l.length > 2 ? _t('多周期') : l.join('/'); };
const layoutDesc = (y) => _t("{0} · {1} · {2} · {3} 个指标", [y.market === 'us' ? _t('美股') : _t('加密'), y.layout === 1 ? _t('1 图') : y.layout + _t(' 图'), ivDesc(y), y.indicators.length]);
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
  head.innerHTML = _t('<b>布局</b><small>点名字一键切换；保存的是当前所有图的设置</small>');
  box.appendChild(head);
  const ul = document.createElement('div'); ul.className = 'lay-list';
  if (!state.layouts.length) ul.innerHTML = _t('<div class="lay-empty">还没有保存的布局。先把图摆好，在下面起个名字保存。</div>');
  for (const y of state.layouts) {
    const row = document.createElement('div'); row.className = 'lay-row' + (y.id === state.curLayout ? ' on' : '');
    row.innerHTML = _t("<button class=\"lay-go\" title=\"切换到这个布局\"><b>{0}</b><small>{1}</small></button>", [esc(y.name), esc(layoutDesc(y))]) +
      _t('<button class="lay-act" data-a="over" title="用当前的图覆盖这个布局">覆盖</button><button class="lay-act" data-a="ren" title="改名">改名</button><button class="lay-act" data-a="del" title="删除">删除</button>');
    row.querySelector('.lay-go').onclick = () => { $('lay-menu').classList.remove('open'); applySavedLayout(y); };
    row.querySelectorAll('.lay-act').forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      const a = b.dataset.a, k = state.layouts.indexOf(y);
      if (a === 'over') { state.layouts[k] = snapshotLayout(y.name, y.id); state.curLayout = y.id; save(); renderLayoutPanel(); alertToast(_t('布局已更新'), y.name); }
      if (a === 'ren') { const n = prompt(_t('布局名字：'), y.name); if (n && n.trim()) { y.name = n.trim().slice(0, 30); save(); renderLayoutPanel(); } }
      if (a === 'del') {
        if (b.dataset.sure) { state.layouts.splice(k, 1); if (state.curLayout === y.id) state.curLayout = null; save(); renderLayoutPanel(); }
        else { b.dataset.sure = '1'; b.textContent = _t('确认删除'); b.classList.add('danger'); setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = _t('删除'); b.classList.remove('danger'); } }, 3000); }
      }
    }));
    ul.appendChild(row);
  }
  box.appendChild(ul);
  const add = document.createElement('div'); add.className = 'ind-add lay-add';
  add.innerHTML = _t('<input type="text" id="lay-name" placeholder="新布局名字，如 科技股 4 图" maxlength="30"><button class="btn primary" id="lay-save">保存当前</button>');
  const doSave = () => {
    const inp = add.querySelector('#lay-name'), name = inp.value.trim() || _t("布局 {0}", [state.layouts.length + 1]);
    const y = snapshotLayout(name); state.layouts.push(y); state.curLayout = y.id; save(); renderLayoutPanel();
  };
  add.querySelector('#lay-save').onclick = doSave;
  add.querySelector('#lay-name').onkeydown = (e) => { if (e.key === 'Enter') doSave(); };
  box.appendChild(add);
}
