// 观潮看盘 · 警报：到价 / 画线穿越提醒、推送到手机、警报面板、另一个市场的警报
// app/ 下的文件按 index.html 里的顺序加载，共用同一个顶层作用域（没有构建步骤，所以不用 import）。
// =====================================================================
// 警报：到价提醒 + 画线（水平线 / 趋势线）穿越提醒
//   { id, market, symbol, kind: 'price'|'line', cond: 'up'|'down'|'cross', price, drawingId, repeat: 'once'|'every', active, created, lastAt }
// =====================================================================
const COND = { up: _t('上穿'), down: _t('下穿'), cross: _t('穿越') };
const lastPx = {};            // 'market:symbol' → 最近一次价格
const drawingOf = (a) => (state.drawings[a.symbol] || []).find((d) => d.id === a.drawingId);
const lineKey = (d) => [d.p1.t, d.p1.p, d.p2 && d.p2.t, d.p2 && d.p2.p].join(',');
function noteLineRef(a, d, chart) {
  const r = chart.drawingRef(d); if (r && isFinite(r.p) && isFinite(r.perMs)) a.ref = { ...r, key: lineKey(d) };
}
function alertLevel(a, t) {
  if (a.kind === 'price') return a.price;
  const d = drawingOf(a); if (!d) return null;
  if (d.type === 'hline') return d.p1.p;
  // 图里正在显示这个品种：按图上看到的位置算（趋势线向右延长），顺便记下这条线的走法
  const c = a.market === state.market && visibleCells().find((x) => x.symbol === a.symbol && x.chart.bars.length);
  if (c) { noteLineRef(a, d, c.chart); return c.chart.drawingPriceAt(d, t); }
  // 图没在显示：沿用上次在图上看到的那条线继续延长，和图上的位置保持一致
  const r = a.ref;
  if (r && r.key === lineKey(d)) return r.p + r.perMs * (t - r.t);
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
    fireAlert(a, p, lv, up ? _t('上穿') : _t('下穿'));
  }
  if (fired) alertsChanged();
}
function alertTitle(a) {
  if (a.kind === 'price') return `${a.symbol} ${COND[a.cond]} ${fmtPx(a.price)}`;
  const d = drawingOf(a);
  return `${a.symbol} ${COND[a.cond]} ${d && d.type === 'hline' ? _t('水平线 ') + fmtPx(d.p1.p) : d && d.type === 'ray' ? _t('射线') : _t('趋势线')}`;
}
const hhmmss = (t) => new Date(t).toLocaleTimeString(Prefs.locale, { hour12: false });
const fullTime = (t) => new Date(t).toLocaleString(Prefs.locale, { hour12: false });
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
    } catch (e) { out.push({ name: 'ntfy', ok: false, err: _t('连不上') }); }
  }
  if (cfg.discord) {
    try {
      const fd = new FormData(); fd.append('payload_json', JSON.stringify({ content: `**${title}**\n${body}`, username: _t('观潮看盘') }));
      await fetch(cfg.discord, { method: 'POST', body: fd, mode: 'no-cors' }); out.push({ name: 'Discord', ok: null });
    } catch (e) { out.push({ name: 'Discord', ok: false, err: _t('连不上') }); }
  }
  if (cfg.bark) {
    const base = /^https?:\/\//.test(cfg.bark) ? cfg.bark.replace(/\/+$/, '') : 'https://api.day.app/' + cfg.bark;
    try { await fetch(`${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${encodeURIComponent(_t('观潮看盘'))}`, { mode: 'no-cors' }); out.push({ name: 'Bark', ok: null }); }
    catch (e) { out.push({ name: 'Bark', ok: false, err: _t('连不上') }); }
  }
  return out;
}
function fireAlert(a, p, lv, dir) {
  const title = `🔔 ${a.symbol} ${dir} ${fmtPx(lv)}`;
  const body = _t("现价 {0} · {1} · {2}", [fmtPx(p), a.kind === 'line' ? _t('画线警报') : _t('到价警报'), hhmmss(Date.now())]) + (a.repeat === 'every' ? '' : _t('（已自动关闭）'));
  state.alertLog.unshift({ t: Date.now(), text: _t("{0} {1} {2}，现价 {3}", [a.symbol, dir, fmtPx(lv), fmtPx(p)]) });
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
  el.innerHTML = _t("<b>{0}</b><div>{1}</div><button title=\"关闭\">×</button>", [esc(title), esc(body)]);
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
  alertToast(_t('已添加警报'), alertTitle(state.alerts[state.alerts.length - 1]));
}
function alertsChanged() { pushChartAlerts(); save(); renderAlertPanel(); renderWatchlist(); renderBadge(); }
function renderBadge() {
  const n = state.alerts.filter((a) => a.active).length, b = $('alert-count');
  b.hidden = !n; b.textContent = n;
}
function pushChartAlerts() {
  for (const a of state.alerts) {
    if (a.kind !== 'line' || a.market !== state.market) continue;
    const d = drawingOf(a), c = d && visibleCells().find((x) => x.symbol === a.symbol && x.chart.bars.length);
    if (c) noteLineRef(a, d, c.chart);
  }
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
  if (!d) { box.innerHTML = _t('<span>画线警报：先在图上画一条水平线或趋势线并点选它，就能在这里给它设警报（左侧工具栏的 🔔 也可以）。</span>'); return; }
  const c = activeCell(), lv = c.chart.drawingPriceAt(d, Date.now());
  box.innerHTML = _t("<span>选中的{0}（{1}，现在约 {2}）</span>", [{ hline: _t('水平线'), trend: _t('趋势线'), ray: _t('射线') }[d.type], esc(c.symbol), fmtPx(lv)]) +
    _t('<select id="al-line-cond"><option value="cross">穿越</option><option value="up">上穿</option><option value="down">下穿</option></select>') +
    _t('<select id="al-line-rep"><option value="once">仅一次</option><option value="every">每次</option></select>') +
    _t('<button class="btn primary" id="al-line-add">设警报</button>');
  box.querySelector('#al-line-add').onclick = () => {
    if (state.alerts.some((a) => a.kind === 'line' && a.drawingId === d.id && a.active)) { alertToast(_t('这条线已经有警报了'), _t('可以在下面的列表里停用或删除。')); return; }
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
  head.innerHTML = _t('<b>价格警报</b><small>触发时：页面弹窗 + 提示音 + 系统通知</small>');
  const f = document.createElement('form'); f.className = 'al-form';
  f.innerHTML = _t('<label>品种<input id="alert-sym" autocomplete="off" spellcheck="false" style="text-transform:uppercase"></label>') +
    _t('<label>价格<input id="alert-price" type="number" step="any"></label>') +
    _t('<label>条件<select id="alert-cond"><option value="cross">到价（自动判断涨到/跌到）</option><option value="up">上穿（涨到）</option><option value="down">下穿（跌到）</option></select></label>') +
    _t('<label>提醒次数<select id="alert-rep"><option value="once">仅一次（触发后自动关闭）</option><option value="every">每次穿过都提醒</option></select></label>') +
    _t('<div class="row"><button class="btn primary">+ 添加到价警报</button></div>');
  f.querySelector('#alert-sym').value = !fresh && old.sym ? old.sym : (c ? c.symbol : '');
  f.querySelector('#alert-price').value = !fresh && old.price ? old.price : (px != null ? fmtPx(px) : '');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const s = feed().normalizeSymbol(f.querySelector('#alert-sym').value), p = Number(f.querySelector('#alert-price').value);
    if (!s || !isFinite(p) || p <= 0) { alertToast(_t('请填写品种和价格'), _t('价格要大于 0。')); return; }
    const known = wantedSyms().includes(s) || (await feed().validateSymbol(s).catch(() => false));
    if (!known) { alertToast(_t('找不到这个代码'), s); return; }
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
  if (!sorted.length) { const e = document.createElement('div'); e.className = 'ind-empty'; e.textContent = _t('还没有警报'); list.appendChild(e); }
  for (const a of sorted) {
    const row = document.createElement('div'); row.className = 'al-row' + (a.active ? '' : ' off');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = a.active; cb.title = _t('启用 / 停用');
    cb.onchange = () => { a.active = cb.checked; if (a.active) a.lastAt = 0; alertsChanged(); startTickers(); };
    const desc = document.createElement('span'); desc.className = 'al-desc';
    const status = a.active ? (a.repeat === 'every' ? _t('生效中 · 每次穿过都提醒') : _t('生效中 · 仅一次')) : (a.lastAt ? _t("已触发 {0}", [fullTime(a.lastAt)]) : _t('已停用'));
    desc.innerHTML = `<span class="al-tag">${a.market === 'us' ? _t('美股') : _t('币')}</span>${esc(alertTitle(a))}<small>${status}</small>`;
    desc.style.cursor = 'pointer'; desc.title = _t('在当前图打开');
    desc.onclick = () => { if (a.market === state.market) openSymbol(a.symbol); };
    const del = document.createElement('button'); del.className = 'ind-del'; del.textContent = '×'; del.title = _t('删除');
    del.onclick = () => { state.alerts = state.alerts.filter((x) => x !== a); alertsChanged(); startTickers(); };
    row.append(cb, desc, del); list.appendChild(row);
  }
  alertPanel.appendChild(list);
  // 通知状态 + 试听 + 最近触发
  const foot = document.createElement('div'); foot.className = 'al-foot';
  const perm = window.Notification ? Notification.permission : 'unsupported';
  foot.innerHTML = _t("<span>系统通知：{0}</span>", [{ granted: _t('已开启'), denied: _t('被拒绝（可在浏览器的网站设置里打开）'), default: _t('未开启'), unsupported: _t('此浏览器不支持') }[perm]]);
  if (perm === 'default') { const b = document.createElement('button'); b.className = 'btn'; b.textContent = _t('开启系统通知'); b.onclick = askNotify; foot.appendChild(b); }
  const t = document.createElement('button'); t.className = 'btn'; t.textContent = _t('试听提示音'); t.onclick = beep; foot.appendChild(t);
  alertPanel.appendChild(foot);
  if (state.alertLog.length) {
    const lg = document.createElement('div'); lg.className = 'al-log';
    lg.innerHTML = _t('<b>最近触发</b><br>') + state.alertLog.slice(0, 5).map((x) => `${fullTime(x.t)}　${esc(x.text)}`).join('<br>');
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
  // 美股盘前盘后的成交走 onExt：和看美股时一样，开着「盘前盘后」才触发
  unsubOther = f.subscribeTickers(syms, (s, t) => onPrice(other, s, t.last), (s, x) => {
    if (x.session === 'rth' || x.session === 'closed') return;
    onPrice(other, s, x.price, !state.extHours);
  });
}
