/**
 * Gitee（模力方舟）Provider 实现
 *
 * 基于 Gitee AI 平台 API 实现。
 * 支持文生图、图片编辑（同步）、图片编辑（异步）以及融合生图模式。
 * 
 * 优化重点 (遵循 Gitee_AI_接口逻辑优化指南):
 * 1. 全量 Base64 返回：强制所有接口使用 response_format="b64_json"，严禁返回 URL。
 * 2. 异步/同步自动聚合：根据模型 ID 自动路由到对应接口。
 * 3. 多图并行上传：支持多张图片通过 FormData 上传。
 * 4. 融合生图支持：复用编辑模型逻辑，支持上下文图片合并。
 */

import {
  BaseProvider,
  type GenerationOptions,
  type ProviderCapabilities,
  type ProviderConfig,
} from "./base.ts";
import type { 
  GenerationResult, 
  ImageData, 
  ImageGenerationRequest, 
  MessageContentItem,
  Message,
  NonStandardImageContentItem,
  ImagesBlendRequest 
} from "../types/index.ts";
import { GiteeConfig } from "../config/manager.ts";
import { getProviderTaskDefaults } from "../config/manager.ts";
import { fetchWithTimeout, urlToBase64 } from "../utils/index.ts";
import { parseErrorMessage } from "../core/error-handler.ts";
import {
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
 * Gitee Provider 实现类
 * 
 * 封装了 Gitee AI 平台的文生图和图生图接口。
 * 根据模型类型自动选择同步或异步处理流程。
 */
export class GiteeProvider extends BaseProvider {
  /** Provider 名称标识 */
  readonly name = "Gitee" as const;

  /**
   * Provider 能力描述
   */
  readonly capabilities: ProviderCapabilities = {
    textToImage: true,      // 支持文生图
    imageToImage: true,     // 支持图生图
    multiImageFusion: true, // 支持多图融合
    asyncTask: true,        // 支持异步任务（轮询）
    maxInputImages: 5,      // 最多支持 5 张输入图片
    maxOutputImages: 1,     // 文生图上限 (Gitee 官方限制为 1)
    maxEditOutputImages: 1, // 图生图上限 (Gitee 官方限制为 1)
    maxBlendOutputImages: 1, // 融合上限 (Gitee 官方限制为 1)
    outputFormats: ["b64_json"], // 仅支持 Base64 输出 (优化指南要求)
  };

  /**
   * Provider 配置信息
   */
  readonly config: ProviderConfig = {
    apiUrl: GiteeConfig.apiUrl,
    textModels: Array.from(new Set([...GiteeConfig.textModels, ...GiteeConfig.asyncTextModels])),
    defaultModel: GiteeConfig.defaultModel,
    defaultSize: GiteeConfig.defaultSize,
    editModels: [...GiteeConfig.editModels, ...GiteeConfig.asyncEditModels], // 合并同步和异步编辑模型
    blendModels: [...GiteeConfig.editModels, ...GiteeConfig.asyncEditModels], // 融合生图模型等同于编辑模型
    defaultEditModel: GiteeConfig.defaultEditModel,
    defaultEditSize: GiteeConfig.defaultEditSize,
  };

  constructor() {
    super();
    console.log("[GiteeProvider] Initializing...");
    console.log("[GiteeProvider] Raw GiteeConfig:", JSON.stringify(GiteeConfig, null, 2));
    console.log("[GiteeProvider] Merged Config:", JSON.stringify(this.config, null, 2));
  }

  /**
   * 检测 API Key 是否属于 Gitee
   * Gitee API Key 通常是 30-60 位的字母数字组合
   */
  override detectApiKey(apiKey: string): boolean {
    const giteeRegex = /^[a-zA-Z0-9]{30,60}$/;
    return giteeRegex.test(apiKey);
  }

  /**
   * 执行图片生成请求
   * 
   * 核心分发逻辑：
   * 1. 自动识别同步/异步模型。
   * 2. 分发到 handleTextToImage, handleSyncEdit 或 handleAsyncEdit。
   */
  override async generate(
    apiKey: string,
    request: ImageGenerationRequest,
    options: GenerationOptions,
  ): Promise<GenerationResult> {
    const startTime = Date.now();
    const hasImages = request.images.length > 0;

    const normalizedRequest: ImageGenerationRequest = { ...request };

    logFullPrompt("Gitee", options.requestId, normalizedRequest.prompt);

    if (hasImages) {
      logInputImages("Gitee", options.requestId, normalizedRequest.images);
    }

    try {
      if (hasImages) {
        const selectedModel = this.selectModel(normalizedRequest.model, true);
        const isAsyncModel = GiteeConfig.asyncEditModels.includes(selectedModel);
        const taskDefaults = getProviderTaskDefaults("Gitee", "edit");
        const size = normalizedRequest.size || taskDefaults.size ||
          (isAsyncModel ? GiteeConfig.defaultAsyncEditSize : GiteeConfig.defaultEditSize);
        const n = normalizedRequest.n ?? taskDefaults.n ?? 1;

        const requestWithDefaults: ImageGenerationRequest = {
          ...normalizedRequest,
          model: selectedModel,
          size,
          n,
        };

        // 检查是否为异步编辑模型
        if (isAsyncModel) {
          return await this.handleAsyncEdit(apiKey, requestWithDefaults, options, size, startTime);
        } else {
          return await this.handleSyncEdit(apiKey, requestWithDefaults, options, size, startTime);
        }
      } else {
        const model = this.selectModel(normalizedRequest.model, false);
        const isAsyncTextModel = GiteeConfig.asyncTextModels.includes(model);
        const taskDefaults = getProviderTaskDefaults("Gitee", "text");
        const size = normalizedRequest.size || taskDefaults.size || GiteeConfig.defaultSize;
        const n = normalizedRequest.n ?? taskDefaults.n ?? 1;

        const requestWithDefaults: ImageGenerationRequest = {
          ...normalizedRequest,
          model,
          size,
          n,
        };
        if (isAsyncTextModel) {
          return await this.handleAsyncTextToImage(apiKey, requestWithDefaults, options, size, startTime);
        }

        return await this.handleTextToImage(apiKey, requestWithDefaults, options, size, startTime);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      return {
        success: false,
        error: errorMessage,
        model: normalizedRequest.model || this.config.defaultModel,
        provider: "Gitee",
      };
    }
  }

  /**
   * 融合生图 (Blend) 实现
   * 
   * 指南场景 E：基于编辑模型的深度定制。
   * 逻辑：提取 Messages 中的所有图片和 Prompt，转换为标准 ImageGenerationRequest，
   * 然后复用 generate 方法的自动分发逻辑 (同步/异步)。
   */
  override blend(
    apiKey: string,
    request: ImagesBlendRequest,
    options: GenerationOptions,
  ): Promise<GenerationResult> {
    const { prompt, images } = this.extractPromptAndImagesFromMessages(request.messages);
    const finalPrompt = request.prompt || prompt || "";

    return this.generate(apiKey, {
      prompt: finalPrompt,
      images,
      model: request.model,
      n: request.n,
      size: request.size,
      response_format: "b64_json",
    }, options);
  }

  /**
   * 从消息列表中提取 Prompt 和图片
   */
  private extractPromptAndImagesFromMessages(messages: Message[]): { prompt: string; images: string[] } {
    const images: string[] = [];

    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const item of msg.content) {
        if (item.type === "image_url" && item.image_url?.url) {
          images.push(item.image_url.url);
        }
        if (item.type === "image") {
          const nonStandard = item as NonStandardImageContentItem;
          const mediaType = nonStandard.mediaType || "image/png";
          const base64Str = nonStandard.image;
          images.push(base64Str.startsWith("data:") ? base64Str : `data:${mediaType};base64,${base64Str}`);
        }
      }
    }

    const prompt = this.extractPromptFromLastUserMessage(messages);
    return { prompt, images };
  }

  private extractPromptFromLastUserMessage(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.role !== "user") continue;

      if (typeof msg.content === "string") return msg.content.trim();
      if (Array.isArray(msg.content)) {
        const parts: string[] = [];
        for (const item of msg.content as MessageContentItem[]) {
          if (item.type === "text") parts.push(item.text);
        }
        return parts.join(" ").trim();
      }
    }
    return "";
  }

  /**
   * 处理文生图请求
   * 强制 response_format: "b64_json"
   */
  private async handleTextToImage(
    apiKey: string,
    request: ImageGenerationRequest,
    options: GenerationOptions,
    size: string,
    startTime: number,
  ): Promise<GenerationResult> {
    const model = request.model || this.selectModel(request.model, false);

    logImageGenerationStart("Gitee", options.requestId, model, size, request.prompt.length);
    info("Gitee", `文生图模式 (强制 Base64), 模型: ${model}`);

    const giteeRequest = {
      model,
      prompt: request.prompt,
      n: 1, // 核心优化：Gitee 官方限制文生图数量只能为 1
      size,
      response_format: "b64_json", // 核心优化：直接请求 Base64
    };

    const response = await withApiTiming(
      "Gitee",
      "generate_image",
      () =>
        fetchWithTimeout(GiteeConfig.apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify(giteeRequest),
        }, options.timeoutMs),
    );

    if (!response.ok) {
      const errorText = await response.text();
      const friendlyError = parseErrorMessage(errorText, response.status, "Gitee");
      logImageGenerationFailed("Gitee", options.requestId, friendlyError);
      throw new Error(friendlyError);
    }

    const data = await response.json();
    const imageData: ImageData[] = data.data || [];

    if (!imageData || imageData.length === 0) {
      throw new Error("Gitee 返回数据为空");
    }

    logGeneratedImages("Gitee", options.requestId, imageData);

    const duration = Date.now() - startTime;
    logImageGenerationComplete("Gitee", options.requestId, imageData.length, duration);

    // 直接返回，不再进行 URL 转换
    return {
      success: true,
      images: imageData,
      model,
      provider: "Gitee",
    };
  }

  private async handleAsyncTextToImage(
    apiKey: string,
    request: ImageGenerationRequest,
    options: GenerationOptions,
    size: string,
    startTime: number,
  ): Promise<GenerationResult> {
    const model = request.model || this.selectModel(request.model, false);

    logImageGenerationStart("Gitee", options.requestId, model, size, request.prompt.length);
    info("Gitee", `异步文生图模式 (强制 Base64), 模型: ${model}`);

    const submitResponse = await withApiTiming(
      "Gitee",
      "generate_image_async_submit",
      () =>
        fetchWithTimeout(GiteeConfig.asyncApiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            prompt: request.prompt,
            n: 1, // 核心优化：Gitee 官方限制异步文生图数量只能为 1
            size,
            response_format: "b64_json",
          }),
        }, options.timeoutMs),
    );

    if (!submitResponse.ok) {
      const errorText = await submitResponse.text();
      const friendlyError = parseErrorMessage(errorText, submitResponse.status, "Gitee");
      logImageGenerationFailed("Gitee", options.requestId, friendlyError);
      throw new Error(friendlyError);
    }

    const submitData = await submitResponse.json();
    const taskId = submitData.task_id;
    if (!taskId) throw new Error("Gitee 异步任务提交失败：未返回 task_id");

    const maxAttempts = 60;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const statusResponse = await fetchWithTimeout(`${GiteeConfig.taskStatusUrl}/${taskId}`,
        {
          method: "GET",
          headers: { "Authorization": `Bearer ${apiKey}` },
        },
        options.timeoutMs,
      );

      if (!statusResponse.ok) continue;

      const statusData = await statusResponse.json();
      const status = statusData.status;
      if (status === "success") {
        const output = statusData.output ?? statusData.data;
        const imageData = this.extractB64ImagesFromAsyncOutput(output);
        if (imageData.length === 0) {
          warn("Gitee", "异步文生图任务成功但未返回 Base64 图像数据");
          throw new Error("Gitee 异步文生图返回了非 Base64 数据，请检查 API 响应格式设置");
        }

        logImageGenerationComplete("Gitee", options.requestId, imageData.length, Date.now() - startTime);

        return { success: true, images: imageData, model, provider: "Gitee" };
      }
      if (status === "failure" || status === "cancelled") {
        logImageGenerationFailed("Gitee", options.requestId, status);
        throw new Error(`Gitee 异步任务${status === "failure" ? "失败" : "已取消"}`);
      }
    }

    logImageGenerationFailed("Gitee", options.requestId, "任务超时");
    throw new Error("Gitee 异步任务超时");
  }

  /**
   * 处理同步图生图请求
   * 强制 response_format: "b64_json" 并支持多图
   */
  private async handleSyncEdit(
    apiKey: string,
    request: ImageGenerationRequest,
    options: GenerationOptions,
    size: string,
    startTime: number,
  ): Promise<GenerationResult> {
    const model = this.selectModel(request.model, true);

    logImageGenerationStart("Gitee", options.requestId, model, size, request.prompt.length);
    info("Gitee", `同步编辑模式 (强制 Base64), 模型: ${model}, 图片数量: ${request.images.length}`);

    const formData = new FormData();
    formData.append("model", model);
    formData.append("prompt", request.prompt || "");
    formData.append("size", size);
    formData.append("n", "1"); // 核心优化：Gitee 官方限制同步编辑图片数量只能为 1
    formData.append("response_format", "b64_json"); // 核心优化：直接请求 Base64

    // 处理输入图片：统一转 Blob 并通过 FormData 上传
    for (let i = 0; i < request.images.length; i++) {
      const imageInput = request.images[i];
      let base64Data: string;
      let mimeType: string;

      if (imageInput.startsWith("data:")) {
        base64Data = imageInput.split(",")[1];
        mimeType = imageInput.split(";")[0].split(":")[1];
      } else {
        const downloaded = await urlToBase64(imageInput);
        base64Data = downloaded.base64;
        mimeType = downloaded.mimeType;
      }

      const blob = new Blob([Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0))], {
        type: mimeType,
      });
      // 关键：Gitee 支持多图上传，通常使用相同字段名 image
      formData.append("image", blob, `image${i + 1}.png`);
    }

    const response = await withApiTiming(
      "Gitee",
      "image_edit",
      () =>
        fetchWithTimeout(GiteeConfig.editApiUrl, {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey}` },
          body: formData,
        }, options.timeoutMs),
    );

    if (!response.ok) {
      const errorText = await response.text();
      const friendlyError = parseErrorMessage(errorText, response.status, "Gitee");
      logImageGenerationFailed("Gitee", options.requestId, friendlyError);
      throw new Error(friendlyError);
    }

    const data = await response.json();
    const imageData: ImageData[] = data.data || [];

    if (!imageData || imageData.length === 0) {
      throw new Error("Gitee 返回数据为空");
    }

    logGeneratedImages("Gitee", options.requestId, imageData);

    const duration = Date.now() - startTime;
    logImageGenerationComplete("Gitee", options.requestId, imageData.length, duration);

    return {
      success: true,
      images: imageData,
      model,
      provider: "Gitee",
    };
  }

  /**
   * 处理异步图生图请求
   * 提交时请求 b64_json，轮询时解析 b64_json
   */
  private async handleAsyncEdit(
    apiKey: string,
    request: ImageGenerationRequest,
    options: GenerationOptions,
    size: string,
    startTime: number,
  ): Promise<GenerationResult> {
    const model = request.model as string;
    const asyncSize = size || GiteeConfig.defaultAsyncEditSize;

    logImageGenerationStart("Gitee", options.requestId, model, asyncSize, request.prompt.length);
    info("Gitee", `异步编辑模式 (强制 Base64), 模型: ${model}, 图片数量: ${request.images.length}`);

    // 1. 提交任务
    const formData = new FormData();
    formData.append("model", model);
    formData.append("prompt", request.prompt || "");
    formData.append("size", asyncSize);
    formData.append("n", "1"); // 核心优化：Gitee 官方限制异步编辑图片数量只能为 1
    // 核心优化：提交任务时就指定 response_format 为 b64_json
    formData.append("response_format", "b64_json");

    for (let i = 0; i < request.images.length; i++) {
      const imageInput = request.images[i];
      let base64Data: string;
      let mimeType: string;

      if (imageInput.startsWith("data:")) {
        base64Data = imageInput.split(",")[1];
        mimeType = imageInput.split(";")[0].split(":")[1];
      } else {
        const downloaded = await urlToBase64(imageInput);
        base64Data = downloaded.base64;
        mimeType = downloaded.mimeType;
      }

      const blob = new Blob([Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0))], {
        type: mimeType,
      });
      formData.append("image", blob, `image${i + 1}.png`);
    }

    const submitResponse = await withApiTiming(
      "Gitee",
      "image_edit_async_submit",
      () =>
        fetchWithTimeout(GiteeConfig.asyncEditApiUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
          },
          body: formData,
        }, options.timeoutMs),
    );

    if (!submitResponse.ok) {
      const errorText = await submitResponse.text();
      const friendlyError = parseErrorMessage(errorText, submitResponse.status, "Gitee");
      logImageGenerationFailed("Gitee", options.requestId, friendlyError);
      throw new Error(friendlyError);
    }

    const submitData = await submitResponse.json();
    const taskId = submitData.task_id;
    if (!taskId) throw new Error("Gitee 异步任务提交失败：未返回 task_id");

    info("Gitee", `异步任务已提交, Task ID: ${taskId}`);

    // 2. 轮询任务状态
    const maxAttempts = 60;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const statusResponse = await fetchWithTimeout(`${GiteeConfig.taskStatusUrl}/${taskId}`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${apiKey}` },
      }, options.timeoutMs);

      if (!statusResponse.ok) continue;

      const statusData = await statusResponse.json();
      const status = statusData.status;

      if (status === "success") {
        const duration = Date.now() - startTime;
        const output = statusData.output ?? statusData.data;
        const imageData = this.extractB64ImagesFromAsyncOutput(output);
        if (imageData.length === 0) {
          warn("Gitee", "异步图片编辑任务成功但未返回 Base64 图像数据");
          throw new Error("Gitee 异步任务返回了非 Base64 数据，请检查 API 响应格式设置");
        }

        logImageGenerationComplete("Gitee", options.requestId, 1, duration);

        return {
          success: true,
          images: imageData,
          model,
          provider: "Gitee",
        };
      } else if (status === "failure" || status === "cancelled") {
        logImageGenerationFailed("Gitee", options.requestId, status);
        throw new Error(`Gitee 异步任务${status === "failure" ? "失败" : "已取消"}`);
      }
    }

    logImageGenerationFailed("Gitee", options.requestId, "任务超时");
    throw new Error("Gitee 异步任务超时");
  }

  private extractB64ImagesFromAsyncOutput(output: unknown): ImageData[] {
    const images: ImageData[] = [];
    if (!output || typeof output !== "object") return images;

    const rawItems = Array.isArray(output) ? output : [output];
    for (const rawItem of rawItems) {
      if (!rawItem || typeof rawItem !== "object") continue;

      const item = rawItem as Record<string, unknown>;
      const b64 = item["b64_json"];
      if (typeof b64 === "string") {
        images.push({ b64_json: b64.startsWith("data:") ? b64.split(",")[1] : b64 });
        continue;
      }

      const data = item["data"];
      if (data && typeof data === "object") {
        const nested = data as Record<string, unknown>;
        const nestedB64 = nested["b64_json"];
        if (typeof nestedB64 === "string") {
          images.push({ b64_json: nestedB64.startsWith("data:") ? nestedB64.split(",")[1] : nestedB64 });
        }
      }
    }

    return images;
  }

  // 移除了 convertUrlsToBase64，因为所有流程都强制 Base64
}

// 导出单例实例
export const giteeProvider = new GiteeProvider();
