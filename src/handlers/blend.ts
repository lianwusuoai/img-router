/**
 * Images Blend 端点处理器
 *
 * 处理 /v1/images/blend 端点（融合生图）。
 *
 * 功能特性：
 * - **自动路由**：根据 Authorization Header 中的 API Key 自动路由到对应的 Provider。
 * - **双模式支持**：支持中转模式 (Relay) 和后端模式 (Backend)。
 * - **后端模式增强**：在后端模式下，支持自动从密钥池分配 Key，并具备错误重试机制。
 * - **格式兼容**：返回 OpenAI Images API 兼容的响应格式。
 */

import {
  getNextAvailableKey,
  getProviderTaskDefaults,
  getSystemConfig,
  reportKeyError,
  reportKeySuccess,
} from "../config/manager.ts";
import type { IProvider } from "../providers/base.ts";
import type {
  GenerationResult,
  ImageData,
  ImagesBlendRequest,
  ImagesResponse,
} from "../types/index.ts";
import { providerRegistry } from "../providers/registry.ts";
import { buildDataUri, urlToBase64 } from "../utils/image.ts";
import { debug, error, generateRequestId, info, logRequestEnd, warn } from "../core/logger.ts";

/**
 * 处理 /v1/images/blend 端点
 *
 * @param req - HTTP 请求对象
 * @returns HTTP 响应对象
 */
export async function handleImagesBlend(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = generateRequestId();
  const systemConfig = getSystemConfig();
  const modes = systemConfig.modes || { relay: true, backend: false };

  // 0. 检查系统是否完全关闭（双关模式）
  if (!modes.relay && !modes.backend) {
    warn("HTTP", "系统服务未启动：中转模式和后端模式均已关闭");
    // logRequestEnd 由 middleware 统一记录
    return new Response(
      JSON.stringify({ error: "服务未启动：请开启中转模式或后端模式" }),
      {
        status: 503,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }

  // logRequestStart(req, requestId);

  const authHeader = req.headers.get("Authorization");
  let apiKey = authHeader?.replace("Bearer ", "").trim() || "";

  // 1. 尝试检测 Provider (基于 Key 格式)
  let provider: IProvider | undefined = providerRegistry.detectProvider(apiKey);
  let usingBackendMode = false;

  // 2. 路由逻辑
  if (provider) {
    // Case A: 识别到 Provider Key
    if (!modes.relay) {
      warn("HTTP", "中转模式已禁用，拒绝外部 Provider Key");
      // logRequestEnd 由 middleware 统一记录
      return new Response(JSON.stringify({ error: "Relay mode is disabled" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    // 继续使用该 Provider 和 Key
  } else {
    // Case B: 未识别到 Key (可能是空，可能是系统 Key，可能是无效 Key)
    // 尝试后端模式
    if (modes.backend) {
      // 验证是否允许访问后端模式
      // 如果设置了 Global Key，必须匹配
      if (systemConfig.globalAccessKey && apiKey !== systemConfig.globalAccessKey) {
        warn("HTTP", "鉴权失败: 非有效 Provider Key 且不匹配 Global Key");
        // logRequestEnd 由 middleware 统一记录
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      usingBackendMode = true;
      // 后续需要从 Body 解析 Model 来确定 Provider
    } else {
      // 后端模式关闭，且 Key 无效
      warn("HTTP", "无法识别 Key 且后端模式未开启");
      // logRequestEnd 由 middleware 统一记录
      return new Response(JSON.stringify({ error: "Invalid API Key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (!usingBackendMode && provider) {
    info("HTTP", `路由到 ${provider.name} (Relay Mode)`);
  }

  const startTime = Date.now();

  try {
    const requestBody: ImagesBlendRequest = await req.json();

    // 如果是后端模式，现在需要确定 Provider 和 Key
    if (usingBackendMode) {
      if (!requestBody.model) {
        warn("HTTP", "后端模式下请求缺失 model 参数");
        logRequestEnd(requestId, req.method, url.pathname, 400, 0, "missing model");
        return new Response(
          JSON.stringify({ error: "Missing 'model' parameter in backend mode" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      provider = providerRegistry.getProviderByModel(requestBody.model);
      if (!provider) {
        warn("HTTP", `后端模式下请求了不支持的模型: ${requestBody.model}`);
        logRequestEnd(requestId, req.method, url.pathname, 400, 0, "unsupported model");
        return new Response(JSON.stringify({ error: `Unsupported model: ${requestBody.model}` }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      info("HTTP", `路由到 ${provider.name} (Backend Mode)`);
    }

    if (!provider) {
      throw new Error("内部错误: Provider 未定义");
    }

    // Inject defaults
    const defaults = getProviderTaskDefaults(provider.name, "blend");
    if (requestBody.steps === undefined && defaults.steps) {
        requestBody.steps = defaults.steps;
    }

    const desiredFormat = requestBody.response_format || "url";

    debug(
      "Router",
      `Images Blend API Request: ${requestBody.model} (Messages: ${
        requestBody.messages?.length || 0
      })`,
    );

    // 验证请求
    // 注意：这里我们可能需要新的验证逻辑，目前简单检查 messages
    if (
      !requestBody.messages || !Array.isArray(requestBody.messages) ||
      requestBody.messages.length === 0
    ) {
      const msg = "必须提供 messages 参数";
      warn("HTTP", `请求参数无效: ${msg}`);
      logRequestEnd(requestId, req.method, url.pathname, 400, Date.now() - startTime, msg);
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 重试循环 (仅限后端模式)
    let attempts = 0;
    const maxAttempts = usingBackendMode ? 3 : 1;
    let lastError: string | null = null;
    let successResult: GenerationResult | null = null;

    while (attempts < maxAttempts) {
      attempts++;

      // 后端模式：每次尝试都重新获取一个 Key (如果是重试)
      if (usingBackendMode) {
        const poolKey = getNextAvailableKey(provider.name);
        if (!poolKey) {
          if (attempts === 1) {
            warn("HTTP", `Provider ${provider.name} 账号池耗尽`);
            logRequestEnd(requestId, req.method, url.pathname, 503, 0, "key pool exhausted");
            return new Response(
              JSON.stringify({ error: `No available API keys for provider: ${provider.name}` }),
              {
                status: 503,
                headers: { "Content-Type": "application/json" },
              },
            );
          } else {
            // 重试时耗尽了 Key，退出循环
            warn("Router", `重试期间 Key 耗尽`);
            break;
          }
        }
        apiKey = poolKey;
        info(
          "Router",
          `后端模式: 为 ${provider.name} 分配了 Key (ID: ...${
            apiKey.slice(-4)
          }) (尝试 ${attempts}/${maxAttempts})`,
        );
      }

      try {
        const generationResult = await provider.blend(apiKey, requestBody, { requestId });

        if (generationResult.success) {
          successResult = generationResult;
          if (usingBackendMode) {
            reportKeySuccess(provider.name, apiKey);
          }
          break;
        } else {
          lastError = generationResult.error || "Unknown error";

          if (usingBackendMode) {
            const errorMsg = lastError || "Unknown error";
            const isRateLimit = errorMsg.includes("429") || errorMsg.includes("rate limit") ||
              errorMsg.includes("速率限制");
            const isAuthError = errorMsg.includes("401") || errorMsg.includes("403") ||
              errorMsg.includes("API Key") || errorMsg.includes("Unauthorized");

            if (isRateLimit) {
              warn("Router", `Key ...${apiKey.slice(-4)} 触发速率限制，标记并重试...`);
              reportKeyError(provider.name, apiKey, "rate_limit");
            } else if (isAuthError) {
              warn("Router", `Key ...${apiKey.slice(-4)} 鉴权失败，标记并重试...`);
              reportKeyError(provider.name, apiKey, "auth_error");
            } else {
              reportKeyError(provider.name, apiKey, "other");
            }
          } else {
            break;
          }
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (!usingBackendMode) break;
      }
    }

    if (!successResult) {
      throw new Error(lastError || "图片融合生成失败");
    }

    const generationResult = successResult;

    // 处理流式响应
    if (generationResult.stream) {
      info("HTTP", "流式响应 (Images Blend API)");
      logRequestEnd(requestId, req.method, url.pathname, 200, Date.now() - startTime);
      return new Response(generationResult.stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    const images: ImageData[] = generationResult.images || [];

    const data: ImageData[] = [];
    for (const img of images) {
      if (desiredFormat === "b64_json") {
        if (img.b64_json) {
          data.push({ b64_json: img.b64_json });
          continue;
        }
        if (img.url) {
          try {
            const { base64 } = await urlToBase64(img.url);
            data.push({ b64_json: base64 });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            warn("HTTP", `URL 转 Base64 失败，回退到 URL: ${msg}`);
            data.push({ url: img.url });
          }
          continue;
        }
        continue;
      }

      // desiredFormat === "url"（或默认）
      if (img.url) {
        data.push({ url: img.url });
        continue;
      }
      if (img.b64_json) {
        // 兼容旧实现：将 Base64 作为 data URI 放入 url 字段
        data.push({ url: buildDataUri(img.b64_json, "image/png") });
        continue;
      }
    }

    const responseBody: ImagesResponse = {
      created: Math.floor(Date.now() / 1000),
      data,
    };

    info("HTTP", "响应完成 (Images Blend API)");
    logRequestEnd(requestId, req.method, url.pathname, 200, Date.now() - startTime);

    return new Response(JSON.stringify(responseBody), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Internal Server Error";
    const errorProvider = provider?.name || "Unknown";

    error("Proxy", `请求处理错误 (${errorProvider}): ${errorMessage}`);
    logRequestEnd(requestId, req.method, url.pathname, 500, Date.now() - startTime, errorMessage);

    return new Response(
      JSON.stringify({
        error: { message: errorMessage, type: "server_error", provider: errorProvider },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
