/**
 * ModelScope（魔搭）Provider 实现
 *
 * 基于阿里云 ModelScope 平台 API 实现。
 * 支持文生图（异步轮询）和图生图（多图融合）功能。
 * 特点：
 * 1. 采用异步任务模式：提交任务 -> 获取 Task ID -> 轮询状态。
 * 2. 图生图需要先将图片上传到公网可访问的图床（本实现中尝试自动转换或使用原始 URL）。
 * 3. 具有复杂的任务状态判断逻辑，兼容不同的返回格式。
 */

import {
  BaseProvider,
  type GenerationOptions,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderName,
} from "./base.ts";
import type {
  GenerationResult,
  ImageGenerationRequest,
  ImagesBlendRequest,
  Message,
  MessageContentItem,
  NonStandardImageContentItem,
} from "../types/index.ts";
import { ModelScopeConfig } from "../config/manager.ts";
import { base64ToUrl, fetchWithTimeout, urlToBase64 } from "../utils/index.ts";
import { buildDataUri } from "../utils/image.ts";
import {
  info,
  logFullPrompt,
  logImageGenerationComplete,
  logImageGenerationFailed,
  logImageGenerationStart,
  logInputImages,
} from "../core/logger.ts";
import { parseErrorMessage } from "../core/error-handler.ts";
import { withApiTiming } from "../middleware/timing.ts";

/**
 * ModelScope Provider 实现类
 *
 * 封装了与 ModelScope 异步 API 的交互。
 * 重点处理异步轮询和异常状态的兼容。
 */
export class ModelScopeProvider extends BaseProvider {
  /** Provider 名称标识 */
  readonly name: ProviderName = "ModelScope";

  /**
   * Provider 能力描述
   */
  readonly capabilities: ProviderCapabilities = {
    textToImage: true, // 支持文生图
    imageToImage: true, // 支持图生图
    multiImageFusion: true, // 支持多图融合
    asyncTask: true, // 必须使用异步轮询
    maxInputImages: 10, // 支持较多输入图片
    maxOutputImages: 16, // 支持并发生成多张
    maxNativeOutputImages: 1, // 原生 API 单次只能生成 1 张
    maxEditOutputImages: 16, // 图生图上限
    maxBlendOutputImages: 16, // 融合上限
    outputFormats: ["url", "b64_json"], // 支持 URL 和 Base64 输出
  };

  /**
   * Provider 配置信息
   */
  readonly config: ProviderConfig = {
    apiUrl: ModelScopeConfig.apiUrl,
    textModels: ModelScopeConfig.textModels,
    defaultModel: ModelScopeConfig.defaultModel,
    defaultSize: ModelScopeConfig.defaultSize,
    editModels: ModelScopeConfig.editModels,
    defaultEditModel: ModelScopeConfig.defaultEditModel,
    defaultEditSize: ModelScopeConfig.defaultEditSize,
    blendModels: ModelScopeConfig.blendModels, // 支持融合模型配置
    defaultBlendModel: ModelScopeConfig.defaultEditModel, // 默认融合模型同编辑模型
  };

  /**
   * 检测 API Key 是否属于 ModelScope
   * 通常以 "ms-" 开头
   */
  override detectApiKey(apiKey: string): boolean {
    return apiKey.startsWith("ms-");
  }

  /**
   * 执行图片生成请求
   */
  override async generate(
    apiKey: string,
    request: ImageGenerationRequest,
    options: GenerationOptions,
  ): Promise<GenerationResult> {
    const hasImages = request.images && request.images.length > 0;

    // 1. 确定最终的生成数量 n
    // ModelScope 特殊逻辑：优先使用 WebUI 配置的 n (如果有)，覆盖请求中的 n
    const n = this.selectCount(request.n, hasImages);
    const requestWithCount = { ...request, n };

    // 使用 BaseProvider 的并发生成策略
    return await this.generateWithConcurrency(
      apiKey,
      requestWithCount,
      options,
      async (singleRequest) => {
        const startTime = Date.now();
        logFullPrompt("ModelScope", options.requestId, singleRequest.prompt);

        if (hasImages) {
          logInputImages("ModelScope", options.requestId, singleRequest.images);
          return await this.handleEdit(apiKey, singleRequest, options, startTime);
        } else {
          return await this.handleTextToImage(apiKey, singleRequest, options, startTime);
        }
      },
    );
  }

  /**
   * 融合生图 (Blend) 实现
   *
   * 逻辑：提取 Messages 中的所有图片和 Prompt，转换为标准 ImageGenerationRequest，
   * 然后复用 generate 逻辑。
   */
  override blend(
    apiKey: string,
    request: ImagesBlendRequest,
    options: GenerationOptions,
  ): Promise<GenerationResult> {
    const { prompt, images } = this.extractPromptAndImagesFromMessages(request.messages);
    const finalPrompt = request.prompt || prompt || "";

    // 融合生图通常使用编辑模型
    const model = request.model || this.config.defaultBlendModel || this.config.defaultEditModel;

    return this.generate(apiKey, {
      prompt: finalPrompt,
      images,
      model: model,
      n: request.n,
      size: request.size,
      response_format: "b64_json",
    }, options);
  }

  /**
   * 从消息列表中提取 Prompt 和图片
   * (复用自 GiteeProvider 的逻辑)
   */
  private extractPromptAndImagesFromMessages(
    messages: Message[],
  ): { prompt: string; images: string[] } {
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
          images.push(
            base64Str.startsWith("data:") ? base64Str : `data:${mediaType};base64,${base64Str}`,
          );
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
   */
  private async handleTextToImage(
    apiKey: string,
    request: ImageGenerationRequest,
    options: GenerationOptions,
    startTime: number,
  ): Promise<GenerationResult> {
    const model = this.selectModel(request.model, false);
    const size = this.selectSize(request.size, false);
    // 此时的 request.n 已经是拆分后的值 (通常为 1)，所以直接使用
    const n = request.n || 1;

    logImageGenerationStart("ModelScope", options.requestId, model, size, request.prompt.length);
    info("ModelScope", `使用文生图模式, 模型: ${model}, n: ${n}`);

    const requestBody: Record<string, unknown> = {
      model,
      prompt: request.prompt || "A beautiful scenery",
      size: size,
      n: n,
    };

    return await this.submitAndPoll(
      apiKey,
      "generate_image",
      requestBody,
      options,
      startTime,
      model,
    );
  }

  /**
   * 处理图生图/融合生图请求
   */
  private async handleEdit(
    apiKey: string,
    request: ImageGenerationRequest,
    options: GenerationOptions,
    startTime: number,
  ): Promise<GenerationResult> {
    const model = this.selectModel(request.model, true);
    // 图生图通常不需要 size，或者 size 必须符合特定比例。
    // 这里我们传入 size，但魔搭文档示例里有些模型可能不需要 size。
    // 既然 config 里有 defaultEditSize，我们还是传进去。
    const size = this.selectSize(request.size, true);
    // 此时的 request.n 已经是拆分后的值 (通常为 1)
    const n = request.n || 1;

    info(
      "ModelScope",
      `使用图生图/融合模式, 模型: ${model}, 图片数量: ${request.images.length}, n: ${n}`,
    );
    logImageGenerationStart("ModelScope", options.requestId, model, size, request.prompt.length);

    // 处理输入图片：上传到图床获取 URL
    const urlImages: string[] = [];
    for (let i = 0; i < request.images.length; i++) {
      const img = request.images[i];
      if (img.startsWith("http")) {
        urlImages.push(img);
        continue;
      }

      const dataUri = img.startsWith("data:") ? img : buildDataUri(img, "image/png");
      try {
        const imageUrl = await base64ToUrl(dataUri);
        urlImages.push(imageUrl);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const errMsg = `第${i + 1}张输入图片上传图床失败: ${msg}`;
        logImageGenerationFailed("ModelScope", options.requestId, errMsg);
        throw new Error(errMsg);
      }
    }

    if (urlImages.length === 0) {
      throw new Error("图生图失败：无可用输入图片 URL");
    }

    info("ModelScope", `发送 ${urlImages.length} 张图片 URL 给魔搭 API`);

    const requestBody: Record<string, unknown> = {
      model: model,
      prompt: request.prompt || "A beautiful scenery",
      n: n,
      image_url: urlImages,
    };

    // 如果是编辑模式，是否需要 size？文档示例里 Z-Image-Turbo 文生图用了 size，Qwen-Image-Edit 用了 image_url 列表。
    // Qwen-Image-Edit 示例里没传 size，但文档表格说 size 是可选的。
    // 为了稳妥，如果不为空则传。
    if (size) {
      requestBody.size = size;
    }

    return await this.submitAndPoll(apiKey, "image_edit", requestBody, options, startTime, model);
  }

  /**
   * 通用提交和轮询逻辑
   */
  private async submitAndPoll(
    apiKey: string,
    apiType: string,
    requestBody: Record<string, unknown>,
    options: GenerationOptions,
    startTime: number,
    model: string,
  ): Promise<GenerationResult> {
    const { requestId } = options;

    // 1. 提交任务
    const submitResponse = await withApiTiming(
      "ModelScope",
      apiType,
      () =>
        fetchWithTimeout(`${ModelScopeConfig.apiUrl}/images/generations`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "X-ModelScope-Async-Mode": "true", // 强制启用异步模式
          },
          body: JSON.stringify(requestBody),
        }, options.timeoutMs),
    );

    if (!submitResponse.ok) {
      const errorText = await submitResponse.text();
      const friendlyError = parseErrorMessage(errorText, submitResponse.status, "ModelScope");
      logImageGenerationFailed("ModelScope", requestId, friendlyError);
      throw new Error(friendlyError);
    }

    const submitData: { task_id?: unknown; [key: string]: unknown } = await submitResponse.json();
    const taskId = String(submitData.task_id || "");

    if (!taskId) {
      const errMsg = "ModelScope 任务提交失败：未返回 task_id";
      logImageGenerationFailed("ModelScope", requestId, errMsg);
      throw new Error(errMsg);
    }

    info("ModelScope", `任务已提交, Task ID: ${taskId}`);

    // 2. 轮询任务状态
    const maxAttempts = 120; // 10分钟超时
    let pollingAttempts = 0;
    let invalidResponseStreak = 0;
    let lastPollError: string | null = null;

    // 优先使用 image_generation，因为绝大多数图生图任务也使用此类型查询
    const taskTypeOrder: Array<string | undefined> = ["image_generation", "video_generation"];

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      pollingAttempts++;

      let taskData: Record<string, unknown> | null = null;
      for (const taskType of taskTypeOrder) {
        const result = await this.getTaskStatus(apiKey, taskId, taskType, options.timeoutMs);
        if (result.data) {
          taskData = result.data;
          break;
        }
        if (result.error) {
          lastPollError = result.error;
        }
      }

      if (!taskData) {
        invalidResponseStreak++;
        if (invalidResponseStreak >= 6) {
          const errMsg = `ModelScope 任务状态查询返回异常：${
            lastPollError ?? "可能任务类型不匹配或任务不存在"
          }`;
          logImageGenerationFailed("ModelScope", requestId, errMsg);
          throw new Error(errMsg);
        }
        continue;
      }

      invalidResponseStreak = 0;

      if (pollingAttempts <= 3 || pollingAttempts % 10 === 0) {
        info("ModelScope", `📊 轮询响应 (第${pollingAttempts}次): ${taskData.task_status}`);
      }

      const status = taskData.task_status;

      if (status === "SUCCEED") {
        const outputImageUrls = this.extractOutputImages(taskData);
        const duration = Date.now() - startTime;

        logImageGenerationComplete("ModelScope", requestId, outputImageUrls.length, duration);

        // 转换为 Base64
        const results: Array<{ url?: string; b64_json?: string }> = [];
        for (const url of outputImageUrls) {
          try {
            const { base64 } = await urlToBase64(url);
            results.push({ b64_json: base64 });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            info("ModelScope", `❌ 图片转换 Base64 失败，使用 URL: ${msg}`);
            results.push({ url });
          }
        }

        return {
          success: true,
          images: results,
          model,
          provider: "ModelScope",
          duration,
        };
      } else if (status === "FAILED") {
        const failReason = taskData.errors || taskData.error || taskData.message ||
          JSON.stringify(taskData);
        logImageGenerationFailed("ModelScope", requestId, `Task Failed: ${failReason}`);
        throw new Error(`ModelScope Task Failed: ${failReason}`);
      }
    }

    logImageGenerationFailed("ModelScope", requestId, "任务超时");
    throw new Error("ModelScope Task Timeout");
  }

  private async getTaskStatus(
    apiKey: string,
    taskId: string,
    taskType?: string,
    timeoutMs?: number,
  ): Promise<{ data: Record<string, unknown> | null; error?: string }> {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${apiKey}`,
    };
    if (taskType) {
      headers["X-ModelScope-Task-Type"] = taskType;
    }

    try {
      const checkResponse = await fetchWithTimeout(`${ModelScopeConfig.apiUrl}/tasks/${taskId}`, {
        method: "GET",
        headers,
      }, timeoutMs);

      if (!checkResponse.ok) {
        return { data: null, error: `HTTP ${checkResponse.status}` };
      }

      const json = await checkResponse.json() as unknown;
      return { data: this.normalizeTaskData(json) };
    } catch (e) {
      return { data: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private normalizeTaskData(raw: unknown): Record<string, unknown> | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;

    if (typeof r.task_status === "string") return r;

    const nested = r.data ?? r.Data;
    if (nested && typeof nested === "object") {
      const n = nested as Record<string, unknown>;
      if (typeof n.task_status === "string") return n;
    }

    return null;
  }

  private extractOutputImages(data: Record<string, unknown>): string[] {
    const direct = data.output_images;
    if (Array.isArray(direct)) {
      return direct.filter((v): v is string => typeof v === "string" && v.length > 0);
    }

    const outputs = data.outputs;
    if (outputs && typeof outputs === "object") {
      const out = outputs as Record<string, unknown>;
      const nested = out.output_images;
      if (Array.isArray(nested)) {
        return nested.filter((v): v is string => typeof v === "string" && v.length > 0);
      }
    }

    return [];
  }
}

// 导出单例实例
export const modelScopeProvider = new ModelScopeProvider();
