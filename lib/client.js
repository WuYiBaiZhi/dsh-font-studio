/**
 * dsh-font-studio — 客户端半边
 *
 * 在「设置」里加一节 **字体**：挑一个字体栈（预设画廊 / 自定义 / 扫本机字体），
 * 实时换掉界面正文与代码字体，并可调正文 / 代码 / 终端字号。
 *
 * ── 官方那套字体通路的确切形状（来自 app.asar 源码，本插件踩的锚点）───────────
 *
 *   base.css（ui-theme 拥有）：
 *     :root{ --dsh-font-family-text-default: -apple-system, …, sans-serif;
 *            --dsh-font-family-code-default: "SF Mono", JetBrains Mono, … ;
 *            --dsw-font-family: var(--dsh-font-family-text-default);
 *            --dsw-font-family-brand: "Montserrat", var(--dsh-font-family-text-default);
 *            --ds-font-family-code: var(--dsh-font-family-code-default); }
 *     body { --dsw-font-family: var(--dsh-font-family-text, <default>), <default>;
 *            --ds-font-family-code: var(--dsh-font-family-code, <default>), <default>; }
 *
 *   所以组件里写的都是 `font-family: var(--dsw-font-family)` / `var(--ds-font-family-code)`。
 *   ThemePresenter 每次 theme/change 会把 `--dsh-font-family-{text,code,terminal}` 写进
 *   **body 的内联样式**（列表为空则 removeProperty），base.css 再把它们合成进
 *   `--dsw-font-family`。=> 想抢在前面，`!important` 覆写 `--dsw-font-family` 这条合成结果
 *   最稳（内联样式优先级低于 !important 的作者样式），官方设置页改字体也照样被本插件接管。
 *
 *   字号走公开服务：`ctx.theme.setFontSize("text"|"code"|"terminal", px)`，
 *   范围 text 10–22 / code 10–16 / terminal 10–20（整数，越界抛错）。
 *   官方 service 面**没有** setFontFamily（只有 getTheme / setTheme / setFontSize /
 *   register / overrideTokens），所以字体族只能靠 CSS 令牌覆写 —— 这也是本插件这么干的原因。
 *
 * ── 四条纪律 ──────────────────────────────────────────────────────────────
 *  1. **fail-open**：拿不到 theme 服务、localStorage 不可用、插槽不存在……一律降级而不抛错，
 *     官方界面保持原样。
 *  2. **不写别人的 DOM**：只挂两个自持节点（`<style>` 主题样式 + `<style>` 插件样式），
 *     卸载时按 data 属性精确移除。
 *  3. **字体栈先清洗再拼 CSS**：去掉 `;{}<>` 与换行，限制长度，杜绝把用户输入拼成样式注入。
 *  4. **幂等**：applyTypography() 可以随便重复调用（启动重试、theme/change 后重新校准都一样）。
 */
window.__ModuleLoader__.load({
  id: "dsh-font-studio",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var h = React.createElement;

    var PACKAGE_ID = "dsh-font-studio";
    var SLOT_NAME = "settings.section";
    var ENTRY_ID = "font-studio";
    var STORAGE_KEY = "dsh-font-studio:v1";
    /** 宿主半边注册的字体清单路由（见 lib/index.js 的 ROUTE_PREFIX）。 */
    var HOST_FONTS_URL = "/dsh-font-studio/fonts";
    /** 输入框自动补全用的 datalist id。 */
    var FONT_DATALIST_ID = "dsh-font-studio-families";
    var STYLE_ID = "dsh-font-studio-typography";
    var PLUGIN_STYLE_ID = "dsh-font-studio-plugin-css";

    /* ────────────────────────────── 字体预设 ───────────────────────────── */

    /** 正文字体预设。每条都自带中文回退，避免选了英文字体后中文掉回难看的兜底。 */
    var TEXT_PRESETS = [
      { id: "default", label: "系统默认", stack: "", hint: "内置字体栈" },
      { id: "pingfang", label: "苹方 PingFang", stack: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", sans-serif' },
      { id: "yahei", label: "微软雅黑", stack: '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Segoe UI", sans-serif' },
      { id: "source-han", label: "思源黑体", stack: '"Source Han Sans SC", "Noto Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif' },
      { id: "wenkai", label: "霞鹜文楷", stack: '"LXGW WenKai", "LXGW WenKai Screen", "Kaiti SC", STKaiti, "Microsoft YaHei", serif' },
      { id: "serif", label: "宋体阅读", stack: '"Source Han Serif SC", "Noto Serif SC", "Songti SC", SimSun, Georgia, serif' },
      { id: "sarasa", label: "更纱黑体", stack: '"Sarasa Gothic SC", "Sarasa Mono SC", "Microsoft YaHei", sans-serif' },
      { id: "inter", label: "Inter", stack: 'Inter, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif' },
      { id: "georgia", label: "Georgia 阅读体", stack: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif' },
      { id: "rounded", label: "圆体 / 幼圆", stack: '"Yuanti SC", YouYuan, "M PLUS Rounded 1c", "PingFang SC", "Microsoft YaHei", sans-serif' }
    ];

    /** 代码字体预设（等宽）。 */
    var CODE_PRESETS = [
      { id: "default", label: "系统默认", stack: "", hint: "内置等宽栈" },
      { id: "jetbrains", label: "JetBrains Mono", stack: '"JetBrains Mono", "Fira Code", Consolas, monospace' },
      { id: "cascadia", label: "Cascadia Code", stack: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
      { id: "fira", label: "Fira Code", stack: '"Fira Code", "Cascadia Code", Consolas, monospace' },
      { id: "sfmono", label: "SF Mono", stack: '"SF Mono", SFMono-Regular, ui-monospace, Menlo, monospace' },
      { id: "consolas", label: "Consolas", stack: 'Consolas, "Courier New", ui-monospace, monospace' },
      { id: "sarasa-mono", label: "更纱等宽（中文等宽）", stack: '"Sarasa Mono SC", "Sarasa Gothic SC", "Microsoft YaHei", ui-monospace, monospace' }
    ];

    /** 字号规格，与官方 FONT_SIZE_SPECS 对齐（越界会被官方服务拒绝，这里先夹一次）。 */
    var SIZE_SPECS = {
      text: { min: 10, max: 22, fallback: 14, label: "正文字号", desc: "会话正文与大部分界面文字", variable: "--dsh-content-font-size" },
      code: { min: 10, max: 16, fallback: 11, label: "代码字号", desc: "代码块与行内代码", variable: "--dsh-code-font-size" },
      terminal: { min: 10, max: 20, fallback: 13, label: "终端字号", desc: "侧边终端单元格（需官方主题服务）", variable: "--dsh-terminal-font-size" }
    };

    var ROLES = ["text", "code"];

    /* ────────────────────────────── 小工具 ──────────────────────────────── */

    function clampSize(role, value) {
      var spec = SIZE_SPECS[role];
      if (!spec) return null;
      var n = Math.round(Number(value));
      if (!isFinite(n)) return null;
      return Math.min(spec.max, Math.max(spec.min, n));
    }

    /**
     * 清洗一条字体栈：只保留「家族名 + 逗号 + 引号 + 空格 + 少量符号」，
     * 去掉能提前闭合声明或标签的字符，再限长。返回 "" 表示「跟随官方默认」。
     */
    function sanitizeStack(raw) {
      if (raw == null) return "";
      var value = String(raw);
      value = value.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
      value = value.replace(/[;{}<>]/g, " ");
      value = value.replace(/!important/gi, " ");
      value = value.replace(/[^\w\s,"'\-.\u0080-\uFFFF]/g, "");
      value = value.replace(/\s+/g, " ").trim();
      value = value.replace(/^,+|,+$/g, "").trim();
      if (value.length > 240) value = value.slice(0, 240);
      return value;
    }

    function isSameStack(a, b) {
      return sanitizeStack(a) === sanitizeStack(b);
    }

    /* ────────────────────── 自定义字体（「我的字体」清单） ──────────────────── */

    /** 「我的字体」最多记这么多条：够用又不至于把 localStorage 撑爆。 */
    var MAX_CUSTOM_FONTS = 24;

    /**
     * 清洗单个字体家族名：用户只会填「一个名字」，所以这里比 sanitizeStack 更严——
     * 引号、逗号、反斜杠全部抹掉（拼栈时统一加引号），只留名字本身。
     */
    function sanitizeFamilyName(raw) {
      if (raw == null) return "";
      var value = String(raw);
      value = value.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
      value = value.replace(/[;{}<>"',\\]/g, " ");
      value = value.replace(/!important/gi, " ");
      value = value.replace(/[^\w\s\-.+\u0080-\uFFFF]/g, " ");
      value = value.replace(/\s+/g, " ").trim();
      if (value.length > 80) value = value.slice(0, 80);
      return value;
    }

    /** 存储里读出来的清单：容忍 `["名字"]` 与 `[{name, alias}]`，去空、去重、限量。 */
    function normalizeCustomList(raw) {
      var out = [];
      if (!Array.isArray(raw)) return out;
      var seen = {};
      for (var i = 0; i < raw.length && out.length < MAX_CUSTOM_FONTS; i++) {
        var item = raw[i];
        var isObject = item && typeof item === "object";
        var name = sanitizeFamilyName(isObject ? item.name : item);
        if (!name) continue;
        var key = name.toLowerCase();
        if (seen[key]) continue;
        seen[key] = true;
        var alias = sanitizeFamilyName(isObject ? item.alias : "");
        out.push({ name: name, alias: alias && alias.toLowerCase() !== key ? alias : "" });
      }
      return out;
    }

    /** 加一条：同名（忽略大小写）先剔掉再插到最前面，超出上限砍尾巴。返回新数组。 */
    function addCustomFont(list, entry) {
      var prev = normalizeCustomList(list);
      var name = sanitizeFamilyName(entry && entry.name);
      if (!name) return prev;
      var key = name.toLowerCase();

      // 同名再添加时沿用第一次的写法（免得用户把「Inter」写成「inter」后清单变丑），
      // 别名没给就继承旧的。
      var previous = null;
      for (var p = 0; p < prev.length; p++) {
        if (prev[p].name.toLowerCase() === key) {
          previous = prev[p];
          break;
        }
      }
      var display = previous ? previous.name : name;
      var alias = sanitizeFamilyName(entry && entry.alias);
      if (!alias && previous) alias = previous.alias;

      var next = [{ name: display, alias: alias && alias.toLowerCase() !== key ? alias : "" }];
      for (var i = 0; i < prev.length && next.length < MAX_CUSTOM_FONTS; i++) {
        if (prev[i].name.toLowerCase() !== key) next.push(prev[i]);
      }
      return next;
    }

    /** 删一条（同名忽略大小写）；删不到就原样返回。 */
    function dropCustomFont(list, name) {
      var key = sanitizeFamilyName(name).toLowerCase();
      return normalizeCustomList(list).filter(function (item) {
        return item.name.toLowerCase() !== key;
      });
    }

    /**
     * 单个家族 → 字体栈：名字带引号，可选别名跟在后面，末尾挂中文 / 等宽兜底，
     * 这样家族里缺字形时会平滑落到系统字体上而不是变成方框。
     */
    function stackForFamily(family, role) {
      var name = sanitizeFamilyName(family && family.name);
      if (!name) return "";
      var parts = ['"' + name + '"'];
      var alias = sanitizeFamilyName(family && family.alias);
      if (alias && alias.toLowerCase() !== name.toLowerCase()) parts.push('"' + alias + '"');
      var tail = role === "code" ? ", ui-monospace, monospace" : ', "Microsoft YaHei", sans-serif';
      return parts.join(", ") + tail;
    }

    /**
     * 「添加自定义字体」的落地数据：把条目记进清单，同时把它拼成字体栈套到指定角色。
     * 抽成纯函数，组件只管调它 + 刷新输入框，测试也能直接盖住这段逻辑。
     */
    function customFontPatch(state, entry, role) {
      var patch = { custom: addCustomFont(state && state.custom, entry) };
      var stack = stackForFamily(entry, role);
      if (stack) patch[role] = stack;
      return patch;
    }

    /* ────────────────────────────── 持久化 ──────────────────────────────── */

    var DEFAULT_STATE = {
      text: "",
      code: "",
      sizes: { text: null, code: null, terminal: null },
      custom: []
    };

    function readState() {
      var state = {
        text: "",
        code: "",
        sizes: { text: null, code: null, terminal: null },
        custom: []
      };
      try {
        var raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return state;
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          state.text = sanitizeStack(parsed.text);
          state.code = sanitizeStack(parsed.code);
          state.custom = normalizeCustomList(parsed.custom);
          var sizes = parsed.sizes && typeof parsed.sizes === "object" ? parsed.sizes : {};
          for (var role in SIZE_SPECS) {
            if (Object.prototype.hasOwnProperty.call(SIZE_SPECS, role)) {
              state.sizes[role] = sizes[role] == null ? null : clampSize(role, sizes[role]);
            }
          }
        }
      } catch (error) {
        /* localStorage 不可用 / JSON 坏了：用默认值，绝不抛 */
      }
      return state;
    }

    function persistState(state) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (error) {
        /* 隐私模式等：静默失败，本次会话仍然生效 */
      }
    }

    /* ────────────────────────────── 迷你状态机 ──────────────────────────── */

    var store = {
      state: readState(),
      snapshot: null,
      subs: [],
      subscribe: function (fn) {
        store.subs.push(fn);
        return function () {
          store.subs = store.subs.filter(function (item) {
            return item !== fn;
          });
        };
      },
      emit: function () {
        var list = store.subs.slice();
        for (var i = 0; i < list.length; i++) {
          try {
            list[i]();
          } catch (error) {
            /* 单个订阅者出错不影响其它订阅者 */
          }
        }
      },
      commit: function (patch) {
        var next = {
          text: "text" in patch ? sanitizeStack(patch.text) : store.state.text,
          code: "code" in patch ? sanitizeStack(patch.code) : store.state.code,
          custom: "custom" in patch ? normalizeCustomList(patch.custom) : store.state.custom,
          sizes: {
            text: store.state.sizes.text,
            code: store.state.sizes.code,
            terminal: store.state.sizes.terminal
          }
        };
        if (patch.sizes) {
          for (var role in SIZE_SPECS) {
            if (Object.prototype.hasOwnProperty.call(SIZE_SPECS, role) && role in patch.sizes) {
              next.sizes[role] = patch.sizes[role] == null ? null : clampSize(role, patch.sizes[role]);
            }
          }
        }
        store.state = next;
        persistState(store.state);
        applyTypography();
        store.emit();
      },
      reset: function () {
        // 「我的字体」是用户自己攒的资产：恢复默认只把字体/字号交还官方，清单留着下次还能点。
        store.state = {
          text: "",
          code: "",
          sizes: { text: null, code: null, terminal: null },
          custom: store.state.custom
        };
        persistState(store.state);
        // 字号曾被我们写进官方设置：恢复成插件首次接管前的快照值
        pushedSizes = { text: null, code: null, terminal: null };
        restoreInitialSizes();
        applyTypography();
        store.emit();
      }
    };

    /* ────────────────────────────── 主题服务桥 ──────────────────────────── */

    var ctxRef = null;

    /** 尽力拿到官方 theme 服务；拿不到返回 null（不声明 inject，避免 fiber 卡 PENDING）。 */
    function themeOf() {
      try {
        var theme = null;
        if (ctxRef && typeof ctxRef.get === "function") {
          try {
            theme = ctxRef.get("theme");
          } catch (error) {
            theme = null;
          }
        }
        if (!theme && ctxRef) {
          try {
            theme = ctxRef.theme;
          } catch (error2) {
            theme = null;
          }
        }
        if (theme && typeof theme.getTheme === "function") return theme;
        return null;
      } catch (error) {
        return null;
      }
    }

    function readSnapshot() {
      var theme = themeOf();
      if (!theme) return null;
      try {
        var snapshot = theme.getTheme();
        if (snapshot && typeof snapshot === "object") {
          store.snapshot = snapshot;
          return snapshot;
        }
      } catch (error) {
        /* 服务在但读不到：当作没有 */
      }
      return null;
    }

    /** 插件首次接管前的官方字号快照，用来在「恢复默认」时把官方设置原样放回去。 */
    var initialSizes = null;

    function captureInitialSizes() {
      if (initialSizes) return;
      var snapshot = readSnapshot();
      if (!snapshot || !snapshot.fontSizes) return;
      initialSizes = {
        text: snapshot.fontSizes.text,
        code: snapshot.fontSizes.code,
        terminal: snapshot.fontSizes.terminal
      };
    }

    function restoreInitialSizes() {
      if (!initialSizes) return;
      var theme = themeOf();
      if (!theme || typeof theme.setFontSize !== "function") return;
      for (var role in initialSizes) {
        if (!Object.prototype.hasOwnProperty.call(initialSizes, role)) continue;
        var value = clampSize(role, initialSizes[role]);
        if (value == null) continue;
        try {
          theme.setFontSize(role, value);
        } catch (error) {
          /* 官方拒绝（例如用户在官方设置里改过范围）：放弃这一个角色 */
        }
      }
      readSnapshot();
    }

    /* ────────────────────────────── 样式注入 ────────────────────────────── */

    function ensureStyleElement(id) {
      var node = document.getElementById(id);
      if (node && node.tagName === "STYLE") return node;
      node = document.createElement("style");
      node.id = id;
      node.setAttribute("data-plugin", PACKAGE_ID);
      (document.head || document.documentElement).appendChild(node);
      return node;
    }

    /** 把字体/字号覆写写进自持 style 节点；没有规则时把节点摘掉。 */
    function installTypographyCss(rules) {
      try {
        if (!rules) {
          var stale = document.getElementById(STYLE_ID);
          if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
          return;
        }
        var node = ensureStyleElement(STYLE_ID);
        node.textContent = rules;
      } catch (error) {
        /* 注入失败：界面保持官方字体 */
      }
    }

    /**
     * 官方主题（ThemePresenter）把字体族写成 body / html 的内联自定义属性：
     * `--dsh-font-family-text|code|terminal`。官方的「设置 → 通用 → 字体」输入框写的就是它，
     * 优先级天然高于任何普通规则——所以本插件一接管某个角色，就把那条内联声明改写成
     * 「等同默认」的 var()，让官方输入框的选择不再参与渲染，视觉上由本插件的 !important 令牌接管。
     *
     * 只在该角色确实由本插件接管时动手：插件没设字体时，官方输入框照常生效。
     */
    var OFFICIAL_FONT_TOKENS = ["--dsh-font-family-text", "--dsh-font-family-code", "--dsh-font-family-terminal"];

    function neutralizeOfficialFonts(prefs) {
      if (!prefs) return;
      try {
        var doc = typeof document === "undefined" ? null : document;
        if (!doc) return;
        var targets = [];
        if (doc.body) targets.push(doc.body);
        if (doc.documentElement && doc.documentElement !== doc.body) targets.push(doc.documentElement);

        for (var t = 0; t < targets.length; t++) {
          var style = targets[t] && targets[t].style;
          if (!style || typeof style.getPropertyValue !== "function") continue;
          for (var i = 0; i < OFFICIAL_FONT_TOKENS.length; i++) {
            var token = OFFICIAL_FONT_TOKENS[i];
            var role = token.slice("--dsh-font-family-".length);
            if (!prefs[role]) continue;
            var current = style.getPropertyValue(token) || "";
            if (!current.trim()) continue;
            var neutral = "var(" + token + "-default)";
            if (current.indexOf(neutral) === 0) continue;
            style.setProperty(token, neutral, "important");
          }
        }
      } catch (error) {
        /* 拿不到 DOM 就算了：!important 令牌覆写本身已经能压过大多数写入 */
      }
    }

    /** 最近一次真正推给官方服务的字号，避免每次重试都重复写设置。 */
    var pushedSizes = { text: null, code: null, terminal: null };

    function pushSizeThroughService(role, px) {
      var theme = themeOf();
      if (!theme || typeof theme.setFontSize !== "function") return false;
      if (pushedSizes[role] === px) return true;
      try {
        theme.setFontSize(role, px);
        pushedSizes[role] = px;
        readSnapshot();
        return true;
      } catch (error) {
        /* 越界 / 服务拒绝：退回 CSS 兜底 */
        return false;
      }
    }

    /** 幂等：按当前状态重算并落地字体与字号。 */
    function applyTypography() {
      try {
        var state = store.state;
        var text = sanitizeStack(state.text);
        var code = sanitizeStack(state.code);
        var rules = [];

        if (text) {
          rules.push(
            "body{--dsw-font-family: " + text + " !important;" +
              " --dsw-font-family-brand: " + text + " !important;}"
          );
        }
        if (code) {
          rules.push(
            "body{--ds-font-family-code: " + code + " !important;" +
              " --dsw-font-mono: " + code + " !important;}"
          );
        }

        for (var i = 0; i < ROLES.length; i++) {
          var role = ROLES[i];
          var value = state.sizes[role];
          if (value == null) {
            pushedSizes[role] = null;
            continue;
          }
          var px = clampSize(role, value);
          if (pushSizeThroughService(role, px)) continue;
          rules.push("body{" + SIZE_SPECS[role].variable + ": " + px + "px !important;}");
        }

        var terminal = state.sizes.terminal;
        if (terminal != null) {
          if (!pushSizeThroughService("terminal", clampSize("terminal", terminal))) {
            pushedSizes.terminal = null;
            rules.push("body{" + SIZE_SPECS.terminal.variable + ": " + clampSize("terminal", terminal) + "px !important;}");
          }
        } else {
          pushedSizes.terminal = null;
        }

        installTypographyCss(rules.join("\n"));
        // 抢在官方 ThemePresenter 之后把内联字体令牌按回默认（它每次 theme/change 都会重写）。
        neutralizeOfficialFonts(state);
      } catch (error) {
        /* 兜底：什么都不做 */
      }
    }

    /** 本插件自己的 UI 样式（设计令牌全部来自 --dsw-*，跟随主题）。 */
    var PLUGIN_CSS = [
      ".dshfs-root{display:grid;gap:14px;color:var(--dsw-alias-label-primary)}",
      ".dshfs-head{display:grid;gap:4px}",
      ".dshfs-head h2{margin:0;font-size:14px;font-weight:500;line-height:20px}",
      ".dshfs-head p{margin:0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
      ".dshfs-status{display:flex;flex-wrap:wrap;gap:6px}",
      ".dshfs-badge{font-size:11.5px;line-height:18px;padding:1px 8px;border-radius:999px;" +
        "border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);" +
        "color:var(--dsw-alias-label-tertiary)}",
      ".dshfs-tabs{display:flex;gap:6px}",
      ".dshfs-tab{font:inherit;font-size:13px;padding:6px 14px;cursor:pointer;color:inherit;" +
        "border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}",
      ".dshfs-tab[data-active=true]{border-color:var(--dsw-alias-brand-primary);" +
        "box-shadow:inset 3px 0 var(--dsw-alias-brand-primary)}",
      ".dshfs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:8px}",
      ".dshfs-card{display:grid;gap:4px;text-align:left;padding:9px 11px;min-height:60px;cursor:pointer;" +
        "color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}",
      ".dshfs-card[data-active=true]{border-color:var(--dsw-alias-brand-primary);" +
        "box-shadow:inset 3px 0 var(--dsw-alias-brand-primary)}",
      ".dshfs-cardName{font-size:11.5px;line-height:15px;color:var(--dsw-alias-label-tertiary);overflow:hidden;" +
        "text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-family)}",
      ".dshfs-cardSample{font-size:15px;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;" +
        "text-overflow:ellipsis;white-space:nowrap}",
      ".dshfs-row{display:flex;gap:8px;align-items:center}",
      ".dshfs-input{flex:1;min-width:0;font-family:var(--ds-font-family-code);font-size:12.5px;padding:7px 10px;" +
        "color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}",
      ".dshfs-select{max-width:100%;font-family:var(--ds-font-family-code);font-size:12.5px;padding:7px 10px;" +
        "color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}",
      ".dshfs-btn{font:inherit;font-size:12.5px;padding:7px 14px;cursor:pointer;color:inherit;" +
        "border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}",
      ".dshfs-btn:hover{border-color:var(--dsw-alias-border-l4)}",
      ".dshfs-btn[data-primary=true]{border-color:transparent;color:#fff;" +
        "background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary))}",
      ".dshfs-sizes{display:grid;gap:10px;padding:12px 14px;border-radius:10px;" +
        "border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}",
      ".dshfs-size{display:grid;gap:6px}",
      ".dshfs-sizeTop{display:flex;justify-content:space-between;align-items:baseline;gap:10px}",
      ".dshfs-sizeLabel{font-size:13px;line-height:18px}",
      ".dshfs-sizeDesc{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".dshfs-sizeValue{font-family:var(--ds-font-family-code);font-size:12px;font-variant-numeric:tabular-nums;" +
        "color:var(--dsw-alias-label-secondary)}",
      ".dshfs-range{width:100%;accent-color:var(--dsw-alias-brand-primary)}",
      ".dshfs-preview{display:grid;gap:8px;padding:12px 14px;border-radius:10px;border:1px dashed var(--dsw-alias-border-l2);" +
        "background:var(--dsw-alias-bg-layer-1)}",
      ".dshfs-previewText{margin:0;font-size:14px;line-height:1.7;color:var(--dsw-alias-label-primary)}",
      ".dshfs-previewCode{margin:0;font-size:12px;line-height:1.6;padding:8px 10px;border-radius:8px;overflow:auto;" +
        "background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}",
      ".dshfs-previewHead{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".dshfs-previewTitle{font-size:11.5px;line-height:16px;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}",
      ".dshfs-btnSmall{font-size:11.5px;padding:4px 10px}",
      ".dshfs-customForm{display:grid;gap:8px;padding:10px 12px;border-radius:8px;" +
        "border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}",
      ".dshfs-formRow{display:flex;gap:8px;flex-wrap:wrap}",
      ".dshfs-formRow .dshfs-input{flex:1 1 170px}",
      ".dshfs-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}",
      ".dshfs-chipsLabel{font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".dshfs-chip{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l2);" +
        "border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}",
      ".dshfs-chip[data-active=true]{border-color:var(--dsw-alias-brand-primary)}",
      ".dshfs-chipMain{font:inherit;font-size:11.5px;line-height:18px;padding:2px 8px 2px 10px;cursor:pointer;" +
        "color:inherit;background:transparent;border:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshfs-chipX{font:inherit;font-size:12px;line-height:18px;padding:2px 7px 2px 4px;cursor:pointer;" +
        "color:var(--dsw-alias-label-tertiary);background:transparent;border:0}",
      ".dshfs-chipX:hover{color:var(--dsw-alias-state-error-primary)}",
      ".dshfs-foot{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
      ".dshfs-hint{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}",
      ".dshfs-hint--owner{color:var(--dsw-alias-state-business-primary)}",
      ".dshfs-error{font-size:11.5px;color:var(--dsw-alias-state-error-primary)}"
    ].join("\n");

    function installPluginCss() {
      try {
        var node = ensureStyleElement(PLUGIN_STYLE_ID);
        node.textContent = PLUGIN_CSS;
      } catch (error) {
        /* 样式失败只是难看，功能照旧 */
      }
    }

    /* ────────────────────────────── 本机字体 ────────────────────────────── */

    /**
     * 浏览器不给枚举接口时（Electron 里 navigator.queryLocalFonts 常年缺席）退化成
     * 「渲染探测」：把候选家族名量一遍字宽，和「一定不存在的家族名」的宽度比对，
     * 宽度变了就说明本机真有这个字体的字形。目录只是候选池，不是白名单。
     */
    var FONT_CATALOG = [
      // 中文 黑体 / 宋体 / 楷体 / 圆体
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Microsoft YaHei UI", "Microsoft JhengHei",
      "SimSun", "NSimSun", "SimHei", "KaiTi", "FangSong", "DengXian", "YouYuan", "Yuanti SC",
      "STHeiti", "STKaiti", "STSong", "STFangsong", "Songti SC", "Kaiti SC",
      "Source Han Sans SC", "Source Han Serif SC", "Noto Sans SC", "Noto Serif SC",
      "Noto Sans CJK SC", "Noto Serif CJK SC", "Source Han Mono SC", "Sarasa Gothic SC", "Sarasa Mono SC",
      "LXGW WenKai", "LXGW WenKai Screen", "LXGW WenKai Mono", "HarmonyOS Sans SC", "MiSans",
      "OPPO Sans", "Alibaba PuHuiTi 3.0", "Alibaba PuHuiTi", "Smiley Sans",
      "WenQuanYi Micro Hei", "WenQuanYi Zen Hei", "FZLanTingHeiS", "FZShuSong", "HYQiHei",
      // 西文 无衬线 / 衬线
      "Inter", "Roboto", "Helvetica", "Helvetica Neue", "Arial", "Segoe UI", "Segoe UI Variable",
      "Calibri", "Cambria", "Georgia", "Times New Roman", "Palatino Linotype", "Book Antiqua",
      "Garamond", "Futura", "Gill Sans", "Optima", "Baskerville", "Avenir Next",
      "SF Pro Display", "SF Pro Text", "Ubuntu", "DejaVu Sans", "Liberation Sans", "Aptos",
      "Verdana", "Tahoma", "Trebuchet MS", "Century Gothic",
      // 等宽
      "JetBrains Mono", "Cascadia Code", "Cascadia Mono", "Fira Code", "Source Code Pro",
      "IBM Plex Mono", "Inconsolata", "Hack", "Menlo", "SF Mono", "SFMono-Regular", "Consolas",
      "Courier New", "DejaVu Sans Mono", "Ubuntu Mono", "Victor Mono", "Roboto Mono",
      "Noto Sans Mono", "Iosevka", "Monaco", "Lucida Console"
    ];

    var PROBE_TEXT = "mmmmmmmmmmlliWWQ@#壹贰叁漢字测试";
    var MISSING_FAMILY = "__dshfs_missing_font_probe__";

    function measureTextWidth(fontShorthand) {
      try {
        if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
        var canvas = document.createElement("canvas");
        if (!canvas || typeof canvas.getContext !== "function") return null;
        var context = canvas.getContext("2d");
        if (!context || typeof context.measureText !== "function") return null;
        context.font = fontShorthand;
        var metrics = context.measureText(PROBE_TEXT);
        return metrics && typeof metrics.width === "number" ? metrics.width : null;
      } catch (error) {
        return null;
      }
    }

    function probeFamily(family, baseline) {
      if (baseline == null) return false;
      var quoted = '"' + String(family).replace(/["\\]/g, "") + '"';
      var width = measureTextWidth("72px " + quoted + ", " + MISSING_FAMILY);
      return width != null && Math.abs(width - baseline) > 0.5;
    }

    /** 返回目录里「本机确实装着」的家族名；探测本身不可用时返回 null。 */
    function probeInstalledFamilies(catalog) {
      var baseline = measureTextWidth("72px " + MISSING_FAMILY);
      if (baseline == null) return null;
      var found = [];
      for (var i = 0; i < catalog.length; i++) {
        if (probeFamily(catalog[i], baseline)) found.push(catalog[i]);
      }
      found.sort(function (a, b) {
        return a.localeCompare(b, "zh-Hans-CN");
      });
      return found;
    }

    function canQueryLocalFonts() {
      try {
        return typeof navigator !== "undefined" && typeof navigator.queryLocalFonts === "function";
      } catch (error) {
        return false;
      }
    }

    function queryLocalFonts() {
      if (!canQueryLocalFonts()) return Promise.reject(new Error("unsupported"));
      return navigator.queryLocalFonts().then(function (fonts) {
        var seen = {};
        var families = [];
        for (var i = 0; i < fonts.length; i++) {
          var family = fonts[i] && fonts[i].family;
          if (typeof family === "string" && family && !seen[family]) {
            seen[family] = true;
            families.push(family);
          }
        }
        families.sort(function (a, b) {
          return a.localeCompare(b, "zh-Hans-CN");
        });
        return families;
      });
    }

    /**
     * 向宿主要本机字体清单：`GET /dsh-font-studio/fonts`（宿主半边注册的前缀路由）。
     * 这是唯一能拿到「TTC / SuperTTC 里每个字面」的通道——浏览器侧没有枚举接口。
     * 放在模块作用域而不是组件里：组件重渲染不该重建这个函数，测试也直接够得着。
     */
    function fetchHostFonts(refresh) {
      var url = HOST_FONTS_URL + (refresh ? "?refresh=1" : "");
      return new Promise(function (resolve, reject) {
        var fetcher = typeof fetch === "function" ? fetch : null;
        if (!fetcher) {
          reject(new Error("这个环境没有 fetch"));
          return;
        }
        Promise.resolve(fetcher(url, { cache: "no-store", headers: { accept: "application/json" } }))
          .then(function (response) {
            if (!response || response.ok === false) throw new Error("HTTP " + (response ? response.status : "?"));
            return response.json();
          })
          .then(function (payload) {
            if (!payload || payload.ok !== true || !Array.isArray(payload.families)) {
              throw new Error("宿主返回的字体清单不可用");
            }
            resolve(payload);
          })
          .catch(reject);
      });
    }

    /** 宿主返回的形状兜底：兼容 `["name"]` 与 `[{name, alias}]` 两种载荷。 */
    function normalizeHostFamilies(payload) {
      return ((payload && payload.families) || [])
        .map(function (item) {
          if (typeof item === "string") return { name: item, alias: "" };
          return {
            name: item && item.name ? String(item.name).trim() : "",
            alias: item && item.alias ? String(item.alias).trim() : ""
          };
        })
        .filter(function (item) {
          return !!item.name;
        });
    }

    /* ────────────────────────────── React 组件 ──────────────────────────── */

    function FontStudioSection() {
      var [tick, setTick] = React.useState(0);
      var [role, setRole] = React.useState("text");
      var [draft, setDraft] = React.useState(null);
      var [fontList, setFontList] = React.useState({ status: "idle", families: [], error: "", hint: "", source: "" });
      // 「添加自定义字体」小表单：开关、两个输入框、一条报错。
      var [adding, setAdding] = React.useState(false);
      var [customDraft, setCustomDraft] = React.useState({ name: "", alias: "" });
      var [customError, setCustomError] = React.useState("");

      React.useEffect(function () {
        var off = store.subscribe(function () {
          setTick(function (value) {
            return value + 1;
          });
        });
        // 挂载时校准一次（服务可能比本插件晚就绪）
        applyTypography();
        return off;
      }, []);

      // 打开这一节就自动取一次字体清单：宿主侧有 10 分钟缓存，代价就是一次本地请求。
      React.useEffect(function () {
        if (fontList.status !== "idle") return;
        scanByHost(false);
      }, []);

      void tick;

      var state = store.state;
      var snapshot = store.snapshot || readSnapshot();
      var api = !!themeOf();
      var presets = role === "text" ? TEXT_PRESETS : CODE_PRESETS;
      var currentStack = state[role] || "";
      var inputValue = draft == null ? currentStack : draft;
      // 老版本存储里没有 custom 字段：这里兜一下，别让界面整块崩掉。
      var customEntries = state.custom || [];

      var commitStack = function (nextStack) {
        var cleaned = sanitizeStack(nextStack);
        var patch = {};
        patch[role] = cleaned;
        store.commit(patch);
        setDraft(null);
      };

      var pickPreset = function (preset) {
        commitStack(preset.stack);
      };

      /** 点「＋ 添加自定义字体」：展开小表单，并清掉上一次的报错。 */
      var openCustomForm = function () {
        setAdding(true);
        setCustomError("");
      };

      var closeCustomForm = function () {
        setAdding(false);
        setCustomError("");
      };

      /**
       * 提交自定义字体：洗干净 → 记进「我的字体」→ 立刻拼成字体栈应用到当前角色。
       * 名字为空就停下并提示，不猜、不写垃圾进存储。
       */
      var submitCustom = function () {
        var name = sanitizeFamilyName(customDraft.name);
        if (!name) {
          setCustomError("先填一个字体名，比如 LXGW WenKai、霞鹜文楷、JetBrains Mono");
          return;
        }
        var entry = { name: name, alias: sanitizeFamilyName(customDraft.alias) };
        store.commit(customFontPatch(state, entry, role));
        setCustomDraft({ name: "", alias: "" });
        setCustomError("");
        setAdding(false);
      };

      /** 点「我的字体」里的胶囊：把这一条套到当前角色上。 */
      var applyCustomEntry = function (entry) {
        commitStack(stackForFamily(entry, role));
      };

      var removeCustomEntry = function (entry) {
        store.commit({ custom: dropCustomFont(customEntries, entry.name) });
      };

      var changeSize = function (sizeRole, value) {
        var sizes = {};
        sizes[sizeRole] = value == null ? null : clampSize(sizeRole, value);
        store.commit({ sizes: sizes });
      };

      var scanByProbe = function (note) {
        var found = probeInstalledFamilies(FONT_CATALOG);
        if (!found) {
          setFontList({
            status: "failure",
            families: [],
            error: "拿不到 canvas 2d 上下文，没法做渲染探测，请直接手写字体名",
            hint: "",
            source: "probe"
          });
          return;
        }
        setFontList({
          status: "ready",
          families: found.map(function (name) {
            return { name: name, alias: "" };
          }),
          error: "",
          hint: found.length
            ? note + "：目录内检测到 " + found.length + " 个，未列出的字体手写即可"
            : note + "：目录内一个都没检测到，直接手写字体名",
          source: "probe"
        });
      };

      var scanByHost = function (refresh) {
        fetchHostFonts(refresh).then(
          function (payload) {
            var families = normalizeHostFamilies(payload);
            setFontList({
              status: "ready",
              families: families,
              error: "",
              hint:
                "宿主扫盘：" +
                families.length +
                " 个字体族（含 TTC / SuperTTC 里每个字面）· " +
                String(payload.files || 0) +
                " 个字体文件",
              source: "host"
            });
          },
          function (hostError) {
            var hostNote = "宿主字体路由不可用（" + (hostError && hostError.message ? hostError.message : "未知原因") + "）";
            if (!canQueryLocalFonts()) {
              scanByProbe(hostNote + "，这个环境也没有枚举接口，已改用渲染探测");
              return;
            }
            queryLocalFonts().then(
              function (names) {
                var list = names.map(function (name) {
                  return { name: name, alias: "" };
                });
                setFontList({
                  status: "ready",
                  families: list,
                  error: "",
                  hint: "浏览器枚举：" + list.length + " 个字体族（" + hostNote + "，改用浏览器接口）",
                  source: "enum"
                });
              },
              function (error) {
                scanByProbe(
                  hostNote +
                    "，浏览器枚举也被拒绝（" +
                    (error && error.message ? error.message : "权限不足") +
                    "），已改用渲染探测"
                );
              }
            );
          }
        );
      };

      var scanFonts = function (refresh) {
        setFontList({ status: "loading", families: [], error: "", hint: "", source: "" });
        scanByHost(refresh === true);
      };

      var sizeValueOf = function (sizeRole) {
        var stored = state.sizes[sizeRole];
        if (stored != null) return stored;
        if (snapshot && snapshot.fontSizes && typeof snapshot.fontSizes[sizeRole] === "number") {
          return snapshot.fontSizes[sizeRole];
        }
        return SIZE_SPECS[sizeRole].fallback;
      };

      var cards = presets.map(function (preset) {
        var active = isSameStack(currentStack, preset.stack);
        var previewStyle = preset.stack ? { fontFamily: preset.stack } : undefined;
        return h(
          "button",
          {
            key: preset.id,
            type: "button",
            className: "dshfs-card",
            "data-active": active ? "true" : "false",
            title: preset.stack || preset.hint || "",
            onClick: function () {
              pickPreset(preset);
            }
          },
          h("span", { className: "dshfs-cardName" }, preset.label),
          h("span", { className: "dshfs-cardSample", style: previewStyle }, "Aa 字体 123")
        );
      });

      var sizeRows = ["text", "code"].concat(api ? ["terminal"] : []).map(function (sizeRole) {
        var spec = SIZE_SPECS[sizeRole];
        var value = sizeValueOf(sizeRole);
        return h(
          "div",
          { key: sizeRole, className: "dshfs-size" },
          h(
            "div",
            { className: "dshfs-sizeTop" },
            h(
              "span",
              null,
              h("span", { className: "dshfs-sizeLabel" }, spec.label),
              h("span", { className: "dshfs-sizeDesc" }, " · " + spec.desc)
            ),
            h("span", { className: "dshfs-sizeValue" }, value + " px")
          ),
          h("input", {
            className: "dshfs-range",
            type: "range",
            min: spec.min,
            max: spec.max,
            step: 1,
            value: value,
            "aria-label": spec.label,
            onChange: function (event) {
              changeSize(sizeRole, event.currentTarget.value);
            }
          })
        );
      });

      var familyNames = (fontList.families || []).map(function (item) {
        return typeof item === "string" ? item : item.name;
      });

      /** 选中一个家族 → 拼字体栈：中文名在前、英文名当别名，最后挂中文/等宽兜底。 */
      var familyStackOf = function (family) {
        return stackForFamily(family, role);
      };

      var fontOptions = null;
      if (fontList.status === "ready" && fontList.families.length) {
        fontOptions = h(
          "select",
          {
            className: "dshfs-select",
            "aria-label": "本机字体",
            value: "",
            onChange: function (event) {
              var value = event.currentTarget.value;
              if (!value) return;
              var picked = fontList.families.filter(function (item) {
                return (typeof item === "string" ? item : item.name) === value;
              })[0];
              var family = typeof picked === "string" ? { name: picked, alias: "" } : picked || { name: value, alias: "" };
              setDraft(familyStackOf(family));
            }
          },
          h("option", { value: "" }, "从清单里挑一个…（共 " + fontList.families.length + " 个）"),
          fontList.families.map(function (item) {
            var name = typeof item === "string" ? item : item.name;
            var alias = typeof item === "string" ? "" : item.alias;
            return h("option", { key: name, value: name, title: alias || undefined }, alias ? name + " · " + alias : name);
          })
        );
      }

      // 输入框挂 datalist：几百个字体族也能边打字边过滤，比在长下拉里找快得多。
      var datalist = familyNames.length
        ? h(
            "datalist",
            { id: FONT_DATALIST_ID },
            familyNames.map(function (name) {
              return h("option", { key: name, value: name });
            })
          )
        : null;

      return h(
        "section",
        { className: "dshfs-root" },
        h(
          "div",
          { className: "dshfs-head" },
          h("h2", null, "字体"),
          h(
            "p",
            null,
            "挑选界面正文字体与代码字体，改完立即生效并记住。字体写入走 CSS 令牌覆写（官方主题服务只开放了字号写入）。"
          )
        ),
        h(
          "div",
          { className: "dshfs-status" },
          h("span", { className: "dshfs-badge" }, "字体：" + (currentStack ? "自定义 / 预设" : "官方默认")),
          h(
            "span",
            { className: "dshfs-badge" },
            "字号：" + (api ? "官方主题服务" : "CSS 兜底（终端字号需主题服务）")
          )
        ),
        state.text || state.code
          ? h(
              "div",
              { className: "dshfs-hint dshfs-hint--owner" },
              "已接管：官方「设置 → 通用 → 字体」里的选择在本节生效期间不参与渲染（想交还官方就点「全部恢复默认」）。"
            )
          : null,
        h(
          "div",
          { className: "dshfs-tabs" },
          ROLES.map(function (item) {
            return h(
              "button",
              {
                key: item,
                type: "button",
                className: "dshfs-tab",
                "data-active": role === item ? "true" : "false",
                onClick: function () {
                  setRole(item);
                  setDraft(null);
                }
              },
              item === "text" ? "正文" : "代码"
            );
          })
        ),
        h("div", { className: "dshfs-grid" }, cards),
        h(
          "div",
          { className: "dshfs-row" },
          h("input", {
            className: "dshfs-input",
            type: "text",
            spellCheck: false,
            autoComplete: "off",
            list: familyNames.length ? FONT_DATALIST_ID : undefined,
            placeholder: role === "text" ? '"PingFang SC", "Microsoft YaHei", sans-serif' : '"JetBrains Mono", Consolas, monospace',
            value: inputValue,
            onChange: function (event) {
              setDraft(event.currentTarget.value);
            },
            onKeyDown: function (event) {
              if (event.nativeEvent && event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                commitStack(event.currentTarget.value);
              }
            }
          }),
          h(
            "button",
            {
              type: "button",
              className: "dshfs-btn",
              "data-primary": "true",
              onClick: function () {
                commitStack(inputValue);
              }
            },
            "应用"
          )
        ),
        h(
          "div",
          { className: "dshfs-row" },
          h(
            "button",
            {
              type: "button",
              className: "dshfs-btn",
              onClick: function () {
                scanFonts(false);
              }
            },
            fontList.status === "loading" ? "读取中…" : "扫描本机字体"
          ),
          fontList.source === "host"
            ? h(
                "button",
                {
                  type: "button",
                  className: "dshfs-btn",
                  title: "绕过宿主侧 10 分钟缓存，重新扫一遍字体目录（新装了字体后点这个）",
                  onClick: function () {
                    scanFonts(true);
                  }
                },
                "重新扫盘"
              )
            : null,
          fontOptions
        ),
        fontList.hint ? h("div", { className: "dshfs-hint" }, fontList.hint) : null,
        fontList.error ? h("div", { className: "dshfs-error" }, fontList.error) : null,
        datalist,
        h("div", { className: "dshfs-sizes" }, sizeRows),
        h(
          "div",
          { className: "dshfs-preview" },
          h(
            "div",
            { className: "dshfs-previewHead" },
            h("span", { className: "dshfs-previewTitle" }, "实时预览"),
            h(
              "button",
              {
                type: "button",
                className: "dshfs-btn dshfs-btnSmall",
                title: "清单里没有的字体，在这里直接加一条并记住",
                onClick: function () {
                  if (adding) closeCustomForm();
                  else openCustomForm();
                }
              },
              adding ? "收起" : "＋ 添加自定义字体"
            )
          ),
          adding
            ? h(
                "div",
                { className: "dshfs-customForm" },
                h(
                  "div",
                  { className: "dshfs-formRow" },
                  h("input", {
                    className: "dshfs-input",
                    placeholder: "字体名，如 LXGW WenKai / 霞鹜文楷",
                    "aria-label": "自定义字体名",
                    autoComplete: "off",
                    value: customDraft.name,
                    onChange: function (event) {
                      var value = event.currentTarget.value;
                      setCustomDraft({ name: value, alias: customDraft.alias });
                    },
                    onKeyDown: function (event) {
                      if (event.nativeEvent && event.nativeEvent.isComposing) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        submitCustom();
                      }
                    }
                  }),
                  h("input", {
                    className: "dshfs-input",
                    placeholder: "别名 / 英文名（可选）",
                    "aria-label": "自定义字体别名",
                    autoComplete: "off",
                    value: customDraft.alias,
                    onChange: function (event) {
                      var value = event.currentTarget.value;
                      setCustomDraft({ name: customDraft.name, alias: value });
                    },
                    onKeyDown: function (event) {
                      if (event.nativeEvent && event.nativeEvent.isComposing) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        submitCustom();
                      }
                    }
                  })
                ),
                h(
                  "div",
                  { className: "dshfs-row" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "dshfs-btn",
                      "data-primary": "true",
                      onClick: function () {
                        submitCustom();
                      }
                    },
                    "添加并应用"
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "dshfs-btn",
                      onClick: function () {
                        closeCustomForm();
                      }
                    },
                    "取消"
                  ),
                  h("span", { className: "dshfs-hint" }, "中文名、英文名、字体文件里的 family 名都认。")
                ),
                customError ? h("div", { className: "dshfs-error" }, customError) : null
              )
            : null,
          h(
            "p",
            {
              className: "dshfs-previewText",
              style: currentStack ? { fontFamily: currentStack } : undefined
            },
            "字体预览：The quick brown fox jumps over 那只懒狗。0123456789"
          ),
          h(
            "pre",
            {
              className: "dshfs-previewCode",
              style: state.code ? { fontFamily: state.code } : undefined
            },
            "const font = \"dsh-font-studio\";  // 代码字体预览"
          ),
          customEntries.length
            ? h(
                "div",
                { className: "dshfs-chips" },
                h("span", { className: "dshfs-chipsLabel" }, "我的字体"),
                customEntries.map(function (entry) {
                  var active = isSameStack(currentStack, stackForFamily(entry, role));
                  return h(
                    "span",
                    { key: entry.name, className: "dshfs-chip", "data-active": active ? "true" : "false" },
                    h(
                      "button",
                      {
                        type: "button",
                        className: "dshfs-chipMain",
                        title: (entry.alias ? entry.name + " · " + entry.alias : entry.name) + "（点击套用到当前" + (role === "text" ? "正文" : "代码") + "字体）",
                        onClick: function () {
                          applyCustomEntry(entry);
                        }
                      },
                      entry.name
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "dshfs-chipX",
                        title: "从「我的字体」里移除",
                        onClick: function () {
                          removeCustomEntry(entry);
                        }
                      },
                      "×"
                    )
                  );
                })
              )
            : null
        ),
        h(
          "div",
          { className: "dshfs-foot" },
          h(
            "button",
            {
              type: "button",
              className: "dshfs-btn",
              onClick: function () {
                setDraft(null);
                store.reset();
              }
            },
            "全部恢复默认"
          ),
          h("span", { className: "dshfs-hint" }, "字体为空即跟随 DSH 内置字体栈；改动即时保存到本机浏览器存储。")
        )
      );
    }

    /* ────────────────────────────── 入口 ────────────────────────────────── */

    function apply(ctx) {
      try {
        ctxRef = ctx;
        installPluginCss();
        captureInitialSizes();
        applyTypography();

        // 服务可能比本插件晚就绪：错峰再校准几次（applyTypography 幂等）。
        [400, 1500, 4000].forEach(function (delay) {
          try {
            window.setTimeout(function () {
              captureInitialSizes();
              applyTypography();
              store.emit();
            }, delay);
          } catch (error) {
            /* 无视 */
          }
        });

        // 官方主题切换会把 --dsh-font-family-* 写回 body 内联样式；我们的 !important 覆写不受影响，
        // 但字号快照会变，且内联令牌要被按回默认——订阅后重新落地一次 + 刷新展示。
        try {
          if (typeof ctx.on === "function") {
            ctx.effect(function () {
              var off = ctx.on("theme/change", function (snapshot) {
                if (snapshot && typeof snapshot === "object") store.snapshot = snapshot;
                applyTypography();
                store.emit();
              });
              return function () {
                try {
                  if (typeof off === "function") off();
                } catch (error) {
                  /* 无视 */
                }
              };
            }, "font-studio: theme listener");
          }
        } catch (error) {
          /* theme 服务不存在也不影响字体写入 */
        }

        // 设置页左侧新增一节「字体」
        ctx.effect(
          function () {
            return ctx.slots.inject(SLOT_NAME, function () {
              return ctx.slots.register(
                {
                  name: SLOT_NAME,
                  id: ENTRY_ID,
                  order: 12,
                  label: function () {
                    return "字体";
                  },
                  inject: function () {
                    readSnapshot();
                    return {};
                  }
                },
                FontStudioSection
              );
            });
          },
          "font-studio: settings section"
        );
      } catch (error) {
        try {
          console.warn("[" + PACKAGE_ID + "] apply 失败（界面不会出现「字体」一节）：", error);
        } catch (ignored) {
          /* 连告警都不能抛 */
        }
      }
    }

    exports.apply = apply;
    exports.inject = ["slots"];

    /** 仅供离线测试驱动（宿主不读这些键）：无 DOM 也能验证清洗与写入逻辑。 */
    exports.__internals = {
      sanitizeStack: sanitizeStack,
      sanitizeFamilyName: sanitizeFamilyName,
      normalizeCustomList: normalizeCustomList,
      addCustomFont: addCustomFont,
      dropCustomFont: dropCustomFont,
      stackForFamily: stackForFamily,
      customFontPatch: customFontPatch,
      maxCustomFonts: MAX_CUSTOM_FONTS,
      clampSize: clampSize,
      applyTypography: applyTypography,
      themeOf: themeOf,
      store: store,
      probeInstalledFamilies: probeInstalledFamilies,
      fetchHostFonts: fetchHostFonts,
      normalizeHostFamilies: normalizeHostFamilies,
      neutralizeOfficialFonts: neutralizeOfficialFonts,
      fontCatalog: FONT_CATALOG,
      hostFontsUrl: HOST_FONTS_URL,
      storageKey: STORAGE_KEY,
      styleId: STYLE_ID,
      pluginStyleId: PLUGIN_STYLE_ID
    };

    return module.exports;
  }
});
