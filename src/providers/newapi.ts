/**
 * @fileoverview NewApi Provider 实现
 * 
 * NewApi 是一个 OpenAI 兼容的 API 网关，支持多种 AI 模型接口。
 * 完全兼容 OpenAI API 标准，支持图像生成、编辑等功能。
 * 
 * 特殊功能：
 * - 支持特殊的 Key 池结构（每个 Key 组包含 URL、Key 和模型列表）
 * - 根据模型 ID 自动路由到对应的 Key 组
 * - 支持从 /v1/models 接口获取可用模型列表
 */

import {
  BaseProvider,
  type GenerationOptions,
  type ProviderConfig,
} from "./base.ts";
import type {
  GenerationResult,
  ImageGenerationRequest,
  ImagesBlendRequest,
} from "../types/index.ts";
import { fetchWithTimeout } from "../utils/index.ts";
import { urlToBase64 } from "../utils/image.ts";
import {
  debug,
  info,
  error as logError,
} from "../core/logger.ts";
import { NewApiConfig as NewApiConfigData, type KeyPoolItem } from "../config/manager.ts";

/**
 * NewAPI Provider 实现
 * 
 * 完全兼容 OpenAI API 标准的网关服务
 */
export class NewApiProvider extends BaseProvider {
  override readonly name = "NewApi" as const;
  
  override readonly capabilities = {
    textToImage: true,
    imageToImage: true,
    multiImageFusion: true,
    asyncTask: false,
    maxInputImages: 10,
    maxOutputImages: 16, // 通过并发支持最多 16 张
    maxNativeOutputImages: 1, // 原生 API 限制为 1（强制并发）
    maxEditOutputImages: 16, // 图生图通过并发支持最多 16 张
    maxBlendOutputImages: 16, // 融合通过并发支持最多 16 张
    outputFormats: ["url", "b64_json"] as Array<"url" | "b64_json">,
  };

  override readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    super();
    this.config = config;
  }

  /**
   * 检测 API Key 是否属于 NewApi
   * 使用 sk-newapi- 前缀区分
   */
  override detectApiKey(apiKey: string): boolean {
    return apiKey.startsWith("sk-newapi-") || (apiKey.startsWith("sk-") && apiKey.length > 40);
  }

  /**
   * 从 Key 池中查找支持指定模型的 Key 组
   * @param model 模型 ID
   * @param keyPool Key 池
   * @returns 匹配的 Key 组，如果没有找到则返回 null
   */
  private findKeyGroupForModel(model: string, keyPool: KeyPoolItem[]): KeyPoolItem | null {
    // 过滤出启用的 Key 组
    const activeKeys = keyPool.filter(k => 
      k.enabled !== false && 
      k.status === "active" &&
      k.baseUrl && 
      k.models && 
      k.models.length > 0
    );

    // 查找包含该模型的 Key 组
    for (const keyGroup of activeKeys) {
      if (keyGroup.models?.includes(model)) {
        return keyGroup;
      }
    }

    return null;
  }

  /**
   * 获取指定 Key 组的可用模型列表
   * @param baseUrl API 基础 URL
   * @param apiKey API Key
   * @returns 模型列表
   */
  async fetchModels(baseUrl: string, apiKey: string): Promise<string[]> {
    try {
      // 智能处理 baseUrl，避免路径重复
      // 如果 baseUrl 已经以 /v1 结尾，不再添加 /v1
      const normalizedUrl = baseUrl.endsWith('/v1') || baseUrl.endsWith('/v1/')
        ? baseUrl.replace(/\/$/, '') // 移除末尾的斜杠
        : baseUrl;
      
      const url = normalizedUrl.endsWith('/v1')
        ? `${normalizedUrl}/models`
        : `${normalizedUrl}/v1/models`;
        
      debug(this.name, `获取模型列表: ${url}`);
      
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
        },
      }, 10000);

      if (!response.ok) {
        throw new Error(`获取模型列表失败 (${response.status})`);
      }

      const data = await response.json();
      // OpenAI API 格式: { data: [{ id: "model-id", ... }, ...] }
      return data.data?.map((m: { id: string }) => m.id) || [];
    } catch (err) {
      logError(this.name, `获取模型列表失败: ${err}`);
      return [];
    }
  }

  /**
   * 合并所有启用 Key 组的模型列表
   * @param keyPool Key 池
   * @returns 合并后的模型列表
   */
  async getMergedModels(keyPool: KeyPoolItem[]): Promise<string[]> {
    const activeKeys = keyPool.filter(k => 
      k.enabled !== false && 
      k.status === "active" &&
      k.baseUrl
    );

    const allModels: string[] = [];
    
    for (const keyGroup of activeKeys) {
      if (keyGroup.models && keyGroup.models.length > 0) {
        // 如果已有模型列表，直接使用
        allModels.push(...keyGroup.models);
      } else if (keyGroup.baseUrl && keyGroup.key) {
        // 否则从 API 获取
        const models = await this.fetchModels(keyGroup.baseUrl, keyGroup.key);
        allModels.push(...models);
      }
    }

    // 去重
    return [...new Set(allModels)];
  }

  /**
   * 生成图片（支持特殊 Key 池结构）
   * @param apiKey API Key（可能是占位符，实际使用 Key 池中的 Key）
   * @param request 图像生成请求
   * @param options 生成选项
   * @param keyPool Key 池（可选，用于特殊路由）
   */
  override async generate(
    apiKey: string,
    request: ImageGenerationRequest,
    options: GenerationOptions,
    keyPool?: KeyPoolItem[],
  ): Promise<GenerationResult> {
    const hasImages = request.images.length > 0;
    
    // 1. 确定最终的生成数量 n
    const n = this.selectCount(request.n, hasImages);
    const requestWithCount = { ...request, n };

    // 2. 使用 BaseProvider 的并发生成策略
    return await this.generateWithConcurrency(
      apiKey,
      requestWithCount,
      options,
      async (singleRequest, imageIndex) => {
        const startTime = Date.now();
        
        // 3. 选择模型和尺寸
        const model = this.selectModel(singleRequest.model, hasImages);
        const size = this.selectSize(singleRequest.size, hasImages);
        
        info(
          this.name,
          `[${options.requestId}] 并发子请求: model=${model}, n=${singleRequest.n}, hasImages=${hasImages}, imageIndex=${imageIndex}`,
        );
        
        // 4. Prompt 优化已移至 BaseProvider 统一处理
        let finalPrompt = singleRequest.prompt || "A beautiful scenery";
        
        // 4.1 多图场景：智能 Prompt 重写
        if (hasImages && singleRequest.images.length > 1) {
          const originalPrompt = finalPrompt;
          finalPrompt = finalPrompt
            .replace(/这张图|这幅图|当前图/g, "图2")
            .replace(/上面那张图?|上面那个人|原图|背景图/g, "图1");
          
          if (originalPrompt === finalPrompt && !finalPrompt.includes("图1")) {
            finalPrompt = `图1是背景，图2是主体。任务：${finalPrompt}`;
          }
          
          if (finalPrompt !== originalPrompt) {
            info(this.name, `Prompt 已智能转换: "${originalPrompt}" -> "${finalPrompt}"`);
          }
        }
        
        // 4.2 多图生成场景：Prompt 扩充
        const currentN = singleRequest.n || 1;
        if (currentN > 1) {
          finalPrompt = `${finalPrompt} 生成${currentN}张图片。`;
          info(
            this.name,
            `[${options.requestId}] 检测到 n=${currentN}，Prompt 追加指令: "生成${currentN}张图片。"`,
          );
        }

        info(
          this.name,
          `[${options.requestId}] 生成参数: model=${model}, size=${size}, n=${currentN}, hasImages=${hasImages}`,
        );

        // 5. 如果提供了 Key 池，尝试根据模型查找对应的 Key 组
        let actualApiKey = apiKey;
        let actualBaseUrl = this.config.apiUrl;

        if (keyPool && keyPool.length > 0) {
          info(
            this.name,
            `[${options.requestId}] 检查 Key 池: 共 ${keyPool.length} 个 Key 组，查找支持模型 ${model} 的组`,
          );
          
          // 5.1 自动获取空 models 字段的 Key 组的模型列表
          for (const keyGroup of keyPool) {
            if (keyGroup.enabled !== false && keyGroup.status === "active" && keyGroup.baseUrl && keyGroup.key) {
              if (!keyGroup.models || keyGroup.models.length === 0) {
                info(
                  this.name,
                  `[${options.requestId}] Key 组 ${keyGroup.name || keyGroup.id} 的 models 为空，自动获取模型列表`,
                );
                const models = await this.fetchModels(keyGroup.baseUrl, keyGroup.key);
                if (models.length > 0) {
                  keyGroup.models = models;
                  info(
                    this.name,
                    `[${options.requestId}] 已获取 ${models.length} 个模型: ${models.slice(0, 3).join(", ")}${models.length > 3 ? "..." : ""}`,
                  );
                }
              }
            }
          }
          
          const keyGroup = this.findKeyGroupForModel(model, keyPool);
          if (keyGroup) {
            actualApiKey = keyGroup.key;
            actualBaseUrl = keyGroup.baseUrl || this.config.apiUrl;
            info(
              this.name,
              `[${options.requestId}] ✓ 找到匹配的 Key 组: ${keyGroup.name || keyGroup.id}`,
            );
            info(
              this.name,
              `[${options.requestId}]   - URL: ${actualBaseUrl}`,
            );
            info(
              this.name,
              `[${options.requestId}]   - 支持模型: ${keyGroup.models?.slice(0, 3).join(", ")}${(keyGroup.models?.length || 0) > 3 ? "..." : ""}`,
            );
          } else {
            info(
              this.name,
              `[${options.requestId}] ✗ 未找到支持模型 ${model} 的 Key 组`,
            );
            info(
              this.name,
              `[${options.requestId}]   可用 Key 组列表:`,
            );
            keyPool.filter(k => k.enabled !== false && k.status === "active").forEach((k, i) => {
              const keyInfo = JSON.stringify({
                id: k.id,
                name: k.name,
                baseUrl: k.baseUrl,
                models: k.models,
                provider: k.provider,
              }, null, 2);
              info(
                this.name,
                `[${options.requestId}]   ${i + 1}. Key 组详情:\n${keyInfo}`,
              );
            });
            info(
              this.name,
              `[${options.requestId}]   使用默认配置: ${this.config.apiUrl}`,
            );
          }
        } else {
          info(
            this.name,
            `[${options.requestId}] 未提供 Key 池，使用默认配置`,
          );
        }

        try {
          // 6. 根据是否有输入图片选择接口
          const requestWithPrompt = { ...singleRequest, prompt: finalPrompt };
          
          if (hasImages) {
            return await this.generateEdit(
              actualApiKey,
              actualBaseUrl,
              requestWithPrompt,
              model,
              size,
              currentN,
              options,
              startTime,
            );
          } else {
            return await this.generateText(
              actualApiKey,
              actualBaseUrl,
              requestWithPrompt,
              model,
              size,
              currentN,
              options,
              startTime,
            );
          }
        } catch (err) {
          logError(this.name, `[${options.requestId}] 生成失败: ${err}`);
          throw err;
        }
      },
    );
  }

  /**
   * 文生图
   */
  private async generateText(
    apiKey: string,
    baseUrl: string,
    request: ImageGenerationRequest,
    model: string,
    size: string,
    n: number,
    options: GenerationOptions,
    startTime: number,
  ): Promise<GenerationResult> {
    // 智能处理 baseUrl，避免路径重复
    const normalizedUrl = baseUrl.endsWith('/v1') || baseUrl.endsWith('/v1/')
      ? baseUrl.replace(/\/$/, '') // 移除末尾的斜杠
      : baseUrl;
    const url = normalizedUrl.endsWith('/v1')
      ? `${normalizedUrl}/images/generations`
      : `${normalizedUrl}/v1/images/generations`;
    
    const body = {
      model,
      prompt: request.prompt,
      n,
      size,
      response_format: request.response_format || "url",
    };

    debug(this.name, `[${options.requestId}] 请求 URL: ${url}`);
    debug(this.name, `[${options.requestId}] 请求体: ${JSON.stringify(body)}`);

    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    }, options.timeoutMs);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`NewApi API 错误 (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const duration = Date.now() - startTime;

    // 添加详细日志
    info(
      this.name,
      `[${options.requestId}] API 响应: data.data.length=${data.data?.length}, 请求 n=${n}`,
    );
    debug(this.name, `[${options.requestId}] 完整响应: ${JSON.stringify(data)}`);

    // 处理响应格式
    const images = await this.processResponse(data, request.response_format, options);

    return {
      success: true,
      images,
      model,
      provider: this.name,
      duration,
    };
  }

  /**
   * 图生图/编辑
   */
  private async generateEdit(
    apiKey: string,
    baseUrl: string,
    request: ImageGenerationRequest,
    model: string,
    size: string,
    n: number,
    options: GenerationOptions,
    startTime: number,
  ): Promise<GenerationResult> {
    // 智能处理 baseUrl，避免路径重复
    const normalizedUrl = baseUrl.endsWith('/v1') || baseUrl.endsWith('/v1/')
      ? baseUrl.replace(/\/$/, '') // 移除末尾的斜杠
      : baseUrl;
    const url = normalizedUrl.endsWith('/v1')
      ? `${normalizedUrl}/images/edits`
      : `${normalizedUrl}/v1/images/edits`;
    
    // 构建 FormData
    const formData = new FormData();
    formData.append("model", model);
    formData.append("prompt", request.prompt || "");
    formData.append("n", n.toString());
    formData.append("size", size);
    formData.append("response_format", request.response_format || "url");

    // 添加图片
    for (let i = 0; i < request.images.length; i++) {
      const imageData = request.images[i];
      if (imageData.startsWith("data:")) {
        // Base64 转 Blob
        const base64Data = imageData.split(",")[1];
        const blob = new Blob([Uint8Array.from(atob(base64Data), c => c.charCodeAt(0))], {
          type: "image/png",
        });
        formData.append("image", blob, `image_${i}.png`);
      } else {
        // URL 格式，需要先下载
        const imageBlob = await fetch(imageData).then(r => r.blob());
        formData.append("image", imageBlob, `image_${i}.png`);
      }
    }

    debug(this.name, `[${options.requestId}] 请求 URL: ${url}`);

    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
      body: formData,
    }, options.timeoutMs);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`NewApi API 错误 (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const duration = Date.now() - startTime;

    // 添加详细日志
    info(
      this.name,
      `[${options.requestId}] Edit API 响应: data.data.length=${data.data?.length}, 请求 n=${n}`,
    );
    debug(this.name, `[${options.requestId}] 完整响应: ${JSON.stringify(data)}`);

    const images = await this.processResponse(data, request.response_format, options);

    return {
      success: true,
      images,
      model,
      provider: this.name,
      duration,
    };
  }

  /**
   * 融合生图
   */
  override blend(
    apiKey: string,
    request: ImagesBlendRequest,
    options: GenerationOptions,
    keyPool?: KeyPoolItem[],
  ): Promise<GenerationResult> {
    // NewApi 的融合功能通过 edits 接口实现
    const imageRequest: ImageGenerationRequest = {
      prompt: request.prompt || "",
      images: request.images as string[],
      model: request.model,
      size: request.size,
      n: request.n,
      response_format: request.response_format,
    };

    return this.generate(apiKey, imageRequest, options, keyPool);
  }

  /**
   * 处理 API 响应
   */
  private async processResponse(
    // deno-lint-ignore no-explicit-any
    data: any,
    responseFormat: string | undefined,
    options: GenerationOptions,
  ): Promise<Array<{ url?: string; b64_json?: string }>> {
    const images: Array<{ url?: string; b64_json?: string }> = [];

    debug(this.name, `[${options.requestId}] 处理响应数据: responseFormat=${responseFormat}`);

    for (const item of data.data || []) {
      if (responseFormat === "b64_json") {
        // 需要 Base64 格式
        if (item.b64_json) {
          images.push({ b64_json: item.b64_json });
        } else if (item.url) {
          // URL 转 Base64
          try {
            const result = await urlToBase64(item.url);
            images.push({ b64_json: result.base64 });
          } catch (err) {
            logError(this.name, `[${options.requestId}] URL 转 Base64 失败: ${err}`);
            images.push({ url: item.url });
          }
        }
      } else {
        // 默认返回 URL
        if (item.url) {
          images.push({ url: item.url });
        } else if (item.b64_json) {
          images.push({ url: `data:image/png;base64,${item.b64_json}` });
        }
      }
    }

    debug(this.name, `[${options.requestId}] 处理完成，生成 ${images.length} 张图片`);
    return images;
  }

  /**
   * 获取支持的模型列表
   */
  override getSupportedModels(): string[] {
    const models = [...this.config.textModels];
    if (this.config.editModels) {
      models.push(...this.config.editModels);
    }
    if (this.config.blendModels) {
      models.push(...this.config.blendModels);
    }
    return [...new Set(models)];
  }
}

/**
 * NewApi Provider 单例实例
 * 使用配置管理器中的配置初始化
 */
export const newApiProvider = new NewApiProvider({
  apiUrl: NewApiConfigData.apiUrl,
  textModels: NewApiConfigData.textModels || [],
  defaultModel: NewApiConfigData.defaultModel || "",
  defaultSize: NewApiConfigData.defaultSize,
  defaultCount: NewApiConfigData.defaultCount,
  editModels: NewApiConfigData.textModels || [],
  defaultEditModel: NewApiConfigData.defaultModel || "",
  defaultEditSize: NewApiConfigData.defaultSize,
  defaultEditCount: NewApiConfigData.defaultEditCount,
  blendModels: NewApiConfigData.textModels || [],
  defaultBlendModel: NewApiConfigData.defaultModel || "",
  defaultBlendSize: NewApiConfigData.defaultSize,
  defaultBlendCount: 1,
});
