// 行情数据源。所有数据源实现同一接口，图表和界面不关心数据来自哪里：
//   loadHistory(symbol, interval, endTime?) -> Promise<bars[]>   bars: [{t,o,h,l,c,v}] 按时间升序
//   fetchTickers(symbols) -> Promise<{SYMBOL: {last, changePct}}>
//   subscribeKline(symbol, interval, onBar, onStatus, lastBar) -> unsubscribe()
//   subscribeTickers(symbols, onTicker, onStatus) -> unsubscribe()
//   validateSymbol(symbol) -> Promise<boolean>
//   normalizeSymbol(input) -> string
(function (global) {
  const INTERVAL_MS = {
    '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3, '1w': 604800e3, '1M': 2629746e3, // 月线按平均 30.44 天算，只用于画图时的间距
  };

  class FeedError extends Error {
    constructor(msg, kind) { super(msg); this.kind = kind; } // kind: 'network' | 'auth' | 'other'
  }
  async function getJSON(url, headers) {
    let r;
    try { r = await fetch(url, { headers }); }
    catch (e) { throw new FeedError('网络连接失败', 'network'); }
    if (r.status === 401 || r.status === 403) throw new FeedError('HTTP ' + r.status, 'auth');
    if (!r.ok) throw new FeedError('HTTP ' + r.status, 'other');
    return r.json();
  }

  // 自动重连的 WebSocket。onOpen(ws) 里发订阅；heartbeat 为心跳文本
  function openSocket(url, { onOpen, onData, onStatus, heartbeat }) {
    let ws = null, closed = false, retry = 0, timer = null, watchdog = null, hb = null;
    const connect = () => {
      onStatus && onStatus('connecting');
      ws = new WebSocket(url);
      ws.onopen = () => {
        retry = 0;
        onOpen && onOpen(ws);
        if (heartbeat) hb = setInterval(() => ws.readyState === 1 && ws.send(heartbeat), 25e3);
      };
      ws.onmessage = (ev) => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => ws && ws.close(), 70e3); // 70 秒无消息视为断线
        let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
        onData(m, ws);
      };
      ws.onclose = () => {
        clearTimeout(watchdog); clearInterval(hb);
        if (closed) return;
        onStatus && onStatus('reconnecting');
        timer = setTimeout(connect, Math.min(30e3, 1000 * 2 ** retry++));
      };
      ws.onerror = () => { try { ws.close(); } catch (_) {} };
    };
    connect();
    return {
      send: (obj) => ws && ws.readyState === 1 && ws.send(JSON.stringify(obj)),
      close: () => { closed = true; clearTimeout(timer); clearTimeout(watchdog); clearInterval(hb); if (ws) ws.close(); },
    };
  }

  // =====================================================================
  // 加密货币：OKX 公开行情（免费、无需注册、浏览器可直接访问、WebSocket 实时）
  // =====================================================================
  const OKX_REST = 'https://www.okx.com/api/v5/market';
  const OKX_WS_PUBLIC = 'wss://ws.okx.com/ws/v5/public';
  const OKX_WS_BUSINESS = 'wss://ws.okx.com/ws/v5/business';
  const OKX_BAR = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '1d': '1Dutc', '1w': '1Wutc', '1M': '1Mutc' };
  const okxBar = (a) => ({ t: +a[0], o: +a[1], h: +a[2], l: +a[3], c: +a[4], v: +a[5] });

  const OkxFeed = {
    id: 'okx', market: 'crypto',
    label: 'OKX 现货公开行情 · WebSocket 实时推送',
    defaults: { symbol: 'BTC-USDT', watchlist: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'BNB-USDT', 'XRP-USDT', 'DOGE-USDT'] },
    normalizeSymbol(s) {
      s = s.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
      if (!s) return '';
      if (s.includes('-')) return s;
      const m = s.match(/^(.+?)(USDT|USDC|BTC|ETH)$/);
      return m && m[1] ? `${m[1]}-${m[2]}` : `${s}-USDT`;
    },
    async loadHistory(symbol, interval, endTime) {
      const bar = OKX_BAR[interval];
      let all = [];
      if (!endTime) {
        const j = await getJSON(`${OKX_REST}/candles?instId=${symbol}&bar=${bar}&limit=300`);
        if (j.code !== '0') throw new FeedError(j.msg || 'OKX 错误', 'other');
        all = j.data.map(okxBar);
        endTime = all.length ? all[all.length - 1].t : Date.now();
      }
      // 再往前补两页，保证长周期均线有足够数据
      for (let k = 0; k < (all.length ? 2 : 3); k++) {
        const j = await getJSON(`${OKX_REST}/history-candles?instId=${symbol}&bar=${bar}&limit=300&after=${endTime}`);
        if (j.code !== '0' || !j.data.length) break;
        const page = j.data.map(okxBar);
        all = all.concat(page);
        endTime = page[page.length - 1].t;
      }
      return all.reverse(); // OKX 返回新→旧
    },
    // 筛选器用：多个品种的日线（同时最多 4 个请求，避免触发 OKX 频率限制）
    async dailyBars(symbols, n, onProgress) {
      const out = {}; let done = 0, k = 0;
      const worker = async () => {
        while (k < symbols.length) {
          const s = symbols[k++];
          try {
            const j = await getJSON(`${OKX_REST}/candles?instId=${s}&bar=1Dutc&limit=${Math.min(300, n)}`);
            if (j.code === '0') out[s] = j.data.map(okxBar).reverse();
          } catch (e) { if (e.kind === 'network') throw e; }
          onProgress && onProgress(++done);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      return out;
    },
    async fetchTickers(symbols) {
      const j = await getJSON(`${OKX_REST}/tickers?instType=SPOT`);
      const want = new Set(symbols), out = {};
      for (const t of j.data || []) if (want.has(t.instId)) {
        const last = +t.last, o = +t.open24h;
        out[t.instId] = { last, changePct: o ? ((last - o) / o) * 100 : 0 };
      }
      return out;
    },
    async validateSymbol(symbol) {
      try { const j = await getJSON(`${OKX_REST}/ticker?instId=${symbol}`); return j.code === '0' && j.data.length > 0; }
      catch (_) { return false; }
    },
    subscribeKline(symbol, interval, onBar, onStatus) {
      const arg = { channel: 'candle' + OKX_BAR[interval], instId: symbol };
      const s = openSocket(OKX_WS_BUSINESS, {
        heartbeat: 'ping', onStatus: (st) => onStatus && onStatus(st),
        onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: [arg] })),
        onData: (m) => {
          if (m.event === 'subscribe') onStatus && onStatus('live');
          if (!m.data || !m.arg || m.arg.channel !== arg.channel) return;
          for (const a of m.data) onBar(okxBar(a), Date.now());
        },
      });
      return s.close;
    },
    subscribeTickers(symbols, onTicker) {
      if (!symbols.length) return () => {};
      const s = openSocket(OKX_WS_PUBLIC, {
        heartbeat: 'ping',
        onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: symbols.map((instId) => ({ channel: 'tickers', instId })) })),
        onData: (m) => {
          if (!m.data || !m.arg || m.arg.channel !== 'tickers') return;
          for (const t of m.data) {
            const last = +t.last, o = +t.open24h;
            onTicker(t.instId, { last, changePct: o ? ((last - o) / o) * 100 : 0 });
          }
        },
      });
      return s.close;
    },
  };

  // =====================================================================
  // 美股：Alpaca Market Data（需免费注册拿 API Key）
  //   feed = 'iex'：免费，只有 IEX 交易所的实时成交
  //   feed = 'sip'：全美所有交易所，需要 Alpaca 付费数据套餐
  // 免费账号只允许 1 个行情 WebSocket 连接，所以K线和自选共用一条连接。
  // =====================================================================
  const ALP_REST = 'https://data.alpaca.markets/v2/stocks';
  const ALP_TF = { '1m': '1Min', '5m': '5Min', '15m': '15Min', '30m': '30Min', '1h': '1Hour', '4h': '4Hour', '1d': '1Day', '1w': '1Week', '1M': '1Month' };
  const ALP_EARLIEST = Date.UTC(2015, 11, 1); // Alpaca 的历史数据大约从 2016 年开始
  const alpCfg = { key: '', secret: '', feed: 'iex' };
  const alpHeaders = () => ({ 'APCA-API-KEY-ID': alpCfg.key, 'APCA-API-SECRET-KEY': alpCfg.secret });
  const parseTs = (s) => Date.parse(String(s).replace(/(\.\d{3})\d+/, '$1'));
  const prevClose = {};

  // 共享的成交流
  const alpStream = {
    sock: null, authed: false, subscribed: new Set(), listeners: new Set(), statusCbs: new Set(), status: 'idle',
    setStatus(s) { this.status = s; this.statusCbs.forEach((f) => f(s)); },
    wanted() { const w = new Set(); this.listeners.forEach((l) => l.symbols.forEach((s) => w.add(s))); return w; },
    sync() {
      if (this.paused) { if (this.sock) { this.sock.close(); this.sock = null; this.authed = false; this.subscribed.clear(); } return; }
      const want = this.wanted();
      clearTimeout(this.idleTimer);
      if (!want.size) {
        // 延迟关闭：切换品种时会先退订再订阅，避免频繁断开重连（免费账号只允许 1 个连接）
        this.idleTimer = setTimeout(() => {
          if (this.wanted().size || !this.sock) return;
          this.sock.close(); this.sock = null; this.authed = false; this.subscribed.clear(); this.status = 'idle';
        }, 5000);
        return;
      }
      if (!this.sock) { this.open(); return; }
      if (!this.authed) return;
      const add = [...want].filter((s) => !this.subscribed.has(s));
      const del = [...this.subscribed].filter((s) => !want.has(s));
      if (del.length) this.sock.send({ action: 'unsubscribe', trades: del });
      if (add.length) this.sock.send({ action: 'subscribe', trades: add });
      this.subscribed = want;
    },
    open() {
      this.authed = false; this.subscribed.clear();
      this.sock = openSocket(`wss://stream.data.alpaca.markets/v2/${alpCfg.feed}`, {
        onStatus: (s) => { if (s !== 'live') { this.authed = false; this.subscribed.clear(); this.setStatus(s); } },
        onData: (arr) => {
          if (!Array.isArray(arr)) return;
          for (const m of arr) {
            if (m.T === 'success' && m.msg === 'connected') this.sock.send({ action: 'auth', key: alpCfg.key, secret: alpCfg.secret });
            else if (m.T === 'success' && m.msg === 'authenticated') { this.authed = true; this.setStatus('live'); this.sync(); }
            else if (m.T === 'error') {
              // 402 认证失败；406 连接数超限（同一账号只能开一个）；405 订阅数超限；409 无权限（如免费账号用 sip）
              const map = { 402: 'autherr', 406: 'connlimit', 405: 'symlimit', 409: 'noperm' };
              this.setStatus(map[m.code] || 'error:' + m.msg);
              if (m.code === 402 || m.code === 409) { const s = this.sock; this.sock = null; s && s.close(); }
            } else if (m.T === 't') {
              const tr = { sym: m.S, p: +m.p, s: +m.s, t: parseTs(m.t) };
              this.listeners.forEach((l) => l.symbols.has(tr.sym) && l.fn(tr));
            }
          }
        },
      });
    },
    add(symbols, fn, statusCb) {
      const l = { symbols: new Set(symbols), fn };
      this.listeners.add(l); if (statusCb) { this.statusCbs.add(statusCb); statusCb(this.status === 'idle' ? 'connecting' : this.status); }
      this.sync();
      return () => { this.listeners.delete(l); if (statusCb) this.statusCbs.delete(statusCb); this.sync(); };
    },
    restart() { if (this.sock) { this.sock.close(); this.sock = null; } this.sync(); },
  };

  // ---- 美东时间工具：判断常规交易时段（09:30–16:00 ET） ----
  const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  function etInfo(t) {
    const o = {}; for (const p of etFmt.formatToParts(new Date(t))) o[p.type] = p.value;
    const h = +o.hour % 24;
    return { date: `${o.year}-${o.month}-${o.day}`, min: h * 60 + +o.minute, wd: o.weekday };
  }
  const RTH_OPEN = 570, RTH_CLOSE = 960;
  // 一根K线（起点 t、长度 ms）是否覆盖常规交易时段
  function barInRth(t, ms) {
    if (ms >= 86400e3) return true;
    const m = etInfo(t).min;
    return m + ms / 60e3 > RTH_OPEN && m < RTH_CLOSE;
  }
  const tradeInRth = (t) => { const m = etInfo(t).min; return m >= RTH_OPEN && m < RTH_CLOSE; };
  // 美东时段：pre 盘前 04:00–09:30、rth 常规、post 盘后 16:00–20:00、night 夜盘 20:00–次日 04:00（周日晚到周五早）、closed 周末
  const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  function etSession(t) {
    const e = etInfo(t), d = WD[e.wd], m = e.min;
    if (d === 6 || (d === 0 && m < 1200) || (d === 5 && m >= 1200)) return 'closed';
    if (m < 240 || m >= 1200) return 'night';
    if (m < RTH_OPEN) return 'pre';
    if (m < RTH_CLOSE) return 'rth';
    return 'post';
  }
  const SIP_DELAY = 16 * 60e3; // 免费账号可以免费查 15 分钟以前的全市场（SIP）数据
  const toBarA = (b) => ({ t: parseTs(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });

  async function alpBars(symbol, interval, startMs, endMs, feed, sort, limit) {
    startMs = Math.max(startMs, ALP_EARLIEST);
    if (startMs >= endMs) return [];
    const q = new URLSearchParams({
      timeframe: ALP_TF[interval], limit: String(limit || 1000), sort: sort || 'desc', feed, adjustment: 'split',
      start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
    });
    const j = await getJSON(`${ALP_REST}/${encodeURIComponent(symbol)}/bars?${q}`, alpHeaders());
    const bars = (j.bars || []).map(toBarA);
    return sort === 'asc' ? bars : bars.reverse();
  }
  // Alpha Vantage 财报：免费 Key 每天 25 次，所以按品种缓存 3 天
  const AV_CACHE = 'guanchao.earn.';
  async function avEarnings(symbol, key) {
    const ck = AV_CACHE + symbol;
    try { const c = JSON.parse(localStorage.getItem(ck) || 'null'); if (c && Date.now() - c.at < 3 * 86400e3) return c.ev; } catch (_) {}
    let j;
    try { j = await getJSON(`https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`); }
    catch (e) { throw new Error(e.kind === 'network' ? '连不上 Alpha Vantage' : e.message); }
    const info = j.Information || j.Note;
    if (info) throw new Error(/rate limit|25 requests|frequency|per day/i.test(info) ? '今天的免费次数（25 次）用完了，明天会恢复' : 'Key 无效或被拒绝');
    if (j['Error Message']) throw new Error('Alpha Vantage 没有这个代码的财报');
    const day = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d, 14, 30); };
    const num = (v) => (v == null || v === 'None' || v === '' ? null : +v);
    const ev = (j.quarterlyEarnings || []).filter((q) => q.reportedDate).map((q) => {
      const a = num(q.reportedEPS), e = num(q.estimatedEPS), sp = num(q.surprisePercentage);
      const beat = a != null && e != null ? (a >= e ? 'beat' : 'miss') : null;
      const when = q.reportTime === 'pre-market' ? ' 盘前' : q.reportTime === 'post-market' ? ' 盘后' : '';
      return { t: day(q.reportedDate), kind: 'earn', title: '财报', beat,
        detail: `${q.reportedDate}${when} · 财季 ${q.fiscalDateEnding} · EPS ${a ?? '—'}（预期 ${e ?? '—'}${sp != null ? `，${sp >= 0 ? '超出' : '低于'} ${Math.abs(sp).toFixed(1)}%` : ''}）` };
    });
    try { localStorage.setItem(ck, JSON.stringify({ at: Date.now(), ev })); } catch (_) {}
    return ev;
  }
  let nightOk = null; // 免费账号能否读夜盘数据（第一次被拒后不再请求）
  let sipHistoryOk = true; // 免费账号查延迟 SIP 是否被允许（第一次失败后就不再尝试）

  const AlpacaFeed = {
    id: 'alpaca', market: 'us',
    get label() {
      return alpCfg.feed === 'sip' ? 'Alpaca · 全美市场 SIP 实时'
        : 'Alpaca 免费版 · 历史K线用全市场数据（延迟15分钟以上的部分），最近15分钟和实时推送来自 IEX';
    },
    defaults: { symbol: 'AAPL', watchlist: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'SPY', 'QQQ'] },
    configure(cfg) {
      const changed = cfg.feed !== alpCfg.feed || cfg.key !== alpCfg.key || cfg.secret !== alpCfg.secret;
      Object.assign(alpCfg, cfg);
      if (changed) { sipHistoryOk = true; alpStream.restart(); }
    },
    setRthOnly(v) { alpCfg.rthOnly = !!v; },
    hasKey() { return !!(alpCfg.key && alpCfg.secret); },
    // 图上最新价是不是延迟 15 分钟的数据：免费版开着盘前盘后时，IEX 只在 08:00–17:00 有成交，
    // 04:00–08:00 和 17:00–20:00 图上最新的K线只能来自延迟的全市场数据
    chartDelayed() {
      if (alpCfg.feed === 'sip' || !sipHistoryOk || alpCfg.rthOnly || !this.hasKey()) return false;
      const now = Date.now(), ses = etSession(now), m = etInfo(now).min;
      return (ses === 'pre' && m < 480) || (ses === 'post' && m >= 1020);
    },
    pause() { if (alpStream.paused) return; alpStream.paused = true; alpStream.sync(); },
    resume() { if (!alpStream.paused) return; alpStream.paused = false; alpStream.sync(); },
    normalizeSymbol(s) { return s.trim().toUpperCase().replace(/[^A-Z.]/g, ''); },
    async loadHistory(symbol, interval, endTime) {
      if (!this.hasKey()) throw new FeedError('未设置 API Key', 'auth');
      const ms = INTERVAL_MS[interval];
      const now = Date.now();
      const end = endTime || now;
      // 往前取足够长的时间窗（含休市、周末），再按倒序取最近 1000 根
      const span = ms * 1000 * (ms < 86400e3 ? (alpCfg.rthOnly ? 8 : 4) : 1.6) + 10 * 86400e3;
      let bars;
      if (alpCfg.feed === 'sip') {
        bars = await alpBars(symbol, interval, end - span, end, 'sip');
      } else {
        // 免费账号：15 分钟以前的部分用全市场 SIP 数据（和券商、主流看盘软件一致），最近 15 分钟只能用 IEX 补上
        const sipEnd = Math.min(end, now - SIP_DELAY);
        bars = null;
        if (sipHistoryOk) {
          try { bars = await alpBars(symbol, interval, end - span, sipEnd, 'sip'); }
          catch (e) { if (e.kind === 'auth') sipHistoryOk = false; else throw e; }
        }
        if (!bars) bars = await alpBars(symbol, interval, end - span, end, 'iex');
        else if (end > sipEnd) {
          const tail = await alpBars(symbol, interval, sipEnd - ms, end, 'iex', 'asc');
          const lastT = bars.length ? bars[bars.length - 1].t : 0;
          for (const b of tail) {
            if (b.t > lastT) bars.push(b);
            else if (b.t === lastT) { // 同一根K线：价格接上 IEX 的最新成交
              const x = bars[bars.length - 1];
              x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c;
            }
          }
        }
      }
      if (alpCfg.rthOnly) bars = bars.filter((b) => barInRth(b.t, ms));
      return bars;
    },
    // 自选列表的价格：
    //  - 收盘价/昨收用全市场 SIP 日线（免费账号可查 15 分钟以前的），和主流看盘软件一致
    //  - 交易时段内如果 IEX 有最近 20 分钟内的成交，用 IEX 实时价
    async fetchTickers(symbols) {
      if (!symbols.length || !this.hasKey()) return {};
      const out = {}, now = Date.now();
      const daily = {};
      try {
        const q = new URLSearchParams({ symbols: symbols.join(','), timeframe: '1Day', feed: alpCfg.feed === 'sip' ? 'sip' : (sipHistoryOk ? 'sip' : 'iex'), adjustment: 'split', limit: '10000',
          start: new Date(now - 12 * 86400e3).toISOString(), end: new Date(alpCfg.feed === 'sip' ? now : now - SIP_DELAY).toISOString() });
        const j = await getJSON(`${ALP_REST}/bars?${q}`, alpHeaders());
        for (const [sym, arr] of Object.entries(j.bars || {})) daily[sym] = arr.map(toBarA);
      } catch (_) {}
      let snaps = {};
      try { snaps = await getJSON(`${ALP_REST}/snapshots?symbols=${symbols.map(encodeURIComponent).join(',')}&feed=${alpCfg.feed}`, alpHeaders()) || {}; } catch (_) {}
      const today = etInfo(now).date;
      for (const sym of symbols) {
        const d = daily[sym] || [], s = snaps[sym];
        const lastD = d[d.length - 1], prevD = d[d.length - 2];
        // 昨收：如果最后一根日线是今天，就取前一根；否则最后一根就是上一个交易日
        let pc = null, last = null;
        if (lastD) {
          if (etInfo(lastD.t).date === today) { pc = prevD ? prevD.c : null; last = lastD.c; }
          else { pc = prevD ? prevD.c : null; last = lastD.c; }
        }
        if (!pc && s && s.prevDailyBar) pc = s.prevDailyBar.c;
        const lt = s && s.latestTrade;
        if (lt) {
          const tt = parseTs(lt.t);
          const fresh = now - tt < 20 * 60e3 && tradeInRth(tt);
          if (fresh || last == null) {
            last = lt.p;
            if (lastD && etInfo(lastD.t).date !== today && etInfo(tt).date === today) pc = lastD.c; // 今天已开盘，昨收=最后一根日线
          }
        }
        if (pc) prevClose[sym] = pc;
        if (last != null) out[sym] = { last, changePct: pc ? ((last - pc) / pc) * 100 : 0 };
      }
      return out;
    },
    // 盘前 / 盘后 / 夜盘价格。返回 { session, nightNote, quotes:{SYM:{session, price, t, ref}} }
    //   ref = 最近一个常规时段的收盘价（涨跌幅相对它算，和主流看盘软件一样）
    //   盘前盘后：全市场 SIP 5 分钟K线（免费，延迟 15 分钟）+ IEX 最新成交（实时，只覆盖 08:00–17:00）
    //   夜盘：Alpaca 的 overnight 数据源，免费账号没有权限时返回 nightNote
    async extQuotes(symbols) {
      const now = Date.now(), session = etSession(now), out = { session, quotes: {}, nightNote: '' };
      if (!symbols.length || !this.hasKey() || session === 'rth') return out;
      const feed = alpCfg.feed === 'sip' ? 'sip' : (sipHistoryOk ? 'sip' : 'iex');
      const bars = {};
      try {
        let token = null, pages = 0;
        do {
          const q = new URLSearchParams({ symbols: symbols.join(','), timeframe: '5Min', feed, limit: '10000',
            start: new Date(now - 5 * 86400e3).toISOString(), end: new Date(feed === 'sip' && alpCfg.feed !== 'sip' ? now - SIP_DELAY : now).toISOString() });
          if (token) q.set('page_token', token);
          const j = await getJSON(`${ALP_REST}/bars?${q}`, alpHeaders());
          for (const [sym, arr] of Object.entries(j.bars || {})) (bars[sym] = bars[sym] || []).push(...arr.map(toBarA));
          token = j.next_page_token;
        } while (token && ++pages < 10);
      } catch (_) {}
      let snaps = {};
      try { snaps = await getJSON(`${ALP_REST}/snapshots?symbols=${symbols.map(encodeURIComponent).join(',')}&feed=${alpCfg.feed}`, alpHeaders()) || {}; } catch (_) {}
      for (const sym of symbols) {
        const arr = bars[sym] || [];
        let ref = null, refT = 0, ext = null;
        for (const b of arr) {
          const m = etInfo(b.t).min;
          if (m >= RTH_OPEN && m < RTH_CLOSE) { ref = b.c; refT = b.t; ext = null; } // 新的常规时段开始，之前的盘前盘后作废
          else if (m >= 240 && m < 1200) ext = { price: b.c, t: b.t + 5 * 60e3, session: m < RTH_OPEN ? 'pre' : 'post', delayed: feed === 'sip' && alpCfg.feed !== 'sip' };
        }
        const lt = snaps[sym] && snaps[sym].latestTrade;
        if (lt) {
          const tt = parseTs(lt.t), m = etInfo(tt).min;
          if (tt > refT && !(m >= RTH_OPEN && m < RTH_CLOSE) && (!ext || tt > ext.t)) ext = { price: lt.p, t: tt, session: m < RTH_OPEN ? 'pre' : 'post', delayed: false };
        }
        // 盘前时段只显示今天的盘前；还没有盘前成交时显示上一个盘后
        // 时段已经结束超过 15 分钟的价格是完整的，不算延迟
        if (ext && ext.session !== session) ext.delayed = false;
        if (ext && ref != null) out.quotes[sym] = { ...ext, ref };
        else if (ref != null) out.quotes[sym] = { session: session === 'pre' ? 'pre' : 'post', price: null, t: 0, ref };
      }
      if (session === 'night') {
        if (nightOk !== false) {
          try {
            const j = await getJSON(`${ALP_REST}/snapshots?symbols=${symbols.map(encodeURIComponent).join(',')}&feed=overnight`, alpHeaders());
            nightOk = true;
            for (const sym of symbols) {
              const lt = j && j[sym] && j[sym].latestTrade; if (!lt || !out.quotes[sym]) continue;
              const tt = parseTs(lt.t); if (etSession(tt) !== 'night' || now - tt > 9 * 3600e3) continue;
              out.quotes[sym] = { ...out.quotes[sym], session: 'night', price: lt.p, t: tt, delayed: false };
            }
          } catch (e) { if (e.kind === 'auth') nightOk = false; }
        }
        if (nightOk === false) out.nightNote = '夜盘（20:00–次日 04:00）价格：Alpaca 免费版没有这项数据，这里显示的是盘后最后价格。';
      }
      return out;
    },
    // 分红、拆股（Alpaca 公司行动接口）+ 财报日（Alpha Vantage，可选，需要免费 Key）
    // 返回 { events:[{t, kind:'div'|'split'|'earn', title, detail}], notes:[说明文字] }
    async events(symbol, startMs, avKey) {
      const ev = [], notes = [];
      const day = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d, 14, 30); };
      const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
      if (this.hasKey()) {
        try {
          let token = null, pages = 0;
          do {
            const q = new URLSearchParams({ symbols: symbol, types: 'cash_dividend,forward_split,reverse_split', start: ymd(Math.max(startMs, ALP_EARLIEST)), end: ymd(Date.now() + 120 * 86400e3), limit: '1000' });
            if (token) q.set('page_token', token);
            const j = await getJSON(`https://data.alpaca.markets/v1/corporate-actions?${q}`, alpHeaders());
            const ca = j.corporate_actions || {};
            for (const d of ca.cash_dividends || []) if (d.ex_date) ev.push({ t: day(d.ex_date), kind: 'div', title: '分红', detail: `除息日 ${d.ex_date} · 每股 $${+(+d.rate).toFixed(4)}${d.special ? '（特别股息）' : ''}${d.payable_date ? ' · 派息日 ' + d.payable_date : ''}` });
            for (const d of [...(ca.forward_splits || []), ...(ca.reverse_splits || [])]) if (d.ex_date) ev.push({ t: day(d.ex_date), kind: 'split', title: '拆股', detail: `${d.ex_date} · ${+d.old_rate} 股变 ${+d.new_rate} 股${+d.new_rate < +d.old_rate ? '（合股）' : ''}` });
            token = j.next_page_token;
          } while (token && ++pages < 10);
        } catch (e) { notes.push('分红/拆股数据读取失败：' + (e.kind === 'auth' ? 'Alpaca 账号没有这项数据的权限' : e.message)); }
      }
      if (avKey) {
        try { ev.push(...await avEarnings(symbol, avKey)); }
        catch (e) { notes.push('财报日读取失败：' + e.message); }
      } else notes.push('财报日需要在 ⚙ 设置里填一个 Alpha Vantage 免费 Key');
      return { events: ev.filter((x) => x.t >= startMs).sort((a, b) => a.t - b.t), notes };
    },
    // 筛选器用：多个品种的日线，一次请求（自动翻页）
    async dailyBars(symbols, n) {
      if (!this.hasKey()) throw new FeedError('未设置 API Key', 'auth');
      const now = Date.now(), out = {};
      const feed = alpCfg.feed === 'sip' ? 'sip' : (sipHistoryOk ? 'sip' : 'iex');
      let token = null, pages = 0;
      do {
        const q = new URLSearchParams({ symbols: symbols.join(','), timeframe: '1Day', feed, adjustment: 'split', limit: '10000',
          start: new Date(now - n * 1.5 * 86400e3).toISOString(), end: new Date(alpCfg.feed === 'sip' ? now : now - SIP_DELAY).toISOString() });
        if (token) q.set('page_token', token);
        const j = await getJSON(`${ALP_REST}/bars?${q}`, alpHeaders());
        for (const [sym, arr] of Object.entries(j.bars || {})) (out[sym] = out[sym] || []).push(...arr.map(toBarA));
        token = j.next_page_token;
      } while (token && ++pages < 20);
      return out;
    },
    async validateSymbol(symbol) {
      try { await getJSON(`${ALP_REST}/${encodeURIComponent(symbol)}/snapshot?feed=${alpCfg.feed}`, alpHeaders()); return true; }
      catch (_) { return false; }
    },
    // 用逐笔成交实时合成当前K线
    subscribeKline(symbol, interval, onBar, onStatus, lastBar) {
      const ms = INTERVAL_MS[interval];
      let cur = lastBar ? { ...lastBar } : null;
      return alpStream.add([symbol], (tr) => {
        if (alpCfg.rthOnly && !tradeInRth(tr.t)) return; // 只看常规时段时，盘前盘后的成交不计入
        if (!cur) cur = { t: Math.floor(tr.t / ms) * ms, o: tr.p, h: tr.p, l: tr.p, c: tr.p, v: 0 };
        if (tr.t < cur.t) return;
        if (interval === '1M') {
          // 月线：按美东日历月判断是否进入新的一根
          const a = etInfo(tr.t).date.slice(0, 7), b = etInfo(cur.t + 86400e3).date.slice(0, 7);
          if (a !== b) cur = { t: tr.t, o: tr.p, h: tr.p, l: tr.p, c: tr.p, v: 0 };
        } else if (tr.t >= cur.t + ms) {
          const t = cur.t + Math.floor((tr.t - cur.t) / ms) * ms; // 与历史K线同一时间网格
          cur = { t, o: tr.p, h: tr.p, l: tr.p, c: tr.p, v: 0 };
        }
        cur.h = Math.max(cur.h, tr.p); cur.l = Math.min(cur.l, tr.p); cur.c = tr.p; cur.v += tr.s;
        onBar({ ...cur }, tr.t);
      }, onStatus);
    },
    subscribeTickers(symbols, onTicker, onExt) {
      if (!symbols.length) return () => {};
      return alpStream.add(symbols, (tr) => {
        // 自选的“最新价”只算常规时段；盘前盘后的成交单独交给 onExt 显示在下面一行
        if (!tradeInRth(tr.t)) { if (onExt) onExt(tr.sym, { price: tr.p, t: tr.t, session: etSession(tr.t) }); return; }
        const pc = prevClose[tr.sym];
        onTicker(tr.sym, { last: tr.p, changePct: pc ? ((tr.p - pc) / pc) * 100 : 0 });
      });
    },
  };

  // =====================================================================
  // 演示数据源：连不上网络时使用的随机行情，界面上会明确标注
  // =====================================================================
  const simState = {};
  function seedPrice(sym) {
    const s = sym.replace(/[-/]?USDT$/, '');
    const base = { BTC: 95000, ETH: 3400, SOL: 180, BNB: 650, XRP: 2.2, DOGE: 0.35, AAPL: 230, MSFT: 420, NVDA: 140, TSLA: 350, AMZN: 210, SPY: 600, QQQ: 520 }[s];
    if (base) return base;
    let h = 0; for (const ch of sym) h = (h * 31 + ch.charCodeAt(0)) % 997;
    return 10 + h;
  }
  function rand(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }
  function simBars(sym, interval, endTime, n) {
    const ms = INTERVAL_MS[interval];
    const end = Math.floor((endTime || Date.now()) / ms) * ms;
    const rnd = rand(Math.floor(end / ms) % 100000 + sym.length * 7919);
    let p = seedPrice(sym);
    const vol = Math.sqrt(ms / 60e3) * 0.0012;
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const o = p;
      const c = o * (1 + (rnd() - 0.5) * 2 * vol);
      const h = Math.max(o, c) * (1 + rnd() * vol * 0.6);
      const l = Math.min(o, c) * (1 - rnd() * vol * 0.6);
      out.push({ t: end - i * ms, o, h, l, c, v: 50 + rnd() * 500 });
      p = c;
    }
    return out;
  }
  function makeSim(base) {
    return {
      id: 'sim', market: base.market, label: '演示数据（随机生成，非真实行情）', defaults: base.defaults,
      normalizeSymbol: base.normalizeSymbol.bind(base),
      chartDelayed() { return base.market === 'us' && typeof window !== 'undefined' && !!window.__simDelayed; },
      async loadHistory(symbol, interval, endTime) {
        const bars = simBars(symbol, interval, endTime, 1000);
        if (!endTime) simState[symbol + interval] = bars[bars.length - 1];
        return bars;
      },
      async fetchTickers(symbols) {
        const out = {}; for (const s of symbols) out[s] = { last: seedPrice(s), changePct: 0 }; return out;
      },
      async validateSymbol() { return true; },
      async dailyBars(symbols, n) { const o = {}; for (const s of symbols) o[s] = simBars(s, '1d', null, n); return o; },
      async extQuotes(symbols) {
        if (base.market !== 'us') return { session: 'rth', quotes: {} };
        const session = typeof window !== 'undefined' && window.__simSession || 'post', quotes = {};
        for (const s of symbols) { const ref = seedPrice(s); quotes[s] = { session, price: ref * (1 + (s.length % 3 - 1) * 0.004), t: Date.now(), ref, delayed: !!window.__simDelayed && session !== 'night' }; }
        return { session, quotes, nightNote: session === 'night' ? '夜盘（20:00–次日 04:00）价格：Alpaca 免费版没有这项数据，这里显示的是盘后最后价格。' : '' };
      },
      async events(symbol, startMs) {
        if (base.market !== 'us') return { events: [], notes: [] };
        const ev = [], now = Date.now(), q = 91.3 * 86400e3, D = 86400e3;
        for (let k = 1; k < 40; k++) {
          const t = Math.floor((now - k * q + 20 * D) / D) * D + 14.5 * 3600e3;
          ev.push({ t, kind: 'earn', title: '财报', beat: k % 3 ? 'beat' : 'miss', detail: '演示数据' });
          ev.push({ t: t + 30 * D, kind: 'div', title: '分红', detail: '演示数据 · 每股 $0.25' });
        }
        ev.push({ t: Math.floor((now - 700 * D) / D) * D + 14.5 * 3600e3, kind: 'split', title: '拆股', detail: '演示数据 · 1 股变 4 股' });
        return { events: ev.filter((x) => x.t >= startMs && x.t <= now).sort((a, b) => a.t - b.t), notes: [] };
      },
      subscribeKline(symbol, interval, onBar, onStatus) {
        onStatus && onStatus('sim');
        const ms = INTERVAL_MS[interval];
        const id = setInterval(() => {
          let last = simState[symbol + interval]; if (!last) return;
          const now = Date.now(), t = Math.floor(now / ms) * ms;
          if (t > last.t) last = { t, o: last.c, h: last.c, l: last.c, c: last.c, v: 0 };
          const c = last.c * (1 + (Math.random() - 0.5) * 0.0008);
          last = { ...last, c, h: Math.max(last.h, c), l: Math.min(last.l, c), v: last.v + Math.random() * 5 };
          simState[symbol + interval] = last; onBar(last, now);
        }, 500);
        return () => clearInterval(id);
      },
      subscribeTickers(symbols, onTicker) {
        const px = {}; symbols.forEach((s) => (px[s] = seedPrice(s)));
        const id = setInterval(() => {
          for (const s of symbols) {
            px[s] *= 1 + (Math.random() - 0.5) * 0.001;
            onTicker(s, { last: px[s], changePct: ((px[s] - seedPrice(s)) / seedPrice(s)) * 100 });
          }
        }, 1000);
        return () => clearInterval(id);
      },
    };
  }

  global.Feeds = { OkxFeed, AlpacaFeed, makeSim, INTERVAL_MS, FeedError, etInfo, etSession };
})(window);
