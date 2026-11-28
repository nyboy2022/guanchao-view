// 在 Node 里加载项目的浏览器脚本（它们都是挂到 window 上的立即执行函数）
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export function loadScripts(files, extra = {}) {
  const w = {
    _t: (s, args) => (args ? s.replace(/\{(\d+)\}/g, (m, k) => args[k] ?? '') : s),
    localStorage: { getItem: () => null, setItem() {} },
    // 假的 WebSocket：不联网，只要接口在
    WebSocket: class { constructor() { this.readyState = 0; } send() {} close() {} addEventListener() {} },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    ...extra,
  };
  w.window = w;
  vm.createContext(w);
  for (const f of files) vm.runInContext(readFileSync(root + f, 'utf8'), w, { filename: f });
  return w;
}
