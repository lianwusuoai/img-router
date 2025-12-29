// 四合一图像生成 API 中转服务
// 支持：火山引擎 (VolcEngine)、Gitee (模力方舟)、ModelScope (魔塔)、Hugging Face
// 路由策略：根据 API Key 格式自动分发

// ================= 导入日志模块 =================

import {
  configureLogger,
  initLogger,
  closeLogger,
  logRequestStart,
  logRequestEnd,
  logProviderRouting,
  logApiCallStart,
  logApiCallEnd,
  generateRequestId,
  info,
  warn,
  error,
  debug,
  LogLevel,
  // 增强日志函数
  logFullPrompt,
  logInputImages,
  logImageGenerationStart,
  logGeneratedImages,
  logImageGenerationComplete,
  logImageGenerationFailed,
} from "./logger.ts";

// ================= 配置常量 =================

import {
  VolcEngineConfig,
  GiteeConfig,
  ModelScopeConfig,
  HuggingFaceConfig,
  API_TIMEOUT_MS,
  PORT,
} from "./config.ts";

// ================= 类型定义 =================

type Provider = "VolcEngine" | "Gitee" | "ModelScope" | "HuggingFace" | "Unknown";

// 消息内容项类型
interface TextContentItem {
  type: "text";
  text: string;
}

interface ImageUrlContentItem {
  type: "image_url";
  image_url?: { url: string };
}

type MessageContentItem = TextContentItem | ImageUrlContentItem;

// 消息类型
interface Message {
  role: string;
  content: string | MessageContentItem[];
}

interface ChatRequest {
  model?: string;
  messages: Message[];
  stream?: boolean;
  size?: string;
  [key: string]: unknown;
}

// ================= 核心逻辑 =================

function detectProvider(apiKey: string): Provider {
  if (!apiKey) return "Unknown";

  // Hugging Face: hf_xxxx...
  if (apiKey.startsWith("hf_")) {
    logProviderRouting("HuggingFace", apiKey.substring(0, 4));
    return "HuggingFace";
  }

  if (apiKey.startsWith("ms-")) {
    logProviderRouting("ModelScope", apiKey.substring(0, 4));
    return "ModelScope";
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(apiKey)) {
    logProviderRouting("VolcEngine", apiKey.substring(0, 4));
    return "VolcEngine";
  }

  const giteeRegex = /^[a-zA-Z0-9]{30,60}$/;
  if (giteeRegex.test(apiKey)) {
    logProviderRouting("Gitee", apiKey.substring(0, 4));
    return "Gitee";
  }

  logProviderRouting("Unknown", apiKey.substring(0, 4));
  return "Unknown";
}

function extractPromptAndImages(messages: Message[]): { prompt: string; images: string[] } {
  let prompt = "";
  let images: string[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const userContent = messages[i].content;
      if (typeof userContent === "string") {
        prompt = userContent;
      } else if (Array.isArray(userContent)) {
        const textItem = userContent.find((item: MessageContentItem) => item.type === "text") as TextContentItem | undefined;
        prompt = textItem?.text || "";
        
        images = userContent
          .filter((item: MessageContentItem): item is ImageUrlContentItem => item.type === "image_url")
          .map((item: ImageUrlContentItem) => item.image_url?.url || "")
          .filter(Boolean);
      }
      break;
    }
  }
  return { prompt, images };
}

// ================= 超时控制辅助函数 =================

/**
 * 带超时控制的 fetch 函数
 * @param url 请求 URL
 * @param options fetch 选项
 * @param timeoutMs 超时时间（毫秒），默认使用 API_TIMEOUT_MS
 * @returns Promise<Response>
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = API_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ================= 渠道处理函数 =================

async function handleVolcEngine(
  apiKey: string,
  reqBody: ChatRequest,
  prompt: string,
  images: string[],
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  logApiCallStart("VolcEngine", "generate_image");
  
  // 记录完整 Prompt
  logFullPrompt("VolcEngine", requestId, prompt);
  
  // 记录输入图片
  logInputImages("VolcEngine", requestId, images);
  
  // 使用配置中的默认模型，支持多模型
  const model = reqBody.model && VolcEngineConfig.supportedModels.includes(reqBody.model)
    ? reqBody.model
    : VolcEngineConfig.defaultModel;
  const size = reqBody.size || "4096x4096";
  
  // 记录生成开始
  logImageGenerationStart("VolcEngine", requestId, model, size, prompt.length);
  
  const arkRequest = {
    model: model,
    prompt: prompt || "A beautiful scenery",
    image: images,
    response_format: "url",
    size: size,
    seed: -1,
    stream: false,
    watermark: false,
  };

  const response = await fetchWithTimeout(VolcEngineConfig.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "Connection": "close"
    },
    body: JSON.stringify(arkRequest),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(`VolcEngine API Error (${response.status}): ${errorText}`);
    logImageGenerationFailed("VolcEngine", requestId, errorText);
    logApiCallEnd("VolcEngine", "generate_image", false, Date.now() - startTime);
    throw err;
  }

  const data = await response.json();
  
  // 记录生成的图片 URL
  logGeneratedImages("VolcEngine", requestId, data.data || []);
  
  const duration = Date.now() - startTime;
  const imageCount = data.data?.length || 0;
  logImageGenerationComplete("VolcEngine", requestId, imageCount, duration);
  
  const result = data.data?.map((img: { url: string }) => `![Generated Image](${img.url})`).join("\n\n") || "图片生成失败";
  
  logApiCallEnd("VolcEngine", "generate_image", true, duration);
  return result;
}

async function handleGitee(
  apiKey: string,
  reqBody: ChatRequest,
  prompt: string,
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  logApiCallStart("Gitee", "generate_image");

  // 记录完整 Prompt
  logFullPrompt("Gitee", requestId, prompt);
  
  // 使用配置中的默认模型，支持多模型
  const model = reqBody.model && GiteeConfig.supportedModels.includes(reqBody.model)
    ? reqBody.model
    : GiteeConfig.defaultModel;
  const size = reqBody.size || "2048x2048";
  
  // 记录生成开始
  logImageGenerationStart("Gitee", requestId, model, size, prompt.length);

  const giteeRequest = {
    model: model,
    prompt: prompt || "A beautiful scenery",
    size: size,
    n: 1,
    response_format: "url"
  };

  debug("Gitee", `发送请求到: ${GiteeConfig.apiUrl}`);

  const response = await fetchWithTimeout(GiteeConfig.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "User-Agent": "ImgRouter/1.0"
    },
    body: JSON.stringify(giteeRequest),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(`Gitee API Error (${response.status}): ${errorText}`);
    error("Gitee", `API 错误: ${response.status}`);
    logImageGenerationFailed("Gitee", requestId, errorText);
    logApiCallEnd("Gitee", "generate_image", false, Date.now() - startTime);
    throw err;
  }

  const responseText = await response.text();
  const data = JSON.parse(responseText);

  if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
    const err = new Error(`Gitee API 返回数据格式异常: ${JSON.stringify(data)}`);
    error("Gitee", "返回数据格式异常");
    logImageGenerationFailed("Gitee", requestId, "返回数据格式异常");
    logApiCallEnd("Gitee", "generate_image", false, Date.now() - startTime);
    throw err;
  }

  // 记录生成的图片 URL
  logGeneratedImages("Gitee", requestId, data.data);
  
  const duration = Date.now() - startTime;
  const imageCount = data.data.length;
  logImageGenerationComplete("Gitee", requestId, imageCount, duration);

  const imageUrls = data.data.map((img: { url?: string; b64_json?: string }) => {
    if (img.url) {
      return `![Generated Image](${img.url})`;
    } else if (img.b64_json) {
      return `![Generated Image](data:image/png;base64,${img.b64_json})`;
    }
    return "";
  }).filter(Boolean);

  const result = imageUrls.join("\n\n");
  logApiCallEnd("Gitee", "generate_image", true, duration);
  return result || "图片生成失败";
}

async function handleModelScope(
  apiKey: string,
  reqBody: ChatRequest,
  prompt: string,
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  logApiCallStart("ModelScope", "generate_image");

  // 记录完整 Prompt
  logFullPrompt("ModelScope", requestId, prompt);
  
  // 使用配置中的默认模型，支持多模型
  const model = reqBody.model && ModelScopeConfig.supportedModels.includes(reqBody.model)
    ? reqBody.model
    : ModelScopeConfig.defaultModel;
  const size = reqBody.size || "2048x2048";
  
  // 记录生成开始
  logImageGenerationStart("ModelScope", requestId, model, size, prompt.length);

  const submitResponse = await fetchWithTimeout(`${ModelScopeConfig.apiUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "X-ModelScope-Async-Mode": "true"
    },
    body: JSON.stringify({
      model: model,
      prompt: prompt || "A beautiful scenery",
      size: size,
      n: 1
    }),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    const err = new Error(`ModelScope Submit Error (${submitResponse.status}): ${errorText}`);
    logImageGenerationFailed("ModelScope", requestId, errorText);
    logApiCallEnd("ModelScope", "generate_image", false, Date.now() - startTime);
    throw err;
  }

  const submitData = await submitResponse.json();
  const taskId = submitData.task_id;
  info("ModelScope", `任务已提交, Task ID: ${taskId}`);

  const maxAttempts = 60;
  let pollingAttempts = 0;
  
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    pollingAttempts++;

    const checkResponse = await fetchWithTimeout(`${ModelScopeConfig.apiUrl}/tasks/${taskId}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "X-ModelScope-Task-Type": "image_generation"
      }
    });

    if (!checkResponse.ok) {
      warn("ModelScope", `轮询警告: ${checkResponse.status}`);
      continue;
    }

    const checkData = await checkResponse.json();
    const status = checkData.task_status;

    if (status === "SUCCEED") {
      const imageUrls = checkData.output_images || [];
      
      // 记录生成的图片 URL
      const imageData = imageUrls.map((url: string) => ({ url }));
      logGeneratedImages("ModelScope", requestId, imageData);
      
      const duration = Date.now() - startTime;
      const imageCount = imageUrls.length;
      logImageGenerationComplete("ModelScope", requestId, imageCount, duration);
      
      const result = imageUrls.map((url: string) => `![Generated Image](${url})`).join("\n\n") || "图片生成失败";
      
      info("ModelScope", `任务成功完成, 耗时: ${pollingAttempts}次轮询`);
      logApiCallEnd("ModelScope", "generate_image", true, duration);
      return result;
    } else if (status === "FAILED") {
      const err = new Error(`ModelScope Task Failed: ${JSON.stringify(checkData)}`);
      error("ModelScope", "任务失败");
      logImageGenerationFailed("ModelScope", requestId, JSON.stringify(checkData));
      logApiCallEnd("ModelScope", "generate_image", false, Date.now() - startTime);
      throw err;
    } else {
      debug("ModelScope", `状态: ${status} (第${i + 1}次)`);
    }
  }

  const err = new Error("ModelScope Task Timeout");
  error("ModelScope", "任务超时");
  logImageGenerationFailed("ModelScope", requestId, "任务超时");
  logApiCallEnd("ModelScope", "generate_image", false, Date.now() - startTime);
  throw err;
}

/**
 * HuggingFace 图片生成处理函数
 * 支持多 URL 故障转移：当前 URL 失败时自动尝试下一个
 */
async function handleHuggingFace(
  apiKey: string,
  reqBody: ChatRequest,
  prompt: string,
  images: string[],
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  logApiCallStart("HuggingFace", "generate_image");

  // 记录完整 Prompt
  logFullPrompt("HuggingFace", requestId, prompt);
  
  // 记录输入图片
  logInputImages("HuggingFace", requestId, images);
  
  // 使用配置中的默认模型
  const model = reqBody.model && HuggingFaceConfig.supportedModels.includes(reqBody.model)
    ? reqBody.model
    : HuggingFaceConfig.defaultModel;
  const size = reqBody.size || "2048x2048";
  const [width, height] = size.split('x').map(Number);
  const seed = Math.round(Math.random() * 2147483647);
  const steps = 9;

  // 记录生成开始
  logImageGenerationStart("HuggingFace", requestId, model, size, prompt.length);

  if (images.length > 0) {
    warn("HuggingFace", "Hugging Face 渠道暂不支持多图参考，将忽略输入图片");
  }

  // 使用 Gradio API 格式
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // 准备请求体数据
  const requestBody = JSON.stringify({
    data: [prompt || "A beautiful scenery", height || 1024, width || 1024, steps, seed, false]
  });

  // 获取配置中的 URL 资源池（支持故障转移）
  const apiUrls = HuggingFaceConfig.apiUrls;
  
  if (!apiUrls || apiUrls.length === 0) {
    const err = new Error("HuggingFace 配置错误: 未配置任何 API URL");
    error("HuggingFace", "API URL 资源池为空");
    logImageGenerationFailed("HuggingFace", requestId, "配置错误");
    logApiCallEnd("HuggingFace", "generate_image", false, Date.now() - startTime);
    throw err;
  }

  info("HuggingFace", `开始处理请求，URL 资源池大小: ${apiUrls.length}`);

  // 遍历所有 URL，尝试执行请求
  let lastError: Error | null = null;
  
  for (let i = 0; i < apiUrls.length; i++) {
    const apiUrl = apiUrls[i];
    const isLastAttempt = i === apiUrls.length - 1;
    
    info("HuggingFace", `尝试 URL [${i + 1}/${apiUrls.length}]: ${apiUrl}`);
    
    try {
      // 步骤1: 提交任务到队列
      const queueResponse = await fetchWithTimeout(`${apiUrl}/gradio_api/call/generate_image`, {
        method: "POST",
        headers,
        body: requestBody,
      });

      if (!queueResponse.ok) {
        const errorText = await queueResponse.text();
        throw new Error(`API Error (${queueResponse.status}): ${errorText}`);
      }

      const { event_id } = await queueResponse.json();
      info("HuggingFace", `任务已提交成功, Event ID: ${event_id}`);

      // 步骤2: 获取结果 (SSE 流)
      const resultResponse = await fetchWithTimeout(`${apiUrl}/gradio_api/call/generate_image/${event_id}`, {
        method: "GET",
        headers,
      });

      if (!resultResponse.ok) {
        const errorText = await resultResponse.text();
        throw new Error(`Result API Error (${resultResponse.status}): ${errorText}`);
      }

      const sseText = await resultResponse.text();
      
      // 解析 SSE 流，提取 complete 事件的数据
      const imageUrl = extractImageUrlFromSSE(sseText);
      
      if (!imageUrl) {
        throw new Error("返回数据格式异常：未能从 SSE 流中提取图片 URL");
      }

      // 成功获取图片！
      logGeneratedImages("HuggingFace", requestId, [{ url: imageUrl }]);
      const duration = Date.now() - startTime;
      logImageGenerationComplete("HuggingFace", requestId, 1, duration);
      
      info("HuggingFace", `✅ 成功使用 URL: ${apiUrl}`);
      
      const result = `![Generated Image](${imageUrl})`;
      logApiCallEnd("HuggingFace", "generate_image", true, duration);
      return result;

    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      error("HuggingFace", `❌ URL [${apiUrl}] 失败: ${lastError.message}`);
      
      // 如果还有更多 URL，提示即将切换
      if (!isLastAttempt) {
        info("HuggingFace", `🔄 正在切换到下一个 URL...`);
      }
      // 如果是最后一个 URL，抛出错误
    }
  }

  // 所有 URL 都尝试完毕，仍然失败
  const err = lastError || new Error("所有 HuggingFace URL 均失败");
  error("HuggingFace", `💥 所有 URL 均失败: ${err.message}`);
  logImageGenerationFailed("HuggingFace", requestId, `所有 URL 均失败: ${err.message}`);
  logApiCallEnd("HuggingFace", "generate_image", false, Date.now() - startTime);
  throw err;
}

// 从 SSE 流中提取图片 URL
function extractImageUrlFromSSE(sseStream: string): string | null {
  const lines = sseStream.split('\n');
  let isCompleteEvent = false;

  for (const line of lines) {
    if (line.startsWith('event:')) {
      const eventType = line.substring(6).trim();
      if (eventType === 'complete') {
        isCompleteEvent = true;
      } else if (eventType === 'error') {
        throw new Error("HuggingFace API 返回错误");
      } else {
        isCompleteEvent = false;
      }
    } else if (line.startsWith('data:') && isCompleteEvent) {
      const jsonData = line.substring(5).trim();
      try {
        const data = JSON.parse(jsonData);
        // data[0] 应该是图片对象 { url: "..." }
        if (data && data[0] && data[0].url) {
          return data[0].url;
        }
      } catch (e) {
        error("HuggingFace", `解析 SSE 数据失败: ${e}`);
      }
    }
  }
  return null;
}

// ================= 主处理函数 =================

async function handleChatCompletions(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = generateRequestId();

  logRequestStart(req, requestId);

  // 基础路径健康检查 (用于 Docker healthcheck)
  if (url.pathname === "/" || url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok", service: "img-router" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (url.pathname !== "/v1/chat/completions") {
    warn("HTTP", `路由不匹配: ${url.pathname}`);
    await logRequestEnd(requestId, req.method, url.pathname, 404, 0);
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  const authHeader = req.headers.get("Authorization");
  const apiKey = authHeader?.replace("Bearer ", "").trim();
  
  if (!apiKey) {
    warn("HTTP", "Authorization header 缺失");
    await logRequestEnd(requestId, req.method, url.pathname, 401, 0, "missing auth");
    return new Response(JSON.stringify({ error: "Authorization header missing" }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  const provider = detectProvider(apiKey);
  if (provider === "Unknown") {
    warn("HTTP", "API Key 格式无法识别");
    await logRequestEnd(requestId, req.method, url.pathname, 401, 0, "invalid key");
    return new Response(JSON.stringify({ error: "Invalid API Key format. Could not detect provider." }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  info("HTTP", `路由到 ${provider}`);

  try {
    const requestBody: ChatRequest = await req.json();
    const isStream = requestBody.stream === true;
    const { prompt, images } = extractPromptAndImages(requestBody.messages || []);

    // 记录完整 Prompt（DEBUG 级别只记录摘要）
    debug("Router", `提取 Prompt: ${prompt?.substring(0, 80)}... (完整长度: ${prompt?.length || 0})`);

    let imageContent = "";
    
    switch (provider) {
      case "VolcEngine":
        imageContent = await handleVolcEngine(apiKey, requestBody, prompt, images, requestId);
        break;
      case "Gitee":
        imageContent = await handleGitee(apiKey, requestBody, prompt, requestId);
        break;
      case "ModelScope":
        imageContent = await handleModelScope(apiKey, requestBody, prompt, requestId);
        break;
      case "HuggingFace":
        imageContent = await handleHuggingFace(apiKey, requestBody, prompt, images, requestId);
        break;
    }

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
              finish_reason: null
            }]
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
              finish_reason: "stop"
            }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        }
      });

      info("HTTP", `响应完成 (流式)`);
      await logRequestEnd(requestId, req.method, url.pathname, 200, Date.now() - startTime);
      
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        }
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
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });

    info("HTTP", `响应完成 (JSON)`);
    await logRequestEnd(requestId, req.method, url.pathname, 200, Date.now() - startTime);

    return new Response(responseBody, {
      headers: { 
        "Content-Type": "application/json", 
        "Access-Control-Allow-Origin": "*" 
      }
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Internal Server Error";
    const errorProvider = provider || "Unknown";
    
    error("Proxy", `请求处理错误 (${errorProvider}): ${errorMessage}`);
    await logRequestEnd(requestId, req.method, url.pathname, 500, 0, errorMessage);
    
    return new Response(JSON.stringify({ 
      error: { message: errorMessage, type: "server_error", provider: errorProvider } 
    }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }
}

// ================= 启动服务 =================

await initLogger();

const logLevel = Deno.env.get("LOG_LEVEL")?.toUpperCase();
if (logLevel && logLevel in LogLevel) {
  configureLogger({ level: LogLevel[logLevel as keyof typeof LogLevel] });
}

info("Startup", `🚀 服务启动端口 ${PORT}`);
info("Startup", "🔧 支持: 火山引擎, Gitee, ModelScope, HuggingFace");
info("Startup", `📁 日志目录: ./data/logs`);

Deno.addSignalListener("SIGINT", async () => {
  info("Startup", "收到 SIGINT, 关闭服务...");
  await closeLogger();
  Deno.exit(0);
});

// Windows only supports SIGINT/SIGBREAK, not SIGTERM
if (Deno.build.os !== "windows") {
  Deno.addSignalListener("SIGTERM", async () => {
    info("Startup", "收到 SIGTERM, 关闭服务...");
    await closeLogger();
    Deno.exit(0);
  });
}

Deno.serve({ port: PORT }, (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      }
    });
  }

  if (req.method !== "POST") {
    warn("HTTP", `不支持 ${req.method}`);
    return new Response("Method Not Allowed", { status: 405 });
  }

  return handleChatCompletions(req);
});
