# dsh-font-studio · DSH 字体工坊

给 DeepSeek Harness 换字体的第三方插件：在「设置」里多出一节 **字体**，挑一个字体栈或手写自己的，
正文、代码字体立即生效并记住；顺带能调正文 / 代码 / 终端字号。

> 一句话：官方只开放了**字号**写入，字体族靠 CSS 令牌覆写——本插件两件事都做了；
> 而「本机装了哪些字体」由**宿主进程**真读字体文件来回答，`.ttc` / 超级 TTC 里的每个字面都在。

## 功能

- **正文 / 代码两组字体**，各带预设画廊（苹方、微软雅黑、思源黑体、霞鹜文楷、宋体阅读、更纱黑体、
  JetBrains Mono、Cascadia Code、Fira Code、SF Mono、Consolas……），卡片用该字体渲染 `Aa 字体 123` 实时预览。
- **自定义字体栈**：直接手写 `"LXGW WenKai", "Microsoft YaHei", serif`，回车或点「应用」即生效。
- **「我的字体」快捷清单**：预设卡片墙的最后一张是**「＋ 添加字体」卡片**——和预设卡片同一款式（虚线边框区分），
  点开就在卡片墙下面出现两个输入框（名字：中文名、英文名、字体文件里的 family 名都认；别名可选），
  点「添加并应用」就套到当前角色。加过的字体**以卡片形式排在卡片墙里、「＋ 添加字体」卡片之前**：
  用的就是预设卡片那套 `dshfs-card` 样式（同尺寸、同圆角、同选中竖条），名字一行 + 「Aa 字体 123」样品一行、
  样品用它自己的字体渲染，右上角 `×` 移除；点卡片一键切换，最多记 24 条，存在同一个 `localStorage` 键里。
- **扫描本机字体（三级通道，按可靠性排序）**：
  1. **宿主扫盘**（首选）：宿主半边注册 `GET /dsh-font-studio/fonts`，在 Node 里直接解析
     `C:\Windows\Fonts` 与用户字体目录下的 `.ttf/.otf/.ttc/.otc`，读 `name` 表拿家族名。
     **`.ttc` / super TTC 是容器，里面每个字面都单独列出**（比如 `Sarasa-SuperTTC.ttc` 里十几种
     更纱黑体），中英文名各取一个（中文名当主名、英文名当别名一起拼进字体栈，DirectWrite 两种都认）。
     一次扫描约 100ms，结果缓存 10 分钟，「重新扫盘」按钮可强制重读。
  2. `navigator.queryLocalFonts()`（若环境支持）：浏览器授权后拿全量字体族。
  3. **渲染探测**（兜底）：拿内置 90 个候选家族逐个用 `canvas.measureText` 量字宽，与「一定不存在的
     家族」比对，宽度变了就是本机真的有这套字形。只覆盖目录内的字体。
- **字号滑条**：正文 10–22、代码 10–16、终端 10–20（与官方 `FONT_SIZE_SPECS` 一致）。
- **即时保存**：状态存在浏览器 `localStorage`（键 `dsh-font-studio:v1`），重启后自动应用。
- **全部恢复默认**：清掉覆写，并把官方字号还原成插件接管前的快照值（「我的字体」清单保留，不跟着清）。

## 安装

先取到本地：

```
git clone https://github.com/WuYiBaiZhi/dsh-font-studio
```

插件是纯 JS、无依赖、无需构建。把整个目录放进 profile 的 `node_modules`，再把包名加进
profile 的 `package.json` 两个地方：

```jsonc
// C:\Users\<你>\.dsh\profiles\desktop\package.json
{
  "dependencies": { "dsh-font-studio": "link:<克隆到的目录>" },
  "dsh": { "profile": { "bundles": [
    // …已有的
    "dsh-font-studio"
  ] } }
}
```

或者，如果环境里装了 `dsh-super-injector`，直接：

```
dev_install_package({ dir: "<克隆到的目录>", profile: "desktop" })
```

注意：`profile` 要用**正在运行的那个**（缺省值是 `web`，装错位置页面不会有反应；用 `dsh web` 启动的常见是 `desktop`）。

装上后**刷新一次页面**（客户端模块表在页面加载时拉取），打开 设置 → 字体。

## 原理

| 目标 | 手段 | 为什么 |
| --- | --- | --- |
| 正文 / 代码字体族 | `<style>` 里 `body{--dsw-font-family: <栈> !important}`、`--dsw-font-family-brand`、`--ds-font-family-code`、`--dsw-font-mono` | 官方 theme 服务只暴露 `getTheme/setTheme/setFontSize/register/overrideTokens`，**没有** `setFontFamily`；而 `ThemePresenter` 把 `--dsh-font-family-*` 写在 body 内联样式上，只有 `!important` 的作者样式能压过它 |
| 字号 | `ctx.theme.setFontSize(role, px)` | 走官方设置，持久化由官方负责，UI 各处一致 |
| 字号（服务不在时） | `body{--dsh-content-font-size: Npx !important}` 兜底 | 服务可能比插件晚就绪或压根没有；`applyTypography()` 幂等，错峰重试会补上 |
| 本机字体清单 | 宿主 `ctx.webServer.register({ kind:"prefix", path:"/dsh-font-studio" })` + 客户端同源 `fetch` | 浏览器里没有字体枚举接口，但宿主是 Node，能直接读字体文件、解开 TTC 容器；同源路由是生态里 `dsh-pet` 等插件的既有做法 |
| 持久化 | `localStorage` | 不需要宿主端存储服务，插件纯客户端即可 |

三条安全线：

1. **fail-open**：拿不到主题服务、localStorage 不可用、插槽不存在、字体路由没注册——一律降级，绝不抛错，
   官方界面保持原样；字体路由注册失败还有 0/250/750/1500/3000/6000ms 的错峰重试（宿主各插件加载顺序不保证）。
2. **不写别人的 DOM**：只挂两个自持 `<style>`（`#dsh-font-studio-typography` / `#dsh-font-studio-plugin-css`），
   卸载时按 `data-plugin` 精确移除。
3. **字体栈先清洗再拼 CSS**：剥掉 `;{}<>`、`!important`、换行与超长内容，杜绝把输入拼成样式注入。

## 接口

`GET /dsh-font-studio/fonts`（`GET`/`HEAD`，`?refresh=1` 绕过 10 分钟缓存）：

```jsonc
{
  "ok": true,
  "families": [{ "name": "更纱黑体 SC", "alias": "Sarasa Gothic SC", "file": "…\\Sarasa-SuperTTC.ttc" }],
  "count": 42,
  "files": 57,
  "dirs": ["C:\\WINDOWS\\Fonts", "C:\\Users\\<你>\\AppData\\Local\\Microsoft\\Windows\\Fonts"],
  "scannedAt": 1700000000000,
  "cached": false
}
```

> 数值仅示意；`count` / `files` 取决于本机装了多少字体。

## 已知边界

- **终端字号**只走官方服务（它没有能兜底的 CSS 变量通路），没有主题服务时不显示这一行。
- 官方设置页自带的「字体」组（`settings.general.item` 里的正文/代码/终端字体输入框）依然在。
  你在那边改字体，本插件的 `!important` 覆写会赢；想交还官方，本插件里选「系统默认」即可。
- 若同时装了别的改字体的插件，两者都写 `body` 令牌，后挂的赢——同时只留一个。
- **宿主扫盘只读字体目录**：用「临时安装/未落盘」方式加载的字体（例如某些软件的私有字体缓存）扫不到，
  手写家族名仍然有效。
- 家族名取 `name` 表的排版家族名（nameID 16，退回 nameID 1），所以 `微软雅黑 Light` 这类字重会归到
  `微软雅黑` 下——CSS 本来就该按家族选字体、按字重选字形。

## 开发

```bash
node --check lib/client.js      # 语法
node test/smoke.mjs             # 离线冒烟：假 DOM 跑通 bundle 契约/清洗/探测/宿主路由/令牌/字号双通路/恢复默认
node test/fonts.test.mjs        # 宿主字体解析：现场拼 sfnt / TTC 二进制，验证多字面、别名、破损容错
```

`lib/client.js` 里的 `exports.__internals` 只给测试用，宿主不读。

| 文件 | 作用 |
| --- | --- |
| `lib/client.js` | 客户端半边：设置页那一节、令牌覆写、字号、localStorage |
| `lib/index.js` | 宿主半边：让包成为 cordis 树一行 + 注册 `/dsh-font-studio/fonts` 路由 |
| `lib/fonts.js` | 宿主侧字体枚举：扫目录、解析 sfnt/TTC `name` 表、10 分钟缓存 |

## License

MIT
