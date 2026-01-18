/**
 * 应用入口组装
 *
 * 负责创建和配置 HTTP 服务器，注册所有路由。
 * 核心职责：
 * 1. 路由分发 (Router)：将请求分发给对应的 Handler。
 * 2. 中间件集成：集成日志 (Logging)、CORS、鉴权 (Auth) 等中间件。
 * 3. 管理 API：提供系统配置、密钥池管理、仪表盘统计等管理接口。
 * 4. 静态资源服务：服务前端 SPA 页面和静态资源。
 */

import { handleChatCompletions } from "./handlers/chat.ts";
import { handleImagesGenerations } from "./handlers/images.ts";
import { handleImagesEdits } from "./handlers/edits.ts";
import { handleImagesBlend } from "./handlers/blend.ts";
import { addLogStream, getRecentLogs, info, type LogEntry, LogLevel, warn } from "./core/logger.ts";
import { type RequestContext, withLogging } from "./middleware/logging.ts";
import * as Config from "./config/manager.ts";
import {
  getKeyPool,
  getRuntimeConfig,
  replaceRuntimeConfig,
  type ProviderTaskDefaults,
  type RuntimeConfig,
  type RuntimeProviderConfig,
  setProviderEnabled,
  setProviderTaskDefaults,
  type SystemConfig,
  updateKeyPool,
} from "./config/manager.ts";
import { providerRegistry } from "./providers/registry.ts";
console.log("Loading app.ts...");
import { aiChatService } from "./core/ai-chat.ts";
import type { ProviderName } from "./providers/base.ts";

// 调试日志：确保 aiChatService 已加载
console.log("[App] aiChatService loaded:", !!aiChatService);

import denoConfig from "../deno.json" with { type: "json" };

function isProviderName(name: string): name is ProviderName {
  return providerRegistry.getNames().includes(name as ProviderName);
}

// CORS 响应头配置
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

// 密钥池更新请求载荷定义
interface KeyPoolUpdatePayload {
  provider: string;
  action: "add" | "batch_add" | "update" | "delete";
  keyItem?: { key: string; name?: string; [key: string]: unknown };
  id?: string;
  keys?: string;
  format?: "csv" | "text" | "auto";
}

// 运行时配置更新请求载荷定义
interface RuntimeConfigUpdatePayload {
  system?: Partial<SystemConfig>;
  providers?: Record<string, Partial<RuntimeProviderConfig>>;
  provider?: string;
  task?: string;
  defaults?: Record<string, unknown>;
  enabled?: boolean;
}

/**
 * 鉴权中间件
 *
 * 验证 Authorization Header 是否包含有效的 Global Access Key。
 * 仅当系统配置了 GLOBAL_ACCESS_KEY 时才生效。
 */
function checkAuth(req: Request): boolean {
  if (!Config.GLOBAL_ACCESS_KEY) return true;
  const auth = req.headers.get("Authorization");
  if (!auth) return false;
  const [type, token] = auth.split(" ");
  if (type !== "Bearer") return false;
  return token === Config.GLOBAL_ACCESS_KEY;
}

/** 健康检查响应 */
function handleHealthCheck(): Response {
  return new Response(
    JSON.stringify({
      status: "ok",
      service: "img-router",
      endpoints: ["/v1/chat/completions", "/v1/images/generations", "/v1/images/edits"],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/** CORS 预检响应 */
function handleCorsOptions(): Response {
  return new Response(null, {
    headers: corsHeaders,
  });
}

/** 404 响应 */
function handleNotFound(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

/** 405 响应 */
function handleMethodNotAllowed(method: string): Response {
  warn("HTTP", `不支持 ${method}`);
  return new Response("Method Not Allowed", { status: 405 });
}

/**
 * 内部路由处理函数（带日志上下文）
 *
 * 这是实际的路由逻辑，由 withLogging 中间件包装。
 *
 * 路由表：
 * - `/health`: 健康检查
 * - `/`: 系统信息
 * - `/v1/*`: OpenAI 兼容 API (Chat, Images)
 * - `/api/*`: 管理 API (Config, Key Pool, Logs, Dashboard)
 * - `/admin`, `/ui`, ...: 前端 SPA 页面
 * - `/css/*`, `/js/*`: 静态资源
 */
async function routeRequest(req: Request, ctx: RequestContext): Promise<Response> {
  const { pathname } = ctx.url;
  const { method } = req;

  // info("DEBUG", `Request: ${method} ${pathname}`);

  // 健康检查端点（允许 GET）
  if (pathname === "/health" && method === "GET") {
    if (!Config.ENABLE_HEALTH_CHECK) {
      return handleNotFound();
    }
    return handleHealthCheck();
  }

  // 静态页面（SPA 路由）
  // 所有前端路由都返回 index.html，由前端 Router 处理页面显示
  const spaRoutes = ["/admin", "/setting", "/channel", "/keys", "/index", "/ui", "/", "/update", "/ai-chat"];
  const spaPath = (pathname.length > 1 && pathname.endsWith("/"))
    ? pathname.slice(0, -1)
    : pathname;
  if (spaRoutes.includes(spaPath) && method === "GET") {
    try {
      const html = await Deno.readTextFile("web/index.html");
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch (e) {
      warn("HTTP", `无法加载设置页面: ${e}`);
      return handleNotFound();
    }
  }

  // 静态资源文件（CSS、JS）
  if (pathname.startsWith("/css/") || pathname.startsWith("/js/")) {
    try {
      const filePath = `web${pathname}`;
      const content = await Deno.readTextFile(filePath);
      const contentType = pathname.endsWith(".css")
        ? "text/css; charset=utf-8"
        : pathname.endsWith(".js")
        ? "application/javascript; charset=utf-8"
        : "text/plain";
      return new Response(content, {
        headers: { "Content-Type": contentType },
      });
    } catch (e) {
      warn("HTTP", `无法加载静态资源 ${pathname}: ${e}`);
      return handleNotFound();
    }
  }

  // 系统信息 API
  if ((pathname === "/api/info" || pathname === "/api/info/") && method === "GET") {
    return new Response(
      JSON.stringify({
        service: "img-router",
        version: denoConfig.version,
        docs: "https://github.com/lianwusuoai/img-router",
        ui: "/admin",
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // CORS 预检请求
  if (method === "OPTIONS") {
    return handleCorsOptions();
  }

  // 统一鉴权
  // 排除不需要鉴权的路径：/health, /admin, /index, /ui, /css/*, /js/*, /
  // 仅对 OpenAI 兼容的 API 接口进行鉴权
  if (pathname.startsWith("/v1/") && pathname !== "/v1/models") {
    const apiKey = req.headers.get("Authorization")?.replace("Bearer ", "").trim() || "";
    // 如果既不是全局 Access Key，也不是已知的 Provider Key，则拒绝访问
    if (!checkAuth(req) && !providerRegistry.isRecognizedApiKey(apiKey)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // 日志流 SSE 端点
  // 允许前端实时订阅后端日志
  if (pathname === "/api/logs/stream" && method === "GET") {
    // 从 URL 参数获取最小日志级别，默认 INFO
    const levelParam = ctx.url.searchParams.get("level") || "INFO";
    const minLevel = LogLevel[levelParam.toUpperCase() as keyof typeof LogLevel] ?? LogLevel.INFO;

    // 用于存储取消订阅函数
    let unsubscribe: (() => void) | null = null;

    // 创建 SSE 流
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        // 发送初始连接消息
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "connected", level: levelParam })}\n\n`),
        );

        // 发送最近的历史日志
        const recentLogs = getRecentLogs();
        for (const entry of recentLogs) {
          if (entry.level >= minLevel) {
            try {
              const data = JSON.stringify({
                type: "log",
                timestamp: entry.timestamp,
                level: entry.levelName,
                module: entry.module,
                message: entry.message,
              });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            } catch { /* ignore */ }
          }
        }

        // 订阅日志流
        unsubscribe = addLogStream((entry: LogEntry) => {
          // 根据日志级别过滤
          if (entry.level >= minLevel) {
            try {
              const data = JSON.stringify({
                type: "log",
                timestamp: entry.timestamp,
                level: entry.levelName,
                module: entry.module,
                message: entry.message,
              });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            } catch {
              // 忽略编码错误
            }
          }
        });
      },
      cancel() {
        // 连接关闭时取消订阅日志流
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...corsHeaders,
      },
    });
  }

  // 路由分发
  switch (pathname) {
    // OpenAI 兼容 API
    case "/v1/chat/completions":
      if (method !== "POST") return handleMethodNotAllowed(method);
      return await handleChatCompletions(req);
    case "/v1/images/generations":
      if (method !== "POST") return handleMethodNotAllowed(method);
      return await handleImagesGenerations(req);
    case "/v1/images/edits":
      if (method !== "POST") return handleMethodNotAllowed(method);
      return await handleImagesEdits(req);
    case "/v1/images/blend":
      if (method !== "POST") return handleMethodNotAllowed(method);
      return await handleImagesBlend(req);

    // 管理 API：系统配置
    case "/api/config":
      if (method === "GET") {
        const providers = providerRegistry.getNames().flatMap((name) => {
          const p = providerRegistry.get(name, true);
          if (!p) return [];
          const isEnabled = providerRegistry.has(name);

          if (name === "Gitee") {
            console.log(
              "[API/Config] Gitee Config Snapshot:",
              JSON.stringify({
                textModelsCount: p.config.textModels?.length,
                editModelsCount: p.config.editModels?.length,
                blendModelsCount: p.config.blendModels?.length,
                firstTextModel: p.config.textModels?.[0],
              }),
            );
          }

          return [{
            name: p.name,
            enabled: isEnabled,
            capabilities: p.capabilities,
            textModels: p.config.textModels,
            editModels: p.config.editModels || [],
            defaultModel: p.config.defaultModel,
            defaultEditModel: p.config.defaultEditModel || p.config.defaultModel,
            defaultSize: p.config.defaultSize,
            defaultEditSize: p.config.defaultEditSize || p.config.defaultSize,
            blendModels: p.config.blendModels || [],
            defaultBlendModel: p.config.defaultBlendModel || p.config.defaultModel,
            defaultBlendSize: p.config.defaultBlendSize || p.config.defaultSize,
            supportsQuality: p.name === "Pollinations",
          }];
        });

        return new Response(
          JSON.stringify({
            version: denoConfig.version,
            textModels: Config.ALL_TEXT_MODELS,
            supportedSizes: Config.SUPPORTED_SIZES,
            providers,
            runtimeConfig: getRuntimeConfig(),
            port: Config.PORT,
            timeout: Config.API_TIMEOUT_MS,
            maxBody: Config.MAX_REQUEST_BODY_SIZE,
            defaultModel: Config.DEFAULT_IMAGE_MODEL,
            defaultSize: Config.DEFAULT_IMAGE_SIZE,
            defaultQuality: Config.DEFAULT_IMAGE_QUALITY,
            doubaoConfigured: !!Config.DOUBAO_ACCESS_KEY ||
              getKeyPool("Doubao").some((k) => k.enabled),
            giteeConfigured: !!Config.GITEE_AI_API_KEY ||
              getKeyPool("Gitee").some((k) => k.enabled),
            modelscopeConfigured: !!Config.MODELSCOPE_API_KEY ||
              getKeyPool("ModelScope").some((k) => k.enabled),
            hfConfigured: !!Config.HUGGINGFACE_API_KEY ||
              getKeyPool("HuggingFace").some((k) => k.enabled),
            pollinationsConfigured: !!Config.POLLINATIONS_API_KEY ||
              getKeyPool("Pollinations").some((k) => k.enabled),
            globalAccessKeyConfigured: !!Config.GLOBAL_ACCESS_KEY,
            cors: Config.ENABLE_CORS,
            logging: Config.ENABLE_REQUEST_LOGGING,
            verboseLogging: Config.VERBOSE_LOGGING,
            healthCheck: Config.ENABLE_HEALTH_CHECK,
          }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return handleMethodNotAllowed(method);

    // OpenAI 兼容 API: 获取模型列表
    case "/v1/models":
      if (method === "GET") {
        // 聚合所有已启用 Provider 的模型
        const allModels = new Set<string>();

        // 添加文本模型
        Config.ALL_TEXT_MODELS.forEach((m) => allModels.add(m));

        const names = providerRegistry.getNames();
        
        for (const name of names) {
          if (!providerRegistry.has(name)) continue;
          const provider = providerRegistry.get(name);
          if (provider) {
             const models = provider.getSupportedModels();
             models.forEach(m => allModels.add(m));
          }
        }

        const modelList = Array.from(allModels).map(id => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "img-router"
        }));

        return new Response(JSON.stringify({
          object: "list",
          data: modelList
        }), {
          headers: { 
            "Content-Type": "application/json",
            ...corsHeaders
          },
        });
      }
      return handleMethodNotAllowed(method);

    // 管理 API：密钥池管理
    case "/api/key-pool":
      if (method === "GET") {
        const provider = ctx.url.searchParams.get("provider");
        if (!provider) {
          return new Response(JSON.stringify({ error: "Missing provider param" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const pool = getKeyPool(provider);
        // Security: Mask keys in response
        const safePool = pool.map((k) => ({
          ...k,
          key: k.key && k.key.length > 8 ? `${k.key.slice(0, 4)}...${k.key.slice(-4)}` : "********",
        }));
        return new Response(JSON.stringify({ pool: safePool }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST") {
        try {
          const body = await req.json() as KeyPoolUpdatePayload;
          const { provider, keyItem, action, id, keys, format } = body;

          if (!provider) throw new Error("Missing provider");

          const pool = getKeyPool(provider);
          let newPool = [...pool];

          if (action === "add") {
            if (!keyItem || !keyItem.key) throw new Error("Missing keyItem");
            // Check duplicate
            if (pool.some((k) => k.key === keyItem.key)) throw new Error("Duplicate key");
            newPool.push({
              id: crypto.randomUUID(),
              enabled: true,
              lastUsed: 0,
              addedAt: Date.now(),
              provider: provider,
              status: "active",
              ...keyItem,
              key: keyItem.key, // Ensure key is set
              name: keyItem.name || "New Key", // Ensure name is set
            });
          } else if (action === "batch_add") {
            if (!keys || typeof keys !== "string") throw new Error("Missing keys string");

            let keyList: string[] = [];
            const inputFormat = format || "auto";

            if (inputFormat === "csv") {
              keyList = keys.split(",").map((k) => k.trim()).filter(Boolean);
            } else if (inputFormat === "text") {
              keyList = keys.split("\n").map((k) => k.trim()).filter(Boolean);
            } else { // auto
              if (keys.includes("\n")) {
                keyList = keys.split("\n").map((k) => k.trim()).filter(Boolean);
              } else {
                keyList = keys.split(",").map((k) => k.trim()).filter(Boolean);
              }
            }

            // Deduplicate input
            keyList = [...new Set(keyList)];

            let addedCount = 0;
            for (const k of keyList) {
              // Skip if already exists in pool
              if (pool.some((pk) => pk.key === k)) continue;

              newPool.push({
                id: crypto.randomUUID(),
                key: k,
                name: `Imported Key ${k.slice(0, 8)}...`,
                enabled: true,
                lastUsed: 0,
                addedAt: Date.now(),
                successCount: 0,
                totalCalls: 0,
                errorCount: 0,
                provider: provider,
                status: "active",
              });
              addedCount++;
            }

            await updateKeyPool(provider, newPool);
            // Security: Mask keys
            const safePool = newPool.map((k) => ({
              ...k,
              key: k.key && k.key.length > 8
                ? `${k.key.slice(0, 4)}...${k.key.slice(-4)}`
                : "********",
            }));
            return new Response(JSON.stringify({ ok: true, pool: safePool, added: addedCount }), {
              headers: { "Content-Type": "application/json" },
            });
          } else if (action === "update") {
            if (!id) throw new Error("Missing id");
            newPool = pool.map((k) => k.id === id ? { ...k, ...keyItem } : k);
          } else if (action === "delete") {
            if (!id) throw new Error("Missing id");
            newPool = pool.filter((k) => k.id !== id);
          } else {
            throw new Error("Invalid action");
          }

          await updateKeyPool(provider, newPool);
          // Security: Mask keys
          const safePool = newPool.map((k) => ({
            ...k,
            key: k.key && k.key.length > 8
              ? `${k.key.slice(0, 4)}...${k.key.slice(-4)}`
              : "********",
          }));
          return new Response(JSON.stringify({ ok: true, pool: safePool }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(
            JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }
      return handleMethodNotAllowed(method);

    // 管理 API：仪表盘统计
    case "/api/dashboard/stats":
      if (method === "GET") {
        const providers = providerRegistry.getNames();

        interface ProviderStats {
          total: number;
          valid: number;
          invalid: number;
          unused: number;
          totalCalls: number;
          totalSuccess: number;
          successRate: number;
        }

        const stats: Record<string, ProviderStats> = {};

        for (const name of providers) {
          const pool = getKeyPool(name);
          const total = pool.length;
          const valid = pool.filter((k) => k.enabled && !k.errorCount).length;
          const invalid = pool.filter((k) => k.enabled && !!k.errorCount).length;
          // Unused: never used (lastUsed is 0 or undefined)
          const unused = pool.filter((k) => !k.lastUsed).length;

          let totalCalls = 0;
          let totalSuccess = 0;

          pool.forEach((k) => {
            totalCalls += k.totalCalls || 0;
            totalSuccess += k.successCount || 0;
          });

          const successRate = totalCalls > 0 ? (totalSuccess / totalCalls) : 0;

          stats[name] = {
            total,
            valid,
            invalid,
            unused,
            totalCalls,
            totalSuccess,
            successRate: Number(successRate.toFixed(4)),
          };
        }

        return new Response(JSON.stringify({ stats }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return handleMethodNotAllowed(method);

    // 管理 API：运行时配置
    case "/api/runtime-config":
      if (method === "GET") {
        return new Response(JSON.stringify(getRuntimeConfig()), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const current = getRuntimeConfig();
        let changed = false;
        const nextConfig: RuntimeConfig = {
          providers: { ...current.providers },
          system: { ...current.system },
          keyPools: current.keyPools || {},
        };

        // 处理系统配置更新
        if (isRecord(body) && "system" in body) {
          const systemVal = body.system;
          if (isRecord(systemVal)) {
            const systemPatch = systemVal as Partial<SystemConfig>;

            nextConfig.system = { ...nextConfig.system, ...systemPatch };

            if ("globalAccessKey" in systemVal) {
              const globalAccessKey = systemVal.globalAccessKey;
              if (globalAccessKey !== undefined) {
                nextConfig.system!.globalAccessKey =
                  globalAccessKey as SystemConfig["globalAccessKey"];
              }
            }

            Config.updateSystemConfig(nextConfig.system!);
            changed = true;
          }
        }

        // 处理 Provider 配置批量更新
        if (isRecord(body) && "providers" in body) {
          const providersVal = body.providers;
          if (isRecord(providersVal)) {
            for (const [key, value] of Object.entries(providersVal)) {
              if (!isProviderName(key)) continue;
              if (!isRecord(value)) continue;

              const pVal = value as Partial<RuntimeProviderConfig>;
              const currentP: RuntimeProviderConfig = nextConfig.providers[key] || {};
              const cleanedCurrent: RuntimeProviderConfig = {
                enabled: currentP.enabled,
                text: currentP.text,
                edit: currentP.edit,
                blend: currentP.blend,
              };
              const cleanedPatch: RuntimeProviderConfig = {
                enabled: pVal.enabled,
                text: pVal.text,
                edit: pVal.edit,
                blend: pVal.blend,
              };

              nextConfig.providers[key] = {
                ...cleanedCurrent,
                ...cleanedPatch,
                text: { ...(cleanedCurrent.text || {}), ...(cleanedPatch.text || {}) },
                edit: { ...(cleanedCurrent.edit || {}), ...(cleanedPatch.edit || {}) },
                blend: { ...(cleanedCurrent.blend || {}), ...(cleanedPatch.blend || {}) },
              };
            }

            changed = true;
          }
        }

        if (changed) {
          info("Config", `Runtime config updated: ${JSON.stringify(nextConfig.providers)}`);
          await replaceRuntimeConfig(nextConfig);
          return new Response(JSON.stringify({ ok: true, runtimeConfig: getRuntimeConfig() }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        const payload = body as {
          provider?: string;
          task?: string;
          defaults?: Record<string, unknown>;
          enabled?: boolean;
        };

        const provider = payload.provider;
        const task = payload.task;
        const defaults = payload.defaults;
        const enabled = payload.enabled;

        if (typeof provider !== "string") {
          return new Response(JSON.stringify({ error: "Invalid payload" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (!isProviderName(provider)) {
          return new Response(JSON.stringify({ error: "Unknown provider" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // 处理启用/禁用状态
        if (typeof enabled === "boolean") {
          await setProviderEnabled(provider as ProviderName, enabled);
          if (enabled) {
            providerRegistry.enable(provider as ProviderName);
          } else {
            providerRegistry.disable(provider as ProviderName);
          }

          // 如果没有其他任务配置，直接返回
          if (!task && !defaults) {
            return new Response(JSON.stringify({ ok: true, runtimeConfig: getRuntimeConfig() }), {
              headers: { "Content-Type": "application/json" },
            });
          }
        }

        if (
          (task !== "text" && task !== "edit" && task !== "blend") || !defaults ||
          typeof defaults !== "object"
        ) {
          return new Response(JSON.stringify({ error: "Invalid payload" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const taskDefaults: ProviderTaskDefaults = {
          model: ("model" in defaults ? defaults.model : undefined) as string | null | undefined,
          size: ("size" in defaults ? defaults.size : undefined) as string | null | undefined,
          quality: ("quality" in defaults ? defaults.quality : undefined) as
            | string
            | null
            | undefined,
          n: ("n" in defaults ? defaults.n : undefined) as number | null | undefined,
          steps: ("steps" in defaults ? defaults.steps : undefined) as number | null | undefined,
          weight: ("weight" in defaults ? defaults.weight : undefined) as number | undefined,
        };

        const aiChat = defaults.aiChat;
        if (isRecord(aiChat)) {
          taskDefaults.aiChat = {
            translate: typeof aiChat.translate === "boolean" ? aiChat.translate : undefined,
            expand: typeof aiChat.expand === "boolean" ? aiChat.expand : undefined,
          };
        }

        await setProviderTaskDefaults(provider as ProviderName, task, taskDefaults);

        return new Response(JSON.stringify({ ok: true, runtimeConfig: getRuntimeConfig() }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return handleMethodNotAllowed(method);

    // 管理 API: AI 聊天服务配置
    case "/api/config/ai-chat":
      if (method === "GET") {
        const config = Config.getAiChatConfig();
        console.log("[API] GET /api/config/ai-chat", config);
        // 直接返回配置，不再脱敏 API Key，以便前端明文显示
        return new Response(JSON.stringify(config || {}), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (!isRecord(body)) {
          return new Response(JSON.stringify({ error: "Invalid body" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const current = Config.getAiChatConfig();

        const nextBaseUrl = typeof body.baseUrl === "string" ? body.baseUrl : (current?.baseUrl ?? "");
        const nextModel = typeof body.model === "string" ? body.model : (current?.model ?? "gpt-3.5-turbo");

        let nextApiKey: string = current?.apiKey ?? "";
        // 移除脱敏判断，始终更新 apiKey
        if (typeof body.apiKey === "string") {
          nextApiKey = body.apiKey;
        }

        const nextEnableTranslate = typeof body.enableTranslate === "boolean"
          ? body.enableTranslate
          : current?.enableTranslate;
        const nextEnableExpand = typeof body.enableExpand === "boolean" ? body.enableExpand : current?.enableExpand;
        const nextTranslatePrompt = typeof body.translatePrompt === "string"
          ? body.translatePrompt
          : current?.translatePrompt;
        const nextExpandPrompt = typeof body.expandPrompt === "string" ? body.expandPrompt : current?.expandPrompt;

        Config.updateAiChatConfig({
          baseUrl: nextBaseUrl,
          apiKey: nextApiKey,
          model: nextModel,
          enableTranslate: nextEnableTranslate,
          enableExpand: nextEnableExpand,
          translatePrompt: nextTranslatePrompt,
          expandPrompt: nextExpandPrompt,
        });

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return handleMethodNotAllowed(method);

    // 工具 API: 获取模型列表
    case "/api/tools/fetch-models":
      if (method === "POST") {
        try {
          const body = await req.json();
          
          // Debug logs to verify inputs
          console.log("[API] fetch-models request:", { 
            baseUrl: body.baseUrl, 
            apiKey: body.apiKey ? (body.apiKey.substring(0, 8) + "...") : "empty" 
          });

          if (!isRecord(body) || typeof body.baseUrl !== "string") {
            return new Response(JSON.stringify({ error: "Missing or invalid baseUrl" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          if (!aiChatService) {
            throw new Error("aiChatService is not initialized");
          }

          const models = await aiChatService.fetchModels({
            baseUrl: body.baseUrl,
            apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
          });

          return new Response(JSON.stringify({ ok: true, models }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          console.error("[API] Fetch models failed:", e);
          return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return handleMethodNotAllowed(method);

    // 工具 API: 测试 AI Chat 连接
    case "/api/tools/test-ai-chat":
      if (method === "POST") {
        try {
          const body = await req.json();
          // 如果是脱敏的 key，尝试从配置中获取真实的 key
          if (body.apiKey === "******") {
            const current = Config.getAiChatConfig();
            if (current?.apiKey) {
              body.apiKey = current.apiKey;
            }
          }

          if (!body.baseUrl || !body.apiKey) {
             return new Response(JSON.stringify({ error: "Missing parameters" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          if (!aiChatService) {
             throw new Error("aiChatService is not initialized");
          }

          const result = await aiChatService.testConnection({
            baseUrl: body.baseUrl,
            apiKey: body.apiKey,
            model: body.model || "gpt-3.5-turbo",
          });

          return new Response(JSON.stringify({ ok: true, message: result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return handleMethodNotAllowed(method);


    // 管理 API: HF 模型映射配置
    case "/api/config/hf-map":
        if (method === "POST") {
            try {
                const body = await req.json(); // Expected: Record<string, { main: string, backup?: string }>
                if (typeof body !== 'object') {
                    return new Response(JSON.stringify({ error: "Invalid body" }), { status: 400 });
                }
                Config.updateHfModelMap(body);
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            } catch {
                return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
            }
        }
        if (method === "GET") {
            return new Response(JSON.stringify(Config.getHfModelMap()), { status: 200 });
        }
        return handleMethodNotAllowed(method);

    default:
      return handleNotFound();
  }
}

/**
 * 附加 CORS 响应头中间件
 */
function attachCorsHeaders(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const response = await handler(req);

    if (Config.ENABLE_CORS) {
      try {
        for (const [key, value] of Object.entries(corsHeaders)) {
          // 确保 CORS 头存在（覆盖策略，确保生效）
          response.headers.set(key, value);
        }
      } catch {
        // 如果 Headers 不可变，重新创建 Response
        const newHeaders = new Headers(response.headers);
        for (const [key, value] of Object.entries(corsHeaders)) {
          newHeaders.set(key, value);
        }

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      }
    }
    return response;
  };
}

/**
 * 主路由函数：包装了日志中间件和 CORS 处理
 *
 * 这是导出给 main.ts 使用的函数，自动记录所有请求并处理 CORS
 */
export const handleRequest = attachCorsHeaders(withLogging(routeRequest));
