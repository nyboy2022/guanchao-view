// 观潮看盘 · 指标面板、画线工具、快捷键、代码框
// app/ 下的文件按 index.html 里的顺序加载，共用同一个顶层作用域（没有构建步骤，所以不用 import）。
// ---------- 指标面板（可自定义：改参数、改颜色、加多条、隐藏、删除） ----------
const indList = $('ind-list');
const applyIndicators = () => { save(); cells.forEach((c) => c.chart.setIndicators(state.indicators)); };
function renderIndicatorPanel() {
  indList.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'ind-head';
  head.innerHTML = _t('<b>指标</b><small>改完立即生效，会自动保存；所有图共用</small>');
  indList.appendChild(head);
  // 成交量分布
  const vp = document.createElement('div'); vp.className = 'ind-sec';
  vp.innerHTML = _t("<label><input type=\"checkbox\" id=\"vp-cb\" {0}>成交量分布（各价位成交量，画在主图右侧）</label>", [state.vprofile ? 'checked' : '']);
  vp.querySelector('input').onchange = (e) => { state.vprofile = e.target.checked; save(); cells.forEach((c) => c.chart.setVolumeProfile(state.vprofile)); };
  indList.appendChild(vp);
  // 财报 / 分红标记
  const evs = document.createElement('div'); evs.className = 'ind-sec ev-sec';
  evs.innerHTML = state.market === 'us'
    ? _t("<label><input type=\"checkbox\" id=\"ev-cb\" {0}>财报 / 分红 / 拆股标记（图底部的 E、D、S，鼠标移上去看详情）</label><small id=\"ev-note\">{1}</small>", [state.events ? 'checked' : '', esc(state.events ? evNotes.join(Prefs.semi) : '')])
    : _t('<label class="off"><input type="checkbox" disabled>财报 / 分红标记：只有美股有</label>');
  const evcb = evs.querySelector('#ev-cb');
  if (evcb) evcb.onchange = (e) => { state.events = e.target.checked; save(); visibleCells().forEach(loadEvents); renderIndicatorPanel(); };
  indList.appendChild(evs);
  // 对比叠加
  const cmp = document.createElement('div'); cmp.className = 'ind-sec';
  cmp.innerHTML = _t('<span>对比叠加</span>') + compares().map((x, k) => _t("<span class=\"chip\"><i style=\"background:{0}\"></i>{1}<button data-k=\"{2}\" title=\"去掉\">×</button></span>", [CMP_COLORS[k % 3], esc(x), k])).join('') +
    _t("<input type=\"text\" id=\"cmp-in\" placeholder=\"{0}\" spellcheck=\"false\"><button class=\"btn\" id=\"cmp-add\">+ 对比</button>", [state.market === 'us' ? 'SPY' : 'ETH']);
  cmp.querySelectorAll('.chip button').forEach((b) => (b.onclick = () => {
    compares().splice(+b.dataset.k, 1); save(); renderIndicatorPanel(); visibleCells().forEach(loadCompares); startTickers();
  }));
  cmp.querySelector('#cmp-add').onclick = () => addCompare(cmp.querySelector('#cmp-in').value);
  cmp.querySelector('#cmp-in').onkeydown = (e) => { if (e.key === 'Enter') addCompare(e.target.value); };
  indList.appendChild(cmp);
  if (!state.indicators.length) {
    const e = document.createElement('div'); e.className = 'ind-empty'; e.textContent = _t('还没有指标，在下面添加'); indList.appendChild(e);
  }
  state.indicators.forEach((inst, idx) => {
    const def = Indicators.TYPES[inst.type];
    const row = document.createElement('div');
    row.className = 'ind-row' + (inst.visible === false ? ' off' : '');
    const vis = document.createElement('input');
    vis.type = 'checkbox'; vis.checked = inst.visible !== false; vis.title = _t('显示 / 隐藏');
    vis.onchange = () => { inst.visible = vis.checked; row.classList.toggle('off', !vis.checked); applyIndicators(); };
    const name = document.createElement('span');
    name.className = 'ind-name'; name.textContent = def.name.split(' ')[0];
    name.title = def.name + (def.kind === 'pane' ? _t('（副图）') : _t('（主图）'));
    row.append(vis, name);
    const params = document.createElement('span');
    params.className = 'ind-params';
    if (!def.params.length) { const s = document.createElement('label'); s.textContent = inst.type === 'vwap' ? _t('每个交易日重新计算') : _t('无参数'); params.appendChild(s); }
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
    color.type = 'color'; color.value = inst.color; color.title = _t('颜色');
    color.oninput = () => { inst.color = color.value; applyIndicators(); };
    const del = document.createElement('button');
    del.className = 'ind-del'; del.textContent = '×'; del.title = _t('删除');
    del.onclick = () => { state.indicators.splice(idx, 1); applyIndicators(); renderIndicatorPanel(); };
    row.append(color, del);
    indList.appendChild(row);
  });
  const add = document.createElement('div');
  add.className = 'ind-add';
  const sel = document.createElement('select');
  for (const kind of ['overlay', 'pane']) {
    const g = document.createElement('optgroup'); g.label = kind === 'overlay' ? _t('主图（画在K线上）') : _t('副图（单独一栏）');
    for (const [k, d] of Object.entries(Indicators.TYPES)) if (d.kind === kind) {
      const o = document.createElement('option'); o.value = k; o.textContent = d.name; g.appendChild(o);
    }
    sel.appendChild(g);
  }
  const btn = document.createElement('button');
  btn.className = 'btn primary'; btn.textContent = _t('+ 添加');
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
  reset.className = 'btn'; reset.textContent = _t('恢复默认');
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
$('del-all').onclick = () => {
  const c = activeCell(), n = c.chart.drawings.length; if (!n) return;
  if (confirm(_t("删除 {0} 上的全部 {1} 条画线？", [c.symbol, n]))) c.chart.clearDrawings();
};
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
    if (!ok) { alertToast(_t('找不到这个代码'), s); return; }
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
