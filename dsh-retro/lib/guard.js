// 并发与安全守卫：跨进程写锁、内容哈希、笔记读取范围、写前备份。
// 说明：GET /retro/api 对本机进程无鉴权，因此写能力必须默认关闭，
// 所有写入都在 CLI 或显式开关下发生，并统一经过本模块的路径与锁校验。
import path from "node:path";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import { open as openFile, readFile, unlink } from "node:fs/promises";
import { safeJoin } from "./util.js";

/** 带错误码的插件异常：HTTP 层据此映射状态码，命令层直接展示 message。 */
export class RetroError extends Error {
  constructor(code, message, { status = 400, hint = null, retryable = false } = {}) {
    super(message);
    this.name = "RetroError";
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.retryable = retryable;
  }
}

/** 面板预览笔记时的默认作用域前缀（插件自有产物目录）。 */
export const NOTE_SCOPE_PREFIX = "Index/06_Retro/";

/** 计算文件内容哈希（取 SHA-256 前 16 位十六进制），用于乐观锁比对。 */
export function computeContentHash(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex").slice(0, 16);
}

/** 写入前为已存在文件生成 .bak 快照；目标不存在时返回 null。 */
export function createBackupSnapshot(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  const backup = `${filePath}.bak`;
  copyFileSync(filePath, backup);
  return backup;
}

/**
 * 校验笔记读取范围：先过 safeJoin（拒绝越界与受保护目录），
 * 再按默认作用域限制在 Index/06_Retro/ 下，避免 HTTP 接口泄露整库正文。
 * @param {object} cfg - 合并后的配置。
 * @param {string} relPath - 知识库相对路径。
 * @returns {string} 绝对路径。
 */
export function verifyNoteScope(cfg, relPath) {
  let abs;
  try {
    abs = safeJoin(cfg.vaultPath, relPath);
  } catch (error) {
    throw new RetroError("RETRO_PATH_OUT_OF_BOUNDS", String(error?.message ?? error), {
      status: 403,
      hint: "目标路径不在知识库白名单内，请检查目录配置"
    });
  }
  const normalized = String(relPath).split(/[\\/]+/).join("/");
  if (!normalized.startsWith(NOTE_SCOPE_PREFIX) && cfg.security?.exposeVaultNotes !== true) {
    throw new RetroError("RETRO_NOTE_SCOPE_DENIED", "默认安全策略仅允许预览 Index/06_Retro/ 下的笔记", {
      status: 403,
      hint: "如需预览知识库其他目录，请运行 /retro config security.exposeVaultNotes true"
    });
  }
  return abs;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 进程内排队链：同一进程的多次写入严格串行，避免 await 交错破坏 JSON。
let inProcessQueue = Promise.resolve();

/**
 * 在跨进程写锁内执行任务：进程内串行 + store.lock 文件锁（wx 原子创建）。
 * 锁持有者进程已退出或超时视为僵死锁并回收。
 * @param {string} retroHome - $DSH_HOME/retro 目录。
 * @param {() => Promise<any>} task - 临界区任务。
 * @param {{ timeoutMs?: number, staleMs?: number }} options - 等锁超时与僵死锁阈值。
 */
export async function withStoreLock(retroHome, task, { timeoutMs = 2500, staleMs = 15000 } = {}) {
  const lockPath = path.join(retroHome, "store.lock");
  const run = inProcessQueue.then(async () => {
    const deadline = Date.now() + timeoutMs;
    let handle = null;
    while (Date.now() <= deadline) {
      try {
        handle = await openFile(lockPath, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), "utf8");
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (await isStaleLock(lockPath, staleMs)) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
        await sleep(50);
      }
    }
    if (!handle) {
      throw new RetroError("RETRO_LOCK_BUSY", "状态库正被其他 DSH 进程写入，请稍后重试", {
        status: 423,
        hint: "等待其他写入完成后重试",
        retryable: true
      });
    }
    try {
      return await task();
    } finally {
      await handle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
  });
  // 队列尾吞掉异常，避免一次失败阻塞后续请求。
  inProcessQueue = run.catch(() => {});
  return run;
}

/** 判断锁文件是否为僵死锁：损坏、持有进程不存在或持有超时。 */
async function isStaleLock(lockPath, staleMs) {
  try {
    const raw = await readFile(lockPath, "utf8");
    const info = JSON.parse(raw);
    if (!Number.isSafeInteger(info?.pid)) return true;
    try {
      process.kill(info.pid, 0);
    } catch (error) {
      // ESRCH 表示进程已不存在；EPERM 表示进程存在但无权限，仍视为存活。
      if (error.code === "ESRCH") return true;
    }
    return Date.now() - Number(info.acquiredAt ?? 0) > staleMs;
  } catch {
    // 锁文件正在写入或被截断：交给下一轮重试。
    return false;
  }
}
