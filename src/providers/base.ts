/**
 * @fileoverview Provider 基础接口定义
 *
 * 定义了所有图片生成服务提供商 (Provider) 必须遵循的接口规范和基类实现。
 * 包含能力描述、配置结构以及核心生成方法的抽象定义。
 */

import type { GenerationResult, ImageGenerationRequest } from "../types/index.ts";
import type { ImagesBlendRequest } from "../types/request.ts";
import { getProviderTaskDefaults } from "../config/manager.ts";
import { info } from "../core/logger.ts";
import { promptOptimizerService } from "../core/prompt-optimizer.ts";
import { getPromptOptimizerConfig } from "../config/manager.ts";

/**
 * 支持的 Provider 名称枚举
 */
export type ProviderName =
  | "Doubao" // 豆包
  | "Gitee" // Gitee AI
  | "ModelScope" // ModelScope
  | "HuggingFace" // Hugging Face
  | "Pollinations" // Pollinations AI
  | "NewApi" // NewApi (OpenAI 兼容网关)
  | "Unknown"; // 未知

/**
 * Provider 能力描述接口
 * 用于在运行时判断 Provider 是否支持特定功能
 */
export interface ProviderCapabilities {
  /** 是否支持文生图 (Text-to-Image) */
  textToImage: boolean;
  /** 是否支持图生图/图片编辑 (Image-to-Image) */
  imageToImage: boolean;
  /** 是否支持多图融合 (Multi-Image Fusion) */
  multiImageFusion: boolean;
  /** 是否支持异步任务 (Async Task) */
  asyncTask: boolean;
  /** 最大支持的输入图片数量 */
  maxInputImages: number;
  /** 系统对外宣称支持的最大输出数量 (通过并发模拟) */
  maxOutputImages: number;
  /** 原生 API 单次请求支持的最大输出数量 (若未定义则默认为 1) */
  maxNativeOutputImages?: number;
  /** 最大支持的图片编辑输出数量 (图生图 n 参数) */
  maxEditOutputImages: number;
  /** 最大支持的融合生图输出数量 (融合 n 参数) */
  maxBlendOutputImages: number;
  /** 支持的输出格式 ("url" 或 "b64_json") */
  outputFormats: ("url" | "b64_json")[];
}

/**
 * Provider 配置接口
 * 定义了连接 API 所需的基本信息
 */
export interface ProviderConfig {
  /** API 基础 URL */
  apiUrl: string;
  /** 支持的文生图模型列表 */
  textModels: string[];
  /** 默认文生图模型 */
  defaultModel: string;
  /** 默认生成尺寸 */
  defaultSize: string;
  /** 默认生成数量 */
  defaultCount?: number;
  /** 支持的图片编辑模型列表（可选） */
  editModels?: string[];
  /** 默认图片编辑模型（可选） */
  defaultEditModel?: string;
  /** 默认图片编辑尺寸（可选） */
  defaultEditSize?: string;
  /** 默认图片编辑生成数量（可选） */
  defaultEditCount?: number;
  /** 支持的融合生图模型列表（可选） */
  blendModels?: string[];
  /** 默认融合生图模型（可选） */
  defaultBlendModel?: string;
  /** 默认融合生图尺寸（可选） */
  defaultBlendSize?: string;
  /** 默认融合生图数量（可选） */
  defaultBlendCount?: number;
  /** 默认推理步数（可选） */
  defaultSteps?: number;
}

/**
 * 生成选项接口
 * 控制单次生成任务的额外参数
 */
export interface GenerationOptions {
  /** 请求 ID（用于全链路日志追踪） */
  requestId: string;
  /** 超时时间（毫秒） */
  timeoutMs?: number;
  /** 是否强制返回 Base64 格式（用于绕过图片防盗链或持久化存储） */
  returnBase64?: boolean;
}

/**
 * Provider 核心接口
 * 所有图片生成 Provider 必须实现此接口
 */
export interface IProvider {
  /** Provider 名称 */
  readonly name: ProviderName;

  /** Provider 能力描述 */
  readonly capabilities: ProviderCapabilities;

  /** Provider 配置信息 */
  readonly config: ProviderConfig;

  /**
   * 检测 API Key 是否属于此 Provider
   * 用于自动路由请求到正确的 Provider
   *
   * @param {string} apiKey - 待检测的 API 密钥
   * @returns {boolean} 如果匹配则返回 true
   */
  detectApiKey(apiKey: string): boolean;

  /**
   * 执行图片生成任务
   *
   * @param {string} apiKey - API 密钥
   * @param {ImageGenerationRequest} request - 标准化的生成请求对象
   * @param {GenerationOptions} options - 生成选项
   * @returns {Promise<GenerationResult>} 生成结果
   */
  generate(
    apiKey: string,
    request: ImageGenerationRequest,
    options: GenerationOptions,
    keyPool?: import("../config/manager.ts").KeyPoolItem[],
  ): Promise<GenerationResult>;

  /**
   * 获取支持的所有模型列表
   * 包括文生图和图生图模型
   *
   * @returns {string[]} 模型名称数组
   */
  getSupportedModels(): string[];

  /**
   * 验证请求参数是否合法
   *
   * @param {ImageGenerationRequest} request - 待验证的请求
   * @returns {string | null} 如果验证失败返回错误信息，否则返回 null
   */
  validateRequest(request: ImageGenerationRequest): string | null;

  /**
   * 融合生图 (Multi-Image Fusion)
   *
   * @param apiKey - API 密钥
   * @param request - 融合请求参数
   * @param options - 生成选项
   * @returns 生成结果
   */
  blend(
    apiKey: string,
    request: ImagesBlendRequest,
    options: GenerationOptions,
  ): Promise<GenerationResult>;
}

/**
 * Provider 抽象基类
 *
 * 实现了部分通用逻辑（如模型选择、参数验证），减少子类重复代码。
 * 子类只需关注核心的 `generate` 和 `detectApiKey` 实现。
 */
export abstract class BaseProvider implements IProvider {
  abstract readonly name: ProviderName;
  abstract readonly capabilities: ProviderCapabilities;
  abstract readonly config: ProviderConfig;

  /**
   * 检测 API Key 格式
   * 子类必须实现具体的正则匹配逻辑
   */
  abstract detectApiKey(apiKey: string): boolean;

  /**
   * 生成图片
   * 子类必须实现具体的 API 调用逻辑
   */
  abstract generate(
    apiKey: string,
    request: ImageGenerationRequest,
    options: GenerationOptions,
    keyPool?: import("../config/manager.ts").KeyPoolItem[],
  ): Promise<GenerationResult>;

  /**
   * 获取支持的模型列表
   * 默认实现：合并 textModels 和 editModels 并去重
   */
  getSupportedModels(): string[] {
    const models = [...this.config.textModels];
    if (this.config.editModels) {
      models.push(...this.config.editModels);
    }
    return [...new Set(models)]; // 去重
  }

  /**
   * 验证请求参数
   * 默认实现：检查 prompt、图片数量及能力支持情况
   */
  validateRequest(request: ImageGenerationRequest): string | null {
    // 验证 prompt 或图片输入
    if (!request.prompt && request.images.length === 0) {
      return "必须提供 prompt 或输入图片";
    }

    // 验证图片数量限制
    if (request.images.length > this.capabilities.maxInputImages) {
      return `最多支持 ${this.capabilities.maxInputImages} 张输入图片`;
    }

    // 验证图生图能力
    if (request.images.length > 0 && !this.capabilities.imageToImage) {
      return `${this.name} 不支持图生图功能`;
    }

    // 验证多图融合能力
    if (request.images.length > 1 && !this.capabilities.multiImageFusion) {
      return `${this.name} 不支持多图融合功能`;
    }

    return null;
  }

  /**
   * 图片编辑
   * 默认实现：抛出未实现错误
   */
  edit(
    _apiKey: string,
    _request: ImageGenerationRequest,
    _options: GenerationOptions,
  ): Promise<GenerationResult> {
    return Promise.reject(new Error(`${this.name} 尚未实现图片编辑功能`));
  }

  /**
   * 融合生图
   * 默认实现：抛出未实现错误
   */
  blend(
    _apiKey: string,
    _request: ImagesBlendRequest,
    _options: GenerationOptions,
  ): Promise<GenerationResult> {
    return Promise.reject(new Error(`${this.name} 尚未实现融合生图功能`));
  }

  /**
   * 智能选择模型
   * 优先级：请求指定 -> 运行时覆盖配置 -> 默认配置
   *
   * @param {string} [requestModel] - 请求中指定的模型
   * @param {boolean} hasImages - 是否包含输入图片（决定是文生图还是图生图）
   * @returns {string} 最终选定的模型名称
   */
  protected selectModel(requestModel: string | undefined, hasImages: boolean): string {
    // 1. 如果请求指定了模型，且该模型在支持列表中，则直接使用
    if (requestModel) {
      if (hasImages) {
        const editList = this.config.editModels || [];
        if (editList.includes(requestModel)) {
          return requestModel;
        }
      } else {
        const textList = this.config.textModels || [];
        if (textList.includes(requestModel)) {
          return requestModel;
        }
      }
    }

    // 2. 检查是否有运行时动态覆盖配置
    const override = getProviderTaskDefaults(this.name, hasImages ? "edit" : "text");
    if (override.model) {
      return override.model;
    }

    // 3. 使用默认配置
    if (hasImages && this.config.defaultEditModel) {
      return this.config.defaultEditModel;
    }

    return this.config.defaultModel;
  }

  /**
   * 智能选择尺寸
   * 优先级：请求指定 -> 运行时覆盖配置 -> 默认配置
   *
   * @param {string} [requestSize] - 请求中指定的尺寸
   * @param {boolean} hasImages - 是否包含输入图片
   * @returns {string} 最终选定的尺寸
   */
  protected selectSize(requestSize: string | undefined, hasImages: boolean): string {
    if (requestSize) {
      return requestSize;
    }

    const override = getProviderTaskDefaults(this.name, hasImages ? "edit" : "text");
    if (override.size) {
      return override.size;
    }

    if (hasImages && this.config.defaultEditSize) {
      return this.config.defaultEditSize;
    }

    return this.config.defaultSize;
  }

  /**
   * 智能选择生成数量
   * 优先级策略：
   * 1. 指定渠道（ModelScope/Pollinations/Gitee/HuggingFace）：运行时覆盖配置 -> 默认配置 -> 1（忽略请求中的 n）
   * 2. 其他渠道：请求指定 -> 运行时覆盖配置 -> 默认配置 -> 1
   *
   * @param {number} [requestCount] - 请求中指定的数量
   * @param {boolean} hasImages - 是否包含输入图片
   * @returns {number} 最终选定的数量
   */
  protected selectCount(requestCount: number | undefined, hasImages: boolean): number {
    const override = getProviderTaskDefaults(this.name, hasImages ? "edit" : "text");
    const defaultConfig = hasImages ? this.config.defaultEditCount : this.config.defaultCount;

    info(
      this.name,
      `selectCount check: requestN=${requestCount}, overrideN=${override.n}, defaultN=${defaultConfig}, task=${
        hasImages ? "edit" : "text"
      }`,
    );

    // 强制优先使用 WebUI 运行时配置的渠道列表
    // 这些渠道通常需要通过配置来强制控制并发数（如防止滥用或加速）
    const forceOverrideProviders: ProviderName[] = [
      "ModelScope",
      "Pollinations",
      "Gitee",
      "HuggingFace",
    ];

    if (forceOverrideProviders.includes(this.name)) {
      if (override.n !== undefined && override.n !== null) {
        info(this.name, `Using ${this.name} override n=${override.n}`);
        return override.n;
      }
    }

    if (requestCount !== undefined) {
      return requestCount;
    }

    // 运行时动态默认配置
    if (override.n !== undefined && override.n !== null) {
      return override.n;
    }

    // 静态默认配置
    if (defaultConfig !== undefined) {
      return defaultConfig;
    }

    return 1;
  }

  /**
   * 解析尺寸字符串
   * 将 "1024x768" 格式解析为宽高对象
   *
   * @param {string} size - 尺寸字符串
   * @returns {{width: number, height: number}} 宽高对象
   */
  protected parseSize(size: string): { width: number; height: number } {
    const match = size.match(/^(\d+)x(\d+)$/);
    if (match) {
      return {
        width: parseInt(match[1], 10),
        height: parseInt(match[2], 10),
      };
    }
    return { width: 1024, height: 1024 }; // 默认回退值
  }

  /**
   * 通用并发生成策略
   *
   * 当请求的 n 超过 Provider 原生支持的最大数量时，自动拆分为多个请求并发执行。
   *
   * @param apiKey - API Key
   * @param request - 原始请求
   * @param options - 生成选项
   * @param executor - 执行单次（或原生最大数量）生成的具体函数
   * @returns 合并后的生成结果
   */
  protected async generateWithConcurrency(
    _apiKey: string,
    request: ImageGenerationRequest,
    _options: GenerationOptions,
    executor: (req: ImageGenerationRequest, imageIndex?: number) => Promise<GenerationResult>,
  ): Promise<GenerationResult> {
    const requestedN = request.n || 1;
    const maxNative = this.capabilities.maxNativeOutputImages || 1;

    // 准备 Prompt 优化配置
    const optimizerConfig = getPromptOptimizerConfig();
    const shouldTranslate = optimizerConfig?.enableTranslate !== false;
    const shouldExpand = optimizerConfig?.enableExpand === true;

    // 辅助函数：执行 Prompt 优化
    const optimizePrompt = async (req: ImageGenerationRequest, idx: number) => {
      const newPrompt = await promptOptimizerService.processPrompt(req.prompt, {
        translate: shouldTranslate,
        expand: shouldExpand,
        imageIndex: idx,
        n: requestedN
      });
      return { ...req, prompt: newPrompt };
    };

    // 如果请求数量在原生支持范围内，直接执行
    if (requestedN <= maxNative) {
      const optimizedRequest = await optimizePrompt(request, 0);
      return executor(optimizedRequest);
    }

    info(
      this.name,
      `检测到 n=${requestedN} 超过原生限制 (${maxNative})，启用通用并发生成模式`,
    );

    const tasks: Promise<GenerationResult>[] = [];
    let remainingN = requestedN;

    // 拆分任务
    let batchIndex = 0;
    while (remainingN > 0) {
      const currentBatchN = Math.min(remainingN, maxNative);
      remainingN -= currentBatchN;

      const subRequest = { ...request, n: currentBatchN };
      // 增加并发延迟以避免触发服务端的速率限制或连接错误（如 tls handshake eof）
      // Pollinations 等免费渠道对并发非常敏感，建议至少 1.5s - 2s
      const taskDelay = batchIndex * 1500;
      
      const currentBatchIndex = batchIndex;

      const taskPromise = (async () => {
        if (taskDelay > 0) await new Promise((r) => setTimeout(r, taskDelay));
        
        const optimizedSubRequest = await optimizePrompt(subRequest, currentBatchIndex);
        return executor(optimizedSubRequest, currentBatchIndex + 1);
      })();

      tasks.push(taskPromise);
      batchIndex++;
    }

    const startTime = Date.now();

    try {
      // 并发执行所有任务
      const results = await Promise.all(tasks);

      // 合并结果
      const allImages = results.flatMap((r) => r.images || []);
      const firstResult = results[0]; // 使用第一个结果作为元数据模板

      // 计算总耗时
      const duration = Date.now() - startTime;

      return {
        success: true,
        images: allImages,
        model: firstResult.model,
        provider: this.name,
        duration,
        // 如果需要，可以合并其他元数据
      };
    } catch (error) {
      // 简单起见，如果任何一个任务失败，抛出错误。
      // 生产环境可能需要更复杂的 Partial Success 处理，但目前先保持一致性。
      throw error;
    }
  }
}
