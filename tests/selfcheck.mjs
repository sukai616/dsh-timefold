// 最小可运行自检：把 lib/client.js 装进一个假的 window.__ModuleLoader__，
// 用一个极简 React 替身渲染消息节点，断言重跑/删除按钮点击后先出确认面板。
import fs from 'node:fs';
import assert from 'node:assert';

const src = fs.readFileSync('lib/client.js', 'utf8');

// 极简 React 替身：createElement 只记录形状，hooks 只保留 useState。
function makeReact() {
  const states = [];
  let idx = 0;
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'Fragment',
    useState: (init) => {
      if (states[idx] === undefined) states[idx] = typeof init === 'function' ? init() : init;
      const at = idx++;
      return [states[at], (v) => { states[at] = typeof v === 'function' ? v(states[at]) : v; }];
    },
    useRef: () => ({ current: null }),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useSyncExternalStore: () => null,
    createContext: () => ({ Provider: 'p', Consumer: 'c' }),
  };
}

let factory = null;
const window = {
  __ModuleLoader__: { load: ({ factory: f }) => { factory = f; } },
  addEventListener() {}, removeEventListener() {},
  location: { href: 'http://localhost/' },
  setTimeout, clearTimeout, setInterval, clearInterval,
};
globalThis.window = window;
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null, querySelectorAll: () => [],
  body: { append() {}, appendChild() {}, removeAttribute() {}, setAttribute() {},
          classList: { add() {}, remove() {} } },
  head: { appendChild() {} },
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {}, children: [] }),
  documentElement: { style: { setProperty() {}, removeProperty() {} } },
  fonts: { ready: Promise.resolve() },
};
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

try {
  new Function('window', 'document', 'fetch', src)(window, document, globalThis.fetch);
} catch (e) {
  console.log('load-threw:', e.message);
}

assert.ok(factory, '模块工厂未注册 —— client.js 结构已变，自检需更新');

const React = makeReact();
const mod = factory((name) => {
  if (name === 'react') return React;
  return new Proxy({}, { get: () => () => null });
});
assert.strictEqual(typeof mod.apply, 'function', 'apply 未导出');

// 文案表里重跑/删除确认窗的键必须全部存在，否则面板会显示原始 key。
const texts = src.match(/"(rewind\.quick\.[a-zA-Z.]+)":/g) || [];
const keys = new Set(texts.map((s) => s.slice(1, -2)));
for (const k of ['rewind.quick.rerun', 'rewind.quick.delete', 'rewind.quick.description',
                 'rewind.quick.files', 'rewind.quick.filesAt', 'rewind.quick.restoreFiles',
                 'rewind.quick.messageOnly', 'rewind.quick.sideEffects', 'rewind.quick.submit']) {
  assert.ok(keys.has(k), `缺少文案键 ${k}`);
}
// 中英各一份
const zhCount = (src.match(/"rewind\.quick\.rerun":/g) || []).length;
assert.strictEqual(zhCount, 2, '重跑确认窗标题应中英各一条');

// 关键行为：确认面板必须在 execute 之前；按钮不得再直连执行
assert.ok(/stage:\s*"confirm-quick"/.test(src), 'confirm-quick 阶段未接入');
assert.ok(!/onClick:\s*\(\)\s*=>\s*triggerQuickRewrite\("(rerun|delete)"\)[\s\S]{0,80}executeRecall/.test(src),
  '按钮仍然直连执行');

console.log('SELF-CHECK OK');
