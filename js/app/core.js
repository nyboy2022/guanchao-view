// 观潮看盘 · 基础：常量、主题和语言按钮、出错提示、本地保存（state / save）、周期和交易日工具
// app/ 下的文件按 index.html 里的顺序加载，共用同一个顶层作用域（没有构建步骤，所以不用 import）。
const INTERVALS = [['1m', _t('1分')], ['5m', _t('5分')], ['15m', _t('15分')], ['30m', _t('30分')], ['1h', _t('1时')], ['4h', _t('4时')], ['1d', _t('日')], ['1w', _t('周')], ['1M', _t('月')], ['ytd', _t('今年至今')]];
const LAYOUTS = [1, 2, 4, 6, 8];
const STORE = 'guanchao.v1';
const $ = (id) => document.getElementById(id);
const FORCE_DEMO = /[?&]demo\b/.test(location.search);
const REAL = { crypto: Feeds.OkxFeed, us: Feeds.AlpacaFeed };
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 页面里写死的文字换成当前语言（英文时）
Prefs.translateDOM(document.body);

// ---------- 主题和语言 ----------
const THEME_NEXT = { auto: 'light', light: 'dark', dark: 'auto' };
const THEME_ICON = { auto: '◐', light: '☀', dark: '☾' };
const THEME_TIP = { auto: _t('主题：跟随系统'), light: _t('主题：浅色'), dark: _t('主题：深色') };
const renderThemeBtn = () => { const b = $('theme-btn'); b.textContent = THEME_ICON[Prefs.themePref]; b.title = THEME_TIP[Prefs.themePref]; };
renderThemeBtn();
$('theme-btn').onclick = () => { Prefs.setTheme(THEME_NEXT[Prefs.themePref]); renderThemeBtn(); };
window.addEventListener('guanchao-theme', (e) => ChartUtil.setTheme(e.detail));
$('lang-btn').textContent = Prefs.lang === 'zh' ? 'EN' : '中';
$('lang-btn').onclick = () => Prefs.setLang(Prefs.lang === 'zh' ? 'en' : 'zh');

// ---------- 出错时直接显示在页面顶部，方便排查 ----------
window.addEventListener('error', (e) => {
  const err = e.error, where = err && err.stack ? String(err.stack).split('\n')[1] || '' : (e.filename ? `${e.filename}:${e.lineno}` : '');
  const b = $('banner'); if (!b) return;
  b.hidden = false; b.textContent = _t("程序出错：{0} {1}", [e.message || err, where.trim()]);
});
window.addEventListener('unhandledrejection', (e) => {
  const b = $('banner'); if (!b) return;
  b.hidden = false; b.textContent = _t('程序出错：') + (e.reason && e.reason.message || e.reason);
});

// ---------- 本地保存 ----------
const sec = (name) => ({ t: 'h', id: uid('h'), name, collapsed: false });
const sym = (s) => ({ t: 's', s });
// 默认的列表 / 板块名没改过的话，跟着界面语言显示
const DEFAULT_NAMES = new Set(['我的自选', '主流', '其他', '科技', '指数 ETF', '新列表']);
const dispName = (n) => (DEFAULT_NAMES.has(n) ? _t(n) : n);
const DEFAULT_LISTS = {
  crypto: () => [{ id: uid('l'), name: _t('我的自选'), items: [sec(_t('主流')), sym('BTC-USDT'), sym('ETH-USDT'), sec(_t('其他')), sym('SOL-USDT'), sym('BNB-USDT'), sym('XRP-USDT'), sym('DOGE-USDT')] }],
  us: () => [{ id: uid('l'), name: _t('我的自选'), items: [sec(_t('科技')), sym('AAPL'), sym('MSFT'), sym('NVDA'), sym('AMZN'), sym('TSLA'), sec(_t('指数 ETF')), sym('SPY'), sym('QQQ')] }],
};
const defaults = {
  market: 'crypto', interval: '15m',
  markets: {},
  indicators: null,
  alpaca: { key: '', secret: '', feed: 'iex', tradier: '' },
  extHours: true,
  drawings: {},
  alerts: [],
  alertLog: [],
  avKey: '',
  push: { ntfy: '', discord: '', bark: '' },
  events: true,
  layouts: [],
};
let state;
try { state = { ...defaults, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch (_) { state = { ...defaults }; }
// 第一版数据迁移：BTCUSDT → BTC-USDT
if (state.watchlist) {
  const conv = (s) => Feeds.OkxFeed.normalizeSymbol(s);
  state.markets = { ...state.markets, crypto: { symbol: conv(state.symbol || 'BTCUSDT'), watchlist: state.watchlist.map(conv) } };
  for (const k of Object.keys(state.drawings)) if (!k.includes('-') && /USDT$/.test(k)) state.drawings[conv(k)] = state.drawings[k];
  delete state.watchlist; delete state.symbol;
}
state.markets = state.markets || {};
for (const m of ['crypto', 'us']) {
  const old = state.markets[m] || {}, mk = { ...old };
  // 旧版单一自选数组 → 多列表
  if (!Array.isArray(mk.lists) || !mk.lists.length) {
    mk.lists = Array.isArray(old.watchlist) && old.watchlist.length
      ? [{ id: uid('l'), name: _t('我的自选'), items: old.watchlist.map(sym) }]
      : DEFAULT_LISTS[m]();
  }
  delete mk.watchlist;
  if (!mk.lists.some((l) => l.id === mk.activeList)) mk.activeList = mk.lists[0].id;
  if (!LAYOUTS.includes(mk.layout)) mk.layout = 1;
  if (!Array.isArray(mk.cells)) mk.cells = [old.symbol || REAL[m].defaults.symbol];
  delete mk.symbol;
  mk.active = Math.min(Math.max(0, mk.active | 0), mk.layout - 1);
  state.markets[m] = mk;
}
state.alpaca = { ...defaults.alpaca, ...state.alpaca };
if (!Array.isArray(state.alerts)) state.alerts = [];
if (!Array.isArray(state.alertLog)) state.alertLog = [];
if (!Array.isArray(state.layouts)) state.layouts = [];
state.push = { ...defaults.push, ...(state.push || {}) };
// 2026-11：改成默认包含盘前盘后（任何时段K线都实时跳动），老设置迁移一次
if (!state.extV2) { state.extHours = true; state.extV2 = true; }
// Key 和推送地址：默认存在本机；设置里关掉「记住 Key」后只放在 sessionStorage，关掉程序就忘
const SECRET_FIELDS = (st) => { st.alpaca = { ...st.alpaca, key: '', secret: '', tradier: '' }; st.avKey = ''; st.push = { ntfy: '', discord: '', bark: '' }; return st; };
const SESS = 'guanchao.secrets';
const pickSecrets = (st) => ({ alpaca: { key: st.alpaca.key, secret: st.alpaca.secret, tradier: st.alpaca.tradier }, avKey: st.avKey, push: { ...st.push } });
if (state.rememberKeys === false) {
  try {
    const x = JSON.parse(sessionStorage.getItem(SESS) || 'null');
    if (x) { state.alpaca = { ...state.alpaca, ...x.alpaca }; state.avKey = x.avKey || ''; state.push = { ...state.push, ...x.push }; }
  } catch (_) {}
}
const save = () => {
  try {
    if (state.rememberKeys === false) {
      localStorage.setItem(STORE, JSON.stringify(SECRET_FIELDS(JSON.parse(JSON.stringify(state)))));
      sessionStorage.setItem(SESS, JSON.stringify(pickSecrets(state)));
    } else {
      localStorage.setItem(STORE, JSON.stringify(state));
      sessionStorage.removeItem(SESS);
    }
  } catch (_) {}
};
Feeds.AlpacaFeed.configure(state.alpaca);
Feeds.AlpacaFeed.setRthOnly(!state.extHours);
// 指标：旧版是开关对象 {ma:true,...}，新版是可自定义的实例列表
state.indicators = Indicators.sanitize(state.indicators) || (() => {
  const old = state.indicators && typeof state.indicators === 'object' ? state.indicators : null;
  if (!old) return Indicators.defaults();
  const list = [];
  if (old.ma) list.push(Indicators.create('ma', { n: 20 }, '#f5c451'), Indicators.create('ma', { n: 50 }, '#5ab0ff'), Indicators.create('ma', { n: 200 }, '#c58cff'));
  if (old.ema) list.push(Indicators.create('ema', { n: 12 }, '#ff8f5a'), Indicators.create('ema', { n: 26 }, '#4fd1c5'));
  if (old.boll) list.push(Indicators.create('boll'));
  if (old.rsi) list.push(Indicators.create('rsi'));
  if (old.macd) list.push(Indicators.create('macd'));
  return list;
})();
save();

const M = () => state.markets[state.market];
const IV_NAME = Object.fromEntries(INTERVALS);
// 每个图自己的周期：M().ivs[k] 是周期按钮的 id（'1m' … '1M'、'ytd'），没设过就用最近一次选的
const ivKey = (k) => { const v = (M().ivs || [])[k]; return v || (state.range === 'ytd' ? 'ytd' : state.interval); };
const ivOf = (k) => (ivKey(k) === 'ytd' ? '1d' : ivKey(k));
const activeList = () => M().lists.find((l) => l.id === M().activeList) || M().lists[0];
const listSyms = (l) => (l || activeList()).items.filter((x) => x.t === 's').map((x) => x.s);
const simFeeds = { crypto: Feeds.makeSim(Feeds.OkxFeed), us: Feeds.makeSim(Feeds.AlpacaFeed) };
const usingSim = { crypto: FORCE_DEMO, us: FORCE_DEMO };
const feedOf = (m) => (usingSim[m] ? simFeeds[m] : REAL[m]);
const feed = () => feedOf(state.market);
// VWAP 按交易日重新累计：美股按美东日期，加密货币按 UTC 日期（美东时间按整点缓存，避免反复格式化）
const etCache = new Map();
const etDay = (t) => { const h = Math.floor(t / 3600e3); let v = etCache.get(h); if (v === undefined) { v = Feeds.etInfo(t).date; etCache.set(h, v); } return v; };
const utcDay = (t) => Math.floor(t / 86400e3);

let tickers = {};
let lastEventAt = 0;
