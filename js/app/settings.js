// 观潮看盘 · 设置对话框（Key、推送、Key 的保存）、备份导入导出、状态栏
// app/ 下的文件按 index.html 里的顺序加载，共用同一个顶层作用域（没有构建步骤，所以不用 import）。
// ---------- 美股设置 ----------
const dlg = $('settings'), form = $('settings-form');
function openSettings() {
  form.key.value = state.alpaca.key; form.secret.value = state.alpaca.secret; form.feed.value = state.alpaca.feed; form.tradier.value = state.alpaca.tradier || ''; form.avkey.value = state.avKey || '';
  form.remember.checked = state.rememberKeys !== false;
  $('bk-res').textContent = ''; form.ntfy.value = state.push.ntfy; form.discord.value = state.push.discord; form.bark.value = state.push.bark; $('push-test-res').textContent = ''; $('tr-test-res').textContent = '';
  dlg.showModal();
}
$('settings-btn').onclick = openSettings;
$('keys-clear').onclick = () => {
  if (!confirm(_t('清除这台电脑上保存的所有 API Key、Token 和推送地址？清除后需要重新填写。'))) return;
  SECRET_FIELDS(state); save(); Feeds.AlpacaFeed.configure(state.alpaca);
  dlg.close(); location.reload();
};
$('tr-test').onclick = async () => {
  const el = $('tr-test-res'), tok = form.tradier.value.trim();
  if (!tok) { el.textContent = _t('先填 Token'); return; }
  el.textContent = _t('测试中…');
  const r = await Feeds.AlpacaFeed.testTradier(tok);
  if (!r.ok) { el.textContent = '✗ ' + r.msg; return; }
  const age = r.t ? Math.round((Date.now() - r.t) / 60e3) : null;
  el.textContent = _t("✓ 连接成功：AAPL 最新成交 {0}", [fmtPx(r.last)]) + (r.t ? Prefs.paren(new Date(r.t).toLocaleString(Prefs.locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + (age != null && age < 2 ? _t('，实时') : '')) : '') + _t("，近几天分钟K线 {0} 根", [r.bars]);
};
const readPushForm = () => ({ ntfy: form.ntfy.value.trim(), discord: form.discord.value.trim(), bark: form.bark.value.trim() });
$('ntfy-gen').onclick = () => { const r = crypto.getRandomValues(new Uint8Array(9)); form.ntfy.value = 'guanchao-' + [...r].map((x) => 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]).join(''); };
// ---------- 备份：导出 / 导入 ----------
$('bk-export').onclick = () => {
  save();
  let data = JSON.parse(JSON.stringify(state));
  const withKeys = $('bk-keys').checked;
  if (!withKeys) data = SECRET_FIELDS(data);
  // 界面语言和主题存在另外的位置，一起带上
  const pack = { app: 'guanchao', version: 1, exportedAt: new Date().toISOString(), withKeys, data, prefs: { lang: Prefs.lang, theme: Prefs.themePref } };
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  const name = `guanchao-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  const a = document.createElement('a');
  // 用 data: 地址：本地文件打开的页面里 blob: 地址会丢掉文件名
  a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(pack, null, 1));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  $('bk-res').textContent = _t("已导出 {0}（在「下载」文件夹）", [name]) + (withKeys ? _t('，包含 Key') : _t('，不含 Key'));
};
$('bk-import').onclick = () => $('bk-file').click();
$('bk-file').onchange = async () => {
  const f = $('bk-file').files[0]; $('bk-file').value = '';
  if (!f) return;
  let pack;
  try { pack = JSON.parse(await f.text()); } catch (_) { $('bk-res').textContent = _t('这个文件不是有效的备份'); return; }
  if (!pack || pack.app !== 'guanchao' || !pack.data || typeof pack.data !== 'object' || !pack.data.markets) { $('bk-res').textContent = _t('这个文件不是观潮看盘的备份'); return; }
  const d = pack.data, n = (m) => (d.markets[m] && d.markets[m].lists || []).reduce((k, l) => k + l.items.filter((x) => x.t === 's').length, 0);
  const msg = _t("导入 {0} 的备份？\n\n", [new Date(pack.exportedAt).toLocaleString()]) +
    _t("美股 {0} 只、加密货币 {1} 只，画线 {2} 条，布局 {3} 个，警报 {4} 个。\n\n", [n('us'), n('crypto'), Object.values(d.drawings || {}).reduce((k, l) => k + l.length, 0), (d.layouts || []).length, (d.alerts || []).length]) +
    _t("现在的自选、画线、布局、警报和设置会被替换。") + (pack.withKeys ? _t('备份里的 Key 也会替换现在的 Key。') : _t('备份里没有 Key，会保留你现在的 Key。'));
  if (!confirm(msg)) return;
  const next = { ...d };
  if (!pack.withKeys) { next.alpaca = { ...(d.alpaca || {}), key: state.alpaca.key, secret: state.alpaca.secret, tradier: state.alpaca.tradier || '' }; next.avKey = state.avKey; next.push = { ...state.push }; }
  try { localStorage.setItem(STORE, JSON.stringify(next)); } catch (_) { $('bk-res').textContent = _t('保存失败'); return; }
  const pf = pack.prefs || {};
  if (['auto', 'light', 'dark'].includes(pf.theme)) Prefs.setTheme(pf.theme);
  dlg.close();
  if (pf.lang === 'zh' || pf.lang === 'en') Prefs.setLang(pf.lang); else location.reload(); // setLang 会刷新页面
};
$('push-test').onclick = async () => {
  const cfg = readPushForm(), el = $('push-test-res');
  if (!cfg.ntfy && !cfg.discord && !cfg.bark) { el.textContent = _t('先填一个推送方式'); return; }
  el.textContent = _t('发送中…');
  const r = await sendPush(_t('🔔 观潮看盘测试'), _t('收到这条，说明警报推送设置好了。'), cfg);
  el.textContent = r.map((x) => `${x.name}${x.ok === true ? _t(' ✓ 已发出') : x.ok === false ? ' ✗ ' + x.err : _t(' 已发出（请看手机/频道）')}`).join('　');
};
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  state.alpaca = { key: form.key.value.trim(), secret: form.secret.value.trim(), feed: form.feed.value, tradier: form.tradier.value.trim() };
  const avChanged = (state.avKey || '') !== form.avkey.value.trim();
  state.avKey = form.avkey.value.trim(); if (avChanged) evCache.clear();
  state.push = readPushForm();
  state.rememberKeys = form.remember.checked;
  save(); Feeds.AlpacaFeed.configure(state.alpaca);
  if (!FORCE_DEMO) usingSim.us = false;
  if (state.market === 'us') startMarket(); else startAlertWatch();
});

// ---------- 状态显示 ----------
const STATUS_TEXT = {
  live: _t('实时'), connecting: _t('连接中…'), reconnecting: _t('断线重连中…'), sim: _t('演示数据'), error: _t('加载失败'),
  autherr: _t('API Key 无效'), noperm: _t('无权限（SIP 需付费套餐）'), paused: _t('已暂停（其它窗口在用）'), connlimit: _t('连接数超限'), symlimit: _t('订阅数超限'), nokey: _t('未设置 API Key'),
};
let statusBanner = false;
// 实时推送诊断（只有这一个定时器写状态栏）：状态旁显示最近一笔成交是几秒前，鼠标移上去看详情
//   美股用整条连接的统计（任何一只有成交都算），其它数据源用当前图最后一次更新的时间
setInterval(() => {
  const el = $('status'), f = feed();
  const drop = () => { if (el) el.title = ''; const x = el && el.querySelector('em'); if (x) x.remove(); };
  if (!el || el.dataset.state !== 'live') return drop();
  const st = f.streamStats ? f.streamStats() : null;
  const lastT = st ? st.last && st.last.t : lastEventAt;
  if (!st && !lastT) return drop();
  const age = lastT ? Math.max(0, Math.round((Date.now() - lastT) / 1000)) : null;
  let em = el.querySelector('em'); if (!em) { em = document.createElement('em'); el.appendChild(em); }
  em.textContent = age == null ? _t(' · 等待成交') : age <= 2 ? '' : age < 60 ? _t(" · {0}秒前", [age]) : age < 3600 ? _t(" · {0}分钟前", [Math.round(age / 60)]) : _t(' · 暂无新成交');
  el.title = st ? _t("实时来源：{0}，订阅 {1} 只\n收到成交 {2} 笔", [st.src, st.subs, st.n]) + (st.last ? _t("\n最近一笔：{0} {1}，{2}", [st.last.sym, fmtPx(st.last.p), new Date(st.last.t).toLocaleTimeString(Prefs.locale)]) : '') : '';
}, 1000);
function setStatus(s, quiet) {
  const el = $('status');
  el.className = 'status ' + (s === 'live' ? 'live' : s === 'sim' || s === 'nokey' ? 'sim' : '');
  el.querySelector('span').textContent = STATUS_TEXT[s] || s;
  el.dataset.state = s;
  if (quiet) return;
  // 连接恢复正常后，清掉之前因连接问题弹出的提示
  if (s === 'live' && statusBanner) { statusBanner = false; showBanner(''); }
  if (['autherr', 'noperm', 'connlimit', 'symlimit'].includes(s)) statusBanner = true;
  if (s === 'autherr') showBanner(state.alpaca.tradier ? _t('Alpaca Key 或 Tradier Token 被拒绝，请检查是否填对。Tradier 要用正式环境（Production）的 Access Token，不能用 Sandbox 的。') : _t('Alpaca 拒绝了你的 API Key，请检查 Key 和 Secret 是否填对。'), _t('打开设置'), openSettings);
  if (s === 'noperm') showBanner(_t('当前 Alpaca 账号没有 SIP 全市场实时数据权限（需要付费套餐）。可以在设置里改回 IEX（免费）。'), _t('打开设置'), openSettings);
  if (s === 'connlimit') showBanner(_t('Alpaca 免费账号同时只能开一个行情连接，正在自动重试。如果一直连不上，请关掉其它正在使用这个 Key 的窗口或程序。'));
  if (s === 'symlimit') showBanner(_t('超过 Alpaca 免费账号的订阅上限（同时最多 30 只股票，包括所有图、当前自选列表和警报里的股票），请减少一些。'));
}
function showBanner(text, btnText, btnFn) {
  const b = $('banner'); b.hidden = !text; b.textContent = text || '';
  if (btnText) { const x = document.createElement('button'); x.className = 'btn'; x.textContent = btnText; x.onclick = btnFn; b.appendChild(x); }
}
function renderSourceNote() {
  let t = _t('数据源：') + feed().label;
  if (state.market === 'us' && feed() === Feeds.AlpacaFeed) t += state.extHours ? _t(' · 含盘前盘后') : _t(' · 只看常规时段（多数看盘软件的默认做法）');
  $('source-note').textContent = t + _t(' · 时间为本地时区');
}
