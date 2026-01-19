/**
 * @fileoverview 日志中间件
 *
 * 提供全链路的请求日志记录功能，包括：
 * 1. 请求上下文创建 (Request ID 生成)
 * 2. 智能日志过滤 (忽略静态资源和特定端点)
 * 3. 统一错误捕获与响应
 * 4. 详细的调试信息记录
 */

import {
  debug,
  error as logError,
  generateRequestId,
  info,
  logRequestEnd,
} from "../core/logger.ts";
import * as Config from "../config/manager.ts";

/** 模块名称 */
const MODULE = "Middleware";

/**
 * 请求上下文接口
 * 在请求处理生命周期中传递的核心数据
 */
export interface RequestContext {
  /** 唯一请求 ID (用于链路追踪) */
  requestId: string;
  /** 请求开始时间戳 (用于计算耗时) */
  startTime: number;
  /** 原始请求对象 */
  request: Request;
  /** 解析后的 URL 对象 */
  url: URL;
}

/**
 * 创建请求上下文
 * 为每个新请求生成唯一的 ID 和开始时间
 *
 * @param {Request} req - 原始请求对象
 * @returns {RequestContext} 请求上下文
 */
export function createRequestContext(req: Request): RequestContext {
  const requestId = generateRequestId();
  const url = new URL(req.url);

  // 注意：我们移除请求开始时的立即日志，以减少日志噪音
  // 只在请求结束时记录完整的汇总信息
  // logRequestStart(req, requestId);

  return {
    requestId,
    startTime: Date.now(),
    request: req,
    url,
  };
}

/**
 * 判断是否为静态资源请求
 * 基于文件扩展名进行判断
 *
 * @param {string} pathname - 请求路径
 * @returns {boolean} 是否为静态资源
 */
function isStaticResource(pathname: string): boolean {
  const ext = pathname.split(".").pop()?.toLowerCase();
  return !!ext &&
    ["css", "js", "jpg", "jpeg", "png", "gif", "ico", "svg", "woff", "woff2", "ttf", "map"]
      .includes(ext);
}

/**
 * 判断是否为需要忽略的内部端点
 * 例如日志流本身的请求，如果不忽略会导致日志死循环
 *
 * @param {string} pathname - 请求路径
 * @returns {boolean} 是否应忽略
 */
function isIgnoredEndpoint(pathname: string): boolean {
  return pathname === "/api/logs/stream";
}

/**
 * 记录请求完成日志
 *
 * @param {RequestContext} ctx - 请求上下文
 * @param {number} statusCode - HTTP 状态码
 * @param {string} [errorMessage] - 可选的错误消息
 */
export async function completeRequestLog(
  ctx: RequestContext,
  statusCode: number,
  errorMessage?: string,
): Promise<void> {
  const duration = Date.now() - ctx.startTime;
  const pathname = ctx.url.pathname;

  // 1. 忽略日志流本身的请求日志，避免死循环和刷屏
  if (isIgnoredEndpoint(pathname) && statusCode < 400) {
    return;
  }

  // 2. 静态资源过滤策略
  // 仅在发生错误 (>= 400) 时记录静态资源请求
  // 正常成功的静态资源加载（如 CSS/JS）不记录日志，以免淹没核心业务日志
  const isStatic = isStaticResource(pathname);
  if (isStatic && statusCode < 400) {
    return;
  }

  await logRequestEnd(
    ctx.requestId,
    ctx.request.method,
    pathname, // 使用 pathname 而不是完整 url，更简洁
    statusCode,
    duration,
    errorMessage,
  );
}

/**
 * 异步处理函数类型定义
 */
export type Handler = (
  req: Request,
  ctx: RequestContext,
) => Promise<Response>;

/**
 * 日志中间件高阶函数
 * 包装原始处理函数，添加自动日志记录和错误处理能力
 *
 * @param {Handler} handler - 原始业务处理函数
 * @returns {Function} 包装后的请求处理函数
 * \
 * @example
 * ```typescript
 * const handleChat = withLogging(async (req, ctx) => {
 *   // 业务逻辑
 *   return new Response("OK");
 * });
 * ```
 */
export function withLogging(handler: Handler): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    // 如果启用了详细日志模式，记录请求头信息以便调试
    if (Config.ENABLE_REQUEST_LOGGING && Config.VERBOSE_LOGGING) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        const lowerKey = k.toLowerCase();
        if (lowerKey === "authorization" || lowerKey.includes("key") || lowerKey.includes("token") || lowerKey === "cookie") {
          headers[k] = "******";
        } else {
          headers[k] = v;
        }
      });
      debug(MODULE, `Request Headers (${req.method} ${req.url}): ${JSON.stringify(headers)}`);
    }

    const ctx = createRequestContext(req);

    try {
      const response = await handler(req, ctx);

      // 记录成功响应日志
      await completeRequestLog(ctx, response.status);

      return response;
    } catch (err) {
      // 统一错误捕获
      const errorMessage = err instanceof Error ? err.message : String(err);

      // 记录错误日志
      logError(MODULE, `请求处理错误: ${errorMessage}`);
      await completeRequestLog(ctx, 500, errorMessage);

      // 返回统一的 JSON 错误响应
      return new Response(
        JSON.stringify({
          error: {
            message: errorMessage,
            type: "server_error",
          },
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  };
}

/**
 * 记录路由决策信息
 *
 * @param {string} provider - 选定的服务提供商
 * @param {string} endpoint - 目标端点
 */
export function logRouting(provider: string, endpoint: string): void {
  info(MODULE, `路由到 ${provider} (${endpoint})`);
}

/**
 * 记录认证失败信息
 *
 * @param {string} message - 错误内容
 */
export function logAuthFailure(message: string): void {
  logError(MODULE, message);
}

/**
 * 记录处理程序内部错误
 *
 * @param {string} provider - 相关提供商
 * @param {string} message - 错误详情
 */
export function logHandlerError(provider: string, message: string): void {
  logError(MODULE, `请求处理错误 (${provider}): ${message}`);
}

// 导出别名
export type { RequestContext as LoggingContext };
