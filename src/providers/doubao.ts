/**
 * Doubao（豆包）Provider 实现
 *
 * 基于火山引擎（Volcengine）API 实现。
 * 支持文生图和图生图（多图融合）功能。
 * 特点：
 * 1. 使用 UUID 格式的 API Key。
 * 2. 强大的中文理解能力。
 * 3. 支持多图融合，并内置了 Prompt 智能重写功能，优化多图引用。
 */

import {
  BaseProvider,
  type GenerationOptions,
  type ProviderCapabilities,
  type ProviderConfig,
} from "./base.ts";
import type {
  GenerationResult,
  ImageGenerationRequest,
  ImagesBlendRequest,
} from "../types/index.ts";
import { DoubaoConfig } from "../config/manager.ts";
import { fetchWithTimeout, urlToBase64 } from "../utils/index.ts";
import { parseErrorMessage } from "../core/error-handler.ts";
import {
  error,
  info,
  logFullPrompt,
  logGeneratedImages,
  logImageGenerationComplete,
  logImageGenerationFailed,
  logImageGenerationStart,
  logInputImages,
} from "../core/logger.ts";
import { withApiTiming } from "../middleware/timing.ts";

/**
 * Doubao Provider 实现类
 *
 * 封装了与火山引擎视觉大模型 API 的交互逻辑。
 */
export class DoubaoProvider extends BaseProvider {
  /** Provider 名称标识 */
  readonly name = "Doubao" as const;

  /**
   * Provider 能力描述
   * 定义了该 Provider 支持的功能特性和限制。
   */
  readonly capabilities: ProviderCapabilities = {
    textToImage: true, // 支持文生图
    imageToImage: true, // 支持图生图
    multiImageFusion: true, // 支持多图融合
    asyncTask: false, // 仅支持同步任务
    maxInputImages: 14, // 最多支持 14 张参考图
    maxOutputImages: 15, // 文生图上限 15 张
    maxEditOutputImages: 14, // 图生图上限 14 张
    maxBlendOutputImages: 13, // 融合生图上限 13 张
    outputFormats: ["url", "b64_json"], // 支持 URL 和 Base64 输出
  };

  /**
   * Provider 配置信息
   * 从全局配置管理器加载默认配置。
   */
  readonly config: ProviderConfig = {
    apiUrl: DoubaoConfig.apiUrl,
    textModels: DoubaoConfig.textModels,
    defaultModel: DoubaoConfig.defaultModel,
    defaultSize: DoubaoConfig.defaultSize,
    editModels: DoubaoConfig.textModels, // 豆包的模型通常通用，图生图也用相同列表
    defaultEditModel: DoubaoConfig.defaultModel,
    defaultEditSize: DoubaoConfig.defaultEditSize,
  };

  /**
   * 检测 API Key 是否属于 Doubao
   * Doubao 使用标准的 UUID 格式 API Key (例如：550e8400-e29b-41d4-a716-446655440000)
   *
   * @param apiKey - 待检测的 API Key
   * @returns 如果格式匹配返回 true，否则返回 false
   */
  detectApiKey(apiKey: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(apiKey);
  }

  override validateRequest(request: ImageGenerationRequest): string | null {
    const baseError = super.validateRequest(request);
    if (baseError) return baseError;

    const hasImages = request.images.length > 0;
    const model = request.model || this.selectModel(request.model, hasImages);
    const size = request.size || this.selectSize(request.size, hasImages);

    const sizeError = this.validateModelPixelSize(model, size);
    if (sizeError) return sizeError;

    // 总和校验逻辑：输入图片数量 + 期望生成张数 (n) <= 15
    const requestCount = typeof request.n === "number" ? request.n : Number(request.n || 1);
    const finalCount = Number.isFinite(requestCount) && requestCount > 0
      ? Math.floor(requestCount)
      : 1;

    if (request.images.length + finalCount > 15) {
      return "总计上限 (输入+输出)超过15张图，生图失败";
    }

    return null;
  }

  /**
   * 智能修正图片尺寸 (Auto-Upscale)
   *
   * 针对豆包不同模型对分辨率的不同要求，自动将不合规的尺寸“升级”到最近的合法尺寸。
   * 这解决了 WebUI 中用户选择了不兼容的尺寸导致请求失败的问题。
   */
  private ensureValidSize(model: string, size: string): string {
    const pixelMatch = size.match(/^(\d+)x(\d+)$/);
    if (!pixelMatch) return size; // 非像素格式不处理

    let width = parseInt(pixelMatch[1], 10);
    let height = parseInt(pixelMatch[2], 10);
    const totalPixels = width * height;
    const constraints = this.getPixelConstraintsByModel(model);

    // 如果模型没有特定限制，或尺寸已达标，直接返回原尺寸
    if (!constraints || (totalPixels >= constraints.min && totalPixels <= constraints.max)) {
      return size;
    }

    // 如果像素不足，尝试按比例升级
    if (totalPixels < constraints.min) {
      const ratio = Math.sqrt(constraints.min / totalPixels);
      // 放大并取整到32的倍数（许多模型对尺寸有倍数要求，虽豆包不严格但更稳妥）
      // 这里简单向上取整
      width = Math.ceil(width * ratio);
      height = Math.ceil(height * ratio);

      // 确保宽高是偶数 (豆包通常推荐)
      if (width % 2 !== 0) width++;
      if (height % 2 !== 0) height++;

      const newSize = `${width}x${height}`;
      info(
        "Doubao",
        `检测到尺寸 ${size} 低于模型 ${constraints.label} 的最小要求 (${constraints.min} px)，已自动升级为 ${newSize}`,
      );
      return newSize;
    }

    // 如果像素过大，理论上也可以降级，但暂不处理，直接返回让上游报错或后续校验拦截
    return size;
  }

  /**
   * 验证模型像素大小限制
   * ... (原有逻辑保持不变，作为最后的安全网)
   */
  private validateModelPixelSize(model: string, size: string): string | null {
    if (!size) return null;

    const pixelMatch = size.match(/^(\d+)x(\d+)$/);
    if (!pixelMatch) {
      const allowed = ["1K", "2K", "4K"];
      if (allowed.includes(size)) return null;
      return `size 参数格式错误：${size}。需为 WxH（如 2048x2048），或使用 ${allowed.join("/")}`;
    }

    const width = parseInt(pixelMatch[1], 10);
    const height = parseInt(pixelMatch[2], 10);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return `size 参数无效：${size}`;
    }

    const ratio = width / height;
    const totalPixels = width * height;

    // Log detailed size validation info
    info(
      "Doubao",
      `校验尺寸: ${size} (Width: ${width}, Height: ${height}, Ratio: ${
        ratio.toFixed(4)
      }, Pixels: ${totalPixels})`,
    );

    if (ratio < 1 / 16 || ratio > 16) {
      const msg = `Doubao 模型 size=${size} 不符合要求：宽高比 ${width}:${height} (${
        ratio.toFixed(4)
      }) 超出 [1/16, 16]`;
      info("Doubao", msg);
      return msg;
    }

    const constraints = this.getPixelConstraintsByModel(model);
    if (!constraints) return null;

    if (totalPixels < constraints.min || totalPixels > constraints.max) {
      const msg =
        `Doubao ${constraints.label} 模型 size=${size} 不符合要求：总像素 ${totalPixels} 超出 [${constraints.min}, ${constraints.max}]`;
      info("Doubao", msg);
      return msg;
    }

    return null;
  }

  private getPixelConstraintsByModel(
    model: string,
  ): { min: number; max: number; label: string } | null {
    if (model.includes("-4-5-") || model.includes("seedream-4-5")) {
      return { min: 2560 * 1440, max: 4096 * 4096, label: "4.5" };
    }
    if (model.includes("-4-0-") || model.includes("seedream-4-0")) {
      return { min: 1280 * 720, max: 4096 * 4096, label: "4.0" };
    }
    return null;
  }

  /**
   * 执行图片生成请求
   *
   * 处理流程：
   * 1. 解析请求参数（模型、尺寸、Prompt）。
   * 2. 如果是多图融合任务，执行 Prompt 智能重写（将"这张图"替换为明确的"图1"、"图2"）。
   * 3. 构建火山引擎 API 请求体（支持组图自适应、流式输出）。
   * 4. 发送 HTTP 请求并处理响应。
   * 5. 将结果转换为统一的 GenerationResult 格式（尝试将 URL 转为 Base64 以实现持久化）。
   *
   * @param apiKey - 认证密钥
   * @param request - 图片生成请求对象
   * @param options - 生成选项（包含 requestId 等）
   * @returns 生成结果 Promise
   */
  async generate(
    apiKey: string,
    request: ImageGenerationRequest,
    options: GenerationOptions,
  ): Promise<GenerationResult> {
    const startTime = Date.now();
    const hasImages = request.images.length > 0;
    // 区分 API 接口类型用于计时统计
    const apiType = hasImages ? "image_edit" : "generate_image";
    const isStream = request.stream === true;

    try {
      const processedImages = request.images;

      // 1. 智能选择模型和尺寸
      const model = this.selectModel(request.model, hasImages);
      let size = request.size || this.selectSize(request.size, hasImages);

      // 1.1 自动修正尺寸 (Auto-Upscale)
      // 如果用户选择了不兼容的小尺寸（如在 4.5 模型用了 1024x1024），自动按比例升级
      size = this.ensureValidSize(model, size);

      const sizeError = this.validateModelPixelSize(model, size);
      if (sizeError) {
        throw new Error(sizeError);
      }

      // 2. 针对豆包多图融合的特殊处理：智能重写 Prompt
      // 豆包的多图模式要求在 Prompt 中明确使用 "图1"、"图2" 来引用参考图。
      // 为了提升用户体验，这里自动将自然语言中的代词（如"这张图"）转换为明确的引用。
      let finalPrompt = request.prompt || "A beautiful scenery";
      if (processedImages.length > 1) {
        const originalPrompt = finalPrompt;
        finalPrompt = finalPrompt
          .replace(/这张图|这幅图|当前图/g, "图2")
          .replace(/上面那张图?|上面那个人|原图|背景图/g, "图1");

        // 如果 Prompt 中完全没有提及图片引用，尝试自动添加默认指令
        if (originalPrompt === finalPrompt && !finalPrompt.includes("图1")) {
          finalPrompt = `图1是背景，图2是主体。任务：${finalPrompt}`;
        }

        if (finalPrompt !== originalPrompt) {
          info("Doubao", `Prompt 已智能转换: "${originalPrompt}" -> "${finalPrompt}"`);
        }
      }

      // 智能 Prompt 数量提取
      // 解决 WebUI 可能始终发送 n=1 的问题
      // 如果 Prompt 中明确要求了数量，优先使用 Prompt 中的意图
      /*
       * [用户指令] 意图识别不重要，移除该逻辑，仅依赖配置和请求参数
      let inferredCount: number | undefined;
      if (request.prompt) {
        const promptCountMatch = request.prompt.match(/(?:生成|generate)\s*([0-9]+|[一二两三四五六七八九十])\s*(?:张|幅|个)?(?:图|图片|images?)/i);
        if (promptCountMatch) {
           const numStr = promptCountMatch[1];
           if (/\d+/.test(numStr)) {
              inferredCount = parseInt(numStr, 10);
           } else {
              const cnNums: Record<string, number> = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
              inferredCount = cnNums[numStr];
           }
           if (inferredCount && inferredCount > 1) {
               info("Doubao", `从 Prompt 中检测到生图数量意图: ${inferredCount} 张`);
           }
        }
      }
      */

      const rawCount = request.n;
      info("Doubao", `收到请求参数 n=${rawCount}`);

      const requestCount = typeof rawCount === "number" ? rawCount : Number(rawCount);
      const count = Number.isFinite(requestCount) && requestCount > 0
        ? Math.floor(requestCount)
        : undefined;

      const finalCount = this.selectCount(count, hasImages);
      
      // 始终添加 sequential_image_generation: "auto" 参数
      // 根据豆包官方文档，这个参数支持自动多图生成
      const sequentialOptions: Record<string, unknown> = {
        sequential_image_generation: "auto",
      };

      if (finalCount > 1) {
        // 当需要生成多张图片时，添加 max_images 配置
        sequentialOptions.sequential_image_generation_options = {
          max_images: finalCount,
        };
        // 使用更明确的中文指令，确保模型理解（应用户要求调整为仅追加中文）
        finalPrompt = `${finalPrompt} 生成${finalCount}张图片。`;
        info(
          this.name,
          `检测到 n=${finalCount}，已启用自动多图模式，Prompt 追加指令: "生成${finalCount}张图片。"`,
        );
      } else {
        info(this.name, `已启用 sequential_image_generation: "auto" 参数`);
      }

      logFullPrompt("Doubao", options.requestId, finalPrompt);
      if (hasImages) logInputImages("Doubao", options.requestId, processedImages);
      logImageGenerationStart("Doubao", options.requestId, model, size, finalPrompt.length);

      // 移除 512 字符的硬编码限制
      // Doubao API 实际支持更长的提示词（通常 2000+ 字符）
      // 如果需要限制，应该使用更合理的值或从配置中读取
      const MAX_PROMPT_LENGTH = 5000; // 提高到 5000 字符
      if (finalPrompt.length > MAX_PROMPT_LENGTH) {
        const msg = `Prompt truncated from ${finalPrompt.length} to ${MAX_PROMPT_LENGTH} chars`;
        info("Doubao", msg);
        finalPrompt = finalPrompt.substring(0, MAX_PROMPT_LENGTH);
      }

      // 额外参数处理 (Guidance Scale, Prompt Optimization 等)
      const extraOptions: Record<string, unknown> = {};
      if (request["optimize_prompt_options"]) {
        extraOptions.optimize_prompt_options = request["optimize_prompt_options"];
      }
      if (request["guidance_scale"]) {
        extraOptions.guidance_scale = request["guidance_scale"];
      }

      const arkRequest = {
        model,
        prompt: finalPrompt,
        // 优先请求 Base64 格式，减少后续转换开销。流式模式下通常直接透传。
        response_format: options.returnBase64 ? "b64_json" : (request.response_format || "url"),
        size,
        watermark: true, // 默认开启水印
        stream: isStream,
        ...(hasImages
          ? { image: processedImages.length === 1 ? processedImages[0] : processedImages }
          : {}),
        ...sequentialOptions,
        ...extraOptions,
      };

      // 5. 发送请求（使用计时中间件）
      const response = await withApiTiming("Doubao", apiType, () =>
        fetchWithTimeout(
          this.config.apiUrl,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify(arkRequest),
          },
          options.timeoutMs,
        ));

      if (!response.ok) {
        const errorText = await response.text();
        // 记录原始错误日志以便排查 4.5 模型的参数问题
        info("Doubao", `API 原始错误响应 (RequestId: ${options.requestId}): ${errorText}`);
        const friendlyError = parseErrorMessage(errorText, response.status, "Doubao");
        logImageGenerationFailed("Doubao", options.requestId, friendlyError);
        throw new Error(friendlyError);
      }

      // 6. 处理流式响应
      if (isStream && response.body) {
        info("Doubao", `开始流式传输响应 (RequestId: ${options.requestId})`);
        return {
          success: true,
          stream: response.body, // 直接返回可读流
          model,
          provider: "Doubao",
        };
      }

      // 7. 处理普通响应
      const data = await response.json();
      logGeneratedImages("Doubao", options.requestId, data.data || []);

      const duration = Date.now() - startTime;
      const imageData = data.data || [];
      logImageGenerationComplete("Doubao", options.requestId, imageData.length, duration);

      // 8. 结果处理：确保返回 Base64 数据
      // 即使 API 返回了 URL，我们也尝试将其下载并转换为 Base64，
      // 这样可以避免临时 URL 过期的问题，实现生成的图片永久保存。
      const images: Array<{ url?: string; b64_json?: string }> = await Promise.all(
        imageData.map(async (img: { url?: string; b64_json?: string }) => {
          if (img.b64_json) {
            return { b64_json: img.b64_json };
          }
          if (img.url) {
            try {
              info("Doubao", `正在将生成结果 URL 转换为 Base64 以供永久保存...`);
              const { base64, mimeType } = await urlToBase64(img.url);
              return { b64_json: base64, mimeType };
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              error("Doubao", `结果转换 Base64 失败，回退到 URL: ${msg}`);
              return { url: img.url };
            }
          }
          return {};
        }),
      );

      return {
        success: true,
        images: images.filter((img) => img.url || img.b64_json),
        model,
        provider: "Doubao",
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        success: false,
        error: errorMessage,
        model: request.model || this.config.defaultModel,
        provider: "Doubao",
      };
    }
  }

  /**
   * 融合生图实现
   * 将 Blend 请求转换为标准生成请求并执行
   *
   * @param apiKey - API 密钥
   * @param request - 融合请求参数
   * @param options - 生成选项
   * @returns 生成结果
   */
  override blend(
    apiKey: string,
    request: ImagesBlendRequest,
    options: GenerationOptions,
  ): Promise<GenerationResult> {
    // 1. 解析 messages 提取 prompt 和 images
    let prompt = request.prompt || "";
    const images: string[] = [];

    if (request.messages && Array.isArray(request.messages)) {
      for (const msg of request.messages) {
        if (typeof msg.content === "string") {
          // 如果是纯文本且没有显式 prompt，则作为补充
          // 注意：通常我们只取最后一条用户的文本作为 Prompt，或者拼接所有
          // 这里简单拼接，但避免重复
          if (!prompt.includes(msg.content)) {
            prompt += (prompt ? " " : "") + msg.content;
          }
        } else if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item.type === "text") {
              if (!prompt.includes(item.text)) {
                prompt += (prompt ? " " : "") + item.text;
              }
            } else if (item.type === "image_url" && item.image_url?.url) {
              images.push(item.image_url.url);
            } else if (item.type === "image") {
              const base64Content = item.image;
              const mimeType = item.mediaType || "image/png";
              if (base64Content.startsWith("data:")) {
                images.push(base64Content);
              } else {
                images.push(`data:${mimeType};base64,${base64Content}`);
              }
            }
          }
        }
      }
    }

    prompt = prompt.trim();
    if (!prompt) {
      prompt = "Image fusion based on input images"; // 默认 Prompt
    }

    // 2. 构建 ImageGenerationRequest
    // 过滤掉 ImagesBlendRequest 特有但 ImageGenerationRequest 不需要或需转换的字段
    const {
      messages: _ignoredMessages,
      prompt: _ignoredPrompt,
      model,
      n,
      size,
      response_format,
      stream,
      ...extraParams
    } = request;

    const generationRequest: ImageGenerationRequest = {
      ...extraParams,
      prompt,
      images,
      model,
      n,
      size,
      response_format,
      stream: typeof stream === "boolean" ? stream : undefined,
    };

    const validationError = this.validateRequest(generationRequest);
    if (validationError) {
      return Promise.resolve({
        success: false,
        error: validationError,
        model: generationRequest.model || this.config.defaultModel,
        provider: "Doubao",
      });
    }

    // 3. 调用 generate 复用逻辑
    return this.generate(apiKey, generationRequest, options);
  }
}

// 导出单例实例
export const doubaoProvider = new DoubaoProvider();
