// 面板 HTTP 网关：只读快照与详情路由，统一错误契约与缓存语义。
// 写接口在后续阶段接入且默认关闭；读路由永远可用。
// 快照与详情拆成两个注册函数，便于按需挂载，也避免单次注册塞入多条路由。
import { createQueryService } from "./query.js";
import { RetroError, computeContentHash, withStoreLock } from "./guard.js";
import { createActionService } from "./actions.js";
import { readStaging } from "./settler.js";

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

// ---------------------------------------------------------------------------
// 受控写接口：POST /retro/action
// 默认关闭（security.enableWriteApi=false）；开启后也仅放行白名单动作，
// 且复用 lib/actions.js 与 CLI 完全相同的实现，避免两条入口行为漂移。
// ---------------------------------------------------------------------------

/** P0 阶段允许通过 HTTP 触发的动作白名单。 */
const WRITE_ACTIONS = new Set(["card.review"]);

/** 读取并解析 JSON 请求体，限制体积避免内存放大。 */
function readJsonBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    if (typeof req.on !== "function") {
      reject(new RetroError("RETRO_BAD_REQUEST", "请求体不可读", { status: 400 }));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new RetroError("RETRO_BAD_REQUEST", "请求体过大（上限 1MB）", { status: 400 }));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new RetroError("RETRO_BAD_REQUEST", "请求体不是合法 JSON", { status: 400 }));
      }
    });
    req.on("error", (error) => reject(error));
  });
}

/** 写出统一 JSON 响应（写接口不接受 HEAD，因此直接 end）。 */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

/**
 * 注册受控写路由 POST /retro/action。
 * @param {object} ctx - 宿主上下文。
 * @param {import("./store.js").RetroStore} store
 * @param {object} cfg - 合并后的配置（读取 security.*）。
 * @param {{ lockDir?: string }} options - 锁目录，默认使用 store.dir，便于测试注入。
 */
export function registerActionApi(ctx, store, cfg = {}, { lockDir = store.dir } = {}) {
  const service = createActionService({ store, cfg });
  return ctx.inject(["webServer"], (childCtx) => {
    childCtx.effect(() => childCtx.webServer.register({
      kind: "exact",
      path: "/retro/action",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405, { allow: "POST" });
          res.end();
          return;
        }
        try {
          // 1) 写能力开关：未显式开启时一律拒绝，且不泄露更多信息。
          if (cfg.security?.enableWriteApi !== true) {
            throw new RetroError("RETRO_WRITE_DISABLED", "面板写接口未开启", {
              status: 403,
              hint: "请运行 /retro config security.enableWriteApi true 后重启面板"
            });
          }
          const body = await readJsonBody(req);
          // 2) 动作白名单：P0 仅支持卡片审阅。
          if (!WRITE_ACTIONS.has(body.action)) {
            throw new RetroError("RETRO_ACTION_NOT_ALLOWED", `不支持的写动作：${String(body.action)}`, {
              status: 400,
              hint: "P0 仅支持 card.review"
            });
          }
          if (typeof body.id !== "string" || !body.id) {
            throw new RetroError("RETRO_BAD_REQUEST", "缺少卡片 id", { status: 400 });
          }
          const subAction = body.subAction ?? "keep";
          if (!["keep", "discard", "edit"].includes(subAction)) {
            throw new RetroError("RETRO_BAD_REQUEST", `未知子动作：${String(subAction)}`, { status: 400 });
          }
          // 3) 乐观锁：客户端持有哈希时必须与磁盘一致，避免覆盖 Obsidian 里的手改。
          const card = store.getCard(body.id);
          if (!card) throw new RetroError("RETRO_ENTITY_NOT_FOUND", `卡片不存在：${body.id}`, { status: 404 });
          if (body.expectedHash && card.stagingPath) {
            let currentHash = null;
            try { currentHash = computeContentHash(readStaging(cfg, card.stagingPath)); } catch { currentHash = null; }
            if (currentHash !== null && currentHash !== body.expectedHash) {
              throw new RetroError("RETRO_CONFLICT_HASH", "暂存文件已被外部修改", {
                status: 409,
                hint: "请刷新详情后重试",
                retryable: true
              });
            }
          }
          // 4) 串行化写入：进程内队列 + 跨进程锁，与命令路径共用。
          const result = await withStoreLock(lockDir, async () => service.reviewCard({
            id: body.id,
            subAction,
            targetDir: typeof body.targetDir === "string" ? body.targetDir : undefined,
            instruction: typeof body.instruction === "string" ? body.instruction : null,
            actor: "web:user"
          }));
          sendJson(res, 200, {
            ok: true,
            rev: store.getRev(),
            action: body.action,
            id: body.id,
            result: { status: result.status ?? null, message: result.message }
          });
        } catch (error) {
          const serialized = serializeError(error);
          sendJson(res, serialized.status, JSON.parse(serialized.body));
        }
      }
    }), "retro.api:/retro/action");
  });
}

// ---------------------------------------------------------------------------
// 变更推送：GET /retro/events（SSE）
// 宿主可能装配 gzip 中间件，因此显式声明 identity 编码并首帧立即下发；
// 客户端若 15 秒收不到任何字节即降级为 sinceRev 轮询。
// ---------------------------------------------------------------------------

/**
 * 注册变更事件流 GET /retro/events。
 * 只推送轻量 { rev } 帧，客户端据此按需拉取增量快照。
 */
export function registerEventsApi(ctx, store, cfg = {}, { pollMs = 1000, heartbeatMs = 25000 } = {}) {
  return ctx.inject(["webServer"], (childCtx) => {
    childCtx.effect(() => childCtx.webServer.register({
      kind: "exact",
      path: "/retro/events",
      handler: async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { allow: "GET, HEAD" });
          res.end();
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          // 显式禁用压缩：否则 SSE 会被中间件缓冲，表现为"连上但不推送"。
          "content-encoding": "identity",
          "x-accel-buffering": "no"
        });
        let closed = false;
        let lastRev = -1;
        let pollTimer = null;
        let beatTimer = null;
        const write = (payload) => {
          if (closed) return;
          try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { closed = true; }
        };
        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (pollTimer !== null) clearInterval(pollTimer);
          if (beatTimer !== null) clearInterval(beatTimer);
          try { res.end(); } catch { /* 连接已断开 */ }
        };
        if (req.method === "HEAD") { cleanup(); return; }
        // 首帧立即下发当前版本，客户端据此确认链路未被缓冲。
        lastRev = store.getRev();
        write({ rev: lastRev, topic: "hello" });
        pollTimer = setInterval(() => {
          const rev = store.getRev();
          if (rev !== lastRev) {
            lastRev = rev;
            write({ rev, topic: "change", ts: Date.now() });
          }
        }, pollMs);
        beatTimer = setInterval(() => {
          if (closed) return;
          try { res.write(": heartbeat\n\n"); } catch { cleanup(); }
        }, heartbeatMs);
        const onClose = () => cleanup();
        req.on?.("close", onClose);
        req.on?.("aborted", onClose);
        res.on?.("close", onClose);
        // 处理器保持到连接关闭；结束时确保定时器被清理。
        await new Promise((resolve) => {
          const done = () => { cleanup(); resolve(); };
          req.once?.("close", done);
          res.once?.("close", done);
        });
      }
    }), "retro.api:/retro/events");
  });
}
