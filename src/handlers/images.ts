/**
 * Images Generations 端点处理器
 *
 * 处理 /v1/images/generations 端点（文生图）。
 *
 * V4 升级特性：
 * - **权重级联路由**：基于权重的 Provider 优先级调度与故障转移。
 * - **智能增强**：集成 Prompt 翻译与扩充。
 * - **Key 池管理**：直连模式下自动轮询 Key。
 */

import { getProviderTaskDefaults, getSystemConfig } from "../config/manager.ts";
import type { IProvider } from "../providers/base.ts";
import type {
  GenerationResult,
  ImageData,
  ImageGenerationRequest,
  ImagesRequest,
  ImagesResponse,
} from "../types/index.ts";
import { providerRegistry } from "../providers/registry.ts";
import { buildDataUri, urlToBase64 } from "../utils/image.ts";
import { debug, error, generateRequestId, info, logRequestEnd } from "../core/logger.ts";
import { weightedRouter, type RouteStep } from "../core/router.ts";
import { promptOptimizerService } from "../core/prompt-optimizer.ts";
import { keyManager } from "../core/key-manager.ts";
import { storageService } from "../core/storage.ts";

/**
 * 处理 /v1/images/generations 端点
 */
export async function handleImagesGenerations(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = generateRequestId();
  const systemConfig = getSystemConfig();
  const modes = systemConfig.modes || { relay: true, backend: false };

  // 0. 检查系统是否完全关闭
  if (!modes.relay && !modes.backend) {
    return new Response(
      JSON.stringify({ error: "服务未启动：请开启中转模式或后端模式" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const authHeader = req.headers.get("Authorization");
  const apiKey = authHeader?.replace("Bearer ", "").trim() || "";

  // 1. 尝试检测 Provider (基于 Key 格式) - Relay Mode
  const detectedProvider: IProvider | undefined = providerRegistry.detectProvider(apiKey);
  let usingBackendMode = false;

  if (detectedProvider) {
    if (!modes.relay) {
      return new Response(JSON.stringify({ error: "Relay mode is disabled" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    info("HTTP", `Relay Mode: Detected provider ${detectedProvider.name}`);
  } else {
    if (modes.backend) {
      if (systemConfig.globalAccessKey && apiKey !== systemConfig.globalAccessKey) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      usingBackendMode = true;
      // info("HTTP", "Backend Mode: Using Weighted Router");
    } else {
      return new Response(JSON.stringify({ error: "Invalid API Key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const startTime = Date.now();

  try {
    const requestBody: ImagesRequest = await req.json();
    debug("HTTP", `Request Body: ${JSON.stringify(requestBody, null, 2)}`);

    // 2. 确定 Provider 执行计划
    let providerPlan: RouteStep[] = [];
    if (usingBackendMode) {
      // Backend Mode: 使用权重路由 (包含重定向逻辑)
      providerPlan = weightedRouter.getRoutePlan("text", requestBody.model);
      if (providerPlan.length === 0) {
        return new Response(JSON.stringify({ error: "No available providers for text-to-image" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      info("Router", `Plan: ${providerPlan.map((s) => `${s.provider.name}(${s.model})`).join(" -> ")}`);
    } else {
      // Relay Mode: 仅使用检测到的 Provider
      if (detectedProvider) {
        let targetModel = requestBody.model || "default";
        // 在 Relay 模式下，我们也尝试解析模型别名，但仅限于该 Provider
        const defaults = getProviderTaskDefaults(detectedProvider.name, "text");
        if (defaults.modelMap === targetModel) {
             // 如果请求的模型等于映射的别名，则使用默认模型或实际模型
             // 这里有个问题：ProviderTaskDefaults 里没有存 realId，而是存的 override model
             // 但我们的设计是 modelMap 只是个别名。
             // 实际上，如果配置了 modelMap，我们应该假设用户想要的是 defaultModel (override model)
             if (defaults.model) {
                 targetModel = defaults.model;
                 info("Router", `Relay Mode: Redirect model ${requestBody.model} -> ${targetModel}`);
             }
        }
        
        providerPlan = [{ provider: detectedProvider, model: targetModel }];
      }
    }

    if (providerPlan.length === 0) {
      throw new Error("Internal Error: No provider plan generated");
    }

    // 3. 执行计划 (级联故障转移)
    let successResult: GenerationResult | null = null;
    let lastError: unknown = null;

    // 原始 Prompt (用于 Intelligence 处理)
    const originalPrompt = requestBody.prompt || "";

    // 遍历计划中的 Provider
    for (const step of providerPlan) {
      const provider = step.provider;
      const targetModel = step.model;

      try {
        info("Router", `Attempting provider: ${provider.name} with model: ${targetModel}`);

        // 3.1 提示词优化 (PromptOptimizer Middleware)
        // 获取该 Provider 的提示词优化配置
        const defaults = getProviderTaskDefaults(provider.name, "text");
        const promptOptimizerConfig = defaults.promptOptimizer || {};

        // 处理 Prompt
        const processedPrompt = await promptOptimizerService.processPrompt(originalPrompt, {
          translate: promptOptimizerConfig.translate,
          expand: promptOptimizerConfig.expand,
        });

        if (processedPrompt !== originalPrompt) {
          debug("PromptOptimizer", `Prompt optimized: ${processedPrompt.substring(0, 50)}...`);
        }

        // 3.2 准备请求对象
        const generationRequest: ImageGenerationRequest = {
          ...requestBody,
          prompt: processedPrompt,
          images: [],
          model: targetModel === "auto" ? (defaults.model || undefined) : targetModel,
          // 从 Task Defaults 中补全 steps (如果请求中未包含)
          steps: requestBody.steps || defaults.steps || undefined,
        };

        // 3.3 获取 Key
        let currentApiKey = apiKey; // Relay Mode 默认使用用户传入的 Key

        if (usingBackendMode) {
          // Backend Mode: 从 KeyManager 获取
          // 对于 HF，KeyManager 已经在 Provider 内部集成，传空字符串即可
          // 对于其他 Provider (如 Gitee)，仍需获取
          if (provider.name === "HuggingFace") {
            currentApiKey = ""; // HF 内部处理
          } else {
            const token = keyManager.getNextKey(provider.name);
            if (!token) {
              info("Router", `Provider ${provider.name} has no available keys, skipping...`);
              lastError = new Error("No keys available");
              continue; // 尝试下一个 Provider
            }
            currentApiKey = token;
          }
        }

        // 3.4 执行生成
        const result = await provider.generate(currentApiKey, generationRequest, { requestId });

        if (result.success) {
          successResult = result;
          // 成功，跳出循环
          break;
        } else {
          lastError = new Error(result.error || "Unknown error");
          error("Router", `Provider ${provider.name} failed: ${result.error}`);
          // 继续下一个 Provider
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        error("Router", `Provider ${provider.name} exception: ${message}`);
        lastError = e;
        // 继续下一个 Provider
      }
    }

    if (!successResult) {
      throw lastError || new Error("All providers failed");
    }

    const generationResult = successResult!;

    // 4. 响应构建 (保持原有逻辑)
    if (generationResult.stream) {
      logRequestEnd(requestId, req.method, url.pathname, 200, Date.now() - startTime, "stream");
      return new Response(generationResult.stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    const images: ImageData[] = generationResult.images || [];
    const desiredFormat = requestBody.response_format || "url";
    const data: ImageData[] = [];

    for (const img of images) {
      // 保存到本地存储
      try {
        let base64ToSave = "";
        if (img.b64_json) {
          base64ToSave = img.b64_json;
        } else if (img.url) {
          // 如果是 URL，尝试下载并转换为 Base64 保存
          try {
            const { base64 } = await urlToBase64(img.url);
            base64ToSave = base64;
          } catch (e) {
            error("Storage", `Failed to download image for storage: ${e}`);
          }
        }

        if (base64ToSave) {
          // 异步保存，不阻塞响应
          storageService.saveImage(base64ToSave, {
            prompt: requestBody.prompt,
            model: requestBody.model || "unknown",
            params: {
              size: requestBody.size,
              n: requestBody.n,
              steps: requestBody.steps,
            },
          }).then((filename: string | null) => {
            if (filename) info("Storage", `Auto-saved image: ${filename}`);
          });
        }
  } catch (e) {
          error("Storage", `Failed to save image: ${e}`);
        }

      if (desiredFormat === "b64_json") {
        if (img.b64_json) {
          data.push({ b64_json: img.b64_json });
        } else if (img.url) {
          try {
            const { base64 } = await urlToBase64(img.url);
            data.push({ b64_json: base64 });
          } catch (_e) {
            data.push({ url: img.url });
          }
        }
      } else {
        if (img.url) {
          data.push({ url: img.url });
        } else if (img.b64_json) {
          data.push({ url: buildDataUri(img.b64_json, "image/png") });
        }
      }
    }

    const responseBody: ImagesResponse = {
      created: Math.floor(Date.now() / 1000),
      data,
    };

    info("HTTP", "响应完成 (Images API)");
    logRequestEnd(requestId, req.method, url.pathname, 200, Date.now() - startTime);

    return new Response(JSON.stringify(responseBody), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    error("Proxy", `请求处理错误: ${errorMessage}`);
    logRequestEnd(requestId, req.method, url.pathname, 500, Date.now() - startTime, errorMessage);
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: "server_error" } }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
