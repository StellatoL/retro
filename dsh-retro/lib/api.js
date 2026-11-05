// 面板 HTTP 网关：只读快照与详情路由，统一错误契约与缓存语义。
// 写接口在后续阶段接入且默认关闭；读路由永远可用。
// 快照与详情拆成两个注册函数，便于按需挂载，也避免单次注册塞入多条路由。
import { createQueryService } from "./query.js";
import { RetroError, computeContentHash, withStoreLock } from "./guard.js";
import { createActionService } from "./actions.js";
import { readStaging } from "./settler.js";
import { saveConfig as persistConfig, loadConfig, listWorkspaces, retroDir } from "./config.js";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

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

/** P0/P1/P2 阶段允许通过 HTTP 触发的动作白名单（工作区切换会改变写入目标，同样需开启写接口）。 */
const WRITE_ACTIONS = new Set(["card.review", "card.patch", "proposal.adopt", "workspace.switch"]);

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

  /** 乐观锁校验：客户端持有的哈希必须与暂存文件当前内容一致。 */
  const ensureHashMatches = (stagingPath, expectedHash) => {
    let currentHash = null;
    try { currentHash = computeContentHash(readStaging(cfg, stagingPath)); } catch { currentHash = null; }
    if (currentHash !== null && currentHash !== expectedHash) {
      throw new RetroError("RETRO_CONFLICT_HASH", "暂存文件已被外部修改", {
        status: 409,
        hint: "请刷新详情后重试",
        retryable: true
      });
    }
  };

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
          if (!WRITE_ACTIONS.has(body.action)) {
            throw new RetroError("RETRO_ACTION_NOT_ALLOWED", `不支持的写动作：${String(body.action)}`, {
              status: 400,
              hint: "可用：card.review / card.patch / proposal.adopt"
            });
          }

          if (body.action === "workspace.switch") {
            // 只切换当前工作区，不触碰 security.* 等安全开关。
            if (typeof body.id !== "string" || !body.id) {
              throw new RetroError("RETRO_BAD_REQUEST", "缺少工作区 id", { status: 400 });
            }
            if (!listWorkspaces(cfg).some((item) => item.id === body.id)) {
              throw new RetroError("RETRO_ENTITY_NOT_FOUND", `工作区不存在：${body.id}`, { status: 404 });
            }
            await withStoreLock(lockDir, async () => {
              persistConfig({ activeWorkspace: body.id });
              // 原位更新配置对象，让后续请求与命令立即读到新路径。
              Object.assign(cfg, loadConfig(cfg));
            });
            sendJson(res, 200, {
              ok: true,
              rev: store.getRev(),
              action: body.action,
              result: { activeWorkspace: cfg.activeWorkspace, vaultPath: cfg.vaultPath, blogPath: cfg.blogPath }
            });
            return;
          }

          if (body.action === "proposal.adopt") {
            // 批量采纳：ids 数组或 "all"（后者按相似度去重，每组只采纳代表）。
            const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string" && id) : undefined;
            if (!ids?.length && body.all !== true) {
              throw new RetroError("RETRO_BAD_REQUEST", "需要 ids 数组或 all:true", { status: 400 });
            }
            const result = await withStoreLock(lockDir, async () => service.adopt({
              ids,
              target: body.all === true ? "all" : undefined,
              actor: "web:user"
            }));
            sendJson(res, result.ok ? 200 : 400, {
              ok: result.ok,
              rev: store.getRev(),
              action: body.action,
              result: { adopted: result.adopted, skipped: result.skipped, message: result.message }
            });
            return;
          }

          if (typeof body.id !== "string" || !body.id) {
            throw new RetroError("RETRO_BAD_REQUEST", "缺少卡片 id", { status: 400 });
          }

          if (body.action === "card.patch") {
            // 内联编辑：只写暂存区，保留用户手写章节；同样受乐观锁保护。
            const card = store.getCard(body.id);
            if (!card) throw new RetroError("RETRO_ENTITY_NOT_FOUND", `卡片不存在：${body.id}`, { status: 404 });
            if (body.expectedHash && card.stagingPath) ensureHashMatches(card.stagingPath, body.expectedHash);
            const result = await withStoreLock(lockDir, async () => service.patchCard({
              id: body.id,
              sections: body.sections && typeof body.sections === "object" ? body.sections : {},
              answers: Array.isArray(body.answers) ? body.answers : [],
              actor: "web:user"
            }));
            sendJson(res, 200, {
              ok: true,
              rev: store.getRev(),
              action: body.action,
              id: body.id,
              result: { message: result.message, contentHash: result.contentHash }
            });
            return;
          }

          const subAction = body.subAction ?? "keep";
          if (!["keep", "discard", "edit"].includes(subAction)) {
            throw new RetroError("RETRO_BAD_REQUEST", `未知子动作：${String(subAction)}`, { status: 400 });
          }
          // 乐观锁：客户端持有哈希时必须与磁盘一致，避免覆盖 Obsidian 里的手改。
          const card = store.getCard(body.id);
          if (!card) throw new RetroError("RETRO_ENTITY_NOT_FOUND", `卡片不存在：${body.id}`, { status: 404 });
          if (body.expectedHash && card.stagingPath) ensureHashMatches(card.stagingPath, body.expectedHash);
          // 串行化写入：进程内队列 + 跨进程锁，与命令路径共用。
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
// 客户端自诊断：浏览器端把装载/渲染错误上报到宿主日志。
// 该路由不写业务数据，只追加一行诊断，因此不受写接口开关限制。
// ---------------------------------------------------------------------------

/**
 * 注册客户端诊断上报路由。
 * @param {object} ctx - 宿主上下文。
 * @param {{ retroHome?: string }} options - 日志目录，默认 $DSH_HOME/retro。
 */
export function registerClientDiagnosticsApi(ctx, cfg = {}, { retroHome = retroDir() } = {}) {
  const logPath = path.join(retroHome, "client-diag.log");
  const append = async (line) => {
    try {
      await mkdir(retroHome, { recursive: true });
      await appendFile(logPath, `${line}\n`, "utf8");
    } catch { /* 诊断写入失败不影响主流程 */ }
  };
  return ctx.inject(["webServer"], (childCtx) => {
    childCtx.effect(() => childCtx.webServer.register({
      kind: "exact",
      path: "/retro/client-error",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405, { allow: "POST" });
          res.end();
          return;
        }
        try {
          const body = await readJsonBody(req, 64 * 1024);
          const entry = {
            at: new Date().toISOString(),
            phase: String(body.phase ?? "unknown").slice(0, 40),
            message: String(body.message ?? "").slice(0, 500),
            stack: String(body.stack ?? "").slice(0, 2000),
            ua: String(req.headers?.["user-agent"] ?? "").slice(0, 200)
          };
          await append(JSON.stringify(entry));
          sendJson(res, 200, { ok: true });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { code: "RETRO_BAD_REQUEST", message: String(error?.message ?? error) } });
        }
      }
    }), "retro.api:/retro/client-error");
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
