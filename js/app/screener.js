// 观潮看盘 · 筛选器：用日线扫描自选里的品种
// app/ 下的文件按 index.html 里的顺序加载，共用同一个顶层作用域（没有构建步骤，所以不用 import）。
// =====================================================================
// 筛选器：用日线扫描自选里的品种
// =====================================================================
const scDlg = $('screener');
let scResults = [];
$('sc-btn').onclick = () => { $('sc-status').textContent = scHint(); scDlg.showModal(); };
const scHint = () => state.market === 'us'
  ? _t('用日线数据计算。美股免费版的日线截至约 15 分钟前（全市场数据），盘中最新几分钟的变化不在里面。')
  : _t('用 OKX 日线（按 UTC 0 点切日）计算，所以“今日涨跌”和自选里的 24 小时涨跌不完全一样。');
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
  if (on('sc-up')) checks.push([r.chg >= num('sc-up-v'), _t("涨 ≥ {0}%", [num('sc-up-v')])]);
  if (on('sc-dn')) checks.push([r.chg <= -num('sc-dn-v'), _t("跌 ≥ {0}%", [num('sc-dn-v')])]);
  if (on('sc-vol')) checks.push([r.volRatio != null && r.volRatio >= num('sc-vol-v'), _t("放量 {0} 倍", [num('sc-vol-v')])]);
  if (on('sc-above')) { const k = Math.round(num('sc-above-v')), m = Indicators.sma(C, k)[n - 1]; checks.push([m != null && last.c > m, _t("站上 MA{0}", [k])]); }
  if (on('sc-below')) { const k = Math.round(num('sc-below-v')), m = Indicators.sma(C, k)[n - 1]; checks.push([m != null && last.c < m, _t("跌破 MA{0}", [k])]); }
  if (on('sc-cross')) {
    const k = Math.round(num('sc-cross-v')), d = Math.round(num('sc-cross-d')), m = Indicators.sma(C, k);
    let hit = false; for (let j = Math.max(1, n - d); j < n; j++) if (m[j - 1] != null && C[j - 1] <= m[j - 1] && C[j] > m[j]) hit = true;
    checks.push([hit, _t("{0} 天内上穿 MA{1}", [d, k])]);
  }
  if (on('sc-high')) { const k = Math.round(num('sc-high-v')), hh = Math.max(...bars.slice(Math.max(0, n - 1 - k), n - 1).map((b) => b.h)); checks.push([n > k && last.h >= hh, _t("创 {0} 日新高", [k])]); }
  if (on('sc-low')) { const k = Math.round(num('sc-low-v')), ll = Math.min(...bars.slice(Math.max(0, n - 1 - k), n - 1).map((b) => b.l)); checks.push([n > k && last.l <= ll, _t("创 {0} 日新低", [k])]); }
  if (on('sc-rsihi')) checks.push([r.rsi != null && r.rsi >= num('sc-rsihi-v'), `RSI ≥ ${num('sc-rsihi-v')}`]);
  if (on('sc-rsilo')) checks.push([r.rsi != null && r.rsi <= num('sc-rsilo-v'), `RSI ≤ ${num('sc-rsilo-v')}`]);
  r.hits = checks.filter((x) => x[0]).map((x) => x[1]);
  r.pass = !checks.length || ($('sc-mode').value === 'all' ? r.hits.length === checks.length : r.hits.length > 0);
  return r;
}
$('sc-run').onclick = async () => {
  const syms = scSymbols(), st = $('sc-status');
  if (!syms.length) { st.textContent = _t('没有要扫描的品种'); return; }
  if (feed() === Feeds.AlpacaFeed && !feed().hasKey()) { st.textContent = _t('请先在设置里填 Alpaca API Key'); return; }
  st.textContent = _t("正在获取 {0} 个品种的日线…", [syms.length]); $('sc-run').disabled = true;
  let data = {};
  try { data = await feed().dailyBars(syms, 260, (k) => (st.textContent = _t("正在获取日线… {0}/{1}", [k, syms.length]))); }
  catch (e) { st.textContent = _t('获取数据失败：') + e.message; $('sc-run').disabled = false; return; }
  $('sc-run').disabled = false;
  scResults = [];
  const missing = [];
  for (const s of syms) { const r = data[s] && scEval(data[s]); if (!r) missing.push(s); else if (r.pass) scResults.push({ s, ...r }); }
  scResults.sort((a, b) => b.chg - a.chg);
  st.textContent = _t("扫描了 {0} 个，符合条件 {1} 个", [syms.length - missing.length, scResults.length]) + (missing.length ? _t("（{0} 没有数据）", [missing.join(Prefs.listSep)]) : '');
  renderScResults();
};
function renderScResults() {
  const tb = $('sc-results'); tb.innerHTML = '';
  for (const r of scResults) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="sym">${esc(r.s)}</td><td>${fmtPx(r.last)}</td><td class="${r.chg >= 0 ? 'up' : 'down'}">${fmtPct(r.chg)}</td>` +
      `<td>${r.volRatio == null ? '—' : r.volRatio.toFixed(2)}</td><td>${r.rsi == null ? '—' : r.rsi.toFixed(1)}</td><td class="tags">${r.hits.map(esc).join(Prefs.listSep) || '—'}</td>`;
    tr.title = _t('点击在当前图打开');
    tr.onclick = () => { openSymbol(r.s); };
    tb.appendChild(tr);
  }
  $('sc-save').disabled = !scResults.length;
}
$('sc-save').onclick = () => {
  const name = (prompt(_t('把筛选结果存为新列表，名字：'), _t('筛选 ') + new Date().toLocaleDateString(Prefs.locale)) || '').trim(); if (!name) return;
  const l = { id: uid('l'), name, items: scResults.map((r) => sym(r.s)) };
  M().lists.push(l); M().activeList = l.id; save(); renderWatchlist(); startTickers();
  $('sc-status').textContent = _t("已存为列表「{0}」", [name]);
};
