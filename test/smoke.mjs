/**
 * dsh-font-studio — 离线冒烟测试（node test/smoke.mjs）
 *
 * 不依赖浏览器与 DSH：用一个 60 行的假 DOM 跑通客户端 bundle 的加载与 apply，
 * 验证 ①bundle 契约 ②字体栈清洗（防样式注入）③CSS 令牌覆写内容 ④字号优先走官方服务、
 * 无服务时退回 CSS 变量 ⑤localStorage 持久化读回。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/* ── 假 DOM ─────────────────────────────────────────────────────────── */
const byId = new Map();

/** 假装本机只装了这几个字体：探测时量出的字宽才会与「不存在的家族」不同。 */
const INSTALLED = new Set(["Microsoft YaHei", "Consolas", "JetBrains Mono", "LXGW WenKai"]);

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.id = "";
    this.textContent = "";
    this.parentNode = null;
    this.attributes = {};
    this._font = "";
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attributes ? this.attributes[k] : null;
  }
  getContext(kind) {
    if (kind !== "2d") return null;
    const el = this;
    return {
      set font(value) {
        el._font = String(value);
      },
      get font() {
        return el._font;
      },
      measureText: () => {
        const hit = [...INSTALLED].some((family) => el._font.includes('"' + family + '"'));
        return { width: hit ? 1000 : 100 };
      }
    };
  }
}

const head = {
  children: [],
  appendChild(node) {
    node.parentNode = head;
    head.children.push(node);
    if (node.id) byId.set(node.id, node);
    return node;
  },
  removeChild(node) {
    head.children = head.children.filter((item) => item !== node);
    if (node.id) byId.delete(node.id);
    node.parentNode = null;
    return node;
  }
};

const document = {
  head,
  documentElement: { appendChild: () => {} },
  createElement: (tag) => new El(tag),
  getElementById: (id) => byId.get(id) || null
};

/* ── 假浏览器外壳 ───────────────────────────────────────────────────── */
const storage = new Map();
const localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k)
};

let captured = null;
const window = {
  __ModuleLoader__: {
    load: (options) => {
      captured = options;
    }
  },
  localStorage,
  setTimeout: () => 0
};

/* ── 假 React ───────────────────────────────────────────────────────── */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn
};

const requireStub = (name) => {
  if (name === "react") return React;
  throw new Error("unexpected require: " + name);
};

/* ── 加载 bundle ────────────────────────────────────────────────────── */
const sandbox = { window, document, navigator: {}, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "client.js" });

assert.ok(captured, "bundle 应当调用 window.__ModuleLoader__.load");
assert.equal(captured.id, "dsh-font-studio", "bundle id 必须与包名一致");

const client = captured.factory(requireStub);
assert.equal(typeof client.apply, "function", "必须导出 apply");
assert.equal(client.inject.length, 1, "inject 只声明 slots（跨 vm 上下文故不比原型）");
assert.equal(client.inject[0], "slots");

/* ── 假 ctx + 假 theme 服务 ─────────────────────────────────────────── */
const pushedSizes = [];
const fakeTheme = {
  getTheme: () => ({
    preference: "system",
    fontSizes: { text: 14, code: 11, terminal: 13 },
    fontFamilies: { text: "", code: "", terminal: "" },
    active: { id: "light", colorScheme: "light", tokens: {} },
    revision: 1
  }),
  setFontSize: (role, px) => {
    pushedSizes.push([role, px]);
  }
};

let registered = null;
const makeCtx = (theme) => ({
  get: (name) => (name === "theme" ? theme : undefined),
  on: () => () => {},
  effect: (fn) => {
    fn();
  },
  slots: {
    inject: (_name, factory) => factory(),
    register: (definition, Component) => {
      registered = { definition, Component };
      return () => {};
    }
  }
});

const internals = client.__internals;
const styleNode = () => byId.get(internals.styleId);

/* ── ① 字体栈清洗：不许把用户输入拼成新规则 ─────────────────────────── */
assert.equal(internals.sanitizeStack('"PingFang SC"'), '"PingFang SC"');
assert.equal(internals.sanitizeStack("a;}body{color:red").includes("}"), false, "必须吃掉右花括号");
assert.equal(internals.sanitizeStack("x;color:red").includes(";"), false, "必须吃掉分号");
assert.equal(internals.sanitizeStack("</style><script>alert(1)</script>").includes("<"), false, "必须吃掉尖括号");
assert.ok(internals.sanitizeStack("a".repeat(400)).length <= 240, "必须限长");

/* ── ①b 字体探测：没有枚举接口时，用字宽探测目录里真实存在的字体 ─────── */
const detected = internals.probeInstalledFamilies(internals.fontCatalog);
assert.ok(Array.isArray(detected), "探测应当返回数组");
assert.equal(
  Array.from(detected).sort().join(" | "),
  "Consolas | JetBrains Mono | LXGW WenKai | Microsoft YaHei",
  "只应报出真的装了的字体"
);
assert.ok(internals.fontCatalog.length > 60, "字体目录要有足够多的候选");

/* ── ② apply：注册插槽 + 装样式 ─────────────────────────────────────── */
storage.set(internals.storageKey, JSON.stringify({ text: '"LXGW WenKai", "Microsoft YaHei", serif', code: "", sizes: {} }));
internals.store.state = { text: '"LXGW WenKai", "Microsoft YaHei", serif', code: "", sizes: { text: null, code: null, terminal: null } };

const ctx = makeCtx(fakeTheme);
client.apply(ctx);

assert.ok(registered, "应当注册 settings.section");
assert.equal(registered.definition.name, "settings.section");
assert.equal(registered.definition.slot, undefined);
assert.equal(registered.definition.id, "font-studio");
assert.equal(registered.definition.label(), "字体");
assert.equal(typeof registered.Component, "function", "插槽必须拿到组件");

const css = styleNode() && styleNode().textContent;
assert.ok(css, "应当写出字体覆写样式");
assert.ok(css.includes("--dsw-font-family"), "必须覆写 --dsw-font-family");
assert.ok(css.includes("LXGW WenKai"), "必须写入选中的字体");
assert.ok(css.includes("!important"), "必须用 !important 压过 body 内联令牌");
assert.ok(!css.includes("color:red"), "不得出现注入内容");
assert.ok(byId.get(internals.pluginStyleId), "应当挂上插件自身样式");

/* ── ②b 渲染：组件函数必须能在假 React 下跑通（真宿主出错就整页白屏）───── */
function renderTree(Component) {
  return Component({});
}

function collectText(node, out = []) {
  if (node == null || node === false) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node === "object") {
    if (node.children) collectText(node.children, out);
    else if (node.props && node.props.children) collectText(node.props.children, out);
  }
  return out;
}

const tree = renderTree(registered.Component);
assert.ok(tree && tree.type === "section", "组件应当渲染出一个 section");
assert.equal(tree.props.className, "dshfs-root");
const treeText = collectText(tree).join(" | ");
assert.ok(treeText.includes("字体"), "应当有“字体”标题");
assert.ok(treeText.includes("侧边终端单元格（需官方主题服务）"), "有 theme 服务时应当出现终端字号行");
assert.ok(treeText.includes("官方主题服务"), "有 theme 服务时状态徽标应说明走官方服务");

/* ── ②c 点「扫描字体」不许抛错：这个环境没有枚举接口，必须走渲染探测 ──── */
function findNode(node, predicate) {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate);
      if (hit) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  const kids = node.children || (node.props && node.props.children);
  return kids ? findNode(kids, predicate) : null;
}

const scanButton = findNode(tree, (node) => node.type === "button" && collectText(node).join("").includes("扫描"));
assert.ok(scanButton, "界面上必须有「扫描字体」按钮");
assert.equal(typeof scanButton.props.onClick, "function");
scanButton.props.onClick();
assert.equal(typeof navigator.queryLocalFonts, "undefined", "沙箱里本来就没有枚举接口（与 Electron 一致）");

/* ── ③ 字号：有官方服务就走服务，不走 CSS ──────────────────────────── */
internals.store.commit({ sizes: { text: 17 } });
assert.deepEqual(pushedSizes.at(-1), ["text", 17], "有 theme 服务时应当调用 setFontSize");
assert.ok(!String(styleNode().textContent).includes("--dsh-content-font-size"), "走服务时不应再写 CSS 兜底");

/* ── ④ 字号：没有官方服务时退回 CSS 变量 ───────────────────────────── */
// 重跑一次 bundle，拿一个干净的工厂（模拟“宿主里没有 theme 服务”的实例）。
vm.runInContext(source, sandbox, { filename: "client-2.js" });
const freshModule = captured.factory(requireStub);
const fallbackCtx = makeCtx(null);
freshModule.apply(fallbackCtx);
freshModule.__internals.store.commit({ sizes: { code: 13 } });
assert.ok(
  String(styleNode().textContent).includes("--dsh-code-font-size: 13px !important"),
  "无 theme 服务时应当用 CSS 变量兜底"
);

/* ── ④b 无服务时渲染：不出终端字号行，状态徽标说明用 CSS 兜底 ───────── */
const fallbackTree = renderTree(registered.Component);
const fallbackText = collectText(fallbackTree).join(" | ");
assert.ok(!fallbackText.includes("侧边终端单元格（需官方主题服务）"), "无 theme 服务时不应出现终端字号行");
assert.ok(fallbackText.includes("CSS 兜底"), "无 theme 服务时应当说明走 CSS 兜底");

/* ── ⑤ 恢复默认：清空字体覆写并还原官方字号快照 ────────────────────── */
freshModule.__internals.store.reset();
assert.ok(!String(styleNode() && styleNode().textContent).includes("--dsw-font-family"), "恢复默认后应当撤掉字体覆写");

/* ── ⑥ 宿主字体路由：同源 fetch → 归一化（TTC 字面 + 中英文别名） ───── */
const HOST_PAYLOAD = {
  ok: true,
  files: 3,
  dirs: ["C:\\WINDOWS\\Fonts"],
  count: 2,
  families: [
    { name: "更纱黑体 SC", alias: "Sarasa Gothic SC", file: "Sarasa-SuperTTC.ttc" },
    { name: "Microsoft YaHei", alias: "", file: "msyh.ttc" }
  ]
};

const requestedUrls = [];
let hostCaptured = null;
const hostSandbox = {
  window: {
    __ModuleLoader__: {
      load: (options) => {
        hostCaptured = options;
      }
    }
  },
  document,
  navigator: {},
  console,
  localStorage,
  fetch: (url) => {
    requestedUrls.push(url);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(HOST_PAYLOAD) });
  }
};
vm.createContext(hostSandbox);
vm.runInContext(source, hostSandbox, { filename: "client-host.js" });

const hostInternals = hostCaptured.factory(requireStub).__internals;
const hostFamilies = await hostInternals.fetchHostFonts(false).then((payload) => hostInternals.normalizeHostFamilies(payload));
assert.equal(requestedUrls.at(-1), "/dsh-font-studio/fonts", "默认走宿主字体路由");
assert.deepEqual(
  Array.from(hostFamilies).map((item) => item.name),
  ["更纱黑体 SC", "Microsoft YaHei"],
  "宿主清单里的每个字面都要保留"
);
assert.equal(hostFamilies[0].alias, "Sarasa Gothic SC", "英文名要带出来当别名");
await hostInternals.fetchHostFonts(true);
assert.equal(requestedUrls.at(-1), "/dsh-font-studio/fonts?refresh=1", "重新扫盘要带 refresh=1");

// 宿主路由没注册 / 返回畸形时：必须是可捕获的失败，而不是静默空清单。
const brokenSandbox = {
  window: {
    __ModuleLoader__: {
      load: (options) => {
        brokenCaptured = options;
      }
    }
  },
  document,
  navigator: {},
  console,
  localStorage,
  fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: false }) })
};
let brokenCaptured = null;
vm.createContext(brokenSandbox);
vm.runInContext(source, brokenSandbox, { filename: "client-host-broken.js" });
await assert.rejects(
  brokenCaptured.factory(requireStub).__internals.fetchHostFonts(false),
  /字体清单不可用/,
  "畸形载荷要明确失败"
);

// 没有 fetch（不支持的运行时）也要明确失败，让上层退回探测。
const noFetchSandbox = {
  window: {
    __ModuleLoader__: {
      load: (options) => {
        noFetchCaptured = options;
      }
    }
  },
  document,
  navigator: {},
  console,
  localStorage
};
let noFetchCaptured = null;
vm.createContext(noFetchSandbox);
vm.runInContext(source, noFetchSandbox, { filename: "client-host-nofetch.js" });
await assert.rejects(
  noFetchCaptured.factory(requireStub).__internals.fetchHostFonts(false),
  /没有 fetch/,
  "缺 fetch 时要明确失败"
);

/* ── ⑦ 官方字体输入框：接管后把 body 内联令牌按回默认，未接管不碰 ────── */
const bodyVars = new Map([
  ["--dsh-font-family-text", '"Comic Sans MS", sans-serif'],
  ["--dsh-font-family-code", "monospace"]
]);
document.body = {
  style: {
    getPropertyValue: (token) => bodyVars.get(token) || "",
    setProperty: (token, value) => bodyVars.set(token, value)
  }
};

internals.neutralizeOfficialFonts({ text: '"LXGW WenKai"', code: "" });
assert.equal(
  bodyVars.get("--dsh-font-family-text"),
  "var(--dsh-font-family-text-default)",
  "接管正文后，官方正文令牌要按回默认"
);
assert.equal(bodyVars.get("--dsh-font-family-code"), "monospace", "没接管代码时不许动官方代码令牌");

internals.neutralizeOfficialFonts({ text: '"LXGW WenKai"', code: "" });
assert.equal(bodyVars.get("--dsh-font-family-text"), "var(--dsh-font-family-text-default)", "重复扫描保持幂等");

// 官方主题重新写入后，applyTypography 每次落地都要再按回去（它就是每次 theme/change 都写）
bodyVars.set("--dsh-font-family-text", '"Comic Sans MS"');
internals.store.state = { text: '"LXGW WenKai"', code: "", sizes: { text: null, code: null, terminal: null } };
internals.applyTypography();
assert.equal(
  bodyVars.get("--dsh-font-family-text"),
  "var(--dsh-font-family-text-default)",
  "applyTypography 后官方内联令牌必须仍是默认"
);

// 接管期间界面上要有一句说明，免得用户以为官方输入框还生效。
// 注意 registered.Component 来自第二次加载的实例（④ 里为拿“无 theme 服务”的干净工厂重跑过 bundle），
// 它的 store 与 `internals.store` 不是同一个对象，要按它自己的实例写状态。
const ownerInternals = freshModule.__internals;
ownerInternals.store.state = { text: '"LXGW WenKai"', code: "", sizes: { text: null, code: null, terminal: null } };
const ownerTree = renderTree(registered.Component);
assert.ok(collectText(ownerTree).join(" ").includes("已接管"), "接管状态下要提示官方输入框不参与渲染");

console.log("PASS  dsh-font-studio smoke: bundle 契约 / 清洗 / 字体探测 / 宿主路由 / 官方令牌接管 / CSS 令牌 / 字号双通路 / 渲染 / 恢复默认");
