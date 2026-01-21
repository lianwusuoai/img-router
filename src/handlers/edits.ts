/**
 * Images Edit 端点处理器
 *
 * 处理 /v1/images/edits 端点（图生图/图片编辑）。
 *
 * 功能特性：
 * - 支持 **multipart/form-data**：标准 OpenAI 风格，适合上传文件。
 * - 支持 **JSON**：兼容部分客户端,通过 Base64 或 URL 传递图片。
 * - **自动路由**：根据 Authorization Header 中的 API Key 自动路由到对应的 Provider。
 * - **格式兼容**：返回 OpenAI Images API 兼容的响应格式。
 * - **提示词优化**：支持翻译和扩充提示词
 * - **图片存储**：自动保存生成的图片到本地和 S3
 * - **后端模式支持**：支持全局密钥和 Key 池管理
 *
 * 注意事项：
 * - 所有的 Provider 实现都统一接收 `ImageGenerationRequest`，其中 `images` 数组包含所有输入图片。
 * - `mask` 参数虽然被解析，但目前的 Provider 实现大多不支持或通过其他方式（如 Alpha 通道）支持，因此暂未强依赖。
 */

import { encodeBase64 } from "@std/encoding/base64";
import { getPromptOptimizerConfig, getProviderTaskDefaults, getRuntimeConfig, getSystemConfig } from "../config/manager.ts";
import type {
  ImageData,
  ImageGenerationRequest,
  ImagesEditRequest,
  ImagesResponse,
  Message,
} from "../types/index.ts";
import type { IProvider, ProviderName } from "../providers/base.ts";
import type { RuntimeProviderConfig } from "../config/manager.ts";
import { providerRegistry } from "../providers/registry.ts";
import { buildDataUri, normalizeAndCompressInputImages, urlToBase64 } from "../utils/image.ts";
import { debug, error, generateRequestId, info } from "../core/logger.ts";
import { extractPromptAndImages, normalizeMessageContent } from "./chat.ts";
import { promptOptimizerService } from "../core/prompt-optimizer.ts";
import { storageService } from "../core/storage.ts";
import { keyManager } from "../core/key-manager.ts";

/**
 * 将 File 对象转换为 Data URI
 *
 * 用于处理 multipart/form-data 上传的文件。
 *
 * @param file - 上传的文件对象
 * @returns Data URI 字符串 (data:image/png;base64,...)
 */
async function fileToDataUri(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  const base64 = encodeBase64(uint8Array);
  const mimeType = file.type || "image/png";
  return buildDataUri(base64, mimeType);
}

/**
 * 处理 /v1/images/edits 端点
 *
 * 核心流程：
 * 1. **鉴权与路由**：根据 API Key 检测 Provider。
 * 2. **请求解析**：
 *    - 如果是 `multipart/form-data`：解析 Form Data，提取文件并转换为 Data URI。
 *    - 如果是 `application/json`：解析 JSON Body，提取 Base64 或 URL 图片。
 * 3. **提示词优化**：翻译和扩充提示词
 * 4. **图片预处理**：统一压缩和格式化输入图片。
 * 5. **Provider 调用**：执行图片编辑生成。
 * 6. **图片存储**：保存生成的图片
 * 7. **响应构建**：根据 `response_format` 返回 URL 或 Base64 JSON。
 *
 * @param req - HTTP 请求对象
 * @returns HTTP 响应对象
 */
export async function handleImagesEdits(req: Request): Promise<Response> {
  const _url = new URL(req.url);
  const requestId = generateRequestId();
  const systemConfig = getSystemConfig();
  const modes = systemConfig.modes || { relay: true, backend: false };

  debug("HTTP", `[${requestId}] Images Edit 请求开始 - Modes: relay=${modes.relay}, backend=${modes.backend}`);

  // 0. 检查系统是否完全关闭
  if (!modes.relay && !modes.backend) {
    error("HTTP", `[${requestId}] 服务未启动：relay 和 backend 模式都已关闭`);
    return new Response(
      JSON.stringify({ error: "服务未启动：请开启中转模式或后端模式" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  // 1. 鉴权与路由
  const authHeader = req.headers.get("Authorization");
  const apiKey = authHeader?.replace("Bearer ", "").trim() || "";

  debug("HTTP", `[${requestId}] API Key 长度: ${apiKey.length}, 前缀: ${apiKey.substring(0, Math.min(10, apiKey.length))}...`);

  // 尝试检测 Provider (基于 Key 格式) - Relay Mode
  let detectedProvider: IProvider | undefined;
  try {
    detectedProvider = providerRegistry.detectProvider(apiKey);
    debug("HTTP", `[${requestId}] detectProvider 结果: ${detectedProvider ? detectedProvider.name : 'null'}`);
  } catch (detectError) {
    const msg = detectError instanceof Error ? detectError.message : String(detectError);
    error("HTTP", `[${requestId}] detectProvider 抛出异常: ${msg}`);
    detectedProvider = undefined;
  }

  let provider: IProvider | null = null;
  let actualApiKey = apiKey;

  if (detectedProvider) {
    // Relay Mode
    if (!modes.relay) {
      error("HTTP", `[${requestId}] Relay mode 已禁用，但检测到 Provider Key`);
      return new Response(JSON.stringify({ error: "Relay mode is disabled" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    provider = detectedProvider;
    info("HTTP", `[${requestId}] Relay Mode: 路由到 ${provider.name} (Images Edit)`);
  } else {
    // Backend Mode
    debug("HTTP", `[${requestId}] 未检测到 Provider Key，尝试 Backend Mode`);
    
    if (!modes.backend) {
      error("HTTP", `[${requestId}] Backend mode 已禁用，且未检测到有效的 Provider Key`);
      return new Response(JSON.stringify({ error: "Invalid API Key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (systemConfig.globalAccessKey && apiKey !== systemConfig.globalAccessKey) {
      error("HTTP", `[${requestId}] 全局密钥验证失败`);
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 获取启用的 Provider（取第一个启用的）
    const runtimeConfig = getRuntimeConfig();
    const providersConfig = runtimeConfig.providers as Record<string, RuntimeProviderConfig> | undefined;
    const enabledProviders = Object.entries(providersConfig || {})
      .filter(([_name, cfg]) => (cfg as RuntimeProviderConfig).enabled === true)
      .map(([name]) => name as ProviderName);

    debug("HTTP", `[${requestId}] 启用的 Providers: ${enabledProviders.join(', ')}`);

    if (enabledProviders.length === 0) {
      error("HTTP", `[${requestId}] Backend mode: 没有启用的 Provider`);
      return new Response(
        JSON.stringify({ error: "No enabled providers for backend mode" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    const providerName = enabledProviders[0];
    provider = providerRegistry.get(providerName) || null;

    if (!provider) {
      error("HTTP", `[${requestId}] Provider ${providerName} 未在注册表中找到`);
      return new Response(
        JSON.stringify({ error: `Provider ${providerName} not found` }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    // 从 Key 池获取 Token
    if (provider.name === "HuggingFace") {
      actualApiKey = ""; // HF 内部处理
      debug("HTTP", `[${requestId}] HuggingFace Provider: 使用内部 Token 管理`);
    } else {
      const token = keyManager.getNextKey(provider.name);
      if (!token) {
        error("HTTP", `[${requestId}] Key 池中没有可用的 ${provider.name} Token`);
        return new Response(
          JSON.stringify({ error: `No available keys for ${provider.name}` }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }
      actualApiKey = token;
      debug("HTTP", `[${requestId}] 从 Key 池获取 Token: ${actualApiKey.substring(0, 10)}...`);
    }

    info("HTTP", `[${requestId}] 后端模式: 路由到 ${provider.name} (Images Edit), Key池状态: ${actualApiKey ? "有可用Key" : "使用内部Key"}`);
  }

  if (!provider) {
    error("HTTP", `[${requestId}] 最终未能确定 Provider`);
    return new Response(
      JSON.stringify({ error: "No provider available" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const _startTime = Date.now();

  try {
    const contentType = req.headers.get("content-type") || "";

    let prompt = "";
    let model: string | undefined;
    let size: string | undefined;
    let steps: number | undefined;
    let responseFormat: "url" | "b64_json" = "url";
    const images: string[] = [];

    // 2. 请求解析
    if (contentType.includes("multipart/form-data")) {
      // 处理表单上传
      const formData = await req.formData();

      prompt = (formData.get("prompt") as string) || "";
      model = (formData.get("model") as string) || undefined;
      size = (formData.get("size") as string) || undefined;
      const stepsVal = formData.get("steps");
      if (stepsVal) steps = Number(stepsVal);

      const rf = formData.get("response_format");
      if (typeof rf === "string" && (rf === "url" || rf === "b64_json")) {
        responseFormat = rf;
      }

      const imageFiles = formData.getAll("image[]");
      const fallbackImage = formData.get("image");
      const allImages = imageFiles.length > 0 ? imageFiles : (fallbackImage ? [fallbackImage] : []);

      for (const item of allImages) {
        if (item instanceof File) {
          images.push(await fileToDataUri(item));
          info(
            "HTTP",
            `从 multipart/form-data 提取图片: ${item.name}, size=${Math.round(item.size / 1024)}KB`,
          );
        } else if (typeof item === "string" && item.trim()) {
          images.push(item.trim());
        }
      }

      const mask = formData.get("mask");
      if (mask) {
        info("HTTP", "mask 参数已提供，但当前实现不保证所有 Provider 支持遮罩编辑");
      }
    } else {
      // 处理 JSON 请求
      const jsonBody = await req.json();

      // 兼容某些客户端发送 messages 数组的情况
      if (jsonBody?.messages && Array.isArray(jsonBody.messages)) {
        const normalizedMessages = (jsonBody.messages as Message[]).map((msg: Message) => ({
          ...msg,
          content: normalizeMessageContent(msg.content),
        }));

        const extracted = extractPromptAndImages(normalizedMessages);
        prompt = extracted.prompt;
        images.push(...extracted.images);

        model = typeof jsonBody.model === "string" ? jsonBody.model : undefined;
        size = typeof jsonBody.size === "string" ? jsonBody.size : undefined;

        const rf = jsonBody.response_format;
        if (typeof rf === "string" && (rf === "url" || rf === "b64_json")) {
          responseFormat = rf;
        }
      } else {
        // 标准 JSON 请求
        const body = jsonBody as ImagesEditRequest;

        prompt = body?.prompt || "";
        model = body?.model;
        size = body?.size;
        steps = body?.steps;

        if (body?.response_format) {
          responseFormat = body.response_format;
        }

        if (typeof body?.image === "string" && body.image.trim()) {
          images.push(body.image.trim());
        }

        if (body?.mask) {
          info("HTTP", "mask 参数已提供，但当前实现不保证所有 Provider 支持遮罩编辑");
        }
      }
    }

    if (images.length === 0) {
      error("HTTP", "Images Edit 请求缺少 image");

      return new Response(
        JSON.stringify({ error: "必须提供 image（multipart/form-data 或 JSON 字段）" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 3. 提示词优化
    const originalPrompt = prompt;
    let processedPrompt = prompt;
    
    try {
      const optimizerConfig = getPromptOptimizerConfig();
      const defaults = getProviderTaskDefaults(provider.name, "edit");
      const imageCount = (defaults.n !== undefined && defaults.n !== null) ? defaults.n : 1;
      
      const shouldTranslate = optimizerConfig?.enableTranslate !== false;
      const shouldExpand = optimizerConfig?.enableExpand === true;
      
      // 根据不同场景处理提示词优化（与 images.ts 逻辑一致）
      if (shouldTranslate && shouldExpand) {
        // 场景1: 同时开启翻译+扩充
        if (imageCount > 1) {
          // 多图：先为每张图翻译，然后对每个翻译结果扩充
          const translatedPrompts: string[] = [];
          
          // 步骤1: 为每张图翻译（调用 n 次）
          for (let i = 1; i <= imageCount; i++) {
            const translated = await promptOptimizerService.processPrompt(prompt, {
              translate: true,
              expand: false,
              imageIndex: i,
            });
            translatedPrompts.push(translated);
          }
          
          // 步骤2: 对每个翻译结果扩充（再调用 n 次）
          for (let i = 1; i <= imageCount; i++) {
            const expanded = await promptOptimizerService.processPrompt(translatedPrompts[i - 1], {
              translate: false,
              expand: true,
              imageIndex: i,
            });
            // 使用最后一次的结果
            if (i === imageCount) {
              processedPrompt = expanded;
            }
          }
        } else {
          // 单图：先翻译，再扩充（调用 2 次）
          const translated = await promptOptimizerService.processPrompt(prompt, {
            translate: true,
            expand: false,
          });
          processedPrompt = await promptOptimizerService.processPrompt(translated, {
            translate: false,
            expand: true,
          });
        }
      } else if (shouldTranslate || shouldExpand) {
        // 场景2: 仅翻译 或 仅扩充
        if (imageCount > 1) {
          // 多图：为每张图调用一次（调用 n 次）
          for (let i = 1; i <= imageCount; i++) {
            const optimized = await promptOptimizerService.processPrompt(prompt, {
              translate: shouldTranslate,
              expand: shouldExpand,
              imageIndex: i,
            });
            // 使用最后一次的结果
            if (i === imageCount) {
              processedPrompt = optimized;
            }
          }
        } else {
          // 单图：调用一次
          processedPrompt = await promptOptimizerService.processPrompt(prompt, {
            translate: shouldTranslate,
            expand: shouldExpand,
          });
        }
      }
      // 场景3: 都未开启 → processedPrompt 保持为 prompt
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      info("PromptOptimizer", `提示词优化失败，使用原始提示词: ${msg}`);
      processedPrompt = prompt;
    }

    // 4. 图片预处理
    const compressedImages = await normalizeAndCompressInputImages(images);
    const defaults = getProviderTaskDefaults(provider.name, "edit");

    debug(
      "Router",
      `Images Edit Prompt: ${processedPrompt.substring(0, 80)}... (完整长度: ${processedPrompt.length})`,
    );
    debug("Router", `Images Edit 图片数量: ${images.length}`);

    // 5. Provider 调用
    const generationRequest: ImageGenerationRequest = {
      prompt: processedPrompt,
      images: compressedImages,
      model,
      size,
      steps: steps || defaults.steps || undefined,
      n: (defaults.n !== undefined && defaults.n !== null) ? defaults.n : undefined,
      response_format: responseFormat,
    };

    const validationError = provider.validateRequest(generationRequest);
    if (validationError) {
      error("HTTP", `请求参数无效: ${validationError}`);

      return new Response(JSON.stringify({ error: validationError }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const generationResult = await provider.generate(actualApiKey, generationRequest, {
      requestId,
      returnBase64: responseFormat === "b64_json",
    });

    if (!generationResult.success) {
      throw new Error(generationResult.error || "图片编辑失败");
    }

    // 6. 存储生成的图片
    const output: ImageData[] = generationResult.images || [];
    
    for (let i = 0; i < output.length; i++) {
      const img = output[i];
      if (img.b64_json) {
        try {
          await storageService.saveImage(img.b64_json, {
            prompt: processedPrompt,
            model: model || "edit",
            seed: 0,
            params: {
              task: "edit",
              originalPrompt: originalPrompt !== processedPrompt ? originalPrompt : undefined,
              provider: provider.name,
              requestId,
            },
          }, "png", i);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          error("Storage", `保存图片失败: ${msg}`);
        }
      }
    }

    // 7. 响应构建
    const data: ImageData[] = [];

    for (const img of output) {
      if (responseFormat === "b64_json") {
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
            error("HTTP", `URL 转 Base64 失败，回退到 URL: ${msg}`);
            data.push({ url: img.url });
          }
        }
        continue;
      }

      // responseFormat === "url"
      if (img.url) {
        data.push({ url: img.url });
        continue;
      }
      if (img.b64_json) {
        data.push({ url: buildDataUri(img.b64_json, "image/png") });
      }
    }

    const responseBody: ImagesResponse = {
      created: Math.floor(Date.now() / 1000),
      data,
    };

    debug("HTTP", "响应完成 (Images Edit API)");

    return new Response(JSON.stringify(responseBody), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Internal Server Error";
    const errorStack = err instanceof Error ? err.stack : undefined;
    const errorProvider = provider?.name || "Unknown";

    error("Proxy", `[${requestId}] 请求处理错误 (${errorProvider}): ${errorMessage}`);
    if (errorStack) {
      debug("Proxy", `[${requestId}] 错误堆栈: ${errorStack}`);
    }

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
