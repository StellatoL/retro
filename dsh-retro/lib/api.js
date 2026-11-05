// 面板 HTTP 网关：只读快照与详情路由，统一错误契约与缓存语义。
// 写接口在后续阶段接入且默认关闭；读路由永远可用。
// 快照与详情拆成两个注册函数，便于按需挂载，也避免单次注册塞入多条路由。
import { createQueryService } from "./query.js";
import { RetroError } from "./guard.js";

export { renderPanelApi } from "./query.js";

/** 解析请求 URL 的查询串；无法解析时返回空对象（HEAD/测试替身不带 url）。 */
function parseQuery(req) {
  const raw = typeof req?.url === "string" ? req.url : "";
  const at = raw.indexOf("?");
  if (at < 0) return {};
  const params = {};
  for (const [key, value] of new URLSearchParams(raw.slice(at + 1))) params[key] = value;
  return params;
}

/** 把异常序列化为统一错误契约 { ok:false, error:{ code, message, hint, retryable } }。 */
function serializeError(error) {
  const known = error instanceof RetroError ? error : null;
  return {
    status: known?.status ?? 500,
    body: JSON.stringify({
      ok: false,
      error: {
        code: known?.code ?? "RETRO_INTERNAL",
        message: String(error?.message ?? error),
        hint: known?.hint ?? null,
        retryable: known?.retryable ?? false
      }
    })
  };
}

/** 生成只读路由的处理器：方法校验 -> 查询解析 -> 统一错误序列化。 */
function makeHandler(handle) {
  return async (req, res) => {
    // 只读路由只接受 GET/HEAD；其他方法明确 405 并给出 Allow。
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    let status = 200;
    let body;
    try {
      body = JSON.stringify(handle(parseQuery(req)));
    } catch (error) {
      const serialized = serializeError(error);
      status = serialized.status;
      body = serialized.body;
    }
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}

/** 注册一条精确只读路由，返回可选依赖的注入实例（由插件生命周期释放）。 */
function registerReadRoute(ctx, routePath, store, cfg, pick) {
  const service = createQueryService({ store, cfg });
  return ctx.inject(["webServer"], (childCtx) => {
    childCtx.effect(
      () => childCtx.webServer.register({ kind: "exact", path: routePath, handler: makeHandler(pick(service)) }),
      `retro.api:${routePath}`
    );
  });
}

/** 注册面板快照路由 GET /retro/api（0.5.0 兼容，带参数时追加 rev/page）。 */
export function registerPanelApi(ctx, store, cfg = {}) {
  return registerReadRoute(ctx, "/retro/api", store, cfg, (service) => (params) => service.getSnapshot(params));
}

/** 注册实体详情路由 GET /retro/detail?type=&id=（卡片 / 提案 / 条目 / 白名单笔记）。 */
export function registerDetailApi(ctx, store, cfg = {}) {
  return registerReadRoute(ctx, "/retro/detail", store, cfg, (service) => (params) => service.getEntityDetail(params));
}
