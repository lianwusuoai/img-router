/**
 * HuggingFace Provider 实现
 *
 * 基于 Hugging Face Gradio API 实现。
 * 支持文生图和图生图功能。
 * 特点：
 * 1. 使用 Gradio 的 SSE (Server-Sent Events) 协议与 API 交互。
 * 2. 支持多 URL 故障转移 (Failover) 机制，提高服务可用性。
 * 3. 实现了复杂的 Prompt 清洗和 SSE 数据解析逻辑。
 */

import {
  BaseProvider,
  type GenerationOptions,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderName,
} from "./base.ts";
import type { GenerationResult, ImageGenerationRequest } from "../types/index.ts";
import { HuggingFaceConfig } from "../config/manager.ts";
import { fetchWithTimeout } from "../utils/index.ts";
import { urlToBase64 } from "../utils/image.ts";
import {
  debug,
  error,
  info,
  logFullPrompt,
  logGeneratedImages,
  logImageGenerationComplete,
  logImageGenerationFailed,
  logImageGenerationStart,
  logInputImages,
  warn,
} from "../core/logger.ts";
import { withApiTiming } from "../middleware/timing.ts";

/** 
 * 将图片（URL 或 Base64）转换为 Blob 对象
 * 用于上传到 Gradio 服务器。
 *
 * @param imageSource - 图片源字符串（Data URI 或 HTTP URL）
 * @returns Blob 对象 Promise
 */
async function imageToBlob(imageSource: string): Promise<Blob> {
  if (imageSource.startsWith("data:image/")) {
    const parts = imageSource.split(",");
    const base64Content = parts[1];
    const mimeType = parts[0].split(";")[0].split(":")[1];
    const binaryData = Uint8Array.from(atob(base64Content), (c) => c.charCodeAt(0));
    return new Blob([binaryData], { type: mimeType });
  } else if (imageSource.startsWith("http")) {
    const response = await fetchWithTimeout(imageSource, { method: "GET" });
    if (!response.ok) throw new Error(`下载图片失败: ${response.status}`);
    return await response.blob();
  } else {
    // 假设是纯 Base64 字符串，默认为 PNG
    const binaryData = Uint8Array.from(atob(imageSource), (c) => c.charCodeAt(0));
    return new Blob([binaryData], { type: "image/png" });
  }
}

/** 
 * 简单的 Prompt 清洗函数 
 * 去除可能导致 Gradio 接口报错的控制字符。
 */
function sanitizePrompt(prompt: string): string {
  // 替换所有控制字符（0-31 和 127）为空格，然后去除首尾空格
  // 这可以解决由于换行符、制表符等导致的 Gradio 错误
  // deno-lint-ignore no-control-regex
  return prompt.replace(/[\x00-\x1F\x7F]/g, " ").trim();
}

/** 
 * 从 SSE 流中提取图片 URL
 * 解析 Gradio 协议的 SSE 数据流，查找生成的图片路径。
 *
 * @param sseStream - SSE 响应文本
 * @param baseUrl - API 基础 URL，用于拼接相对路径
 * @returns 提取到的完整图片 URL，若未找到返回 null
 */
function extractImageUrlFromSSE(sseStream: string, baseUrl?: string): string | null {
  const lines = sseStream.split("\n");
  let isCompleteEvent = false;
  let isErrorEvent = false;

  debug("HuggingFace", `SSE 流内容 (前500字符): ${sseStream.substring(0, 500)}`);

  for (const line of lines) {
    if (line.startsWith("event:")) {
      const eventType = line.substring(6).trim();
      isCompleteEvent = eventType === "complete";
      isErrorEvent = eventType === "error";
    } else if (line.startsWith("data:")) {
      const jsonData = line.substring(5).trim();

      if (isErrorEvent) {
        error("HuggingFace", `SSE 错误事件数据: ${jsonData}`);
        try {
          const errObj = JSON.parse(jsonData);
          if (errObj === null) {
            throw new Error(
              "服务端返回未知错误 (null)，可能是服务暂时不可用、Prompt 包含不支持字符或触发了安全过滤",
            );
          }
          throw new Error(
            `HuggingFace API 错误: ${errObj.message || errObj.error || JSON.stringify(errObj)}`,
          );
        } catch (parseErr) {
          if (parseErr instanceof Error && parseErr.message.startsWith("服务端返回")) {
            throw parseErr;
          }
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
            // 情况 1: 返回对象包含 url 属性
            if (typeof data[0] === "object" && data[0].url) {
              info("HuggingFace", `从 SSE 提取到图片 URL: ${data[0].url.substring(0, 80)}...`);
              return data[0].url;
            }
            // 情况 2: 返回字符串路径
            if (typeof data[0] === "string") {
              const imagePath = data[0];
              let finalUrl = imagePath;
              // 处理相对路径
              if (imagePath.startsWith("/") && baseUrl) {
                finalUrl = `${baseUrl}/gradio_api/file=${imagePath}`;
              } else if (!imagePath.startsWith("http") && baseUrl) {
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

/**
 * HuggingFace Provider 实现类
 * 
 * 封装了对 Hugging Face Space 上 Gradio 应用的调用。
 * 核心功能是管理多个 API URL 的故障转移。
 */
export class HuggingFaceProvider extends BaseProvider {
  /** Provider 名称标识 */
  readonly name: ProviderName = "HuggingFace";

  /**
   * Provider 能力描述
   */
  readonly capabilities: ProviderCapabilities = {
    textToImage: true,      // 支持文生图
    imageToImage: true,     // 支持图生图
    multiImageFusion: true, // 支持多图融合
    asyncTask: true,        // 实际上是长连接等待，被视为异步
    maxInputImages: 3,      // 最多支持 3 张输入图片
    maxOutputImages: 1,     // 最多支持生成 1 张图片
    maxEditOutputImages: 1,
    maxBlendOutputImages: 1,
    outputFormats: ["url", "b64_json"], // 支持 URL 和 Base64 输出
  };

  /**
   * Provider 配置信息
   */
  readonly config: ProviderConfig = {
    apiUrl: HuggingFaceConfig.apiUrls[0] || "",
    textModels: HuggingFaceConfig.textModels,
    defaultModel: HuggingFaceConfig.defaultModel,
    defaultSize: HuggingFaceConfig.defaultSize,
    editModels: HuggingFaceConfig.editModels,
    defaultEditModel: HuggingFaceConfig.defaultEditModel,
    defaultEditSize: HuggingFaceConfig.defaultEditSize,
  };

  /**
   * 检测 API Key 是否属于 HuggingFace
   * 通常以 "hf_" 开头
   */
  override detectApiKey(apiKey: string): boolean {
    return apiKey.startsWith("hf_");
  }

  /**
   * 执行图片生成请求
   * 
   * 根据是否有输入图片，分发到文生图或图生图处理逻辑。
   */
  override async generate(
    apiKey: string,
    request: ImageGenerationRequest,
    options: GenerationOptions,
  ): Promise<GenerationResult> {
    const startTime = Date.now();
    const { requestId } = options;
    const hasImages = request.images && request.images.length > 0;
    const prompt = request.prompt || "";
    const images = request.images || [];

    logFullPrompt("HuggingFace", requestId, prompt);
    if (hasImages) logInputImages("HuggingFace", requestId, images);

    const headers: Record<string, string> = { 
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    if (hasImages) {
      return await this.generateImageToImage(apiKey, request, options, startTime, headers);
    } else {
      return await this.generateTextToImage(request, options, startTime, headers);
    }
  }

  /**
   * 处理文生图请求
   * 
   * 特性：
   * 1. 遍历配置的 API URL 列表进行尝试（故障转移）。
   * 2. 提交任务 -> 获取 Event ID -> 获取结果 (SSE)。
   */
  private async generateTextToImage(
    request: ImageGenerationRequest,
    options: GenerationOptions,
    startTime: number,
    headers: Record<string, string>,
  ): Promise<GenerationResult> {
    const { requestId } = options;
    const rawPrompt = request.prompt || "A beautiful scenery";
    const prompt = sanitizePrompt(rawPrompt);
    const model = HuggingFaceConfig.defaultModel;
    const size = request.size || HuggingFaceConfig.defaultSize;
    const [width, height] = size.split("x").map(Number);
    const seed = Math.round(Math.random() * 2147483647);

    logImageGenerationStart("HuggingFace", requestId, model, size, prompt.length);
    info("HuggingFace", `使用文生图模式, 模型: ${model}`);
    if (prompt !== rawPrompt) {
      info("HuggingFace", `Prompt 已清洗 (原长度: ${rawPrompt.length}, 新长度: ${prompt.length})`);
    }

    const [defaultWidth, defaultHeight] = HuggingFaceConfig.defaultSize.split("x").map(Number);
    // Gradio API 的参数数组
    const requestBody = JSON.stringify({
      data: [prompt, height || defaultHeight, width || defaultWidth, 9, seed, false],
    });
    
    debug("HuggingFace", `Request Body: ${requestBody}`);

    const apiUrls = HuggingFaceConfig.apiUrls;
    if (!apiUrls || apiUrls.length === 0) {
      error("HuggingFace", "文生图 API URL 资源池为空");
      logImageGenerationFailed("HuggingFace", requestId, "配置错误");
      return {
        success: false,
        error: "HuggingFace 配置错误: 未配置任何文生图 API URL",
        duration: Date.now() - startTime,
      };
    }

    info("HuggingFace", `开始处理文生图请求，URL 资源池大小: ${apiUrls.length}`);

    let lastError: Error | null = null;

    // 故障转移循环
    for (let i = 0; i < apiUrls.length; i++) {
      const apiUrl = apiUrls[i];
      const isLastAttempt = i === apiUrls.length - 1;

      info("HuggingFace", `尝试文生图 URL [${i + 1}/${apiUrls.length}]: ${apiUrl}`);

      try {
        // 1. 提交任务到队列
        const queueResponse = await withApiTiming(
          "HuggingFace",
          "generate_image",
          () =>
            fetchWithTimeout(`${apiUrl}/gradio_api/call/generate_image`, {
              method: "POST",
              headers,
              body: requestBody,
            }),
        );

        if (!queueResponse.ok) {
          const errorText = await queueResponse.text();
          throw new Error(`API Error (${queueResponse.status}): ${errorText}`);
        }

        const { event_id } = await queueResponse.json();
        info("HuggingFace", `文生图任务已提交, Event ID: ${event_id}`);

        // 2. 获取任务结果（返回 SSE 流）
        const resultResponse = await fetchWithTimeout(
          `${apiUrl}/gradio_api/call/generate_image/${event_id}`,
          {
            method: "GET",
            headers,
          },
        );

        if (!resultResponse.ok) {
          const errorText = await resultResponse.text();
          throw new Error(`Result API Error (${resultResponse.status}): ${errorText}`);
        }

        // 3. 解析 SSE 流获取图片 URL
        const sseText = await resultResponse.text();
        const imageUrl = extractImageUrlFromSSE(sseText, apiUrl);

        if (!imageUrl) throw new Error("返回数据格式异常：未能从 SSE 流中提取图片 URL");

        info("HuggingFace", `📎 原始图片 URL: ${imageUrl}`);

        // 4. 将结果转换为 Base64
        let result: Array<{ url?: string; b64_json?: string }>;
        try {
          const { base64, mimeType } = await urlToBase64(imageUrl);
          info(
            "HuggingFace",
            `✅ 图片已转换为 Base64, MIME: ${mimeType}, 大小: ${
              Math.round(base64.length / 1024)
            }KB`,
          );
          result = [{ b64_json: base64 }];
        } catch (e) {
          warn(
            "HuggingFace",
            `❌ 图片转换 Base64 失败，使用 URL: ${e instanceof Error ? e.message : String(e)}`,
          );
          result = [{ url: imageUrl }];
        }

        logGeneratedImages("HuggingFace", requestId, [{ url: imageUrl }]);
        const duration = Date.now() - startTime;
        logImageGenerationComplete("HuggingFace", requestId, 1, duration);

        info("HuggingFace", `✅ 文生图成功使用 URL: ${apiUrl}`);
        return { success: true, images: result, duration };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        error("HuggingFace", `❌ 文生图 URL [${apiUrl}] 失败: ${lastError.message}`);
        if (!isLastAttempt) info("HuggingFace", `🔄 正在切换到下一个文生图 URL...`);
      }
    }

    const errMsg = lastError?.message || "所有 HuggingFace 文生图 URL 均失败";
    error("HuggingFace", `💥 所有文生图 URL 均失败: ${errMsg}`);
    logImageGenerationFailed("HuggingFace", requestId, errMsg);
    return { success: false, error: errMsg, duration: Date.now() - startTime };
  }

  /**
   * 处理图生图请求
   * 
   * 特性：
   * 1. 同样支持多 URL 故障转移。
   * 2. 需要先将图片上传到 Gradio 服务器，获取内部路径。
   * 3. 调用 /infer 端点进行生成。
   */
  private async generateImageToImage(
    apiKey: string,
    request: ImageGenerationRequest,
    options: GenerationOptions,
    startTime: number,
    headers: Record<string, string>,
  ): Promise<GenerationResult> {
    const { requestId } = options;
    const rawPrompt = request.prompt || "";
    const prompt = sanitizePrompt(rawPrompt);
    const images = request.images || [];
    const model = HuggingFaceConfig.defaultEditModel;
    const size = request.size || HuggingFaceConfig.defaultEditSize;
    const [width, height] = size.split("x").map(Number);

    logImageGenerationStart("HuggingFace", requestId, model, size, prompt.length);
    info("HuggingFace", `使用图生图/融合生图模式, 模型: ${model}, 图片数量: ${images.length}`);
    if (prompt !== rawPrompt) {
      info("HuggingFace", `Prompt 已清洗 (原长度: ${rawPrompt.length}, 新长度: ${prompt.length})`);
    }

    const editApiUrls = HuggingFaceConfig.editApiUrls;
    if (!editApiUrls || editApiUrls.length === 0) {
      error("HuggingFace", "图生图 API URL 资源池为空");
      logImageGenerationFailed("HuggingFace", requestId, "配置错误");
      return {
        success: false,
        error: "HuggingFace 配置错误: 未配置图生图 API URL",
        duration: Date.now() - startTime,
      };
    }

    info("HuggingFace", `开始处理图生图请求，URL 资源池大小: ${editApiUrls.length}`);

    // 转换图片为 Blob
    const imageBlobs: (Blob | null)[] = [null, null, null];
    for (let i = 0; i < Math.min(images.length, 3); i++) {
      try {
        info("HuggingFace", `正在转换图片 ${i + 1}/${Math.min(images.length, 3)} 为 Blob...`);
        imageBlobs[i] = await imageToBlob(images[i]);
        info(
          "HuggingFace",
          `✅ 图片 ${i + 1} 转换成功, 大小: ${Math.round((imageBlobs[i] as Blob).size / 1024)}KB`,
        );
      } catch (e) {
        warn(
          "HuggingFace",
          `❌ 图片 ${i + 1} 转换失败: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    if (!imageBlobs[0]) {
      error("HuggingFace", "所有输入图片转换失败");
      logImageGenerationFailed("HuggingFace", requestId, "图片转换失败");
      return { success: false, error: "没有有效的输入图片", duration: Date.now() - startTime };
    }

    let lastError: Error | null = null;

    // 故障转移循环
    for (let i = 0; i < editApiUrls.length; i++) {
      const apiUrl = editApiUrls[i];
      const isLastAttempt = i === editApiUrls.length - 1;

      info("HuggingFace", `尝试图生图 URL [${i + 1}/${editApiUrls.length}]: ${apiUrl}`);

      try {
        // 1. 上传图片到 Gradio 服务器
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

            if (!uploadResponse.ok) throw new Error(`图片上传失败: ${uploadResponse.status}`);

            const uploadResult = await uploadResponse.json();
            if (Array.isArray(uploadResult) && uploadResult.length > 0) {
              uploadedFiles[j] = uploadResult[0];
              info("HuggingFace", `✅ 图片 ${j + 1} 上传成功: ${uploadedFiles[j]}`);
            }
          }
        }

        const [defaultWidth, defaultHeight] = HuggingFaceConfig.defaultEditSize.split("x").map(
          Number,
        );

        // 2. 构造推理请求
        const inferRequest = {
          data: [
            uploadedFiles[0]
              ? { path: uploadedFiles[0], meta: { _type: "gradio.FileData" } }
              : null,
            uploadedFiles[1]
              ? { path: uploadedFiles[1], meta: { _type: "gradio.FileData" } }
              : null,
            uploadedFiles[2]
              ? { path: uploadedFiles[2], meta: { _type: "gradio.FileData" } }
              : null,
            prompt || "",
            0,
            true,
            1,
            4,
            height || defaultHeight,
            width || defaultWidth,
          ],
        };

        info("HuggingFace", `正在调用 /infer 端点...`);

        // 3. 提交推理任务
        const queueResponse = await withApiTiming(
          "HuggingFace",
          "image_edit",
          () =>
            fetchWithTimeout(`${apiUrl}/gradio_api/call/infer`, {
              method: "POST",
              headers,
              body: JSON.stringify(inferRequest),
            }),
        );

        if (!queueResponse.ok) {
          const errorText = await queueResponse.text();
          throw new Error(`Infer API Error (${queueResponse.status}): ${errorText}`);
        }

        const { event_id } = await queueResponse.json();
        info("HuggingFace", `图生图任务已提交, Event ID: ${event_id}`);

        // 4. 获取结果 (SSE)
        const resultResponse = await fetchWithTimeout(
          `${apiUrl}/gradio_api/call/infer/${event_id}`,
          {
            method: "GET",
            headers: apiKey ? { "Authorization": `Bearer ${apiKey}` } : {},
          },
        );

        if (!resultResponse.ok) {
          const errorText = await resultResponse.text();
          throw new Error(`Result API Error (${resultResponse.status}): ${errorText}`);
        }

        const sseText = await resultResponse.text();
        const imageUrl = extractImageUrlFromSSE(sseText, apiUrl);

        if (!imageUrl) throw new Error("返回数据格式异常：未能从 SSE 流中提取图片 URL");

        info("HuggingFace", `📎 原始图片 URL: ${imageUrl}`);

        // 5. 将结果转换为 Base64
        let result: Array<{ url?: string; b64_json?: string }>;
        try {
          const { base64, mimeType } = await urlToBase64(imageUrl);
          info(
            "HuggingFace",
            `✅ 图片已转换为 Base64, MIME: ${mimeType}, 大小: ${
              Math.round(base64.length / 1024)
            }KB`,
          );
          result = [{ b64_json: base64 }];
        } catch (e) {
          warn(
            "HuggingFace",
            `❌ 图片转换 Base64 失败，使用 URL: ${e instanceof Error ? e.message : String(e)}`,
          );
          result = [{ url: imageUrl }];
        }

        logGeneratedImages("HuggingFace", requestId, [{ url: imageUrl }]);
        const duration = Date.now() - startTime;
        logImageGenerationComplete("HuggingFace", requestId, 1, duration);

        info("HuggingFace", `✅ 图生图成功使用 URL: ${apiUrl}`);
        return { success: true, images: result, duration };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        error("HuggingFace", `❌ 图生图 URL [${apiUrl}] 失败: ${lastError.message}`);
        if (!isLastAttempt) info("HuggingFace", `🔄 正在切换到下一个图生图 URL...`);
      }
    }

    const errMsg = lastError?.message || "所有 HuggingFace 图生图 URL 均失败";
    error("HuggingFace", `💥 所有图生图 URL 均失败: ${errMsg}`);
    logImageGenerationFailed("HuggingFace", requestId, errMsg);
    return { success: false, error: errMsg, duration: Date.now() - startTime };
  }
}

// 导出单例实例
export const huggingFaceProvider = new HuggingFaceProvider();
