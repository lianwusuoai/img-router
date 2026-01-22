/**
 * Chat Completions 端点处理器
 *
 * 处理 /v1/chat/completions 端点。
 * 该端点主要用于接收包含图片生成指令的聊天请求，并将其转换为标准的图片生成请求。
 * 支持 OpenAI 格式的流式 (Stream) 和非流式响应。
 *
 * 核心逻辑：
 * 1. 鉴权与路由：根据 API Key 或后端模式配置，确定使用的 Provider。
 * 2. 消息标准化：处理非标准格式的图片输入（如 Cherry Studio 格式）。
 * 3. 提取 Prompt：从最后一条用户消息中提取 Prompt 和图片。
 * 4. 调用 Provider：执行图片生成。
 * 5. 响应构建：将生成的图片 URL 封装为 OpenAI 兼容的 Chat Completion 响应。
 */

import type {
  ChatRequest,
  ImageGenerationRequest,
  ImageUrlContentItem,
  Message,
  MessageContentItem,
  NonStandardImageContentItem,
  TextContentItem,
} from "../types/index.ts";
import { providerRegistry } from "../providers/registry.ts";
import { getNextAvailableKey, getPromptOptimizerConfig, getRuntimeConfig, getSystemConfig } from "../config/manager.ts";
import type { IProvider } from "../providers/base.ts";
import { buildDataUri, normalizeAndCompressInputImages } from "../utils/image.ts";
import { debug, error, generateRequestId, info, logRequestEnd } from "../core/logger.ts";
import { promptOptimizerService } from "../core/prompt-optimizer.ts";

/**
 * 标准化消息内容格式
 *
 * 将所有非标准图片格式转换为标准 OpenAI 格式。
 * 兼容性处理：
 * - Cherry Studio 格式：{type:"image", image:"base64", mediaType:"image/png"}
 * - 其他未来可能出现的非标准格式
 *
 * @param content - 原始消息内容（字符串或数组）
 * @returns 标准化后的消息内容
 */
export function normalizeMessageContent(
  content: string | MessageContentItem[],
): string | MessageContentItem[] {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return content;
  }

  // 转换数组中的每个内容项
  return content.map((item: MessageContentItem) => {
    // 处理 Cherry Studio 等非标准图片格式
    if (item.type === "image" && "image" in item) {
      const nonStdItem = item as NonStandardImageContentItem;
      const mimeType = nonStdItem.mediaType || "image/png";
      const base64Data = nonStdItem.image;

      // 转换为标准 OpenAI 格式
      return {
        type: "image_url",
        image_url: {
          url: `data:${mimeType};base64,${base64Data}`,
        },
      } as ImageUrlContentItem;
    }

    // 已经是标准格式，直接返回
    return item;
  });
}

/**
 * 从消息数组中提取 Prompt 和图片
 *
 * 策略：
 * 1. 只关注最后一条用户消息（忽略历史上下文，因为目前是单轮生成）。
 * 2. 提取文本作为 Prompt。
 * 3. 提取 Markdown 格式的图片链接（`![alt](url)`）。
 * 4. 提取 standard `image_url` 类型的图片。
 *
 * @param messages - 聊天消息历史
 * @returns 包含提取出的 Prompt 和图片 URL 列表的对象
 */
export function extractPromptAndImages(messages: Message[]): { prompt: string; images: string[] } {
  let prompt = "";
  const images: string[] = [];

  // 只从最后一条用户消息中提取 prompt 和图片（不追溯历史）
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const userContent = messages[i].content;
      if (typeof userContent === "string") {
        prompt = userContent; // 从字符串内容中提取 Markdown 格式的图片
        const matches = userContent.matchAll(/!\[.*?\]\(((?:https?:\/\/|data:image\/)[^\)]+)\)/g);
        for (const match of matches) {
          images.push(match[1]);
        }
      } else if (Array.isArray(userContent)) {
        const textItem = userContent.find((item: MessageContentItem) => item.type === "text") as
          | TextContentItem
          | undefined;
        prompt = textItem?.text || "";
        // 从 text 中提取 Markdown 格式的图片
        if (prompt) {
          const matches = prompt.matchAll(/!\[.*?\]\(((?:https?:\/\/|data:image\/)[^\)]+)\)/g);
          for (const match of matches) {
            images.push(match[1]);
          }
        } // 提取 image_url 类型的图片
        const imgs = userContent
          .filter((item: MessageContentItem): item is ImageUrlContentItem =>
            item.type === "image_url"
          )
          .map((item: ImageUrlContentItem) => item.image_url?.url || "")
          .filter(Boolean);
        images.push(...imgs);
      }
      break;
    }
  }

  return { prompt, images };
}

/**
 * 处理 /v1/chat/completions 端点
 *
 * 核心流程：
 * 1. **鉴权与路由**：
 *    - **中转模式 (Relay Mode)**：客户端提供 Provider 的 API Key，直接透传。
 *    - **后端模式 (Backend Mode)**：客户端提供系统 Global Key，后端根据 Model 参数从密钥池选择 Provider Key。
 * 2. **请求预处理**：标准化消息格式，提取 Prompt 和图片，压缩图片。
 * 3. **Provider 调用**：调用 `provider.generate()`。
 * 4. **响应构建**：支持流式 (SSE) 和普通 JSON 响应，格式完全兼容 OpenAI。
 *
 * @param req - HTTP 请求对象
 * @returns HTTP 响应对象
 */
export async function handleChatCompletions(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = generateRequestId();
  const systemConfig = getSystemConfig();
  const modes = systemConfig.modes || { relay: true, backend: false };

  // 0. 检查系统是否完全关闭（双关模式）
  if (!modes.relay && !modes.backend) {
    error("HTTP", "系统服务未启动：中转模式和后端模式均已关闭");
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

  // 1. 获取 Authorization Header
  const authHeader = req.headers.get("Authorization");
  let apiKey = authHeader?.replace("Bearer ", "").trim() || "";

  // 2. 尝试检测 Provider (基于 Key 格式)
  let provider: IProvider | undefined = providerRegistry.detectProvider(apiKey);
  let usingBackendMode = false;

  // 3. 路由逻辑
  if (provider) {
    // Case A: 识别到 Provider Key
    if (!modes.relay) {
      error("HTTP", "中转模式已禁用，拒绝外部 Provider Key");
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
        // 如果 Key 不匹配系统 Key，且也不是 Provider Key (上面已检测)，则拒绝
        error("HTTP", "鉴权失败: 非有效 Provider Key 且不匹配 Global Key");
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
      error("HTTP", "无法识别 Key 且后端模式未开启");
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

  try {
    const requestBody: ChatRequest = await req.json();

    // 一劳永逸：统一标准化所有消息格式
    if (requestBody.messages && Array.isArray(requestBody.messages)) {
      requestBody.messages = requestBody.messages.map((msg) => ({
        ...msg,
        content: normalizeMessageContent(msg.content),
      }));
    }

    // 如果是后端模式，现在需要确定 Provider 和 Key
    if (usingBackendMode) {
      if (!requestBody.model) {
        error("HTTP", "后端模式下请求缺失 model 参数");
        logRequestEnd(requestId, req.method, url.pathname, 400, 0, "missing model");
        return new Response(
          JSON.stringify({ error: "Missing 'model' parameter in backend mode" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // 尝试解析模型映射（按优先级尝试所有任务类型）
      let mappingResult = await providerRegistry.resolveModelMapping(requestBody.model, "text");
      
      if (!mappingResult) {
        // 尝试 edit 任务类型
        mappingResult = await providerRegistry.resolveModelMapping(requestBody.model, "edit");
      }
      
      if (!mappingResult) {
        // 尝试 blend 任务类型
        mappingResult = await providerRegistry.resolveModelMapping(requestBody.model, "blend");
      }
      
      if (mappingResult) {
        // 找到了映射，使用映射的 Provider 和实际模型名
        provider = mappingResult.provider;
        requestBody.model = mappingResult.actualModel; // 更新为实际模型名
        info("HTTP", `模型映射: ${requestBody.model} -> ${mappingResult.actualModel} (Provider: ${provider.name})`);
      } else {
        // 没有找到映射，尝试直接匹配模型名
        provider = providerRegistry.getProviderByModel(requestBody.model);
      }

      if (!provider) {
        info("HTTP", `后端模式下请求了不支持的模型: ${requestBody.model}`);
        logRequestEnd(requestId, req.method, url.pathname, 400, 0, "unsupported model");
        return new Response(JSON.stringify({ error: `Unsupported model: ${requestBody.model}` }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      info("HTTP", `路由到 ${provider.name} (Backend Mode)`);

      // 从池中获取 Key
      const poolKey = await getNextAvailableKey(provider.name);
      if (!poolKey) {
        error("HTTP", `Provider ${provider.name} 账号池耗尽`);
        logRequestEnd(requestId, req.method, url.pathname, 503, 0, "key pool exhausted");
        return new Response(
          JSON.stringify({ error: `No available API keys for provider: ${provider.name}` }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      apiKey = poolKey; // 注入 Key
      info("Router", `后端模式: 为 ${provider.name} 分配了 Key (ID: ...${apiKey.slice(-4)})`);
    }

    if (!provider) {
      throw new Error("内部错误: Provider 未定义");
    }

    const isStream = requestBody.stream === true;
    const { prompt, images } = extractPromptAndImages(requestBody.messages || []);

    const compressedImages = await normalizeAndCompressInputImages(images);

    debug(
      "Router",
      `提取 Prompt: ${prompt?.substring(0, 80)}... (完整长度: ${prompt?.length || 0})`,
    );

    // 🔄 Prompt 优化（翻译+扩充）
    const optimizerConfig = getPromptOptimizerConfig();
    const shouldTranslate = optimizerConfig?.enableTranslate !== false;
    const shouldExpand = optimizerConfig?.enableExpand === true;
    
    let processedPrompt = prompt;
    
    if (shouldTranslate && shouldExpand) {
      // 场景1: 同时开启翻译+扩充
      const translated = await promptOptimizerService.processPrompt(prompt, {
        translate: true,
        expand: false,
      });
      processedPrompt = await promptOptimizerService.processPrompt(translated, {
        translate: false,
        expand: true,
      });
    } else if (shouldTranslate || shouldExpand) {
      // 场景2: 仅翻译 或 仅扩充
      processedPrompt = await promptOptimizerService.processPrompt(prompt, {
        translate: shouldTranslate,
        expand: shouldExpand,
      });
    }
    
    if (processedPrompt !== prompt) {
      info("PromptOptimizer", `Chat 端点: Prompt 已优化`);
    }

    // 使用 Provider 生成图片
    const generationRequest: ImageGenerationRequest = {
      prompt: processedPrompt,
      images: compressedImages,
      model: requestBody.model,
      size: requestBody.size,
      response_format: "url",
    };

    const validationError = provider.validateRequest(generationRequest);
    if (validationError) {
      error("HTTP", `请求参数无效: ${validationError}`);
      logRequestEnd(requestId, req.method, url.pathname, 400, 0, validationError);
      return new Response(JSON.stringify({ error: validationError }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 获取完整的 Key 池配置以支持 Key 池路由（用于 NewApi 等支持多模型的 Provider）
    const allKeyPools = getRuntimeConfig().keyPools || {};
    // 只传递 NewApi Provider 的 Key 池（其他 Provider 的 Key 没有 models 字段）
    const newApiKeyPool = allKeyPools["NewApi"] || [];
    const generationResult = await provider.generate(apiKey, generationRequest, { requestId }, newApiKeyPool);

    if (!generationResult.success) {
      throw new Error(generationResult.error || "图片生成失败");
    }

    const imageContent = (generationResult.images || [])
      .map((img, idx) => {
        if (img.url) return `![image${idx + 1}](${img.url})`;
        if (img.b64_json) return `![image${idx + 1}](${buildDataUri(img.b64_json, "image/png")})`;
        return "";
      })
      .filter(Boolean)
      .join("\n");

    const responseId = `chatcmpl-${crypto.randomUUID()}`;
    const modelName = requestBody.model || "unknown-model";
    const startTime = Date.now();

    if (isStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const contentChunk = {
            id: responseId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{
              index: 0,
              delta: { role: "assistant", content: imageContent },
              finish_reason: null,
            }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));

          const endChunk = {
            id: responseId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "stop",
            }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        },
      });

      debug("HTTP", `响应完成 (流式)`);
      logRequestEnd(requestId, req.method, url.pathname, 200, Date.now() - startTime);
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    const responseBody = JSON.stringify({
      id: responseId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [{
        index: 0,
        message: { role: "assistant", content: imageContent },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });

    debug("HTTP", `响应完成 (JSON)`);
    logRequestEnd(requestId, req.method, url.pathname, 200, Date.now() - startTime);

    return new Response(responseBody, {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Internal Server Error";
    const errorProvider = provider?.name || "Unknown";

    error("Proxy", `请求处理错误 (${errorProvider}): ${errorMessage}`);
    logRequestEnd(requestId, req.method, url.pathname, 500, 0, errorMessage);

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
