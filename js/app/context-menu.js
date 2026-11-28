// 观潮看盘 · 图表右键菜单
// app/ 下的文件按 index.html 里的顺序加载，共用同一个顶层作用域（没有构建步骤，所以不用 import）。
// =====================================================================
// 图表右键菜单
// =====================================================================
const ctxMenu = document.createElement('div'); ctxMenu.id = 'ctx-menu'; ctxMenu.hidden = true; document.body.appendChild(ctxMenu);
const closeCtx = () => { ctxMenu.hidden = true; };
document.addEventListener('pointerdown', (e) => { if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) closeCtx(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });
window.addEventListener('blur', closeCtx); window.addEventListener('resize', closeCtx);
const DRAW_NAME = { hline: _t('水平线'), trend: _t('趋势线'), ray: _t('射线'), channel: _t('平行通道'), rect: _t('矩形'), fib: _t('斐波那契回撤'), fibext: _t('斐波那契扩展'), text: _t('文字标注'), measure: _t('测量') };
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
    items.push({ head: DRAW_NAME[d.type] || _t('画线') });
    if (d.type !== 'measure') row(_t('颜色'), DRAW_COLORS.map((col) => `<button class="sw${(d.color || '#ffb547') === col ? ' on' : ''}" data-col="${col}" style="background:${col}" title="${col}"></button>`).join(''),
      (el) => el.querySelectorAll('.sw').forEach((b) => (b.onclick = () => { d.color = b.dataset.col; ch.drawingsChanged(); closeCtx(); })));
    if (['hline', 'trend', 'ray'].includes(d.type)) {
      const has = state.alerts.some((a) => a.kind === 'line' && a.drawingId === d.id && a.active);
      if (has) item('🔔', _t('这条线已有警报（在「警报」里管理）'), () => { $('alert-btn').click(); }, 'muted');
      else item('🔔', _t('给这条线设警报（穿越时提醒）'), () => addAlert({ kind: 'line', symbol: c.symbol, drawingId: d.id, cond: 'cross', repeat: 'once' }));
    }
    if (d.type === 'text') item('✎', _t('修改文字'), () => { const t = prompt(_t('标注文字：'), d.text); if (t) { d.text = t; ch.drawingsChanged(); } });
    item(d.locked ? '🔓' : '🔒', d.locked ? _t('解锁（可以拖动）') : _t('锁定（防止误拖动）'), () => { d.locked = !d.locked; ch.drawingsChanged(); });
    item('⧉', _t('复制一份'), () => {
      const cp = JSON.parse(JSON.stringify(d)); cp.id = newId(); cp.locked = false;
      const S = ch._S, dp = S ? (S.max - S.min) * 0.03 : 0;
      for (const k of ['p1', 'p2', 'p3']) if (cp[k]) cp[k].p -= dp;
      ch.addDrawing(cp);
    });
    sep();
    item('🗑', _t('删除'), () => ch.deleteSelected(), 'danger');
  } else {
    const p = info.price;
    if (p != null && (info.area === 'main' || info.area === 'price')) {
      const ps = fmtPx(p);
      items.push({ head: _t("{0} · 价格 {1}", [c.symbol, ps]) });
      item('🔔', _t("在 {0} 设警报", [ps]), () => {
        const cur = cellPrice(c);
        addAlert({ kind: 'price', symbol: c.symbol, price: Number(ps), cond: cur != null && Number(ps) < cur ? 'down' : 'up', repeat: 'once' });
      });
      item('─', _t("在 {0} 画水平线", [ps]), () => ch.addDrawing({ id: newId(), type: 'hline', p1: { t: info.t, p: Number(ps) } }));
      if (info.point) item('T', _t('在这里加文字标记'), () => { const t = prompt(_t('标注文字：'), ''); if (t) ch.addDrawing({ id: newId(), type: 'text', p1: info.point, text: t }); });
      item('📋', _t("复制价格 {0}", [ps]), async () => { alertToast(await copyText(ps) ? _t('已复制') : _t('复制失败'), ps); });
      sep();
    } else items.push({ head: c.symbol });
    item('⇥', _t('回到最新'), () => ch.goLatest());
    item('⟲', _t('重置缩放'), () => ch.resetView());
    sep();
    const cur = ivKey(c.k);
    row(M().layout > 1 ? _t('这个图的周期') : _t('周期'), INTERVALS.map(([id, l]) => `<button class="chip-b${id === cur ? ' on' : ''}" data-iv="${id}">${l}</button>`).join(''),
      (el) => el.querySelectorAll('[data-iv]').forEach((b) => (b.onclick = () => { closeCtx(); ivBox.querySelector(`[data-iv="${b.dataset.iv}"]`).click(); })));
    if (M().layout > 1) item('⊞', _t("所有图都用「{0}」", [IV_NAME[cur]]), () => { const m = M(); m.ivs = visibleCells().map(() => cur); save(); loadAll(true); });
    const ct = state.chartType || 'candle';
    row(_t('K线样式'), [['candle', _t('蜡烛')], ['hollow', _t('空心')], ['ha', _t('平均K线')], ['line', _t('折线')], ['area', _t('面积')]].map(([id, l]) => `<button class="chip-b${id === ct ? ' on' : ''}" data-ct="${id}">${l}</button>`).join(''),
      (el) => el.querySelectorAll('[data-ct]').forEach((b) => (b.onclick = () => { closeCtx(); $('ctype').value = b.dataset.ct; $('ctype').onchange(); })));
    sep();
    item('＋', _t('添加对比品种…'), () => { $('ind-btn').click(); setTimeout(() => { const i = $('cmp-in'); if (i) i.focus(); }, 0); });
    item('ƒ', _t('指标设置…'), () => $('ind-btn').click());
    if (state.market === 'us') item(state.events ? '☑' : '☐', _t('财报 / 分红标记'), () => { state.events = !state.events; save(); visibleCells().forEach(loadEvents); renderIndicatorPanel(); });
    item(state.vprofile ? '☑' : '☐', _t('成交量分布'), () => { state.vprofile = !state.vprofile; save(); cells.forEach((x) => x.chart.setVolumeProfile(state.vprofile)); renderIndicatorPanel(); });
    if (ch.drawings.length) { sep(); item('🗑', _t("删除这个图上的全部画线（{0} 条）", [ch.drawings.length]), () => { if (confirm(_t("删除 {0} 上的全部 {1} 条画线？", [c.symbol, ch.drawings.length]))) ch.clearDrawings(); }, 'danger'); }
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
