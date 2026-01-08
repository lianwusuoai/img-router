// 多合一图像生成 API 中转服务 - 根据 API Key 格式自动路由到对应渠道

import { Image } from "imagescript";
import { encodeBase64, decodeBase64 } from "@std/encoding/base64";
import {
  configureLogger, initLogger, closeLogger,
  logRequestStart, logRequestEnd, logProviderRouting,
  logApiCallStart, logApiCallEnd, generateRequestId,
  info, warn, error, debug, LogLevel,
  logFullPrompt, logInputImages, logImageGenerationStart,
  logGeneratedImages, logImageGenerationComplete, logImageGenerationFailed,
} from "./logger.ts";
import {
  VolcEngineConfig, GiteeConfig, ModelScopeConfig, HuggingFaceConfig,
  PollinationsConfig, ImageBedConfig, API_TIMEOUT_MS, PORT,
} from "./config.ts";

type Provider = "VolcEngine" | "Gitee" | "ModelScope" | "HuggingFace" | "Pollinations" | "Unknown";

interface TextContentItem {
  type: "text";
  text: string;
}

interface ImageUrlContentItem {
  type: "image_url";
  image_url?: { url: string };
}

// 支持非标准格式（如 Cherry Studio）
interface NonStandardImageContentItem {
  type: "image";
  image: string;  // 纯 Base64 数据（无前缀）
  mediaType?: string;  // 例如 "image/png"
}

type MessageContentItem = TextContentItem | ImageUrlContentItem | NonStandardImageContentItem;

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

/** OpenAI Images API 请求格式 */
interface ImagesRequest {
  model?: string;
  prompt: string;
  n?: number;
  size?: string;
  response_format?: "url" | "b64_json";
  [key: string]: unknown;
}

/** OpenAI Images Edit API 请求格式 */
interface ImagesEditRequest {
  model?: string;
  prompt: string;
  image: File | Blob | string;  // 支持 File、Blob 或 Base64 字符串
  mask?: File | Blob | string;  // 可选的遮罩
  n?: number;
  size?: string;
  response_format?: "url" | "b64_json";
  [key: string]: unknown;
}

function detectProvider(apiKey: string): Provider {
  if (!apiKey) return "Unknown";

  // Pollinations - pk_ 或 sk_ 开头
  if (apiKey.startsWith("pk_") || apiKey.startsWith("sk_")) {
    logProviderRouting("Pollinations", apiKey.substring(0, 3));
    return "Pollinations";
  }

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

/**
 * 标准化消息内容格式：将所有非标准图片格式转换为标准 OpenAI 格式
 * 这是"一劳永逸"的入口转换函数，支持：
 * - Cherry Studio 格式：{type:"image", image:"base64", mediaType:"image/png"}
 * - 其他未来可能出现的非标准格式
 */
function normalizeMessageContent(content: string | MessageContentItem[]): string | MessageContentItem[] {
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
          url: `data:${mimeType};base64,${base64Data}`
        }
      } as ImageUrlContentItem;
    }
    
    // 已经是标准格式，直接返回
    return item;
  });
}

function extractPromptAndImages(messages: Message[]): { prompt: string; images: string[] } {
  let prompt = "";
  const images: string[] = [];

  // 只从最后一条用户消息中提取 prompt 和图片（不追溯历史）
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const userContent = messages[i].content;
      if (typeof userContent === "string") {
        prompt = userContent;
        // 从字符串内容中提取 Markdown 格式的图片
        const matches = userContent.matchAll(/!\[.*?\]\(((?:https?:\/\/|data:image\/)[^\)]+)\)/g);
        for (const match of matches) {
          images.push(match[1]);
        }
      } else if (Array.isArray(userContent)) {
        const textItem = userContent.find((item: MessageContentItem) => item.type === "text") as TextContentItem | undefined;
        prompt = textItem?.text || "";
        // 从 text 中提取 Markdown 格式的图片
        if (prompt) {
          const matches = prompt.matchAll(/!\[.*?\]\(((?:https?:\/\/|data:image\/)[^\)]+)\)/g);
          for (const match of matches) {
            images.push(match[1]);
          }
        }
        // 提取 image_url 类型的图片
        const imgs = userContent
          .filter((item: MessageContentItem): item is ImageUrlContentItem => item.type === "image_url")
          .map((item: ImageUrlContentItem) => item.image_url?.url || "")
          .filter(Boolean);
        images.push(...imgs);
      }
      break;
    }
  }

  return { prompt, images };
}

/** 校验 URL 是否安全（防 SSRF） */
function isSafeUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    
    const hostname = url.hostname.toLowerCase();

    // 白名单：允许访问已配置的图床域名
    try {
      const bedHost = new URL(ImageBedConfig.baseUrl).hostname.toLowerCase();
      if (hostname === bedHost) return true;
    } catch { /* 忽略配置错误 */ }

    // 禁止访问本地和私有网络
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("172.16.") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 带超时控制的 fetch 函数 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = API_TIMEOUT_MS
): Promise<Response> {
  // 仅对非官方 API 渠道的外部 URL 进行安全校验
  const isOfficialApi = url.includes("volces.com") ||
                        url.includes("gitee.com") ||
                        url.includes("modelscope.cn") ||
                        url.includes("hf.space") ||
                        url.includes("pollinations.ai");

  if (url.startsWith("http") && !isOfficialApi) {
    if (!isSafeUrl(url)) {
      throw new Error(`安全限制：禁止访问该 URL (${url})`);
    }
  }

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

/** 根据图片魔数检测 MIME 类型 */
function detectImageMimeType(uint8Array: Uint8Array): string | null {
  if (uint8Array.length < 4) return null;
  if (uint8Array[0] === 0x89 && uint8Array[1] === 0x50 && uint8Array[2] === 0x4E && uint8Array[3] === 0x47) return "image/png";
  if (uint8Array[0] === 0xFF && uint8Array[1] === 0xD8 && uint8Array[2] === 0xFF) return "image/jpeg";
  if (uint8Array[0] === 0x47 && uint8Array[1] === 0x49 && uint8Array[2] === 0x46 && uint8Array[3] === 0x38) return "image/gif";
  if (uint8Array[0] === 0x52 && uint8Array[1] === 0x49 && uint8Array[2] === 0x46 && uint8Array[3] === 0x46 &&
      uint8Array.length > 11 && uint8Array[8] === 0x57 && uint8Array[9] === 0x45 && uint8Array[10] === 0x42 && uint8Array[11] === 0x50) return "image/webp";
  if (uint8Array[0] === 0x42 && uint8Array[1] === 0x4D) return "image/bmp";
  return null;
}

/** 将 WebP 转换为 PNG */
async function convertWebpToPng(webpData: Uint8Array): Promise<Uint8Array> {
  info("ImageConvert", "🔄 开始将 WebP 转换为 PNG...");
  const image = await Image.decode(webpData);
  const pngData = await image.encode();
  info("ImageConvert", `✅ WebP 转 PNG 完成, 原大小: ${Math.round(webpData.length / 1024)}KB, 新大小: ${Math.round(pngData.length / 1024)}KB`);
  return pngData;
}

/** 将图片 URL 下载并转换为 Base64（WebP 自动转 PNG） */
async function urlToBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const response = await fetchWithTimeout(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`下载图片失败: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  let uint8Array = new Uint8Array(arrayBuffer);
  
  let mimeType = detectImageMimeType(uint8Array);
  if (!mimeType) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.startsWith("image/")) {
      mimeType = contentType.split(";")[0].trim();
    }
  }
  
  if (!mimeType) {
    const urlLower = url.toLowerCase();
    if (urlLower.endsWith(".png")) mimeType = "image/png";
    else if (urlLower.endsWith(".jpg") || urlLower.endsWith(".jpeg")) mimeType = "image/jpeg";
    else if (urlLower.endsWith(".gif")) mimeType = "image/gif";
    else if (urlLower.endsWith(".webp")) mimeType = "image/webp";
    else if (urlLower.endsWith(".bmp")) mimeType = "image/bmp";
    else mimeType = "image/png";
  }
  if (mimeType === "image/webp") {
    try {
      const pngData = await convertWebpToPng(uint8Array);
      uint8Array = new Uint8Array(pngData);
      mimeType = "image/png";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn("ImageConvert", `❌ WebP 转 PNG 失败，保持原格式: ${msg}`);
    }
  }
  const base64 = encodeBase64(uint8Array);
  
  return { base64, mimeType };
}

/** 将 Base64 图片上传到图床获取 URL */
async function base64ToUrl(base64Data: string): Promise<string> {
  let base64Content: string;
  let mimeType: string;
  if (base64Data.startsWith("data:image/")) {
    const parts = base64Data.split(",");
    base64Content = parts[1];
    mimeType = parts[0].split(";")[0].split(":")[1];
  } else {
    base64Content = base64Data;
    mimeType = "image/png";
  }
  const binaryData = decodeBase64(base64Content);
  const blob = new Blob([binaryData], { type: mimeType });
  const extMap: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
  };
  const ext = extMap[mimeType] || "png";
  const filename = `img_${Date.now()}.${ext}`;
  const formData = new FormData();
  formData.append("file", blob, filename);
  const uploadUrl = new URL(ImageBedConfig.uploadEndpoint, ImageBedConfig.baseUrl);
  uploadUrl.searchParams.set("uploadChannel", ImageBedConfig.uploadChannel);
  uploadUrl.searchParams.set("uploadFolder", ImageBedConfig.uploadFolder);
  uploadUrl.searchParams.set("returnFormat", "full"); // 返回完整链接格式
  
  info("ImageBed", `正在上传图片到图床: ${filename} (${Math.round(binaryData.length / 1024)}KB)`);
  const response = await fetchWithTimeout(uploadUrl.toString(), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ImageBedConfig.authCode}`,
    },
    body: formData,
  }, 60000);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`图床上传失败 (${response.status}): ${errorText}`);
  }
  const result = await response.json();
  if (!result || !Array.isArray(result) || result.length === 0 || !result[0].src) {
    throw new Error(`图床返回格式异常: ${JSON.stringify(result)}`);
  }
  
  let imageUrl = result[0].src;
  if (!imageUrl.startsWith("http")) {
    imageUrl = `${ImageBedConfig.baseUrl}${imageUrl}`;
  }
  
  info("ImageBed", `✅ 图片上传成功: ${imageUrl}`);
  return imageUrl;
}

/** 火山引擎（豆包）图片生成 */
async function handleVolcEngine(
  apiKey: string,
  reqBody: ChatRequest,
  prompt: string,
  images: string[],
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  const hasImages = images.length > 0;
  const apiType = hasImages ? "image_edit" : "generate_image";
  logApiCallStart("VolcEngine", apiType);

  // 核心改进：将所有输入图片（包括 Base64）统一转换为图床 URL，以获得最稳定的生成效果
  const processedImages = await Promise.all(images.map(async (img, i) => {
    if (img.startsWith("http")) return img;
    try {
      info("VolcEngine", `正在上传图片${i + 1}到图床...`);
      return await base64ToUrl(img);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn("VolcEngine", `图片${i + 1}上传失败: ${msg}`);
      return img;
    }
  }));

  const model = reqBody.model && VolcEngineConfig.supportedModels.includes(reqBody.model)
    ? reqBody.model : VolcEngineConfig.defaultModel;
  const size = reqBody.size || (hasImages ? VolcEngineConfig.defaultEditSize : VolcEngineConfig.defaultSize);

  // 针对豆包多图融合的特殊处理：智能重写 Prompt，将口语化描述转换为明确的“图n”引用
  let finalPrompt = prompt || "A beautiful scenery";
  if (processedImages.length > 1) {
    const originalPrompt = finalPrompt;
    finalPrompt = finalPrompt
      .replace(/这张图|这幅图|当前图/g, "图2")
      .replace(/上面那张|上面那个人|原图|背景图/g, "图1");
    
    if (originalPrompt === finalPrompt && !finalPrompt.includes("图1")) {
      finalPrompt = `图1是背景，图2是主体。任务：${finalPrompt}`;
    }
    if (finalPrompt !== originalPrompt) {
      info("VolcEngine", `Prompt 已智能转换: "${originalPrompt}" -> "${finalPrompt}"`);
    }
  }

  logFullPrompt("VolcEngine", requestId, finalPrompt);
  if (hasImages) logInputImages("VolcEngine", requestId, processedImages);
  logImageGenerationStart("VolcEngine", requestId, model, size, finalPrompt.length);

  const arkRequest = {
    model,
    prompt: finalPrompt,
    response_format: (reqBody["response_format"] as string) || "url", // 优先请求 URL，方便我们后续转换
    size,
    watermark: true,
    ...(hasImages ? {
      image: processedImages,
      sequential_image_generation: "disabled"
    } : {})
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
  logGeneratedImages("VolcEngine", requestId, data.data || []);
  const duration = Date.now() - startTime;
  const imageData = data.data || [];
  logImageGenerationComplete("VolcEngine", requestId, imageData.length, duration);

  // 核心改进：将生成的图片 URL 转换回 Base64，确保客户端能够永久保存图片
  const resultParts = await Promise.all(imageData.map(async (img: { url?: string; b64_json?: string }) => {
    if (img.b64_json) return `![Generated Image](data:image/png;base64,${img.b64_json})`;
    if (img.url) {
      try {
        info("VolcEngine", `正在将生成结果 URL 转换为 Base64 以供永久保存...`);
        const { base64, mimeType } = await urlToBase64(img.url);
        return `![Generated Image](data:${mimeType};base64,${base64})`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warn("VolcEngine", `结果转换 Base64 失败，回退到 URL: ${msg}`);
        return `![Generated Image](${img.url})`;
      }
    }
    return "";
  }));
  const result = resultParts.filter(Boolean).join("\n\n") || "图片生成失败";
  
  logApiCallEnd("VolcEngine", apiType, true, duration);
  return result;
}

/**
 * Gitee（模力方舟）图片生成处理函数
 *
 * 【文生图】纯文字生成图片
 *   - API：GiteeConfig.apiUrl (同步 API)
 *   - 默认尺寸：GiteeConfig.defaultSize (2048x2048)
 *   - 支持模型：z-image-turbo
 *   - 返回格式：Base64 嵌入（永久有效）
 *
 * 【图片编辑】参考图片 + 文字编辑图片（同步）
 *   - API：GiteeConfig.editApiUrl (同步图片编辑 API)
 *   - 默认尺寸：GiteeConfig.defaultEditSize (1024x1024)
 *   - 支持模型：Qwen-Image-Edit 等
 *   - 输入格式：multipart/form-data，图片自动转换为 Base64
 *   - 返回格式：Base64 嵌入（永久有效）
 *
 * 【图片编辑（异步）】参考图片 + 文字编辑图片（异步轮询）
 *   - API：GiteeConfig.asyncEditApiUrl (异步图片编辑 API)
 *   - 默认尺寸：GiteeConfig.defaultAsyncEditSize (2048x2048)
 *   - 支持模型：Qwen-Image-Edit-2511, LongCat-Image-Edit, FLUX.1-Kontext-dev
 *   - 输入格式：multipart/form-data
 *   - 返回格式：URL（1天有效），自动转换为 Base64 嵌入
 *   - 轮询间隔：10秒，最大等待：30分钟
 */
async function handleGitee(
  apiKey: string,
  reqBody: ChatRequest,
  prompt: string,
  images: string[],
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  const hasImages = images.length > 0;
  const apiType = hasImages ? "image_edit" : "generate_image";
  
  logApiCallStart("Gitee", apiType);
  logFullPrompt("Gitee", requestId, prompt);
  
  if (hasImages) {
    logInputImages("Gitee", requestId, images);
  }

  // 文生图和图片编辑使用不同的默认尺寸
  const size = reqBody.size || (hasImages ? GiteeConfig.defaultEditSize : GiteeConfig.defaultSize);

  if (hasImages) {
    // 根据模型判断使用同步还是异步图片编辑 API
    const isAsyncModel = reqBody.model && GiteeConfig.asyncEditModels.includes(reqBody.model);
    
    if (isAsyncModel) {
      // ========== 图片编辑（异步）模式 ==========
      const model = reqBody.model as string;
      const asyncSize = GiteeConfig.defaultAsyncEditSize;
      
      logImageGenerationStart("Gitee", requestId, model, asyncSize, prompt.length);
      info("Gitee", `使用图片编辑（异步）模式, 模型: ${model}, 图片数量: ${images.length}`);

      const formData = new FormData();
      formData.append("model", model);
      formData.append("prompt", prompt || "");
      formData.append("size", asyncSize);
      formData.append("n", "1");
      formData.append("response_format", "url");

      // 处理图片输入
      for (let i = 0; i < images.length; i++) {
        const imageInput = images[i];
        let base64Data: string;
        let mimeType: string;
        
        if (imageInput.startsWith("data:image/")) {
          base64Data = imageInput.split(",")[1];
          mimeType = imageInput.split(";")[0].split(":")[1];
        } else {
          const downloaded = await urlToBase64(imageInput);
          base64Data = downloaded.base64;
          mimeType = downloaded.mimeType;
        }

        const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        const blob = new Blob([binaryData], { type: mimeType });
        formData.append("image", blob, `image_${i + 1}.png`);
      }

      // 提交异步任务
      const submitResponse = await fetchWithTimeout(GiteeConfig.asyncEditApiUrl, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}` },
        body: formData,
      });

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        error("Gitee", `图片编辑（异步）API 错误: ${submitResponse.status}`);
        logImageGenerationFailed("Gitee", requestId, errorText);
        logApiCallEnd("Gitee", apiType, false, Date.now() - startTime);
        throw new Error(`Gitee Async Edit API Error (${submitResponse.status}): ${errorText}`);
      }

      const submitData = await submitResponse.json();
      const taskId = submitData.task_id;
      if (!taskId) throw new Error("Gitee 异步任务提交失败：未返回 task_id");
      
      info("Gitee", `异步任务已提交, Task ID: ${taskId}`);

      // 轮询任务状态（10秒间隔，最大30分钟）
      const maxAttempts = 180;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        const statusResponse = await fetchWithTimeout(`${GiteeConfig.taskStatusUrl}/${taskId}`, {
          method: "GET",
          headers: { "Authorization": `Bearer ${apiKey}` },
        });

        if (!statusResponse.ok) continue;

        const statusData = await statusResponse.json();
        const status = statusData.status;

        if (status === "success") {
          const output = statusData.output;
          const duration = Date.now() - startTime;
          let result: string;
          
          if (output?.file_url) {
            try {
              const { base64, mimeType } = await urlToBase64(output.file_url);
              result = `![Generated Image](data:${mimeType};base64,${base64})`;
            } catch {
              result = `![Generated Image](${output.file_url})`;
            }
          } else if (output?.b64_json) {
            result = `![Generated Image](data:image/png;base64,${output.b64_json})`;
          } else {
            throw new Error("Gitee 异步任务成功但无图片数据");
          }

          logImageGenerationComplete("Gitee", requestId, 1, duration);
          logApiCallEnd("Gitee", apiType, true, duration);
          return result;
          
        } else if (status === "failure" || status === "cancelled") {
          logImageGenerationFailed("Gitee", requestId, status);
          logApiCallEnd("Gitee", apiType, false, Date.now() - startTime);
          throw new Error(`Gitee 异步任务${status === "failure" ? "失败" : "已取消"}`);
        }
      }

      logImageGenerationFailed("Gitee", requestId, "任务超时");
      logApiCallEnd("Gitee", apiType, false, Date.now() - startTime);
      throw new Error("Gitee 异步任务超时");
      
    } else {
      // ========== 图片编辑模式（同步 API）==========
      const model = reqBody.model && GiteeConfig.editModels.includes(reqBody.model)
        ? reqBody.model
        : GiteeConfig.editModels[0];
      
      logImageGenerationStart("Gitee", requestId, model, size, prompt.length);
      info("Gitee", `使用图片编辑模式, 模型: ${model}, 图片数量: ${images.length}`);

      const formData = new FormData();
      formData.append("model", model);
      formData.append("prompt", prompt || "");
      formData.append("size", GiteeConfig.defaultEditSize);
      formData.append("n", "1");
      formData.append("response_format", "b64_json");

      for (let i = 0; i < images.length; i++) {
        const imageInput = images[i];
        let base64Data: string;
        let mimeType: string;
        
        if (imageInput.startsWith("data:image/")) {
          base64Data = imageInput.split(",")[1];
          mimeType = imageInput.split(";")[0].split(":")[1];
          info("Gitee", `图片${i + 1}已是 Base64 格式`);
        } else {
          info("Gitee", `正在下载图片${i + 1}并转换为 Base64...`);
          const downloaded = await urlToBase64(imageInput);
          base64Data = downloaded.base64;
          mimeType = downloaded.mimeType;
          info("Gitee", `图片${i + 1}下载完成, MIME: ${mimeType}, 大小: ${Math.round(base64Data.length / 1024)}KB`);
        }

        const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        const blob = new Blob([binaryData], { type: mimeType });
        formData.append("image", blob, `image_${i + 1}.png`);
      }

      debug("Gitee", `发送图片编辑请求到: ${GiteeConfig.editApiUrl}`);

      const response = await fetchWithTimeout(GiteeConfig.editApiUrl, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}` },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        error("Gitee", `图片编辑 API 错误: ${response.status}`);
        logImageGenerationFailed("Gitee", requestId, errorText);
        logApiCallEnd("Gitee", apiType, false, Date.now() - startTime);
        throw new Error(`Gitee Edit API Error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const imageData = data.data || [];
      
      if (!imageData || imageData.length === 0) {
        throw new Error("Gitee 返回数据为空");
      }

      logGeneratedImages("Gitee", requestId, imageData);
      
      const duration = Date.now() - startTime;
      logImageGenerationComplete("Gitee", requestId, imageData.length, duration);

      const results = imageData.map((img: { url?: string; b64_json?: string }) => {
        if (img.b64_json) {
          return `![Generated Image](data:image/png;base64,${img.b64_json})`;
        } else if (img.url) {
          return `![Generated Image](${img.url})`;
        }
        return "";
      }).filter(Boolean);

      logApiCallEnd("Gitee", apiType, true, duration);
      return results.join("\n\n") || "图片生成失败";
    }
    
  } else {
    // 文生图模式（同步 API）
    const model = reqBody.model && GiteeConfig.supportedModels.includes(reqBody.model)
      ? reqBody.model
      : GiteeConfig.defaultModel;
    
    logImageGenerationStart("Gitee", requestId, model, size, prompt.length);
    info("Gitee", `使用文生图模式, 模型: ${model}`);

    const giteeRequest = {
      model: model,
      prompt: prompt || "A beautiful scenery",
      size: size,
      n: 1,
      response_format: "b64_json" // 使用 Base64 返回
    };

    debug("Gitee", `发送文生图请求到: ${GiteeConfig.apiUrl}`);

    const response = await fetchWithTimeout(GiteeConfig.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(giteeRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const err = new Error(`Gitee API Error (${response.status}): ${errorText}`);
      error("Gitee", `文生图 API 错误: ${response.status}`);
      logImageGenerationFailed("Gitee", requestId, errorText);
      logApiCallEnd("Gitee", apiType, false, Date.now() - startTime);
      throw err;
    }

    // 同步 API 直接返回结果
    const data = await response.json();
    const imageData = data.data || [];
    
    if (!imageData || imageData.length === 0) {
      throw new Error("Gitee 返回数据为空");
    }

    logGeneratedImages("Gitee", requestId, imageData);
    
    const duration = Date.now() - startTime;
    logImageGenerationComplete("Gitee", requestId, imageData.length, duration);

    // 构建返回结果（优先使用 Base64 嵌入，URL 也转换为 Base64）
    const results = await Promise.all(imageData.map(async (img: { url?: string; b64_json?: string }) => {
      if (img.b64_json) {
        return `![Generated Image](data:image/png;base64,${img.b64_json})`;
      } else if (img.url) {
        // 将 URL 转换为 Base64 以确保永久保存
        try {
          info("Gitee", `正在将 URL 转换为 Base64 以供永久保存...`);
          const { base64, mimeType } = await urlToBase64(img.url);
          return `![Generated Image](data:${mimeType};base64,${base64})`;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          warn("Gitee", `URL 转换 Base64 失败，回退到 URL: ${msg}`);
          return `![Generated Image](${img.url})`;
        }
      }
      return "";
    }));

    logApiCallEnd("Gitee", apiType, true, duration);
    return results.filter(Boolean).join("\n\n") || "图片生成失败";
  }
}

/** ModelScope（魔搭）图片生成处理：支持文生图（异步轮询）和图生图（多图融合） */
async function handleModelScope(
  apiKey: string,
  reqBody: ChatRequest,
  prompt: string,
  images: string[],
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  const hasImages = images.length > 0;
  const apiType = hasImages ? "image_edit" : "generate_image";
  
  logApiCallStart("ModelScope", apiType);

  logFullPrompt("ModelScope", requestId, prompt);
  if (hasImages) logInputImages("ModelScope", requestId, images);
  
  // 智能选择模型
  let model: string;
  let size: string;
  
  if (hasImages) {
    // 图生图/融合生图模式
    model = reqBody.model && ModelScopeConfig.editModels.includes(reqBody.model)
      ? reqBody.model
      : ModelScopeConfig.defaultEditModel;
    size = reqBody.size || ModelScopeConfig.defaultEditSize;
    info("ModelScope", `使用图生图模式, 模型: ${model}, 图片数量: ${images.length}`);
  } else {
    // 文生图模式
    model = reqBody.model && ModelScopeConfig.supportedModels.includes(reqBody.model)
      ? reqBody.model
      : ModelScopeConfig.defaultModel;
    size = reqBody.size || ModelScopeConfig.defaultSize;
    info("ModelScope", `使用文生图模式, 模型: ${model}`);
  }
  
  logImageGenerationStart("ModelScope", requestId, model, size, prompt.length);

  interface ModelScopeRequest {
    model: string;
    prompt: string;
    size?: string;
    n?: number;
    image_url?: string[];
  }
  
  const requestBody: ModelScopeRequest = {
    model: model,
    prompt: prompt || "A beautiful scenery",
  };
  
  if (!hasImages) {
    requestBody.size = size;
    requestBody.n = 1;
  }
  
  // 图生图模式：魔搭 API 只接受 URL 格式，Base64 需先上传到图床
  if (hasImages) {
    const urlImages: string[] = [];
    
    for (const img of images) {
      if (img.startsWith("http")) {
        // 已经是 URL 格式，直接使用
        urlImages.push(img);
        info("ModelScope", `使用 URL 格式图片: ${img.substring(0, 60)}...`);
      } else if (img.startsWith("data:image/")) {
        // Base64 格式，上传到图床获取 URL
        info("ModelScope", `检测到 Base64 图片，正在上传到图床...`);
        try {
          const imageUrl = await base64ToUrl(img);
          urlImages.push(imageUrl);
          info("ModelScope", `✅ Base64 图片已转换为 URL: ${imageUrl}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          warn("ModelScope", `❌ Base64 图片上传失败: ${msg}`);
          // 继续处理其他图片，不中断
        }
      } else {
        // 纯 Base64（无前缀），添加前缀后上传到图床
        info("ModelScope", `检测到纯 Base64 图片，正在上传到图床...`);
        try {
          const dataUri = `data:image/png;base64,${img}`;
          const imageUrl = await base64ToUrl(dataUri);
          urlImages.push(imageUrl);
          info("ModelScope", `✅ 纯 Base64 图片已转换为 URL: ${imageUrl}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          warn("ModelScope", `❌ 纯 Base64 图片上传失败: ${msg}`);
        }
      }
    }
    
    if (urlImages.length > 0) {
      requestBody.image_url = urlImages;
      info("ModelScope", `发送 ${urlImages.length} 张 URL 格式图片给魔搭 API`);
    } else {
      // 没有可用的 URL 格式图片，回退到文生图模式
      warn("ModelScope", "无可用 URL 格式图片，回退到文生图模式");
      requestBody.model = ModelScopeConfig.defaultModel;
      requestBody.size = ModelScopeConfig.defaultSize;
      requestBody.n = 1;
    }
  }

  const submitResponse = await fetchWithTimeout(`${ModelScopeConfig.apiUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "X-ModelScope-Async-Mode": "true"
    },
    body: JSON.stringify(requestBody),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    const err = new Error(`ModelScope Submit Error (${submitResponse.status}): ${errorText}`);
    logImageGenerationFailed("ModelScope", requestId, errorText);
    logApiCallEnd("ModelScope", apiType, false, Date.now() - startTime);
    throw err;
  }

  const submitData = await submitResponse.json();
  const taskId = submitData.task_id;
  info("ModelScope", `任务已提交, Task ID: ${taskId}`);

  const maxAttempts = 120; // 10分钟超时 (120次 × 5秒)
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
      const errorText = await checkResponse.text();
      warn("ModelScope", `轮询失败 (${checkResponse.status}): ${errorText}`);
      continue;
    }

    const checkData = await checkResponse.json();
    
    // 🔍 调试：输出完整响应以诊断问题
    if (pollingAttempts <= 3 || pollingAttempts % 10 === 0) {
      info("ModelScope", `📊 轮询响应 (第${pollingAttempts}次): ${JSON.stringify(checkData).substring(0, 200)}`);
    }
    
    const status = checkData.task_status;

    if (status === "SUCCEED") {
      const outputImageUrls = checkData.output_images || [];
      
      const imageData = outputImageUrls.map((url: string) => ({ url }));
      logGeneratedImages("ModelScope", requestId, imageData);
      
      const duration = Date.now() - startTime;
      const imageCount = outputImageUrls.length;
      logImageGenerationComplete("ModelScope", requestId, imageCount, duration);
      
      // 转换为 Base64 实现永久保存
      const results: string[] = [];
      for (const url of outputImageUrls) {
        info("ModelScope", `📎 原始图片 URL: ${url}`);
        info("ModelScope", `正在下载图片并转换为 Base64...`);
        try {
          const { base64, mimeType } = await urlToBase64(url);
          const sizeKB = Math.round(base64.length / 1024);
          info("ModelScope", `✅ 图片已转换为 Base64, MIME: ${mimeType}, 大小: ${sizeKB}KB`);
          // 返回 Base64 格式用于显示（永久有效）
          results.push(`![Generated Image](data:${mimeType};base64,${base64})`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          warn("ModelScope", `❌ 图片转换 Base64 失败，使用 URL: ${msg}`);
          results.push(`![Generated Image](${url})`);
        }
      }
      
      const result = results.join("\n\n") || "图片生成失败";
      
      info("ModelScope", `任务成功完成, 耗时: ${pollingAttempts}次轮询`);
      logApiCallEnd("ModelScope", apiType, true, duration);
      return result;
    } else if (status === "FAILED") {
      const err = new Error(`ModelScope Task Failed: ${JSON.stringify(checkData)}`);
      error("ModelScope", "任务失败");
      logImageGenerationFailed("ModelScope", requestId, JSON.stringify(checkData));
      logApiCallEnd("ModelScope", apiType, false, Date.now() - startTime);
      throw err;
    } else {
      debug("ModelScope", `状态: ${status} (第${i + 1}次)`);
    }
  }

  const err = new Error("ModelScope Task Timeout");
  error("ModelScope", "任务超时");
  logImageGenerationFailed("ModelScope", requestId, "任务超时");
  logApiCallEnd("ModelScope", apiType, false, Date.now() - startTime);
  throw err;
}

/** 将图片（URL 或 Base64）转换为 Blob 对象，用于 Gradio API 上传 */
async function imageToBlob(imageSource: string): Promise<Blob> {
  if (imageSource.startsWith("data:image/")) {
    // Base64 格式：data:image/png;base64,xxxxx
    const parts = imageSource.split(",");
    const base64Content = parts[1];
    const mimeType = parts[0].split(";")[0].split(":")[1];
    const binaryData = Uint8Array.from(atob(base64Content), c => c.charCodeAt(0));
    return new Blob([binaryData], { type: mimeType });
  } else if (imageSource.startsWith("http")) {
    // URL 格式：下载图片并转换为 Blob
    const response = await fetchWithTimeout(imageSource, { method: "GET" });
    if (!response.ok) {
      throw new Error(`下载图片失败: ${response.status}`);
    }
    return await response.blob();
  } else {
    // 纯 Base64（无前缀）
    const binaryData = Uint8Array.from(atob(imageSource), c => c.charCodeAt(0));
    return new Blob([binaryData], { type: "image/png" });
  }
}

/** HuggingFace 图片生成处理：支持文生图和图生图（Gradio API），多 URL 故障转移 */
async function handleHuggingFace(
  apiKey: string,
  reqBody: ChatRequest,
  prompt: string,
  images: string[],
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  const hasImages = images.length > 0;
  const apiType = hasImages ? "image_edit" : "generate_image";
  
  logApiCallStart("HuggingFace", apiType);

  logFullPrompt("HuggingFace", requestId, prompt);
  if (hasImages) logInputImages("HuggingFace", requestId, images);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  if (hasImages) {
    // 图生图/融合生图模式
    const model = HuggingFaceConfig.defaultEditModel;
    const size = reqBody.size || HuggingFaceConfig.defaultEditSize;
    const [width, height] = size.split('x').map(Number);
    
    logImageGenerationStart("HuggingFace", requestId, model, size, prompt.length);
    info("HuggingFace", `使用图生图/融合生图模式, 模型: ${model}, 图片数量: ${images.length}`);

    const editApiUrls = HuggingFaceConfig.editApiUrls;
    
    if (!editApiUrls || editApiUrls.length === 0) {
      const err = new Error("HuggingFace 配置错误: 未配置图生图 API URL");
      error("HuggingFace", "图生图 API URL 资源池为空");
      logImageGenerationFailed("HuggingFace", requestId, "配置错误");
      logApiCallEnd("HuggingFace", apiType, false, Date.now() - startTime);
      throw err;
    }

    info("HuggingFace", `开始处理图生图请求，URL 资源池大小: ${editApiUrls.length}`);

    const imageBlobs: (Blob | null)[] = [null, null, null];
    for (let i = 0; i < Math.min(images.length, 3); i++) {
      try {
        info("HuggingFace", `正在转换图片 ${i + 1}/${Math.min(images.length, 3)} 为 Blob...`);
        imageBlobs[i] = await imageToBlob(images[i]);
        info("HuggingFace", `✅ 图片 ${i + 1} 转换成功, 大小: ${Math.round((imageBlobs[i] as Blob).size / 1024)}KB`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warn("HuggingFace", `❌ 图片 ${i + 1} 转换失败: ${msg}`);
      }
    }

    if (!imageBlobs[0]) {
      const err = new Error("没有有效的输入图片");
      error("HuggingFace", "所有输入图片转换失败");
      logImageGenerationFailed("HuggingFace", requestId, "图片转换失败");
      logApiCallEnd("HuggingFace", apiType, false, Date.now() - startTime);
      throw err;
    }

    let lastError: Error | null = null;
    
    for (let i = 0; i < editApiUrls.length; i++) {
      const apiUrl = editApiUrls[i];
      const isLastAttempt = i === editApiUrls.length - 1;
      
      info("HuggingFace", `尝试图生图 URL [${i + 1}/${editApiUrls.length}]: ${apiUrl}`);
      
      try {
        const uploadedFiles: (string | null)[] = [null, null, null];
        
        for (let j = 0; j < 3; j++) {
          if (imageBlobs[j]) {
            info("HuggingFace", `正在上传图片 ${j + 1} 到 Gradio 服务器...`);
            const formData = new FormData();
            formData.append("files", imageBlobs[j] as Blob, `image_${j + 1}.png`);
            
            const uploadResponse = await fetchWithTimeout(`${apiUrl}/gradio_api/upload`, {
              method: "POST",
              headers: apiKey ? { "Authorization": `Bearer ${apiKey}` } : {},
              body: formData,
            });
            
            if (!uploadResponse.ok) {
              throw new Error(`图片上传失败: ${uploadResponse.status}`);
            }
            
            const uploadResult = await uploadResponse.json();
            // 返回格式: ["/tmp/gradio/xxx/image.png"] 或 ["path"]
            if (Array.isArray(uploadResult) && uploadResult.length > 0) {
              uploadedFiles[j] = uploadResult[0];
              info("HuggingFace", `✅ 图片 ${j + 1} 上传成功: ${uploadedFiles[j]}`);
            }
          }
        }

        const [defaultWidth, defaultHeight] = HuggingFaceConfig.defaultEditSize.split('x').map(Number);
        
        const inferRequest = {
          data: [
            // image_1: 必需
            uploadedFiles[0] ? {
              path: uploadedFiles[0],
              meta: { _type: "gradio.FileData" }
            } : null,
            // image_2: 可选
            uploadedFiles[1] ? {
              path: uploadedFiles[1],
              meta: { _type: "gradio.FileData" }
            } : null,
            // image_3: 可选
            uploadedFiles[2] ? {
              path: uploadedFiles[2],
              meta: { _type: "gradio.FileData" }
            } : null,
            // prompt
            prompt || "",
            // seed
            0,
            // randomize_seed
            true,
            // true_guidance_scale
            1,
            // num_inference_steps
            4,
            // height（使用配置中的默认值作为 fallback）
            height || defaultHeight,
            // width（使用配置中的默认值作为 fallback）
            width || defaultWidth,
          ]
        };

        info("HuggingFace", `正在调用 /infer 端点...`);
        
        const queueResponse = await fetchWithTimeout(`${apiUrl}/gradio_api/call/infer`, {
          method: "POST",
          headers,
          body: JSON.stringify(inferRequest),
        });

        if (!queueResponse.ok) {
          const errorText = await queueResponse.text();
          throw new Error(`Infer API Error (${queueResponse.status}): ${errorText}`);
        }

        const { event_id } = await queueResponse.json();
        info("HuggingFace", `图生图任务已提交, Event ID: ${event_id}`);

        const resultResponse = await fetchWithTimeout(`${apiUrl}/gradio_api/call/infer/${event_id}`, {
          method: "GET",
          headers: apiKey ? { "Authorization": `Bearer ${apiKey}` } : {},
        });

        if (!resultResponse.ok) {
          const errorText = await resultResponse.text();
          throw new Error(`Result API Error (${resultResponse.status}): ${errorText}`);
        }

        const sseText = await resultResponse.text();
        const imageUrl = extractImageUrlFromSSE(sseText, apiUrl);
        
        if (!imageUrl) {
          throw new Error("返回数据格式异常：未能从 SSE 流中提取图片 URL");
        }

        info("HuggingFace", `📎 原始图片 URL: ${imageUrl}`);
        info("HuggingFace", `正在下载图片并转换为 Base64...`);
        
        let result: string;
        try {
          const { base64, mimeType } = await urlToBase64(imageUrl);
          const sizeKB = Math.round(base64.length / 1024);
          info("HuggingFace", `✅ 图片已转换为 Base64, MIME: ${mimeType}, 大小: ${sizeKB}KB`);
          result = `![Generated Image](data:${mimeType};base64,${base64})`;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          warn("HuggingFace", `❌ 图片转换 Base64 失败，使用 URL: ${msg}`);
          result = `![Generated Image](${imageUrl})`;
        }

        logGeneratedImages("HuggingFace", requestId, [{ url: imageUrl }]);
        const duration = Date.now() - startTime;
        logImageGenerationComplete("HuggingFace", requestId, 1, duration);
        
        info("HuggingFace", `✅ 图生图成功使用 URL: ${apiUrl}`);
        logApiCallEnd("HuggingFace", apiType, true, duration);
        return result;

      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        error("HuggingFace", `❌ 图生图 URL [${apiUrl}] 失败: ${lastError.message}`);
        
        if (!isLastAttempt) {
          info("HuggingFace", `🔄 正在切换到下一个图生图 URL...`);
        }
      }
    }

    const err = lastError || new Error("所有 HuggingFace 图生图 URL 均失败");
    error("HuggingFace", `💥 所有图生图 URL 均失败: ${err.message}`);
    logImageGenerationFailed("HuggingFace", requestId, `所有图生图 URL 均失败: ${err.message}`);
    logApiCallEnd("HuggingFace", apiType, false, Date.now() - startTime);
    throw err;

  } else {
    // 文生图模式
    const model = HuggingFaceConfig.defaultModel;
    const size = reqBody.size || HuggingFaceConfig.defaultSize;
    const [width, height] = size.split('x').map(Number);
    const seed = Math.round(Math.random() * 2147483647);
    const steps = 9;

    logImageGenerationStart("HuggingFace", requestId, model, size, prompt.length);
    info("HuggingFace", `使用文生图模式, 模型: ${model}`);

    const [defaultWidth, defaultHeight] = HuggingFaceConfig.defaultSize.split('x').map(Number);
    const requestBody = JSON.stringify({
      data: [prompt || "A beautiful scenery", height || defaultHeight, width || defaultWidth, steps, seed, false]
    });

    const apiUrls = HuggingFaceConfig.apiUrls;
    
    if (!apiUrls || apiUrls.length === 0) {
      const err = new Error("HuggingFace 配置错误: 未配置任何文生图 API URL");
      error("HuggingFace", "文生图 API URL 资源池为空");
      logImageGenerationFailed("HuggingFace", requestId, "配置错误");
      logApiCallEnd("HuggingFace", apiType, false, Date.now() - startTime);
      throw err;
    }

    info("HuggingFace", `开始处理文生图请求，URL 资源池大小: ${apiUrls.length}`);

    let lastError: Error | null = null;
    
    for (let i = 0; i < apiUrls.length; i++) {
      const apiUrl = apiUrls[i];
      const isLastAttempt = i === apiUrls.length - 1;
      
      info("HuggingFace", `尝试文生图 URL [${i + 1}/${apiUrls.length}]: ${apiUrl}`);
      
      try {
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
        info("HuggingFace", `文生图任务已提交, Event ID: ${event_id}`);

        const resultResponse = await fetchWithTimeout(`${apiUrl}/gradio_api/call/generate_image/${event_id}`, {
          method: "GET",
          headers,
        });

        if (!resultResponse.ok) {
          const errorText = await resultResponse.text();
          throw new Error(`Result API Error (${resultResponse.status}): ${errorText}`);
        }

        const sseText = await resultResponse.text();
        const imageUrl = extractImageUrlFromSSE(sseText, apiUrl);
        
        if (!imageUrl) {
          throw new Error("返回数据格式异常：未能从 SSE 流中提取图片 URL");
        }

        info("HuggingFace", `📎 原始图片 URL: ${imageUrl}`);
        info("HuggingFace", `正在下载图片并转换为 Base64...`);
        
        let result: string;
        try {
          const { base64, mimeType } = await urlToBase64(imageUrl);
          const sizeKB = Math.round(base64.length / 1024);
          info("HuggingFace", `✅ 图片已转换为 Base64, MIME: ${mimeType}, 大小: ${sizeKB}KB`);
          result = `![Generated Image](data:${mimeType};base64,${base64})`;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          warn("HuggingFace", `❌ 图片转换 Base64 失败，使用 URL: ${msg}`);
          result = `![Generated Image](${imageUrl})`;
        }

        logGeneratedImages("HuggingFace", requestId, [{ url: imageUrl }]);
        const duration = Date.now() - startTime;
        logImageGenerationComplete("HuggingFace", requestId, 1, duration);
        
        info("HuggingFace", `✅ 文生图成功使用 URL: ${apiUrl}`);
        logApiCallEnd("HuggingFace", apiType, true, duration);
        return result;

      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        error("HuggingFace", `❌ 文生图 URL [${apiUrl}] 失败: ${lastError.message}`);
        
        if (!isLastAttempt) {
          info("HuggingFace", `🔄 正在切换到下一个文生图 URL...`);
        }
      }
    }

    const err = lastError || new Error("所有 HuggingFace 文生图 URL 均失败");
    error("HuggingFace", `💥 所有文生图 URL 均失败: ${err.message}`);
    logImageGenerationFailed("HuggingFace", requestId, `所有文生图 URL 均失败: ${err.message}`);
    logApiCallEnd("HuggingFace", apiType, false, Date.now() - startTime);
    throw err;
  }
}

/** 从 SSE 流中提取图片 URL */
function extractImageUrlFromSSE(sseStream: string, baseUrl?: string): string | null {
  const lines = sseStream.split('\n');
  let isCompleteEvent = false;
  let isErrorEvent = false;

  debug("HuggingFace", `SSE 流内容 (前500字符): ${sseStream.substring(0, 500)}`);

  for (const line of lines) {
    if (line.startsWith('event:')) {
      const eventType = line.substring(6).trim();
      if (eventType === 'complete') {
        isCompleteEvent = true;
        isErrorEvent = false;
      } else if (eventType === 'error') {
        isErrorEvent = true;
        isCompleteEvent = false;
      } else {
        isCompleteEvent = false;
        isErrorEvent = false;
      }
    } else if (line.startsWith('data:')) {
      const jsonData = line.substring(5).trim();
      
      if (isErrorEvent) {
        error("HuggingFace", `SSE 错误事件数据: ${jsonData}`);
        // 尝试解析错误详情
        try {
          const errObj = JSON.parse(jsonData);
          const errMsg = errObj.message || errObj.error || JSON.stringify(errObj);
          throw new Error(`HuggingFace API 错误: ${errMsg}`);
        } catch (parseErr) {
          if (parseErr instanceof Error && parseErr.message.startsWith("HuggingFace API 错误")) {
            throw parseErr;
          }
          throw new Error(`HuggingFace API 错误: ${jsonData}`);
        }
      }
      
      if (isCompleteEvent) {
        try {
          const data = JSON.parse(jsonData);
          if (data && data[0]) {
            if (typeof data[0] === 'object' && data[0].url) {
              info("HuggingFace", `从 SSE 提取到图片 URL: ${data[0].url.substring(0, 80)}...`);
              return data[0].url;
            }
            if (typeof data[0] === 'string') {
              const imagePath = data[0];
              let finalUrl = imagePath;
              if (imagePath.startsWith('/') && baseUrl) {
                finalUrl = `${baseUrl}/gradio_api/file=${imagePath}`;
              } else if (!imagePath.startsWith('http') && baseUrl) {
                finalUrl = `${baseUrl}/gradio_api/file=${imagePath}`;
              }
              info("HuggingFace", `从 SSE 提取到图片路径: ${finalUrl.substring(0, 80)}...`);
              return finalUrl;
            }
          }
          warn("HuggingFace", `SSE complete 事件数据格式无法识别: ${jsonData.substring(0, 200)}`);
        } catch (e) {
          error("HuggingFace", `解析 SSE 数据失败: ${e}, 原始数据: ${jsonData.substring(0, 200)}`);
        }
      }
    }
  }
  
  warn("HuggingFace", `SSE 流中未找到图片 URL，流长度: ${sseStream.length}`);
  return null;
}

/** Pollinations 文生图 - 使用简单的 GET 端点 */
async function pollinationsGenerateImage(
  apiKey: string,
  prompt: string,
  reqBody: ChatRequest
): Promise<string> {
  const model = reqBody.model || PollinationsConfig.defaultModel;
  const size = reqBody.size || PollinationsConfig.defaultSize;
  const [width, height] = size.split("x").map(Number);
  
  const encodedPrompt = encodeURIComponent(prompt);
  const url = `${PollinationsConfig.apiUrl}${PollinationsConfig.imageEndpoint}/${encodedPrompt}`;
  
  // 构建请求参数，使用配置中的特有参数
  const params = new URLSearchParams({
    model,
    width: String(width || 1024),
    height: String(height || 1024),
  });

  // 添加 Pollinations 参数（仅使用全局配置）
  // seed：按配置原样透传（-1 也直接传给服务端）；未配置则不传
  if (PollinationsConfig.seed !== undefined) params.set("seed", String(PollinationsConfig.seed));

  if (PollinationsConfig.quality !== undefined) params.set("quality", String(PollinationsConfig.quality));
  if (PollinationsConfig.transparent) params.set("transparent", "true");
  if (PollinationsConfig.guidanceScale !== undefined) params.set("guidance_scale", String(PollinationsConfig.guidanceScale));

  if (PollinationsConfig.nologo) params.set("nologo", "true");
  if (PollinationsConfig.enhance) params.set("enhance", "true");
  if (PollinationsConfig.negativePrompt) params.set("negative_prompt", PollinationsConfig.negativePrompt);
  if (PollinationsConfig.private) params.set("private", "true");
  if (PollinationsConfig.nofeed) params.set("nofeed", "true");
  if (PollinationsConfig.safe) params.set("safe", "true");
  
  const fullUrl = `${url}?${params.toString()}`;
  
  info("Pollinations", `请求 URL: ${fullUrl.substring(0, 100)}...`);
  
  const response = await fetchWithTimeout(fullUrl, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Pollinations API 错误 (${response.status}): ${errorText}`);
  }
  
  // GET 端点直接返回图片二进制，转换为 Base64
  const arrayBuffer = await response.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  
  let mimeType = detectImageMimeType(uint8Array);
  if (!mimeType) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.startsWith("image/")) {
      mimeType = contentType.split(";")[0].trim();
    } else {
      mimeType = "image/png";
    }
  }
  
  const base64 = encodeBase64(uint8Array);
  return `data:${mimeType};base64,${base64}`;
}

/** Pollinations 图生图 - 使用 GET /image 端点 + image 参数 */
async function pollinationsImageEdit(
  apiKey: string,
  prompt: string,
  images: string[],
  reqBody: ChatRequest
): Promise<string> {
  // 选择支持图片输入的模型
  let model = reqBody.model || PollinationsConfig.defaultEditModel;
  
  // 如果用户指定的模型不支持图生图，自动切换到默认图生图模型
  if (!PollinationsConfig.editModels.includes(model)) {
    info("Pollinations", `模型 ${model} 不支持图生图，切换到 ${PollinationsConfig.defaultEditModel}`);
    model = PollinationsConfig.defaultEditModel;
  }
  
  const size = reqBody.size || PollinationsConfig.defaultEditSize;
  const [width, height] = size.split("x").map(Number);
  
  // 使用 GET /image 端点，通过 image 参数传递图片 URL
  // 多张图片用 | 分隔
  const imageParam = images.join("|");
  
  const encodedPrompt = encodeURIComponent(prompt);
  const url = `${PollinationsConfig.apiUrl}${PollinationsConfig.imageEndpoint}/${encodedPrompt}`;
  
  // 构建请求参数
  const params = new URLSearchParams({
    model,
    width: String(width || 1024),
    height: String(height || 1024),
    image: imageParam,
  });

  // 添加 Pollinations 参数
  if (PollinationsConfig.seed !== undefined) params.set("seed", String(PollinationsConfig.seed));
  if (PollinationsConfig.quality !== undefined) params.set("quality", String(PollinationsConfig.quality));
  if (PollinationsConfig.transparent) params.set("transparent", "true");
  if (PollinationsConfig.guidanceScale !== undefined) params.set("guidance_scale", String(PollinationsConfig.guidanceScale));
  if (PollinationsConfig.nologo) params.set("nologo", "true");
  if (PollinationsConfig.enhance) params.set("enhance", "true");
  if (PollinationsConfig.negativePrompt) params.set("negative_prompt", PollinationsConfig.negativePrompt);
  if (PollinationsConfig.private) params.set("private", "true");
  if (PollinationsConfig.nofeed) params.set("nofeed", "true");
  if (PollinationsConfig.safe) params.set("safe", "true");
  
  const fullUrl = `${url}?${params.toString()}`;
  
  info("Pollinations", `图生图请求，模型: ${model}, 图片数: ${images.length}`);
  debug("Pollinations", `请求 URL: ${fullUrl.substring(0, 150)}...`);
  
  const response = await fetchWithTimeout(fullUrl, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Pollinations API 错误 (${response.status}): ${errorText}`);
  }
  
  // GET 端点直接返回图片二进制，转换为 Base64
  const arrayBuffer = await response.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  
  let mimeType = detectImageMimeType(uint8Array);
  if (!mimeType) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.startsWith("image/")) {
      mimeType = contentType.split(";")[0].trim();
    } else {
      mimeType = "image/png";
    }
  }
  
  const base64 = encodeBase64(uint8Array);
  return `data:${mimeType};base64,${base64}`;
}

/** Pollinations 图片生成 */
async function handlePollinations(
  apiKey: string,
  reqBody: ChatRequest,
  prompt: string,
  images: string[],
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  const hasImages = images.length > 0;
  const apiType = hasImages ? "image_edit" : "generate_image";
  logApiCallStart("Pollinations", apiType);
  
  logFullPrompt("Pollinations", requestId, prompt);
  if (images.length > 0) {
    logInputImages("Pollinations", requestId, images);
  }
  
  const model = reqBody.model || (hasImages ? PollinationsConfig.defaultEditModel : PollinationsConfig.defaultModel);
  const size = reqBody.size || PollinationsConfig.defaultSize;
  logImageGenerationStart("Pollinations", requestId, model, size, prompt.length);
  
  try {
    let imageData: string;
    
    if (hasImages) {
      // 图生图：使用 GET /image 端点 + image 参数，直接返回 data URL
      imageData = await pollinationsImageEdit(apiKey, prompt, images, reqBody);
    } else {
      // 文生图：使用 GET 端点，直接返回 data URL
      imageData = await pollinationsGenerateImage(apiKey, prompt, reqBody);
    }
    
    const result = `![Generated Image](${imageData})`;
    const duration = Date.now() - startTime;
    
    logApiCallEnd("Pollinations", apiType, true, duration);
    logGeneratedImages("Pollinations", requestId, [{ b64_json: imageData.substring(0, 100) + "..." }]);
    logImageGenerationComplete("Pollinations", requestId, 1, duration);
    
    return result;
    
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logApiCallEnd("Pollinations", apiType, false, Date.now() - startTime);
    logImageGenerationFailed("Pollinations", requestId, msg);
    throw e;
  }
}

async function handleChatCompletions(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = generateRequestId();

  logRequestStart(req, requestId);

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
    const requestBody: ImagesRequest = await req.json();
    const prompt = requestBody.prompt || "";
    const images: string[] = [];
    
    debug("Router", `Images API Prompt: ${prompt.substring(0, 80)}... (完整长度: ${prompt.length})`);

    let imageContent = "";
    
    // 将 ImagesRequest 转换为 ChatRequest 格式以复用现有处理函数
    const chatRequest: ChatRequest = {
      model: requestBody.model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      size: requestBody.size,
    };
    
    switch (provider) {
      case "VolcEngine":
        imageContent = await handleVolcEngine(apiKey, chatRequest, prompt, images, requestId);
        break;
      case "Gitee":
        imageContent = await handleGitee(apiKey, chatRequest, prompt, images, requestId);
        break;
      case "ModelScope":
        imageContent = await handleModelScope(apiKey, chatRequest, prompt, images, requestId);
        break;
      case "HuggingFace":
        imageContent = await handleHuggingFace(apiKey, chatRequest, prompt, images, requestId);
        break;
    }

    const startTime = Date.now();
    
    // 从 Markdown 格式提取图片 URL 或 Base64
    const imageMatches = imageContent.matchAll(/!\[.*?\]\(((?:https?:\/\/|data:image\/)[^\)]+)\)/g);
    const imageDataArray = [];
    
    for (const match of imageMatches) {
      const imageUrl = match[1];
      if (imageUrl.startsWith("data:image/")) {
        // Base64 格式
        const base64Data = imageUrl.split(",")[1];
        imageDataArray.push({
          b64_json: base64Data
        });
      } else {
        // URL 格式
        imageDataArray.push({
          url: imageUrl
        });
      }
    }

    // 返回 OpenAI Images API 格式
    const responseBody = JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: imageDataArray
    });

    info("HTTP", `响应完成 (Images API)`);
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

/** 处理 /v1/images/edits 端点 */
async function handleImagesEdits(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = generateRequestId();

  logRequestStart(req, requestId);

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

  info("HTTP", `路由到 ${provider} (图片编辑)`);

  try {
    // 解析 multipart/form-data 或 JSON
    const contentType = req.headers.get("content-type") || "";
    let prompt = "";
    const images: string[] = [];
    let requestBody: ChatRequest;

    if (contentType.includes("multipart/form-data")) {
      // 处理 multipart/form-data 格式
      const formData = await req.formData();
      prompt = formData.get("prompt") as string || "";
      const model = formData.get("model") as string || undefined;
      const size = formData.get("size") as string || undefined;
      
      // 提取图片文件
      const imageFile = formData.get("image");
      if (imageFile && imageFile instanceof File) {
        const arrayBuffer = await imageFile.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        const base64 = encodeBase64(uint8Array);
        const mimeType = imageFile.type || "image/png";
        images.push(`data:${mimeType};base64,${base64}`);
        info("HTTP", `从 multipart/form-data 提取图片: ${imageFile.name}, 大小: ${Math.round(uint8Array.length / 1024)}KB`);
      }

      requestBody = {
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        size,
      };
      
    } else {
      // 处理 JSON 格式（非标准，但兼容性处理）
      const jsonBody = await req.json();
      prompt = jsonBody.prompt || "";
      
      // 从 JSON 中提取图片（可能是 Base64 字符串）
      if (jsonBody.image) {
        if (typeof jsonBody.image === "string") {
          images.push(jsonBody.image);
        }
      }
      
      requestBody = {
        model: jsonBody.model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        size: jsonBody.size,
      };
    }
    
    debug("Router", `Images Edit API Prompt: ${prompt.substring(0, 80)}... (完整长度: ${prompt.length})`);
    debug("Router", `Images count: ${images.length}`);

    let imageContent = "";
    
    switch (provider) {
      case "VolcEngine":
        imageContent = await handleVolcEngine(apiKey, requestBody, prompt, images, requestId);
        break;
      case "Gitee":
        imageContent = await handleGitee(apiKey, requestBody, prompt, images, requestId);
        break;
      case "ModelScope":
        imageContent = await handleModelScope(apiKey, requestBody, prompt, images, requestId);
        break;
      case "HuggingFace":
        imageContent = await handleHuggingFace(apiKey, requestBody, prompt, images, requestId);
        break;
    }

    const startTime = Date.now();
    
    // 从 Markdown 格式提取图片 URL 或 Base64
    const imageMatches = imageContent.matchAll(/!\[.*?\]\(((?:https?:\/\/|data:image\/)[^\)]+)\)/g);
    const imageDataArray = [];
    
    for (const match of imageMatches) {
      const imageUrl = match[1];
      if (imageUrl.startsWith("data:image/")) {
        // Base64 格式
        const base64Data = imageUrl.split(",")[1];
        imageDataArray.push({
          b64_json: base64Data
        });
      } else {
        // URL 格式
        imageDataArray.push({
          url: imageUrl
        });
      }
    }

    // 返回 OpenAI Images API 格式
    const responseBody = JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: imageDataArray
    });

    info("HTTP", `响应完成 (Images Edit API)`);
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

/** 处理 /v1/chat/completions 端点 */
async function handleChatCompletions(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = generateRequestId();

  logRequestStart(req, requestId);

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
    
    // 🎯 一劳永逸：统一标准化所有消息格式
    if (requestBody.messages && Array.isArray(requestBody.messages)) {
      requestBody.messages = requestBody.messages.map(msg => ({
        ...msg,
        content: normalizeMessageContent(msg.content)
      }));
    }
    
    const isStream = requestBody.stream === true;
    const { prompt, images } = extractPromptAndImages(requestBody.messages || []);

    debug("Router", `提取 Prompt: ${prompt?.substring(0, 80)}... (完整长度: ${prompt?.length || 0})`);

    let imageContent = "";
    
    switch (provider) {
      case "VolcEngine":
        imageContent = await handleVolcEngine(apiKey, requestBody, prompt, images, requestId);
        break;
      case "Gitee":
        imageContent = await handleGitee(apiKey, requestBody, prompt, images, requestId);
        break;
      case "ModelScope":
        imageContent = await handleModelScope(apiKey, requestBody, prompt, images, requestId);
        break;
      case "HuggingFace":
        imageContent = await handleHuggingFace(apiKey, requestBody, prompt, images, requestId);
        break;
      case "Pollinations":
        imageContent = await handlePollinations(apiKey, requestBody, prompt, images, requestId);
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

/** 主路由函数：根据路径分发到对应的处理函数 */
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  
  // 健康检查端点
  if (url.pathname === "/" || url.pathname === "/health") {
    return new Response(JSON.stringify({
      status: "ok",
      service: "img-router",
      endpoints: ["/v1/chat/completions", "/v1/images/generations", "/v1/images/edits"]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  
  // 路由到对应的处理函数
  if (url.pathname === "/v1/chat/completions") {
    return await handleChatCompletions(req);
  } else if (url.pathname === "/v1/images/generations") {
    return await handleImagesGenerations(req);
  } else if (url.pathname === "/v1/images/edits") {
    return await handleImagesEdits(req);
  } else {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/** 读取版本号 */
async function getVersion(): Promise<string> {
  try {
    const denoJson = await Deno.readTextFile("./deno.json");
    const config = JSON.parse(denoJson);
    return config.version || "unknown";
  } catch {
    return "unknown";
  }
}

await initLogger();

const logLevel = Deno.env.get("LOG_LEVEL")?.toUpperCase();
if (logLevel && logLevel in LogLevel) {
  configureLogger({ level: LogLevel[logLevel as keyof typeof LogLevel] });
}

const version = await getVersion();
info("Startup", `🚀 服务启动端口 ${PORT}`);
info("Startup", `📦 版本: ${version}`);
info("Startup", "🔧 支持: 火山引擎, Gitee, ModelScope, HuggingFace, Pollinations");
info("Startup", "📡 端点: /v1/chat/completions, /v1/images/generations, /v1/images/edits");
info("Startup", `📁 日志目录: ./data/logs`);

Deno.addSignalListener("SIGINT", async () => {
  info("Startup", "收到 SIGINT, 关闭服务...");
  await closeLogger();
  Deno.exit(0);
});

// Windows 不支持 SIGTERM，仅在非 Windows 系统上监听
// 感谢 @johnnyee 在 PR #3 中提出的修复方案
if (Deno.build.os !== "windows") {
  Deno.addSignalListener("SIGTERM", async () => {
    info("Startup", "收到 SIGTERM, 关闭服务...");
    await closeLogger();
    Deno.exit(0);
  });
}

Deno.serve({ port: PORT }, (req: Request) => {
  const url = new URL(req.url);
  
  // 健康检查端点允许 GET 请求
  if ((url.pathname === "/" || url.pathname === "/health") && req.method === "GET") {
    return new Response(JSON.stringify({
      status: "ok",
      service: "img-router",
      endpoints: ["/v1/chat/completions", "/v1/images/generations", "/v1/images/edits"]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      }
    });
  }

  if (req.method !== "POST") {
    warn("HTTP", `不支持 ${req.method}`);
    return new Response("Method Not Allowed", { status: 405 });
  }

  return handleRequest(req);
});
