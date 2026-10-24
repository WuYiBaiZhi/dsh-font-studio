/**
 * dsh-font-studio — 宿主半边
 *
 * 两件事：
 *   1. 让本包成为 cordis 树上的一行（客户端 bundle 是靠「Loader 条目里有这个包」被扫出来的，
 *      没有宿主条目，lib/client.js 永远不会被加载）。
 *   2. 在宿主进程里**真的读本机字体**，并把结果挂到一条 HTTP 路由上：
 *      `GET /dsh-font-studio/fonts[?refresh=1]` → `{ ok, families: [{name, file}], count, ... }`
 *      —— 浏览器拿不到 `navigator.queryLocalFonts`，宿主却能读 `C:\Windows\Fonts` 与用户字体目录，
 *      连 .ttc / .otc / super TTC 里每一个字面的家族名都能列出来（见 lib/fonts.js）。
 *
 * 三条纪律：
 *   1. `apply()` 绝不抛错 —— 同步抛错会让该条目 fiber 失败，整份插件从界面上消失。
 *   2. `inject` 不声明任何服务 —— 声明一个永不被 provide 的服务会让 fiber 停在 PENDING。
 *      `webServer` 用惰性获取 + 有界重试（宿主启动顺序不保证）。
 *   3. 不打日志噪音 —— 成功不吭声，只在产物缺失、路由注册失败时告警一次。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { enumerateFonts } from "./fonts.js";

const PACKAGE_ID = "dsh-font-studio";

/** 路由前缀。客户端按 `GET /dsh-font-studio/fonts` 取字体清单。 */
const ROUTE_PREFIX = "/dsh-font-studio";

/** 惰性取服务失败时的重试节奏（宿主各插件按依赖顺序加载，webServer 可能晚一步就绪）。 */
const RETRY_DELAYS_MS = [0, 250, 750, 1500, 3000, 6000];

/**
 * 静态核对客户端产物：只读文件、查关键标志，**不执行**产物。
 * 有问题才说话（成功留白，避免每次启动刷一行无意义日志）。
 */
function auditClientBundle(log) {
  try {
    const bundle = readFileSync(fileURLToPath(new URL("./client.js", import.meta.url)), "utf8");
    const problems = [];
    if (!bundle.includes(`id: "${PACKAGE_ID}"`) && !bundle.includes(`id:"${PACKAGE_ID}"`)) problems.push("bundle id 不匹配");
    if (!bundle.includes("__ModuleLoader__.load")) problems.push("不是模块加载器 bundle");
    if (!bundle.includes("return module.exports")) problems.push("工厂没有交出 exports");
    if (!bundle.includes("settings.section")) problems.push("没有声明目标插槽");
    if (!/exports\.apply\s*=/.test(bundle)) problems.push("没有导出 apply");
    if (problems.length > 0) {
      log(`客户端产物 lib/client.js 检查未通过（设置页不会出现「字体」一节）：${problems.join("；")}`);
    }
  } catch (error) {
    log(`客户端产物 lib/client.js 不可读（设置页不会出现「字体」一节）：${String(error)}`);
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

/**
 * 路由处理器：`/dsh-font-studio/fonts`（GET/HEAD）。
 * 只读、无副作用；`refresh=1` 绕过 10 分钟缓存重新扫盘。
 */
function createFontsHandler(log) {
  return function fontsHandler(req, res) {
    try {
      const method = req.method || "GET";
      if (method !== "GET" && method !== "HEAD") {
        res.statusCode = 405;
        res.setHeader("allow", "GET, HEAD");
        res.end();
        return;
      }
      const raw = String(req.url || "/");
      const queryAt = raw.indexOf("?");
      const pathname = queryAt === -1 ? raw : raw.slice(0, queryAt);
      const search = queryAt === -1 ? "" : raw.slice(queryAt + 1);
      const sub = pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) : pathname;

      if (sub !== "/fonts" && sub !== "/fonts/") {
        sendJson(res, 404, { ok: false, error: "unknown route", route: `${ROUTE_PREFIX}/fonts` });
        return;
      }

      const refresh = /(?:^|&)refresh=1(?:&|$)/.test(search);
      const result = enumerateFonts({ refresh });
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      log(`枚举本机字体失败：${message}`);
      try {
        sendJson(res, 500, { ok: false, error: message });
      } catch {
        /* 连接可能已经断了 */
      }
    }
  };
}

/** 取宿主服务：cordis ctx 的 `get(name)` 与直接属性都试一遍。 */
function lookup(ctx, name) {
  try {
    if (typeof ctx?.get === "function") {
      const viaGet = ctx.get(name);
      if (viaGet) return viaGet;
    }
  } catch {
    /* 服务不存在时 get 可能抛，忽略 */
  }
  try {
    return ctx?.[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * 注册路由；服务还没就绪就按 RETRY_DELAYS_MS 有界重试。
 * 返回 disposer（未注册成功时也返回一个安全的空函数）。
 */
function attachRoute(ctx, log) {
  let disposeRoute = null;
  let timer = null;
  let disposed = false;

  const attempt = (index) => {
    if (disposed || disposeRoute) return;
    const webServer = lookup(ctx, "webServer");
    if (webServer && typeof webServer.register === "function") {
      try {
        const handle = webServer.register({
          kind: "prefix",
          path: ROUTE_PREFIX,
          handler: createFontsHandler(log)
        });
        disposeRoute = typeof handle === "function" ? handle : () => {};
        // 拿到服务立刻预热缓存（首次扫盘几百毫秒，不占用户点按钮的时间）
        try {
          enumerateFonts({ refresh: false });
        } catch {
          /* 预热失败不影响路由 */
        }
        return;
      } catch (error) {
        log(`注册字体路由失败：${error && error.message ? error.message : String(error)}`);
        return;
      }
    }
    const delay = RETRY_DELAYS_MS[index];
    if (delay == null) return;
    timer = setTimeout(() => {
      timer = null;
      attempt(index + 1);
    }, delay);
    if (timer && typeof timer.unref === "function") timer.unref();
  };

  // 首轮同步尝试；同时把清理逻辑挂进 ctx.effect（没有 effect 也不会泄露，disposer 仍可手动调用）
  const attachWithinEffect = () => {
    attempt(0);
    return () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (disposeRoute) {
        try {
          disposeRoute();
        } catch {
          /* 卸载时路由可能已经没了 */
        }
        disposeRoute = null;
      }
    };
  };

  if (typeof ctx?.effect === "function") {
    try {
      ctx.effect(attachWithinEffect, "dsh-font-studio: /fonts route");
      return;
    } catch {
      /* effect 不可用就退回同步 */
    }
  }
  attempt(0);
}

/**
 * @param ctx 宿主 cordis 上下文
 */
export function apply(ctx) {
  try {
    const candidate = ctx?.logger;
    const sink = typeof candidate === "function" ? candidate(PACKAGE_ID) : candidate;
    const log = (message) => {
      try {
        if (sink && typeof sink.warn === "function") sink.warn(`[${PACKAGE_ID}] ${message}`);
        else if (sink && typeof sink.info === "function") sink.info(`[${PACKAGE_ID}] ${message}`);
        else console.warn(`[${PACKAGE_ID}] ${message}`);
      } catch {
        /* 连日志都不能抛 */
      }
    };
    auditClientBundle(log);
    attachRoute(ctx, log);
  } catch {
    /* 宿主半边任何失败都不能让 apply 抛错 */
  }
}

export default { apply };
