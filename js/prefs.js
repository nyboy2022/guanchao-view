// 界面语言和明暗主题。放在 <head> 里最先加载：页面一出来就是正确的主题，不会先闪一下深色。
//   语言：'zh' | 'en'，切换后刷新页面
//   主题：'auto'（跟随系统）| 'light' | 'dark'，切换立即生效
// _t(中文原文, 参数) 返回当前语言的文字；英文词典在 lang-en.js，以中文原文为键，参数写成 {0} {1} …
(function (global) {
  const LANG_KEY = 'guanchao.lang', THEME_KEY = 'guanchao.theme';
  const read = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

  let lang = read(LANG_KEY);
  if (lang !== 'zh' && lang !== 'en') lang = /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

  function _t(s, args) {
    let r = s;
    if (lang === 'en') { const d = global.I18N_EN; if (d && d[s] != null) r = d[s]; }
    if (args) r = r.replace(/\{(\d+)\}/g, (m, k) => (args[k] == null ? '' : args[k]));
    return r;
  }

  // 页面里写死的中文：逐个文本节点和 title / placeholder 换成英文（保留前后空白）
  function translateDOM(root) {
    if (lang !== 'en' || !global.I18N_EN) return;
    const d = global.I18N_EN;
    const walk = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const raw = n.nodeValue, key = raw.trim();
      if (key && d[key] != null) n.nodeValue = raw.replace(key, d[key]);
    }
    for (const el of (root || document.body).querySelectorAll('[title],[placeholder]')) {
      for (const a of ['title', 'placeholder']) { const v = el.getAttribute(a); if (v && d[v] != null) el.setAttribute(a, d[v]); }
    }
    if (d[document.title] != null) document.title = d[document.title];
  }

  // ---------- 主题 ----------
  const mq = global.matchMedia ? global.matchMedia('(prefers-color-scheme: light)') : null;
  let themePref = read(THEME_KEY);
  if (!['auto', 'light', 'dark'].includes(themePref)) themePref = 'auto';
  const resolve = () => (themePref === 'auto' ? (mq && mq.matches ? 'light' : 'dark') : themePref);
  let theme = resolve();
  const applyTheme = () => {
    theme = resolve();
    document.documentElement.dataset.theme = theme;
    global.dispatchEvent(new CustomEvent('guanchao-theme', { detail: theme }));
  };
  document.documentElement.dataset.theme = theme;
  if (mq) {
    const onSys = () => { if (themePref === 'auto') applyTheme(); };
    if (mq.addEventListener) mq.addEventListener('change', onSys); else if (mq.addListener) mq.addListener(onSys);
  }

  global._t = _t;
  global.Prefs = {
    get lang() { return lang; },
    get locale() { return lang === 'zh' ? 'zh-CN' : 'en-US'; },
    setLang(v) { write(LANG_KEY, v); location.reload(); },
    get theme() { return theme; },          // 实际生效的：'light' | 'dark'
    get themePref() { return themePref; },  // 用户选的：'auto' | 'light' | 'dark'
    setTheme(v) { themePref = v; write(THEME_KEY, v); applyTheme(); },
    translateDOM,
    // 标点：中文用全角，英文用半角
    paren: (x) => (lang === 'zh' ? `（${x}）` : ` (${x})`),
    get listSep() { return lang === 'zh' ? '、' : ', '; },
    get semi() { return lang === 'zh' ? '；' : '; '; },
  };
})(window);
